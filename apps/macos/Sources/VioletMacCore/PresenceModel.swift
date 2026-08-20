import Combine
import Foundation

public enum PresenceConnectionState: Equatable, Sendable {
  case checking
  case offline(message: String)
  case ready(version: String)
  case sealed(reason: String?)
}

public struct PresenceMessage: Equatable, Identifiable, Sendable {
  public enum Role: Equatable, Sendable {
    case assistant
    case user
  }

  public let id: UUID
  public let role: Role
  public var text: String

  public init(id: UUID = UUID(), role: Role, text: String) {
    self.id = id
    self.role = role
    self.text = text
  }
}

@MainActor
public final class PresenceModel: ObservableObject {
  @Published public private(set) var connectionState: PresenceConnectionState = .checking
  @Published public private(set) var isResponding = false
  @Published public private(set) var messages: [PresenceMessage] = []

  private let client: any VioletCoreClientPort
  private var chatTask: Task<Void, Never>?
  private var monitoringTask: Task<Void, Never>?

  public init(client: any VioletCoreClientPort) {
    self.client = client
  }

  deinit {
    chatTask?.cancel()
    monitoringTask?.cancel()
  }

  public func startMonitoring(retryInterval: Duration = .seconds(10)) {
    monitoringTask?.cancel()
    monitoringTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: retryInterval)
        guard let self, !self.isResponding else {
          continue
        }
        if case .offline = self.connectionState {
          await self.refresh()
        }
      }
    }
  }

  public func stopMonitoring() {
    monitoringTask?.cancel()
    monitoringTask = nil
  }

  public func refresh() async {
    connectionState = .checking
    do {
      let status = try await client.status()
      switch status.state {
      case .ready:
        connectionState = .ready(version: status.version)
      case .sealed(let reason):
        connectionState = .sealed(reason: reason)
      }
    } catch {
      connectionState = .offline(message: userFacingMessage(error))
    }
  }

  public func send(_ value: String) {
    let message = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty, case .ready = connectionState, !isResponding else {
      return
    }

    let responseId = UUID()
    messages.append(PresenceMessage(role: .user, text: message))
    messages.append(PresenceMessage(id: responseId, role: .assistant, text: ""))
    isResponding = true

    chatTask = Task { [weak self, client] in
      do {
        for try await delta in client.streamChat(message: message, requestId: UUID()) {
          guard let self else {
            return
          }
          self.append(delta, to: responseId)
        }
        self?.finishResponse()
      } catch is CancellationError {
        self?.finishResponse()
      } catch {
        guard let self else {
          return
        }
        self.replaceResponse(responseId, with: userFacingMessage(error))
        self.connectionState = .offline(message: userFacingMessage(error))
        self.finishResponse()
      }
    }
  }

  public func stop() {
    chatTask?.cancel()
    chatTask = nil
    isResponding = false
  }

  private func append(_ delta: String, to responseId: UUID) {
    guard let index = messages.firstIndex(where: { $0.id == responseId }) else {
      return
    }
    messages[index].text += delta
  }

  private func finishResponse() {
    chatTask = nil
    isResponding = false
  }

  private func replaceResponse(_ responseId: UUID, with text: String) {
    guard let index = messages.firstIndex(where: { $0.id == responseId }) else {
      return
    }
    messages[index].text = text
  }
}

private func userFacingMessage(_ error: Error) -> String {
  switch error {
  case let error as DeviceTokenError:
    return error.errorDescription ?? "The Violet device token is unavailable."
  case let error as VioletCoreClientError:
    return error.errorDescription ?? "Violet Core is offline."
  case let error as RealtimeSessionClientError:
    return error.errorDescription ?? "The realtime session is unavailable."
  default:
    return "Violet Core is offline."
  }
}
