import Foundation

// Only an explicitly armed acceptance run can retain one already-filtered image.
@MainActor
public final class NaturalPointingReplayRecorder {
  private let directory: URL
  private let armedUntil: Date
  private var consumed = false

  public init(directory: URL, now: Date = Date()) {
    self.directory = directory
    self.armedUntil = now.addingTimeInterval(900)
  }

  @discardableResult
  public func record(
    context: FilteredContext,
    question: String,
    turnId: UUID,
    now: Date = Date()
  ) throws -> Bool {
    guard !consumed, now < armedUntil,
      !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      case .image(let data, let point, let height, _, let mediaType, _, let hash, let width) =
        context.payload
    else {
      return false
    }
    consumed = true
    let manager = FileManager.default
    let file = directory.appendingPathComponent("case.json")
    guard !manager.fileExists(atPath: file.path) else {
      throw CocoaError(.fileWriteFileExists)
    }
    try manager.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let fixture = ReplayCase(
      capturedAt: now.ISO8601Format(),
      expiresAt: now.addingTimeInterval(86_400).ISO8601Format(),
      question: question,
      turnId: turnId,
      focusPoint: point,
      image: ImageWire(
        data: data.base64EncodedString(), height: height, mediaType: mediaType,
        sha256: hash, width: width
      )
    )
    try JSONEncoder().encode(fixture).write(to: file, options: .withoutOverwriting)
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    Task { [directory] in
      try? await Task.sleep(for: .seconds(86_400))
      try? Self.removeExpiredCase(in: directory)
    }
    return true
  }

  public static func removeExpiredCase(in directory: URL, now: Date = Date()) throws {
    let file = directory.appendingPathComponent("case.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    let expiry = try JSONDecoder().decode(ReplayExpiry.self, from: Data(contentsOf: file))
    guard expiry.schemaVersion == 1, expiry.purpose == "natural-pointing-replay",
      let expiresAt = parseISO8601(expiry.expiresAt), expiresAt <= now
    else { return }
    try FileManager.default.removeItem(at: file)
  }
}

@MainActor
public func configuredNaturalPointingReplayRecorder(
  environment: [String: String] = ProcessInfo.processInfo.environment
) -> NaturalPointingReplayRecorder? {
  guard let path = environment["VIOLET_POINTING_REPLAY_DIR"], !path.isEmpty else { return nil }
  let directory = URL(fileURLWithPath: path, isDirectory: true)
  do {
    try NaturalPointingReplayRecorder.removeExpiredCase(in: directory)
    return NaturalPointingReplayRecorder(directory: directory)
  } catch {
    return nil
  }
}

private struct ReplayCase: Encodable {
  let schemaVersion = 1
  let purpose = "natural-pointing-replay"
  let capturedAt: String
  let expiresAt: String
  let question: String
  let turnId: UUID
  let focusPoint: NormalizedContextPoint?
  let image: ImageWire
}

private struct ReplayExpiry: Decodable {
  let schemaVersion: Int
  let purpose: String
  let expiresAt: String
}
