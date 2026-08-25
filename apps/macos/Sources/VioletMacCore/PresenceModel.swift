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

public enum PresenceContextState: Equatable, Sendable {
  case blocked(message: String)
  case failed(message: String)
  case idle
  case ready(expiresAt: Date)
  case selecting
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
  @Published public private(set) var contextState: PresenceContextState = .idle
  @Published public private(set) var isResponding = false
  @Published public private(set) var messages: [PresenceMessage] = []

  private let acceptanceRecorder: any RealtimeAcceptanceRecording
  private let audioIO: any AudioIOPort
  private let client: any VioletCoreClientPort
  private let contextCapture: (any ContextCapturePort)?
  private let contextClient: (any ContextClientPort)?
  private let contextPrivacyFilter: any LocalContextPrivacyFiltering
  private let deviceId: UUID
  private let realtimeClient: (any RealtimeSessionClientPort)?
  private var activeContextSessionId: UUID?
  private var activeRealtimeResponseId: UUID?
  private var audioFrameContinuation: AsyncStream<VioletAudioFrame>.Continuation?
  private var audioOutputFormat: VioletAudioFormat?
  private var audioResponseMessageId: UUID?
  private var audioSessionId: UUID?
  private var audioTask: Task<Void, Never>?
  private var audioTranscriptMessageId: UUID?
  private var chatTask: Task<Void, Never>?
  private var contextExpiryTask: Task<Void, Never>?
  private var contextTask: Task<Void, Never>?
  private var ignoredRealtimeResponseIds = Set<UUID>()
  private var localBargeInFrameCount = 0
  private var monitoringTask: Task<Void, Never>?
  private var recordedAudioResponseIds = Set<UUID>()
  public var onAudioSessionEnded: (@MainActor @Sendable () -> Void)?
  public var onAudioSessionStarted: (@MainActor @Sendable () -> Void)?
  public var onContextSelectionFinished: (@MainActor @Sendable () -> Void)?
  public var onContextSelectionStarted: (@MainActor @Sendable () -> Void)?

  public init(
    client: any VioletCoreClientPort,
    audioIO: any AudioIOPort = SilentAudioIO(),
    contextCapture: (any ContextCapturePort)? = nil,
    contextClient: (any ContextClientPort)? = nil,
    contextPrivacyFilter: any LocalContextPrivacyFiltering = LocalContextPrivacyFilter(),
    deviceId: UUID = UUID(),
    realtimeClient: (any RealtimeSessionClientPort)? = nil,
    acceptanceRecorder: any RealtimeAcceptanceRecording =
      NoopRealtimeAcceptanceRecorder()
  ) {
    self.acceptanceRecorder = acceptanceRecorder
    self.audioIO = audioIO
    self.client = client
    self.contextCapture = contextCapture
    self.contextClient = contextClient
    self.contextPrivacyFilter = contextPrivacyFilter
    self.deviceId = deviceId
    self.realtimeClient = realtimeClient
  }

