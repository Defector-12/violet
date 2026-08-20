import Foundation

public struct RealtimeCapabilities: Codable, Equatable, Sendable {
  public let inputModalities: [String]
  public let interruption: Bool
  public let outputModalities: [String]
  public let runtimeKind: String
  public let transcription: Bool
  public let voiceKind: String
}

public enum RealtimeServerEvent: Equatable, Sendable {
  case ready(RealtimeCapabilities)
  case transcript(text: String, final: Bool, turnId: UUID)
  case responseStarted(responseId: UUID, turnId: UUID)
  case responseText(responseId: UUID, text: String, turnId: UUID)
  case responseAudio(responseId: UUID, audio: Data, turnId: UUID)
  case responseCompleted(responseId: UUID, turnId: UUID)
  case responseCancelled(responseId: UUID)
  case error(code: String, message: String, retryable: Bool)
}

public enum RealtimeSessionClientError: Error, Equatable, LocalizedError {
  case invalidEvent
  case invalidServerSequence(expected: Int, actual: Int)
  case notConnected
  case server(code: String, message: String, retryable: Bool)
  case sessionMismatch
  case turnInProgress

  public var errorDescription: String? {
    switch self {
    case .invalidEvent:
      "Violet Core returned an invalid realtime event."
    case .invalidServerSequence(let expected, let actual):
      "Realtime event sequence mismatch: expected \(expected), received \(actual)."
    case .notConnected:
      "The realtime session is not connected."
    case .server(_, let message, _):
      message
    case .sessionMismatch:
      "Violet Core returned an event for another realtime session."
    case .turnInProgress:
      "A realtime turn is already in progress."
    }
  }
}

public protocol RealtimeSessionClientPort: Sendable {
  func close() async
  func connect() async throws -> RealtimeCapabilities
  func streamText(_ text: String) async -> AsyncThrowingStream<String, Error>
}

public actor URLSessionRealtimeClient: RealtimeSessionClientPort {
  private let coreURL: URL
  private let deviceToken: String
  private let session: URLSession
  private let sessionId = UUID()
  private var clientSequence = 1
  private var serverSequence = 1
  private var activeResponseId: UUID?
  private var turnActive = false
  private var socket: URLSessionWebSocketTask?

  public init(
    coreURL: URL,
    deviceToken: String,
    session: URLSession = .shared
  ) {
    self.coreURL = coreURL
    self.deviceToken = deviceToken
    self.session = session
  }

  public func connect() async throws -> RealtimeCapabilities {
    if socket != nil {
      throw RealtimeSessionClientError.invalidEvent
    }
    var request = URLRequest(url: try realtimeURL(from: coreURL))
    request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
    let newSocket = session.webSocketTask(with: request)
    socket = newSocket
    newSocket.resume()

    do {
      try await send(
        ConfigureEvent(
          configuration: .init(
            inputModalities: ["audio", "text"],
            outputModalities: ["audio", "text"],
            protocolVersion: "1"
          ),
          eventId: UUID(),
          sequence: nextClientSequence(),
          sessionId: sessionId,
          type: "session.configure"
        )
      )
      let event = try await receive()
      guard case .ready(let capabilities) = event else {
        throw RealtimeSessionClientError.invalidEvent
      }
      return capabilities
    } catch {
      newSocket.cancel(with: .goingAway, reason: nil)
      socket = nil
      throw error
    }
  }

  public func streamText(_ text: String) async -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          try await performTextTurn(text, continuation: continuation)
        } catch is CancellationError {
          await cancelActiveResponse()
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in
        task.cancel()
      }
    }
  }

  public func close() async {
    guard let socket else {
      return
    }
    try? await send(
      CloseEvent(
        eventId: UUID(),
        sequence: nextClientSequence(),
        sessionId: sessionId,
        type: "session.close"
      )
    )
    socket.cancel(with: .normalClosure, reason: nil)
    self.socket = nil
    activeResponseId = nil
    turnActive = false
  }

  private func performTextTurn(
    _ text: String,
    continuation: AsyncThrowingStream<String, Error>.Continuation
  ) async throws {
    guard socket != nil else {
      throw RealtimeSessionClientError.notConnected
    }
    guard !turnActive else {
      throw RealtimeSessionClientError.turnInProgress
    }
    turnActive = true
    defer {
      activeResponseId = nil
      turnActive = false
    }
    let turnId = UUID()
    try await send(
      TextInputEvent(
        eventId: UUID(),
        sequence: nextClientSequence(),
        sessionId: sessionId,
        text: text,
        turnId: turnId,
        type: "input.text"
      )
    )

    while !Task.isCancelled {
      switch try await receive() {
      case .responseStarted(let responseId, let responseTurnId):
        guard responseTurnId == turnId else {
          throw RealtimeSessionClientError.invalidEvent
        }
        activeResponseId = responseId
      case .responseText(_, let delta, let responseTurnId):
        guard responseTurnId == turnId else {
          throw RealtimeSessionClientError.invalidEvent
        }
        continuation.yield(delta)
      case .responseCompleted(_, let responseTurnId):
        guard responseTurnId == turnId else {
          throw RealtimeSessionClientError.invalidEvent
        }
        continuation.finish()
        return
      case .error(let code, let message, let retryable):
        throw RealtimeSessionClientError.server(
          code: code,
          message: message,
          retryable: retryable
        )
      case .ready, .responseAudio, .responseCancelled, .transcript:
        continue
      }
    }
  }

  private func cancelActiveResponse() async {
    guard let responseId = activeResponseId, socket != nil else {
      return
    }
    try? await send(
      CancelEvent(
        eventId: UUID(),
        responseId: responseId,
        sequence: nextClientSequence(),
        sessionId: sessionId,
        type: "response.cancel"
      )
    )
  }

  private func receive() async throws -> RealtimeServerEvent {
    guard let socket else {
      throw RealtimeSessionClientError.notConnected
    }
    let message = try await socket.receive()
    let data: Data =
      switch message {
      case .data(let data):
        data
      case .string(let value):
        Data(value.utf8)
      @unknown default:
        throw RealtimeSessionClientError.invalidEvent
      }
    let envelope = try JSONDecoder().decode(ServerEnvelope.self, from: data)
    guard envelope.sessionId == sessionId else {
      throw RealtimeSessionClientError.sessionMismatch
    }
    guard envelope.sequence == serverSequence else {
      throw RealtimeSessionClientError.invalidServerSequence(
        expected: serverSequence,
        actual: envelope.sequence
      )
    }
    serverSequence += 1
    return try decodeRealtimeServerEvent(data)
  }

  private func send<T: Encodable>(_ event: T) async throws {
    guard let socket else {
      throw RealtimeSessionClientError.notConnected
    }
    let data = try JSONEncoder().encode(event)
    guard let value = String(data: data, encoding: .utf8) else {
      throw RealtimeSessionClientError.invalidEvent
    }
    try await socket.send(.string(value))
  }

  private func nextClientSequence() -> Int {
    defer { clientSequence += 1 }
    return clientSequence
  }
}

