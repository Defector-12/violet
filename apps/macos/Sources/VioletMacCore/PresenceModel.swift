import Combine
import Foundation

public enum PresenceConnectionState: Equatable, Sendable {
  case checking
  case offline(message: String)
  case ready(version: String)
  case sealed(reason: String?)
}

public enum PresenceAudioState: Equatable, Sendable {
  case connecting
  case failed(message: String)
  case idle
  case listening
  case processing
  case unavailable(message: String)
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
  @Published public private(set) var audioState: PresenceAudioState = .idle
  @Published public private(set) var connectionState: PresenceConnectionState = .checking
  @Published public private(set) var isResponding = false
  @Published public private(set) var messages: [PresenceMessage] = []

  private let audioIO: any AudioIOPort
  private let client: any VioletCoreClientPort
  private let realtimeClient: (any RealtimeSessionClientPort)?
  private var audioFrameContinuation: AsyncStream<VioletAudioFrame>.Continuation?
  private var audioOutputFormat: VioletAudioFormat?
  private var audioResponseMessageId: UUID?
  private var audioSessionId: UUID?
  private var audioTask: Task<Void, Never>?
  private var audioTranscriptMessageId: UUID?
  private var chatTask: Task<Void, Never>?
  private var monitoringTask: Task<Void, Never>?

  public init(
    client: any VioletCoreClientPort,
    audioIO: any AudioIOPort = SilentAudioIO(),
    realtimeClient: (any RealtimeSessionClientPort)? = nil
  ) {
    self.audioIO = audioIO
    self.client = client
    self.realtimeClient = realtimeClient
  }

  deinit {
    audioTask?.cancel()
    chatTask?.cancel()
    monitoringTask?.cancel()
  }