  deinit {
    audioTask?.cancel()
    chatTask?.cancel()
    contextExpiryTask?.cancel()
    contextTask?.cancel()
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

  public var isSelectingContext: Bool {
    contextState == .selecting
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
    let contextSessionId = activeContextSessionId

    chatTask = Task { [weak self, client] in
      do {
        for try await delta in client.streamChat(
          message: message,
          requestId: UUID(),
          contextSessionId: contextSessionId
        ) {
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

  public func captureContext(_ kind: ContextCaptureKind) {
    guard
      case .ready = connectionState,
      let contextCapture,
      let contextClient,
      !isSelectingContext
    else {
      return
    }

    cancelAudioSession(reason: .userStop)
    contextTask?.cancel()
    let previousContextSessionId = activeContextSessionId
    activeContextSessionId = nil
    onContextSelectionStarted?()
    contextState = .selecting
    contextTask = Task { [weak self, contextCapture, contextClient] in
      guard let self else {
        return
      }
      do {
        if let previous = previousContextSessionId {
          await contextClient.deleteContext(sessionId: previous)
        }
        let captured = try await contextCapture.capture(kind)
        try Task.checkCancellation()
        let filtered = try contextPrivacyFilter.filter(captured)
        let sessionId = UUID()
        let receipt = try await contextClient.submitContext(
          filtered,
          deviceId: deviceId,
          sessionId: sessionId
        )
        activeContextSessionId = receipt.sessionId
        contextState = .ready(expiresAt: receipt.expiresAt)
        scheduleContextExpiry(receipt)
      } catch is CancellationError {
        contextState = .idle
      } catch let error as LocalContextPrivacyError {
        contextState = .blocked(
          message: error.errorDescription ?? "Context was blocked by local policy."
        )
      } catch {
        contextState = .failed(message: contextUserFacingMessage(error))
      }
      contextTask = nil
      onContextSelectionFinished?()
    }
  }

  public func prepareSelectedTextCapture() {
    contextCapture?.prepareSelectedTextCapture()
  }

  public func clearContext() {
    contextCapture?.cancel()
    contextExpiryTask?.cancel()
    contextExpiryTask = nil
    contextTask?.cancel()
    contextTask = nil
    let sessionId = activeContextSessionId
    activeContextSessionId = nil
    contextState = .idle
    if let sessionId, let contextClient {
      Task {
        await contextClient.deleteContext(sessionId: sessionId)
      }
    }
  }

  private func scheduleContextExpiry(_ receipt: ContextReceipt) {
    contextExpiryTask?.cancel()
    let delay = max(0, receipt.expiresAt.timeIntervalSinceNow)
    contextExpiryTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else {
        return
      }
      self?.clearContext()
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
    onAudioSessionStarted?()
    audioSessionId = sessionId
    audioOutputFormat = nil
    audioResponseMessageId = nil
    audioTranscriptMessageId = nil
    activeRealtimeResponseId = nil
    ignoredRealtimeResponseIds.removeAll()
    localBargeInFrameCount = 0
    recordedAudioResponseIds.removeAll()
    audioState = .connecting
    acceptanceRecorder.record(
      .init(type: .sessionStartRequested, sessionId: sessionId)
    )
    audioTask = Task { [weak self, realtimeClient] in
      await realtimeClient.close()
      guard let self, self.audioSessionId == sessionId else {
        return
      }

      do {
        let capabilities = try await realtimeClient.connect(
          contextSessionId: self.activeContextSessionId
        )
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
            state: .unavailable(message: "Audio is unavailable for this runtime."),
            reason: .failure
          )
          return
        }
        let outputFormat = VioletAudioFormat(
          sampleRate: Double(negotiatedOutput.sampleRate),
          channels: UInt32(negotiatedOutput.channels)
        )
        self.audioOutputFormat = outputFormat
        try self.audioIO.preparePlayback(format: outputFormat)
        let captureAccessGranted = await self.audioIO.requestCaptureAccess()
        guard self.audioSessionId == sessionId else {
          await realtimeClient.close()
          return
        }
        guard captureAccessGranted else {
          await realtimeClient.close()
          guard self.audioSessionId == sessionId else {
            return
          }
          self.finishAudioSession(
            state: .failed(message: "Microphone access was not granted."),
            reason: .failure
          )
          return
        }

        let (frames, continuation) = AsyncStream.makeStream(
          of: VioletAudioFrame.self,
          bufferingPolicy: .bufferingNewest(64)
        )
        self.audioFrameContinuation = continuation
        let events = await realtimeClient.streamAudio(frames)
        try self.audioIO.startCapture { [weak self] frame in
          continuation.yield(frame)
          Task { @MainActor [weak self] in
            self?.observeLocalBargeIn(frame)
          }
        }
        self.audioState = .listening
        self.acceptanceRecorder.record(
          .init(type: .captureStarted, sessionId: sessionId)
        )

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
        self.finishAudioSession(state: .idle, reason: .streamEnded)
      } catch is CancellationError {
        await realtimeClient.close()
        guard self.audioSessionId == sessionId else {
          return
        }
        self.finishAudioSession(state: .idle, reason: .failure)
      } catch {
        await realtimeClient.close()
        guard self.audioSessionId == sessionId else {
          return
        }
        self.finishAudioSession(
          state: .failed(message: audioUserFacingMessage(error)),
          reason: .failure
        )
      }
    }
  }

  public func finishAudioInput() {
    cancelAudioSession()
  }

  public func cancelAudioSession(
    reason: RealtimeAcceptanceReason = .userStop
  ) {
    let sessionId = audioSessionId
    if let sessionId {
      acceptanceRecorder.record(
        .init(type: .sessionStopRequested, reason: reason, sessionId: sessionId)
      )
    }
    let wasCapturing = audioIO.isCapturing
    audioSessionId = nil
    audioFrameContinuation?.finish()
    audioFrameContinuation = nil
    audioTask?.cancel()
    audioTask = nil
    audioIO.stopCapture()
    audioIO.stopPlayback()
    if wasCapturing, let sessionId {
      acceptanceRecorder.record(
        .init(type: .captureStopped, reason: reason, sessionId: sessionId)
      )
    }
    audioOutputFormat = nil
    activeRealtimeResponseId = nil
    ignoredRealtimeResponseIds.removeAll()
    localBargeInFrameCount = 0
    recordedAudioResponseIds.removeAll()
    audioState = .idle
    if let sessionId {
      acceptanceRecorder.record(
        .init(type: .sessionEnded, reason: reason, sessionId: sessionId)
      )
      onAudioSessionEnded?()
    }
    if let realtimeClient {
      Task {
        await realtimeClient.close()
      }
    }
  }

  public func interruptAudioResponse() {
    interruptAudioResponse(reason: .userClick)
  }

  private func interruptAudioResponse(
    reason: RealtimeAcceptanceReason
  ) {
    guard audioState == .processing || audioIO.isPlaying else {
      return
    }
    let responseId = activeRealtimeResponseId
    let wasPlaying = audioIO.isPlaying
    if wasPlaying {
      acceptanceRecorder.record(
        .init(
          type: .interruptionDetected,
          reason: reason,
          sessionId: audioSessionId,
          responseId: responseId
        )
      )
    }
    if let activeRealtimeResponseId {
      ignoredRealtimeResponseIds.insert(activeRealtimeResponseId)
    }
    audioIO.stopPlayback()
    if wasPlaying {
      acceptanceRecorder.record(
        .init(
          type: .playbackStopped,
          reason: reason,
          sessionId: audioSessionId,
          responseId: responseId
        )
      )
    }
    audioResponseMessageId = nil
    localBargeInFrameCount = 0
    audioState = .listening
    if let realtimeClient {
      Task {
        await realtimeClient.cancelResponse()
      }
    }
  }

  public func stop(reason: RealtimeAcceptanceReason = .userStop) {
    chatTask?.cancel()
    chatTask = nil
    isResponding = false
    cancelAudioSession(reason: reason)
    if reason != .userStop {
      clearContext()
    }
  }

  private func handleAudioEvent(_ event: RealtimeServerEvent) throws {
    switch event {
    case .speechStarted(let turnId):
      let responseId = activeRealtimeResponseId
      let wasPlaying = audioIO.isPlaying
      if let responseId {
        ignoredRealtimeResponseIds.insert(responseId)
      }
      acceptanceRecorder.record(
        .init(type: .speechStarted, sessionId: audioSessionId, turnId: turnId)
      )
      if wasPlaying {
        acceptanceRecorder.record(
          .init(
            type: .interruptionDetected,
            reason: .serverSpeech,
            sessionId: audioSessionId,
            turnId: turnId,
            responseId: responseId
          )
        )
      }
      audioIO.stopPlayback()
      if wasPlaying {
        acceptanceRecorder.record(
          .init(
            type: .playbackStopped,
            reason: .serverSpeech,
            sessionId: audioSessionId,
            turnId: turnId,
            responseId: responseId
          )
        )
      }
      audioResponseMessageId = nil
      audioTranscriptMessageId = nil
      localBargeInFrameCount = 0
      audioState = .listening
    case .speechStopped(let turnId):
      acceptanceRecorder.record(
        .init(type: .speechStopped, sessionId: audioSessionId, turnId: turnId)
      )
      audioState = .processing
    case .transcript(let text, _, _):
      if let audioTranscriptMessageId {
        replaceMessage(audioTranscriptMessageId, with: text)
      } else {
        let message = PresenceMessage(role: .user, text: text)
        audioTranscriptMessageId = message.id
        messages.append(message)
      }
    case .responseStarted(let responseId, let turnId):
      activeRealtimeResponseId = responseId
      acceptanceRecorder.record(
        .init(
          type: .responseStarted,
          sessionId: audioSessionId,
          turnId: turnId,
          responseId: responseId
        )
      )
      if audioResponseMessageId == nil {
        let message = PresenceMessage(role: .assistant, text: "")
        audioResponseMessageId = message.id
        messages.append(message)
      }
    case .responseText(let responseId, let text, _):
      guard !ignoredRealtimeResponseIds.contains(responseId) else {
        return
      }
      if let audioResponseMessageId {
        append(text, to: audioResponseMessageId)
      } else {
        let message = PresenceMessage(role: .assistant, text: text)
        audioResponseMessageId = message.id
        messages.append(message)
      }
    case .responseAudio(let responseId, let audio, let turnId):
      guard !ignoredRealtimeResponseIds.contains(responseId) else {
        return
      }
      guard let audioOutputFormat else {
        throw RealtimeSessionClientError.invalidEvent
      }
      try audioIO.play(
        VioletAudioFrame(
          data: audio,
          format: audioOutputFormat
        )
      )
      acceptanceRecorder.record(
        .init(
          type: .responseAudioScheduled,
          sessionId: audioSessionId,
          turnId: turnId,
          responseId: responseId
        )
      )
      if recordedAudioResponseIds.insert(responseId).inserted {
        acceptanceRecorder.record(
          .init(
            type: .responseAudioStarted,
            sessionId: audioSessionId,
            turnId: turnId,
            responseId: responseId
          )
        )
      }
    case .error(let code, let message, let retryable):
      throw RealtimeSessionClientError.server(
        code: code,
        message: message,
        retryable: retryable
      )
    case .responseCompleted(let responseId, let turnId):
      acceptanceRecorder.record(
        .init(
          type: .responseCompleted,
          sessionId: audioSessionId,
          turnId: turnId,
          responseId: responseId
        )
      )
      if activeRealtimeResponseId == responseId {
        activeRealtimeResponseId = nil
        audioResponseMessageId = nil
        audioTranscriptMessageId = nil
        audioState = .listening
      }
    case .responseCancelled(let responseId):
      acceptanceRecorder.record(
        .init(type: .responseCancelled, sessionId: audioSessionId, responseId: responseId)
      )
      if activeRealtimeResponseId == responseId {
        activeRealtimeResponseId = nil
        audioResponseMessageId = nil
        audioState = .listening
      }
    case .ready:
      break
    }
  }

  private func finishAudioSession(
    state: PresenceAudioState,
    reason: RealtimeAcceptanceReason
  ) {
    let sessionId = audioSessionId
    let wasCapturing = audioIO.isCapturing
    audioIO.stopCapture()
    audioIO.stopPlayback()
    if wasCapturing, let sessionId {
      acceptanceRecorder.record(
        .init(type: .captureStopped, reason: reason, sessionId: sessionId)
      )
    }
    audioFrameContinuation?.finish()
    audioFrameContinuation = nil
    audioSessionId = nil
    audioOutputFormat = nil
    activeRealtimeResponseId = nil
    ignoredRealtimeResponseIds.removeAll()
    localBargeInFrameCount = 0
    recordedAudioResponseIds.removeAll()
    audioTask = nil
    audioState = state
    if let sessionId {
      acceptanceRecorder.record(
        .init(type: .sessionEnded, reason: reason, sessionId: sessionId)
      )
      onAudioSessionEnded?()
    }
  }

  private func observeLocalBargeIn(_ frame: VioletAudioFrame) {
    guard audioSessionId != nil, audioIO.isPlaying else {
      localBargeInFrameCount = 0
      return
    }
    let peak = frame.data.withUnsafeBytes { rawBuffer in
      rawBuffer.bindMemory(to: Int16.self).reduce(0) { current, sample in
        max(current, abs(Int(sample)))
      }
    }
    if peak >= 1_500 {
      localBargeInFrameCount += 1
    } else {
      localBargeInFrameCount = 0
    }
    guard localBargeInFrameCount >= 2 else {
      return
    }
    interruptAudioResponse(reason: .localSpeech)
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

private func contextUserFacingMessage(_ error: Error) -> String {
  if let error = error as? ContextCaptureError {
    return error.errorDescription ?? "Context capture failed."
  }
  if let error = error as? LocalContextPrivacyError {
    return error.errorDescription ?? "Context was blocked by local policy."
  }
  if let error = error as? VioletCoreClientError {
    return error.errorDescription ?? "Violet could not process this context."
  }
  return "Violet could not process this context."
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