private struct ConfigureEvent: Encodable {
  struct Configuration: Encodable {
    let inputModalities: [String]
    let outputModalities: [String]
    let protocolVersion: String
  }

  let configuration: Configuration
  let eventId: UUID
  let sequence: Int
  let sessionId: UUID
  let type: String
}

private struct TextInputEvent: Encodable {
  let eventId: UUID
  let sequence: Int
  let sessionId: UUID
  let text: String
  let turnId: UUID
  let type: String
}

private struct CloseEvent: Encodable {
  let eventId: UUID
  let sequence: Int
  let sessionId: UUID
  let type: String
}

private struct CancelEvent: Encodable {
  let eventId: UUID
  let responseId: UUID
  let sequence: Int
  let sessionId: UUID
  let type: String
}

private struct ServerEnvelope: Decodable {
  let sequence: Int
  let sessionId: UUID
  let type: String
}

private struct ReadyEvent: Decodable {
  let capabilities: RealtimeCapabilities
}

private struct TranscriptEvent: Decodable {
  let final: Bool
  let text: String
  let turnId: UUID
}

private struct ResponseEvent: Decodable {
  let audio: String?
  let responseId: UUID
  let text: String?
  let turnId: UUID?
}

private struct ErrorEvent: Decodable {
  let code: String
  let message: String
  let retryable: Bool
}

func decodeRealtimeServerEvent(_ data: Data) throws -> RealtimeServerEvent {
  let decoder = JSONDecoder()
  let envelope = try decoder.decode(ServerEnvelope.self, from: data)
  switch envelope.type {
  case "session.ready":
    return .ready(try decoder.decode(ReadyEvent.self, from: data).capabilities)
  case "input.transcript":
    let event = try decoder.decode(TranscriptEvent.self, from: data)
    return .transcript(text: event.text, final: event.final, turnId: event.turnId)
  case "response.started":
    let event = try decoder.decode(ResponseEvent.self, from: data)
    guard let turnId = event.turnId else {
      throw RealtimeSessionClientError.invalidEvent
    }
    return .responseStarted(responseId: event.responseId, turnId: turnId)
  case "response.text":
    let event = try decoder.decode(ResponseEvent.self, from: data)
    guard let text = event.text, let turnId = event.turnId else {
      throw RealtimeSessionClientError.invalidEvent
    }
    return .responseText(responseId: event.responseId, text: text, turnId: turnId)
  case "response.audio":
    let event = try decoder.decode(ResponseEvent.self, from: data)
    guard
      let audio = event.audio.flatMap({ Data(base64Encoded: $0) }),
      let turnId = event.turnId
    else {
      throw RealtimeSessionClientError.invalidEvent
    }
    return .responseAudio(responseId: event.responseId, audio: audio, turnId: turnId)
  case "response.completed":
    let event = try decoder.decode(ResponseEvent.self, from: data)
    guard let turnId = event.turnId else {
      throw RealtimeSessionClientError.invalidEvent
    }
    return .responseCompleted(responseId: event.responseId, turnId: turnId)
  case "response.cancelled":
    let event = try decoder.decode(ResponseEvent.self, from: data)
    return .responseCancelled(responseId: event.responseId)
  case "error":
    let event = try decoder.decode(ErrorEvent.self, from: data)
    return .error(code: event.code, message: event.message, retryable: event.retryable)
  default:
    throw RealtimeSessionClientError.invalidEvent
  }
}

private func realtimeURL(from coreURL: URL) throws -> URL {
  guard var components = URLComponents(url: coreURL, resolvingAgainstBaseURL: false) else {
    throw RealtimeSessionClientError.invalidEvent
  }
  switch components.scheme {
  case "http":
    components.scheme = "ws"
  case "https":
    components.scheme = "wss"
  default:
    throw RealtimeSessionClientError.invalidEvent
  }
  components.path = "/v1/realtime"
  components.query = nil
  components.fragment = nil
  guard let url = components.url else {
    throw RealtimeSessionClientError.invalidEvent
  }
  return url
}
