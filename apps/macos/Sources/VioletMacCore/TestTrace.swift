import Foundation
import Darwin

public struct TestTraceFailure: Error, LocalizedError {
  public init() {}
  public var errorDescription: String? {
    "Test trace is unavailable or full. Interaction stopped to avoid losing diagnostic evidence."
  }
}

public final class TestTraceRecorder: @unchecked Sendable {
  public static let context = TaskLocal<[String: String]>(wrappedValue: [:])
  public let runId: String
  public let activeUntil: String
  public let directory: URL
  private let expiresAt: Date
  private let deadline: Date
  private let recordingId = UUID().uuidString.lowercased()
  private let lock = NSLock()
  private let file: FileHandle
  private let coreFile: URL
  private var sequence = 0
  private var imageBytes = 0
  private var failure = false
  private var answers: [String: String] = [:]
  private var answerTurns: [String: String] = [:]
  private var questions: [String: String] = [:]
  private var collected = Set<String>()
  private let startedAt = Date()

  public static func configured(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) throws -> TestTraceRecorder? {
    guard let path = environment["VIOLET_TEST_RUN_DIR"], !path.isEmpty else { return nil }
    return try TestTraceRecorder(directory: URL(fileURLWithPath: path, isDirectory: true))
  }

  public init(directory: URL) throws {
    self.directory = directory
    let manager = FileManager.default
    let manifest = try JSONDecoder().decode(Manifest.self, from: Data(
      contentsOf: directory.appendingPathComponent("manifest.json")
    ))
    guard manifest.schemaVersion == 1, manifest.purpose == "violet-test-trace",
      let id = UUID(uuidString: manifest.runId)
    else { throw TestTraceFailure() }
    let deadline = parseISO8601(manifest.activeUntil) ?? .distantPast
    let expiry = parseISO8601(manifest.expiresAt) ?? .distantPast
    guard deadline > Date() && deadline.timeIntervalSinceNow <= 1_800
      && expiry > deadline && expiry.timeIntervalSinceNow <= 86_400 else { throw TestTraceFailure() }
    runId = id.uuidString.lowercased()
    activeUntil = manifest.activeUntil
    self.deadline = deadline
    expiresAt = expiry
    coreFile = directory.appendingPathComponent("core.ndjson")
    guard (try directory.resourceValues(forKeys: [.isSymbolicLinkKey])).isSymbolicLink != true else {
      throw TestTraceFailure()
    }
    try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let url = directory.appendingPathComponent("mac-\(recordingId).ndjson")
    let fd = Darwin.open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_EXCL, 0o600)
    guard fd >= 0 else { throw TestTraceFailure() }
    file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    if let previous = try? String(contentsOf: coreFile, encoding: .utf8) {
      for line in previous.split(separator: "\n") { collected.insert(String(line)) }
    }
    try record("trace.ready", fields: [
      "activeUntil": activeUntil, "expiresAt": manifest.expiresAt,
      "imageRetention": "filtered on-demand captures only; no microphone audio",
    ])
  }

  deinit { try? file.close() }

  public func prepareCore(coreURL: URL, deviceToken: String) async throws {
    try record("core.trace.preflight")
    var request = URLRequest(url: coreURL.appendingPathComponent("v1/test-traces"))
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "runId": runId,
      "activeUntil": activeUntil,
    ])
    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200,
      let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      manifest["status"] as? String == "ready",
      manifest["runId"] as? String == runId
    else {
      try record("core.trace.preflight.failed")
      throw TestTraceFailure()
    }
    try record("core.trace.ready", fields: manifest)
  }

  public func collectCore(coreURL: URL, deviceToken: String) async throws {
    var request = URLRequest(url: coreURL.appendingPathComponent("v1/test-traces/\(runId)"))
    request.timeoutInterval = 10
    request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw TestTraceFailure()
    }
    try collect(data)
    try record("core.trace.collected", fields: ["byteLength": data.count])
  }

  public func record(_ type: String, fields: [String: Any] = [:]) throws {
    lock.lock()
    defer { lock.unlock() }
    do {
      guard !failure, deadline > Date() else { throw TestTraceFailure() }
      sequence += 1
      let record: [String: Any] = [
        "schemaVersion": 1, "source": "mac", "runId": runId, "recordingId": recordingId,
        "recordedAt": Date().ISO8601Format(.init(includingFractionalSeconds: true)),
        "elapsedMs": Int(Date().timeIntervalSince(startedAt) * 1_000),
        "sequence": sequence, "type": type,
        "data": Self.sanitize(fields.merging(Self.context.get()) { value, _ in value }),
      ]
      var encoded = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
      encoded.append(0x0A)
      try appendLocked(encoded)
    } catch {
      failure = true
      throw TestTraceFailure()
    }
  }

  private func appendLocked(_ data: Data) throws {
    guard !failure, deadline > Date() else { throw TestTraceFailure() }
    let fd = file.fileDescriptor
    guard flock(fd, LOCK_EX) == 0 else { throw TestTraceFailure() }
    defer { _ = flock(fd, LOCK_UN) }
    var stat = Darwin.stat()
    guard fstat(fd, &stat) == 0, stat.st_nlink > 0,
      stat.st_mode & S_IFMT == S_IFREG, fchmod(fd, 0o600) == 0
    else { throw TestTraceFailure() }
    let limit = 16 * 1024 * 1024
    guard stat.st_size + Int64(data.count) <= limit else { throw TestTraceFailure() }
    try file.write(contentsOf: data)
    try file.synchronize()
  }

  public func wire(_ direction: String, data: Data) throws {
    do {
      try recordWire(direction, data: data)
    } catch {
      lock.lock()
      failure = true
      lock.unlock()
      throw TestTraceFailure()
    }
  }

  private func recordWire(_ direction: String, data: Data) throws {
    guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw TestTraceFailure()
    }
    let type = object["type"] as? String ?? "unknown"
    let turn = (object["turnId"] as? String)?.lowercased() ?? ""
    let response = (object["responseId"] as? String)?.lowercased() ?? ""
    if (type == "input.transcript" && object["final"] as? Bool == true) || type == "input.text",
      let text = object["text"] as? String
    {
      lock.lock()
      if questions.count >= 128 { questions.removeAll() }
      questions[turn] = text
      lock.unlock()
    }
    if type == "response.text", let text = object["text"] as? String {
      lock.lock()
      let combined = (answers[response] ?? "") + text
      answers[response] = combined
      answerTurns[response] = turn
      lock.unlock()
      guard combined.utf8.count <= 65_536 else { throw TestTraceFailure() }
      object["text"] = ["length": text.count, "content": "[CHUNK_OMITTED]"]
    }
    if type == "input.transcript", object["final"] as? Bool == false {
      object["text"] = ["length": (object["text"] as? String)?.count ?? 0, "content": "[PARTIAL_OMITTED]"]
    }
    if type == "context.capture.succeeded" {
      try saveCapture(object, turn: turn)
    }
    try record(direction, fields: object)
    if type == "response.completed" || type == "response.cancelled" {
      lock.lock()
      let text = answers.removeValue(forKey: response) ?? ""
      answerTurns.removeValue(forKey: response)
      lock.unlock()
      try record("answer.\(type == "response.completed" ? "completed" : "cancelled")", fields: [
        "turnId": turn, "responseId": response, "sessionId": object["sessionId"] ?? "",
        "text": text, "empty": text.isEmpty,
      ])
    }
  }

  public func finishIncompleteAnswers(reason: String) throws {
    lock.lock()
    let pending = answers.map { response, text in
      (response: response, text: text, turn: answerTurns[response] ?? "")
    }
    answers.removeAll()
    answerTurns.removeAll()
    lock.unlock()
    for answer in pending {
      try record("answer.incomplete", fields: [
        "turnId": answer.turn,
        "responseId": answer.response,
        "text": answer.text,
        "empty": answer.text.isEmpty,
        "reason": reason,
      ])
    }
  }

  public func collect(_ data: Data) throws {
    guard expiresAt > Date(), data.count <= 32 * 1024 * 1024,
      let source = String(data: data, encoding: .utf8)
    else { throw TestTraceFailure() }
    lock.lock()
    defer { lock.unlock() }
    let manager = FileManager.default
    if !manager.fileExists(atPath: coreFile.path) {
      guard manager.createFile(atPath: coreFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
      else { throw TestTraceFailure() }
    }
    let handle = try FileHandle(forWritingTo: coreFile)
    defer { try? handle.close() }
    try handle.seekToEnd()
    for line in source.split(separator: "\n") {
      guard let event = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
        event["runId"] as? String == runId
      else { throw TestTraceFailure() }
      let string = String(line)
      if collected.insert(string).inserted {
        try handle.write(contentsOf: Data((string + "\n").utf8))
      }
    }
    try handle.synchronize()
    try writeReport()
  }

  private func writeReport() throws {
    var events: [[String: Any]] = []
    for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    where url.lastPathComponent.hasPrefix("mac-") || url.lastPathComponent == "core.ndjson" {
      let content = try String(contentsOf: url, encoding: .utf8)
      for line in content.split(separator: "\n") {
        if let value = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] {
          events.append(value)
        }
      }
    }
    events.sort { ($0["recordedAt"] as? String ?? "") < ($1["recordedAt"] as? String ?? "") }
    var report = "# Test Run\n\nRun: `\(runId)`\n\n"
      + "Recorder evidence is not a product PASS. Full events: [Core](./core.ndjson).\n\n"
    for event in events {
      let type = event["type"] as? String ?? ""
      let data = event["data"] as? [String: Any] ?? [:]
      let isFinalTranscript = data["type"] as? String == "input.transcript" && data["final"] as? Bool == true
      guard isFinalTranscript || [
        "answer.completed", "answer.cancelled", "capture.requested", "capture.path",
        "capture.failed", "grounding.result", "tool.result", "core.trace.collection.failed",
      ].contains(type) else { continue }
      let json = try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
      let text = (String(data: json, encoding: .utf8) ?? "").replacingOccurrences(of: "````", with: "` ` ` `")
      report += "## \(type)\n\n\(event["recordedAt"] as? String ?? "")\n\n"
        + "````json\n\(text)\n````\n\n"
    }
    let url = directory.appendingPathComponent("REPORT.md")
    try Data(report.utf8).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  private func saveCapture(_ event: [String: Any], turn: String) throws {
    guard let context = event["context"] as? [String: Any],
      let payload = context["payload"] as? [String: Any],
      let requestId = event["requestId"] as? String, UUID(uuidString: requestId) != nil
    else { throw TestTraceFailure() }
    guard let image = payload["image"] as? [String: Any],
      let encoded = image["data"] as? String
    else { return } // AX text is already retained in the event.
    guard let data = Data(base64Encoded: encoded), data.count <= 8 * 1024 * 1024,
      let hash = image["sha256"] as? String, contextImageHash(data) == hash
    else { throw TestTraceFailure() }
    lock.lock()
    defer { lock.unlock() }
    guard deadline > Date(), !failure else { throw TestTraceFailure() }
    imageBytes += data.count
    guard imageBytes <= 128 * 1024 * 1024 else { throw TestTraceFailure() }
    let url = directory.appendingPathComponent("capture-\(requestId.lowercased()).json")
    let fixture: [String: Any] = [
      "schemaVersion": 1, "purpose": "natural-pointing-replay",
      "question": Self.redact(questions.removeValue(forKey: turn) ?? "[FINAL_TRANSCRIPT_NOT_RECEIVED]"),
      "turnId": turn, "requestId": requestId, "image": image,
      "focusPoint": payload["focusPoint"] ?? NSNull(),
      "capturedAt": context["capturedAt"] ?? "",
      "expiresAt": expiresAt.ISO8601Format(),
    ]
    let encodedFixture = try JSONSerialization.data(withJSONObject: fixture, options: [.sortedKeys])
    try encodedFixture.write(to: url, options: [.withoutOverwriting])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  static func sanitize(_ value: Any, key: String = "") -> Any {
    if ["authorization", "headers", "token", "password", "secret", "apikey", "devicetoken"].contains(key.lowercased()) {
      return "[REDACTED]"
    }
    if let string = value as? String {
      if ["turnId", "sessionId", "requestId", "responseId", "eventId", "recordingId", "runId", "providerResponseId"].contains(key),
        UUID(uuidString: string) != nil
      {
        return string
      }
      if ["audio", "data", "bytes"].contains(key) {
        return ["byteLength": Data(base64Encoded: string)?.count ?? 0, "content": "[BINARY_OMITTED]"] as [String: Any]
      }
      return redact(string)
    }
    if let object = value as? [String: Any] {
      return object.reduce(into: [String: Any]()) { result, entry in
        result[entry.key] = sanitize(entry.value, key: entry.key)
      }
    }
    if let array = value as? [Any] { return array.map { sanitize($0) } }
    return value
  }

  static func redact(_ text: String) -> String {
    [
      #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"#,
      #"\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b"#,
      #"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#,
      #"(?i)\bBearer\s+\S+"#,
      #"(?i)["']?(?:password|passwd|token|secret|api[_-]?key|device[_-]?token|access[_-]?token|验证码)["']?\s*[:=：]\s*["']?[^"'\s,;}]+["']?"#,
      #"\b(?:\d[ -]?){13,19}\b"#,
    ].reduce(text) { result, pattern in
      result.replacingOccurrences(of: pattern, with: "[REDACTED]", options: .regularExpression)
    }
  }
}

private struct Manifest: Decodable {
  let schemaVersion: Int
  let purpose: String
  let runId: String
  let activeUntil: String
  let expiresAt: String
}
