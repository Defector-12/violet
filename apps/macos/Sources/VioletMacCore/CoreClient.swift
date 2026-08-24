import Foundation
import OpenAPIRuntime
import VioletProtocolClient

public enum VioletCoreState: Equatable, Sendable {
  case ready
  case sealed(reason: String?)
}

public struct VioletCoreStatus: Equatable, Sendable {
  public let state: VioletCoreState
  public let version: String

  public init(state: VioletCoreState, version: String) {
    self.state = state
    self.version = version
  }
}

public enum VioletCoreClientError: Error, Equatable, LocalizedError {
  case invalidResponse
  case requestFailed(code: Int)
  case streamError(message: String)

  public var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "Violet Core returned an invalid response."
    case .requestFailed(let code):
      "Violet Core request failed with status \(code)."
    case .streamError(let message):
      message
    }
  }
}

public protocol VioletCoreClientPort: Sendable {
  func status() async throws -> VioletCoreStatus
  func streamChat(message: String, requestId: UUID) -> AsyncThrowingStream<String, Error>
  func streamChat(
    message: String,
    requestId: UUID,
    contextSessionId: UUID?
  ) -> AsyncThrowingStream<String, Error>
}

extension VioletCoreClientPort {
  public func streamChat(
    message: String,
    requestId: UUID,
    contextSessionId: UUID?
  ) -> AsyncThrowingStream<String, Error> {
    streamChat(message: message, requestId: requestId)
  }
}

public struct GeneratedVioletCoreClient: VioletCoreClientPort {
  private let client: Client

  public init(serverURL: URL, deviceToken: String) {
    client = VioletProtocolClientFactory.make(
      serverURL: serverURL,
      deviceToken: deviceToken
    )
  }

  public func status() async throws -> VioletCoreStatus {
    let output = try await client.getCoreStatus(.init())
    switch output {
    case .ok(let response):
      let status = try response.body.json
      let state: VioletCoreState =
        switch status.state {
        case .ready:
          .ready
        case .sealed:
          .sealed(reason: status.reason)
        }
      return VioletCoreStatus(state: state, version: status.version)
    case .unauthorized:
      throw VioletCoreClientError.requestFailed(code: 401)
    case .undocumented(let statusCode, _):
      throw VioletCoreClientError.requestFailed(code: statusCode)
    }
  }

  public func streamChat(
    message: String,
    requestId: UUID
  ) -> AsyncThrowingStream<String, Error> {
    streamChat(message: message, requestId: requestId, contextSessionId: nil)
  }

  public func streamChat(
    message: String,
    requestId: UUID,
    contextSessionId: UUID?
  ) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let output = try await client.streamChat(
            .init(
              body: .json(
                .init(
                  contextSessionId: contextSessionId?.uuidString.lowercased(),
                  message: message,
                  requestId: requestId.uuidString.lowercased()
                )
              )
            )
          )
          switch output {
          case .ok(let response):
            let body = try response.body.application_x_hyphen_ndjson
            try await decodeChatStream(body, continuation: continuation)
          case .unauthorized:
            throw VioletCoreClientError.requestFailed(code: 401)
          case .code423:
            throw VioletCoreClientError.requestFailed(code: 423)
          case .undocumented(let statusCode, _):
            throw VioletCoreClientError.requestFailed(code: statusCode)
          }
        } catch is CancellationError {
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
}

private struct ChatWireEvent: Decodable {
  struct WireError: Decodable {
    let message: String
  }

  let content: String?
  let error: WireError?
  let type: String
}

private func decodeChatStream(
  _ body: HTTPBody,
  continuation: AsyncThrowingStream<String, Error>.Continuation
) async throws {
  var buffer = Data()

  for try await chunk in body {
    try Task.checkCancellation()
    buffer.append(contentsOf: chunk)

    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = buffer[..<newline]
      buffer.removeSubrange(...newline)
      try decodeChatLine(Data(line), continuation: continuation)
    }
  }

  if !buffer.isEmpty {
    try decodeChatLine(buffer, continuation: continuation)
  }
  continuation.finish()
}

private func decodeChatLine(
  _ data: Data,
  continuation: AsyncThrowingStream<String, Error>.Continuation
) throws {
  guard !data.isEmpty else {
    return
  }
  let event = try JSONDecoder().decode(ChatWireEvent.self, from: data)
  switch event.type {
  case "delta":
    guard let content = event.content else {
      throw VioletCoreClientError.invalidResponse
    }
    continuation.yield(content)
  case "error":
    throw VioletCoreClientError.streamError(
      message: event.error?.message ?? "Violet Core realtime request failed."
    )
  case "complete", "start":
    break
  default:
    throw VioletCoreClientError.invalidResponse
  }
}
