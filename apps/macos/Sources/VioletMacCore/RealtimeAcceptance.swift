import Foundation

public enum RealtimeAcceptanceEventType: String, Codable, Sendable {
  case captureStarted = "capture.started"
  case captureStopped = "capture.stopped"
  case interruptionDetected = "interruption.detected"
  case playbackStopped = "playback.stopped"
  case presencePresented = "presence.presented"
  case presenceTriggered = "presence.triggered"
  case responseAudioScheduled = "response.audio.scheduled"
  case responseAudioStarted = "response.audio.started"
  case responseCancelled = "response.cancelled"
  case responseCompleted = "response.completed"
  case responseStarted = "response.started"
  case sessionEnded = "session.ended"
  case sessionStartRequested = "session.start.requested"
  case sessionStopRequested = "session.stop.requested"
  case speechStarted = "speech.started"
  case speechStopped = "speech.stopped"
}

public enum RealtimeAcceptanceReason: String, Codable, Sendable {
  case appTermination = "app_termination"
  case failure
  case localSpeech = "local_speech"
  case menuBar = "menu_bar"
  case popoverClosed = "popover_closed"
  case serverSpeech = "server_speech"
  case shortcut
  case streamEnded = "stream_ended"
  case systemLifecycle = "system_lifecycle"
  case userClick = "user_click"
  case userStop = "user_stop"
}

public struct RealtimeAcceptanceMark: Equatable, Sendable {
  public let responseId: UUID?
  public let reason: RealtimeAcceptanceReason?
  public let sessionId: UUID?
  public let triggerId: UUID?
  public let turnId: UUID?
  public let type: RealtimeAcceptanceEventType

  public init(
    type: RealtimeAcceptanceEventType,
    reason: RealtimeAcceptanceReason? = nil,
    sessionId: UUID? = nil,
    turnId: UUID? = nil,
    responseId: UUID? = nil,
    triggerId: UUID? = nil
  ) {
    self.responseId = responseId
    self.reason = reason
    self.sessionId = sessionId
    self.triggerId = triggerId
    self.turnId = turnId
    self.type = type
  }
}

@MainActor
public protocol RealtimeAcceptanceRecording: AnyObject {
  func flush()
  func record(_ mark: RealtimeAcceptanceMark)
}

@MainActor
public final class NoopRealtimeAcceptanceRecorder: RealtimeAcceptanceRecording {
  public init() {}

  public func flush() {}

  public func record(_ mark: RealtimeAcceptanceMark) {}
}

@MainActor
public final class JSONLinesRealtimeAcceptanceRecorder: RealtimeAcceptanceRecording {
  private let clock = ContinuousClock()
  private let encoder = JSONEncoder()
  private let formatter = ISO8601DateFormatter()
  private let runId = UUID()
  private var sequence = 0
  private let startedAt: ContinuousClock.Instant
  private let writer: JSONLinesWriter

  public init(fileURL: URL) throws {
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    if !FileManager.default.fileExists(atPath: fileURL.path) {
      guard FileManager.default.createFile(atPath: fileURL.path, contents: nil) else {
        throw RealtimeAcceptanceRecorderError.cannotCreateFile
      }
    }
    writer = try JSONLinesWriter(fileURL: fileURL)
    startedAt = clock.now
    encoder.outputFormatting = [.sortedKeys]
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  }

  deinit {
    writer.close()
  }

  public func flush() {
    writer.flush()
  }

  public func record(_ mark: RealtimeAcceptanceMark) {
    sequence += 1
    let elapsed = startedAt.duration(to: clock.now).components
    let event = StoredRealtimeAcceptanceEvent(
      elapsedMilliseconds: elapsed.seconds * 1_000
        + elapsed.attoseconds / 1_000_000_000_000_000,
      recordedAt: formatter.string(from: Date()),
      responseId: mark.responseId,
      reason: mark.reason,
      runId: runId,
      schemaVersion: 1,
      sequence: sequence,
      sessionId: mark.sessionId,
      triggerId: mark.triggerId,
      turnId: mark.turnId,
      type: mark.type
    )
    guard var data = try? encoder.encode(event) else {
      return
    }
    data.append(0x0A)
    writer.write(data)
  }
}

public enum RealtimeAcceptanceRecorderError: Error, Equatable {
  case cannotCreateFile
}

@MainActor
public func configuredRealtimeAcceptanceRecorder(
  environment: [String: String] = ProcessInfo.processInfo.environment
) -> any RealtimeAcceptanceRecording {
  guard
    let path = environment["VIOLET_ACCEPTANCE_LOG"]?
      .trimmingCharacters(in: .whitespacesAndNewlines),
    !path.isEmpty
  else {
    return NoopRealtimeAcceptanceRecorder()
  }
  do {
    return try JSONLinesRealtimeAcceptanceRecorder(
      fileURL: URL(fileURLWithPath: path)
    )
  } catch {
    try? FileHandle.standardError.write(
      contentsOf: Data("Violet acceptance recorder is unavailable.\n".utf8)
    )
    return NoopRealtimeAcceptanceRecorder()
  }
}

private struct StoredRealtimeAcceptanceEvent: Codable {
  let elapsedMilliseconds: Int64
  let recordedAt: String
  let responseId: UUID?
  let reason: RealtimeAcceptanceReason?
  let runId: UUID
  let schemaVersion: Int
  let sequence: Int
  let sessionId: UUID?
  let triggerId: UUID?
  let turnId: UUID?
  let type: RealtimeAcceptanceEventType
}

private final class JSONLinesWriter: @unchecked Sendable {
  private let fileHandle: FileHandle
  private let queue = DispatchQueue(label: "com.violet.acceptance-writer")

  init(fileURL: URL) throws {
    fileHandle = try FileHandle(forWritingTo: fileURL)
    try fileHandle.seekToEnd()
  }

  func write(_ data: Data) {
    queue.async { [self] in
      try? fileHandle.write(contentsOf: data)
    }
  }

  func close() {
    queue.sync { [self] in
      try? fileHandle.close()
    }
  }

  func flush() {
    queue.sync { [self] in
      try? fileHandle.synchronize()
    }
  }
}