  public var isAudioSessionActive: Bool {
    switch audioState {
    case .connecting, .listening, .processing:
      true
    case .failed, .idle, .unavailable:
      false
    }
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
    guard
      !message.isEmpty,
      case .ready = connectionState,
      !isResponding,
      !isAudioSessionActive
    else {
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

  public func toggleAudioSession() {
    switch audioState {
    case .idle, .failed, .unavailable:
      startAudioSession()
    case .processing:
      interruptAudioResponse()
    case .listening where audioIO.isPlaying:
      interruptAudioResponse()
    case .connecting, .listening:
      cancelAudioSession()
    }
  }

  public func startAudioSession() {
    guard
      case .ready = connectionState,
      !isResponding,
      !isAudioSessionActive
    else {
      return
    }
    guard let realtimeClient else {
      audioState = .unavailable(message: "Audio is unavailable.")
      return
    }

    let sessionId = UUID()
    audioSessionId = sessionId
    audioOutputFormat = nil
    audioResponseMessageId = nil
    audioTranscriptMessageId = nil
    audioState = .connecting
    audioTask = Task { [weak self, realtimeClient] in
      await realtimeClient.close()
      guard let self, self.audioSessionId == sessionId else {
        return
      }

      do {
        let capabilities = try await realtimeClient.connect()
        guard self.audioSessionId == sessionId else {
          await realtimeClient.close()
          return
        }
        guard
          capabilities.inputModalities.contains("audio"),
          capabilities.outputModalities.contains("audio"),
          capabilities.inputAudio
            == RealtimeAudioFormat(sampleRate: 16_000),
          let negotiatedOutput = capabilities.outputAudio,
          negotiatedOutput.channels == 1,
          negotiatedOutput.encoding == "pcm_s16le",
          negotiatedOutput.sampleRate == 24_000
        else {
          await realtimeClient.close()
          guard self.audioSessionId == sessionId else {
            return
          }
          self.finishAudioSession(
            state: .unavailable(message: "Audio is unavailable for this runtime.")
          )
          return
        }
        self.audioOutputFormat = VioletAudioFormat(
          sampleRate: Double(negotiatedOutput.sampleRate),
          channels: UInt32(negotiatedOutput.channels)
        )
        guard await self.audioIO.requestCaptureAccess() else {
          await realtimeClient.close()
          guard self.audioSessionId == sessionId else {
            return
          }
          self.finishAudioSession(
            state: .failed(message: "Microphone access was not granted.")
          )
          return
        }

        let (frames, continuation) = AsyncStream.makeStream(
          of: VioletAudioFrame.self,
          bufferingPolicy: .bufferingNewest(64)
        )
        self.audioFrameContinuation = continuation
        let events = await realtimeClient.streamAudio(frames)
        try self.audioIO.startCapture { frame in
          continuation.yield(frame)
        }
        self.audioState = .listening

        for try await event in events {
          guard self.audioSessionId == sessionId else {
            return
          }
          try self.handleAudioEvent(event)
        }

        await realtimeClient.close()
        guard self.audioSessionId == sessionId else {
          return
        }
        self.finishAudioSession(state: .idle)
      } catch is CancellationError {
        await realtimeClient.close()
        guard self.audioSessionId == sessionId else {
          return
        }
        self.finishAudioSession(state: .idle)
      } catch {
        await realtimeClient.close()
        guard self.audioSessionId == sessionId else {
          return
        }
        self.finishAudioSession(
          state: .failed(message: audioUserFacingMessage(error))
        )
      }
    }
  }

  public func finishAudioInput() {
    cancelAudioSession()
  }

  public func cancelAudioSession() {
    audioSessionId = nil
    audioFrameContinuation?.finish()
    audioFrameContinuation = nil
    audioTask?.cancel()
    audioTask = nil
    audioIO.stopCapture()
    audioIO.stopPlayback()
    audioOutputFormat = nil
    audioState = .idle
    if let realtimeClient {
      Task {
        await realtimeClient.close()
      }
    }
  }

  public func interruptAudioResponse() {
    guard audioState == .processing || audioIO.isPlaying else {
      return
    }
    audioIO.stopPlayback()
    audioResponseMessageId = nil
    audioState = .listening
    if let realtimeClient {
      Task {
        await realtimeClient.cancelResponse()
      }
    }
  }

  public func stop() {
    chatTask?.cancel()
    chatTask = nil
    isResponding = false
    cancelAudioSession()
  }

  private func handleAudioEvent(_ event: RealtimeServerEvent) throws {
    switch event {
    case .speechStarted:
      audioIO.stopPlayback()
      audioResponseMessageId = nil
      audioTranscriptMessageId = nil
      audioState = .listening
    case .speechStopped:
      audioState = .processing
    case .transcript(let text, _, _):
      if let audioTranscriptMessageId {
        replaceMessage(audioTranscriptMessageId, with: text)
      } else {
        let message = PresenceMessage(role: .user, text: text)
        audioTranscriptMessageId = message.id
        messages.append(message)
      }
    case .responseStarted:
      if audioResponseMessageId == nil {
        let message = PresenceMessage(role: .assistant, text: "")
        audioResponseMessageId = message.id
        messages.append(message)
      }
    case .responseText(_, let text, _):
      if let audioResponseMessageId {
        append(text, to: audioResponseMessageId)
      } else {
        let message = PresenceMessage(role: .assistant, text: text)
        audioResponseMessageId = message.id
        messages.append(message)
      }
    case .responseAudio(_, let audio, _):
      guard let audioOutputFormat else {
        throw RealtimeSessionClientError.invalidEvent
      }
      try audioIO.play(
        VioletAudioFrame(
          data: audio,
          format: audioOutputFormat
        )
      )
    case .error(let code, let message, let retryable):
      throw RealtimeSessionClientError.server(
        code: code,
        message: message,
        retryable: retryable
      )
    case .responseCompleted:
      audioResponseMessageId = nil
      audioTranscriptMessageId = nil
      audioState = .listening
    case .responseCancelled:
      audioResponseMessageId = nil
      audioState = .listening
    case .ready:
      break
    }
  }

  private func finishAudioSession(state: PresenceAudioState) {
    audioIO.stopCapture()
    audioIO.stopPlayback()
    audioFrameContinuation?.finish()
    audioFrameContinuation = nil
    audioSessionId = nil
    audioOutputFormat = nil
    audioTask = nil
    audioState = state
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
    replaceMessage(responseId, with: text)
  }

  private func replaceMessage(_ messageId: UUID, with text: String) {
    guard let index = messages.firstIndex(where: { $0.id == messageId }) else {
      return
    }
    messages[index].text = text
  }
}

private func audioUserFacingMessage(_ error: Error) -> String {
  if error is AudioIOError {
    return "The microphone is unavailable."
  }
  return userFacingMessage(error)
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
