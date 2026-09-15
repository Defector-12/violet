import Foundation
import Testing

@testable import VioletMacCore

@Suite("Explicit test trace")
struct TestTraceTests {
  @Test
  func remainsDisabledWithoutAnExplicitRun() throws {
    #expect(try TestTraceRecorder.configured(environment: [:]) == nil)
    #expect(try TestTraceRecorder.configured(environment: ["VIOLET_TEST_RUN_DIR": ""]) == nil)
  }

  @Test
  func explicitRunsUseSeparateFilesAcrossRestarts() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let configured = try TestTraceRecorder.configured(environment: ["VIOLET_TEST_RUN_DIR": directory.path])
    let first = try #require(configured)
    try first.record("session.one")
    let second = try TestTraceRecorder(directory: directory)
    try second.record("session.two")
    let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("mac-") }
    #expect(files.count == 2)
    let text = try files.map { try String(contentsOf: $0, encoding: .utf8) }.joined(separator: "\n")
    #expect(text.contains("session.one"))
    #expect(text.contains("session.two"))
    for line in text.split(separator: "\n") {
      let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
      if object?["source"] as? String == "mac" {
        let timestamp = try #require(object?["recordedAt"] as? String)
        #expect(parseISO8601(timestamp) != nil)
        #expect(timestamp.contains("T") && timestamp.hasSuffix("Z"))
      }
    }
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("REPORT.md").path))
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix("capture-") }.isEmpty)
  }

  @Test
  func traceFailsWhenTheOpenFileIsDeleted() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let file = try #require(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .first { $0.lastPathComponent.hasPrefix("mac-") })
    try FileManager.default.removeItem(at: file)
    #expect(throws: TestTraceFailure.self) { try recorder.record("lost") }
  }

  @Test
  func restoresPrivatePermissionsWhenAppendingToExistingTrace() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let path = try #require(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .first { $0.lastPathComponent.hasPrefix("mac-") })
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
    try recorder.record("after-permission-change")
    let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
  }

  @Test
  func preservesUUIDCorrelationFieldsWithoutExemptingSecretsOrText() {
    let id = "12345678-1234-4123-8123-123456789012"
    for key in ["turnId", "sessionId", "requestId", "responseId", "eventId"] {
      #expect(TestTraceRecorder.sanitize(id, key: key) as? String == id)
      #expect(!(TestTraceRecorder.sanitize("password=synthetic-secret", key: key) as? String ?? "").contains("synthetic-secret"))
      #expect(TestTraceRecorder.sanitize("1234567890123456", key: key) as? String != "1234567890123456")
    }
    #expect(TestTraceRecorder.sanitize(id, key: "text") as? String != id)
    #expect(TestTraceRecorder.sanitize(id, key: "secret") as? String == "[REDACTED]")
    let json = TestTraceRecorder.sanitize(
      #"{"password":"synthetic-secret","api_key":"synthetic-api-value"}"#,
      key: "text"
    ) as? String ?? ""
    #expect(!json.contains("synthetic-secret"))
    #expect(!json.contains("synthetic-api-value"))
  }

  @Test
  func rejectsExpiredRunBeforeRecording() throws {
    let directory = try fixture(expired: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(throws: TestTraceFailure.self) { try TestTraceRecorder(directory: directory) }
  }

  @Test
  func recordsFullAnswersWithoutLeakingSplitSecretsOrAudio() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let responseId = UUID().uuidString
    let turnId = UUID().uuidString
    for part in ["password=", "synthetic-secret"] {
      try recorder.wire("mac.receive", data: json([
        "type": "response.text", "responseId": responseId, "turnId": turnId, "text": part,
      ]))
    }
    try recorder.wire("mac.receive", data: json([
      "type": "response.completed", "responseId": responseId, "turnId": turnId,
    ]))
    let audio = Data("not an audio recording".utf8).base64EncodedString()
    try recorder.wire("mac.send", data: json(["type": "input.audio", "audio": audio]))
    let text = try log(directory)
    #expect(text.contains("answer.completed"))
    #expect(text.contains("[REDACTED]"))
    #expect(!text.contains("synthetic-secret"))
    #expect(!text.contains(audio))
  }

  @Test
  func preservesIncompleteAnswersOnSessionClose() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let responseId = UUID().uuidString
    let turnId = UUID().uuidString
    try recorder.wire("mac.receive", data: json([
      "type": "response.text", "responseId": responseId, "turnId": turnId,
      "text": "partial password=synthetic-secret",
    ]))

    try recorder.finishIncompleteAnswers(reason: "session-closed")

    let text = try log(directory)
    #expect(text.contains("answer.incomplete"))
    #expect(text.contains("session-closed"))
    #expect(text.contains("[REDACTED]"))
    #expect(!text.contains("synthetic-secret"))
  }

  @Test
  @MainActor
  func blocksExcludedApplicationsBeforeRecordingTheirIdentityOrPointer() async throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let excludedBundleId = "com.example.private-records"
    let capture = SystemContextCapture(
      excludedBundleIds: [excludedBundleId],
      currentProcessIdentifier: 999,
      activeApplication: {
        ContextApplicationTarget(bundleIdentifier: excludedBundleId, processIdentifier: 123)
      },
      accessibilityAccess: { false },
      focusedElementReader: { _ in nil },
      selectionReader: { _, _ in .unavailable },
      mouseLocation: { CGPoint(x: 321, y: 654) },
      testTrace: recorder
    )

    #expect(capture.prepareNaturalPointingCapture())
    await #expect(throws: LocalContextPrivacyError.blockedApplication) {
      try await capture.capture(.naturalPointing)
    }

    let text = try log(directory)
    #expect(text.contains("capture.blocked"))
    #expect(!text.contains("capture.target"))
    #expect(!text.contains(excludedBundleId))
    #expect(!text.contains("appKitPointer"))
  }

  @Test
  func retainsTheActualFilteredCaptureWithItsTurnAndQuestion() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let turnId = UUID().uuidString
    let requestId = UUID().uuidString
    try recorder.wire("mac.receive", data: json([
      "type": "input.transcript", "final": true, "turnId": turnId, "text": "Which gate?",
    ]))
    let image = Data("synthetic fixture image bytes".utf8)
    try recorder.wire("mac.send", data: json([
      "type": "context.capture.succeeded", "turnId": turnId, "requestId": requestId,
      "context": [
        "capturedAt": Date().ISO8601Format(),
        "payload": [
          "type": "screen.snapshot", "focusPoint": ["x": 0.3, "y": 0.6],
          "image": [
            "data": image.base64EncodedString(), "sha256": contextImageHash(image),
            "width": 1, "height": 1, "mediaType": "image/png",
          ],
        ],
      ],
    ]))
    let file = directory.appendingPathComponent("capture-\(requestId.lowercased()).json")
    let object = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    #expect(object["question"] as? String == "Which gate?")
    #expect(object["turnId"] as? String == turnId.lowercased())
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    #expect(!(try log(directory)).contains(image.base64EncodedString()))
  }

  @Test
  func rejectsHashMismatchesAndStopsFurtherRecording() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    #expect(throws: TestTraceFailure.self) {
      try recorder.wire("mac.send", data: json([
        "type": "context.capture.succeeded", "turnId": UUID().uuidString, "requestId": UUID().uuidString,
        "context": ["payload": ["image": ["data": "aGVsbG8=", "sha256": "invalid"]]],
      ]))
    }
    #expect(throws: TestTraceFailure.self) { try recorder.record("later", fields: [:]) }
  }

  @Test
  func collectsCoreEventsWithoutOverwritingOrDuplicatingHistory() throws {
    let directory = try fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let event = try json([
      "schemaVersion": 1, "runId": recorder.runId, "recordingId": "core",
      "sequence": 1, "source": "core", "type": "answer.completed",
      "recordedAt": Date().ISO8601Format(),
      "data": ["turnId": UUID().uuidString, "text": "Eastern gate."],
    ]) + Data([0x0A])
    try recorder.collect(event)
    try recorder.collect(event)
    let content = try String(contentsOf: directory.appendingPathComponent("core.ndjson"), encoding: .utf8)
    #expect(content.split(separator: "\n").count == 1)
    #expect(!FileManager.default.fileExists(
      atPath: directory.appendingPathComponent("REPORT.md").path
    ))
  }

  private func fixture(expired: Bool = false) throws -> URL {
    let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../.local-acceptance/swift-trace-\(UUID().uuidString)")
      .standardizedFileURL
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try json([
      "schemaVersion": 1, "purpose": "violet-test-trace", "runId": UUID().uuidString.lowercased(),
      "activeUntil": Date().addingTimeInterval(expired ? -60 : 300).ISO8601Format(),
      "expiresAt": Date().addingTimeInterval(3_600).ISO8601Format(),
    ]).write(to: directory.appendingPathComponent("manifest.json"))
    return directory
  }

  private func json(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  }

  private func log(_ directory: URL) throws -> String {
    let path = try #require(FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil
    ).first(where: { $0.lastPathComponent.hasPrefix("mac-") }))
    return try String(contentsOf: path, encoding: .utf8)
  }
}
