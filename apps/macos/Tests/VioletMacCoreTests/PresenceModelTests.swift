import Foundation
import Testing

@testable import VioletMacCore

@Suite("Presence model")
struct PresenceModelTests {
  @Test
  @MainActor
  func refreshesReadyAndSealedStates() async {
    let ready = PresenceModel(
      client: FakeCoreClient(
        statusValue: .init(state: .ready, version: "1.0.0")
      )
    )
    let sealed = PresenceModel(
      client: FakeCoreClient(
        statusValue: .init(state: .sealed(reason: "missing key"), version: "1.0.0")
      )
    )

    await ready.refresh()
    await sealed.refresh()

    #expect(ready.connectionState == .ready(version: "1.0.0"))
    #expect(sealed.connectionState == .sealed(reason: "missing key"))
  }

  @Test
  @MainActor
  func streamsTextIntoOneAssistantMessage() async throws {
    let model = PresenceModel(
      client: FakeCoreClient(
        statusValue: .init(state: .ready, version: "1.0.0"),
        deltas: ["Hello", " from Violet"]
      )
    )
    await model.refresh()

    model.send("Hi")
    try await waitUntil { !model.isResponding }

    #expect(model.messages.count == 2)
    #expect(model.messages[0].role == .user)
    #expect(model.messages[0].text == "Hi")
    #expect(model.messages[1].role == .assistant)
    #expect(model.messages[1].text == "Hello from Violet")
  }

  @Test
  @MainActor
  func silentAdaptersHaveNoDeviceSideEffects() async {
    let audio = SilentAudioIO()
    let shortcut = SilentGlobalShortcut()

    #expect(await audio.requestCaptureAccess())
    audio.startCapture { _ in }
    shortcut.start {}
    audio.play(
      VioletAudioFrame(
        data: Data([0, 0]),
        format: VioletAudioFormat(sampleRate: 16_000)
      )
    )
    audio.stopCapture()
    audio.stopPlayback()
    shortcut.stop()

    #expect(!audio.isCapturing)
    #expect(audio.playedFrameCount == 1)
    #expect(shortcut.startCount == 1)
  }

  @Test
  @MainActor
  func refusesCaptureWhenRuntimeDoesNotSupportAudio() async throws {
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: .init(
        inputModalities: ["text"],
        interruption: true,
        outputModalities: ["text"],
        runtimeKind: "deterministic",
        transcription: false,
        turnDetection: "manual",
        voiceKind: "none"
      )
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil {
      model.audioState
        == .unavailable(message: "Audio is unavailable for this runtime.")
    }

    #expect(audio.captureAccessRequestCount == 0)
    #expect(audio.startCaptureCount == 0)
    #expect(!audio.isCapturing)
  }

  @Test
  @MainActor
  func refusesCaptureWhenMicrophoneAccessIsDenied() async throws {
    let audio = FakeAudioIO(captureAccessGranted: false)
    let realtime = FakeRealtimeSessionClient(capabilities: audioCapabilities)
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil {
      model.audioState
        == .failed(message: "Microphone access was not granted.")
    }

    #expect(audio.captureAccessRequestCount == 1)
    #expect(audio.startCaptureCount == 0)
    #expect(!audio.isCapturing)
  }

  @Test
  @MainActor
  func streamsContinuousAudioAndRendersRealtimeOutput() async throws {
    let turnId = UUID()
    let responseId = UUID()
    let outputAudio = Data([0, 0])
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: turnId),
        .transcript(text: "Hello Violet", final: true, turnId: turnId),
        .speechStopped(turnId: turnId),
        .responseStarted(responseId: responseId, turnId: turnId),
        .responseText(responseId: responseId, text: "Hello", turnId: turnId),
        .responseAudio(responseId: responseId, audio: outputAudio, turnId: turnId),
        .responseCompleted(responseId: responseId, turnId: turnId),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    let inputFrame = VioletAudioFrame(
      data: Data([1, 2]),
      format: VioletAudioFormat(sampleRate: 16_000)
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil { model.audioState == .listening }
    audio.emit(inputFrame)
    try await waitUntil { model.messages.count == 2 && !audio.playedFrames.isEmpty }

    #expect(await realtime.receivedFrames() == [inputFrame])
    #expect(audio.captureAccessRequestCount == 1)
    #expect(audio.startCaptureCount == 1)
    #expect(audio.preparedPlaybackFormats == [VioletAudioFormat(sampleRate: 24_000)])
    #expect(audio.playedFrames.map(\.data) == [outputAudio])
    #expect(audio.playedFrames.map(\.format) == [VioletAudioFormat(sampleRate: 24_000)])
    #expect(model.messages.map(\.text) == ["Hello Violet", "Hello"])
    #expect(model.audioState == .listening)

    audio.finishPlayback()
    model.toggleAudioSession()
    #expect(model.audioState == .idle)
    #expect(audio.stopCaptureCount >= 1)
  }

  @Test
  @MainActor
  func keepsOneAudioSessionAcrossTurnsAndStopsPlaybackOnBargeIn() async throws {
    let firstTurnId = UUID()
    let firstResponseId = UUID()
    let secondTurnId = UUID()
    let secondResponseId = UUID()
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: firstTurnId),
        .transcript(text: "First question", final: true, turnId: firstTurnId),
        .speechStopped(turnId: firstTurnId),
        .responseStarted(responseId: firstResponseId, turnId: firstTurnId),
        .responseText(responseId: firstResponseId, text: "First answer", turnId: firstTurnId),
        .responseAudio(responseId: firstResponseId, audio: Data([0, 0]), turnId: firstTurnId),
        .speechStarted(turnId: secondTurnId),
        .responseCancelled(responseId: firstResponseId),
        .transcript(text: "Second question", final: true, turnId: secondTurnId),
        .speechStopped(turnId: secondTurnId),
        .responseStarted(responseId: secondResponseId, turnId: secondTurnId),
        .responseText(responseId: secondResponseId, text: "Second answer", turnId: secondTurnId),
        .responseCompleted(responseId: secondResponseId, turnId: secondTurnId),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil { model.messages.count == 4 }

    #expect(await realtime.connectCount == 1)
    #expect(audio.stopPlaybackCount == 2)
    #expect(
      model.messages.map(\.text) == [
        "First question",
        "First answer",
        "Second question",
        "Second answer",
      ])
    #expect(model.audioState == .listening)

    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func lateCancellationCannotResetOrReplayAnOlderResponse() async throws {
    let firstTurnId = UUID()
    let firstResponseId = UUID()
    let secondTurnId = UUID()
    let secondResponseId = UUID()
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: firstTurnId),
        .speechStopped(turnId: firstTurnId),
        .responseStarted(responseId: firstResponseId, turnId: firstTurnId),
        .responseAudio(responseId: firstResponseId, audio: Data([1, 0]), turnId: firstTurnId),
        .speechStarted(turnId: secondTurnId),
        .speechStopped(turnId: secondTurnId),
        .responseStarted(responseId: secondResponseId, turnId: secondTurnId),
        .responseCancelled(responseId: firstResponseId),
        .responseText(responseId: firstResponseId, text: "late", turnId: firstTurnId),
        .responseAudio(responseId: firstResponseId, audio: Data([2, 0]), turnId: firstTurnId),
        .responseText(responseId: secondResponseId, text: "Second answer", turnId: secondTurnId),
        .responseAudio(responseId: secondResponseId, audio: Data([3, 0]), turnId: secondTurnId),
        .responseCompleted(responseId: secondResponseId, turnId: secondTurnId),
      ],
      eventInterval: .milliseconds(2)
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil {
      model.messages.last?.text == "Second answer"
        && audio.playedFrames.count == 2
        && model.audioState == .listening
    }

    #expect(model.messages.map(\.text) == ["", "Second answer"])
    #expect(audio.playedFrames.map(\.data) == [Data([1, 0]), Data([3, 0])])
    #expect(model.audioState == .listening)
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func clickingDuringAResponseInterruptsWithoutClosingTheSession() async throws {
    let turnId = UUID()
    let responseId = UUID()
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: turnId),
        .speechStopped(turnId: turnId),
        .responseStarted(responseId: responseId, turnId: turnId),
        .responseAudio(responseId: responseId, audio: Data([0, 0]), turnId: turnId),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()
    model.startAudioSession()
    try await waitUntil { model.audioState == .processing && !audio.playedFrames.isEmpty }

    model.toggleAudioSession()
    try await Task.sleep(for: .milliseconds(20))

    #expect(model.audioState == .listening)
    #expect(audio.stopPlaybackCount >= 2)
    #expect(await realtime.connectCount == 1)
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func localSpeechInterruptsPlaybackWithoutWaitingForServerVad() async throws {
    let turnId = UUID()
    let responseId = UUID()
    let audio = FakeAudioIO()
    let acceptance = FakeAcceptanceRecorder()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: turnId),
        .speechStopped(turnId: turnId),
        .responseStarted(responseId: responseId, turnId: turnId),
        .responseAudio(responseId: responseId, audio: Data([0, 0]), turnId: turnId),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime,
      acceptanceRecorder: acceptance
    )
    let voicedFrame = VioletAudioFrame(
      data: Data([0xD0, 0x07, 0xD0, 0x07]),
      format: VioletAudioFormat(sampleRate: 16_000)
    )
    await model.refresh()
    model.startAudioSession()
    try await waitUntil { model.audioState == .processing && audio.isPlaying }

    audio.emit(voicedFrame)
    audio.emit(voicedFrame)
    try await Task.sleep(for: .milliseconds(30))

    #expect(model.audioState == .listening)
    #expect(!audio.isPlaying)
    #expect(await realtime.cancelResponseCount == 1)
    #expect(
      acceptance.marks
        .filter { $0.reason == .localSpeech }
        .map(\.type)
        == [.interruptionDetected, .playbackStopped]
    )
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func refusesCaptureWhenNegotiatedAudioFormatIsUnsupported() async throws {
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: .init(
        inputAudio: .init(sampleRate: 16_000),
        inputModalities: ["audio", "text"],
        interruption: false,
        outputAudio: .init(sampleRate: 16_000),
        outputModalities: ["audio", "text"],
        runtimeKind: "integrated",
        transcription: true,
        voiceKind: "preset"
      )
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil {
      model.audioState
        == .unavailable(message: "Audio is unavailable for this runtime.")
    }

    #expect(audio.captureAccessRequestCount == 0)
    #expect(audio.startCaptureCount == 0)
  }

  @Test
  @MainActor
  func cancellingAudioSessionStopsCaptureImmediately() async throws {
    let audio = FakeAudioIO()
    let acceptance = FakeAcceptanceRecorder()
    let realtime = FakeRealtimeSessionClient(capabilities: audioCapabilities)
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime,
      acceptanceRecorder: acceptance
    )
    await model.refresh()
    model.startAudioSession()
    try await waitUntil { model.audioState == .listening }

    model.cancelAudioSession()

    #expect(model.audioState == .idle)
    #expect(!audio.isCapturing)
    #expect(audio.stopCaptureCount >= 1)
    #expect(
      acceptance.marks
        .filter { $0.reason == .userStop }
        .map(\.type)
        == [.sessionStopRequested, .captureStopped, .sessionEnded]
    )
  }

  @Test
  @MainActor
  func cancellingWhileCaptureAccessIsPendingDoesNotStartCapture() async throws {
    let audio = FakeAudioIO(captureAccessDelay: .milliseconds(100))
    let realtime = FakeRealtimeSessionClient(capabilities: audioCapabilities)
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()
    model.startAudioSession()
    try await waitUntil { audio.captureAccessRequestCount == 1 }

    model.cancelAudioSession()
    try await Task.sleep(for: .milliseconds(120))

    #expect(model.audioState == .idle)
    #expect(audio.startCaptureCount == 0)
  }

  @Test
  @MainActor
  func canRestartAfterRealtimeStreamFailure() async throws {
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      streamFailureCount: 1
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntil {
      if case .failed = model.audioState {
        return true
      }
      return false
    }

    #expect(!audio.isCapturing)
    #expect(audio.stopCaptureCount >= 1)

    model.startAudioSession()
    try await waitUntil { model.audioState == .listening }

    #expect(await realtime.connectCount == 2)
    #expect(audio.isCapturing)
    model.cancelAudioSession()
  }

  @Test
  func decodesProviderNeutralRealtimeEvents() throws {
    let sessionId = UUID()
    let turnId = UUID()
    let responseId = UUID()
    let ready = Data(
      """
      {
        "capabilities": {
          "inputModalities": ["text"],
          "interruption": true,
          "outputModalities": ["text"],
          "runtimeKind": "deterministic",
          "transcription": false,
          "turnDetection": "manual",
          "voiceKind": "none"
        },
        "eventId": "\(UUID())",
        "sequence": 1,
        "sessionId": "\(sessionId)",
        "type": "session.ready"
      }
      """.utf8
    )
    let text = Data(
      """
      {
        "eventId": "\(UUID())",
        "responseId": "\(responseId)",
        "sequence": 2,
        "sessionId": "\(sessionId)",
        "text": "Hello",
        "turnId": "\(turnId)",
        "type": "response.text"
      }
      """.utf8
    )
    let speechStarted = Data(
      """
      {
        "eventId": "\(UUID())",
        "sequence": 3,
        "sessionId": "\(sessionId)",
        "turnId": "\(turnId)",
        "type": "input.speech.started"
      }
      """.utf8
    )

    #expect(
      try decodeRealtimeServerEvent(ready)
        == .ready(
          .init(
            inputModalities: ["text"],
            interruption: true,
            outputModalities: ["text"],
            runtimeKind: "deterministic",
            transcription: false,
            turnDetection: "manual",
            voiceKind: "none"
          )
        )
    )
    #expect(
      try decodeRealtimeServerEvent(text)
        == .responseText(
          responseId: responseId,
          text: "Hello",
          turnId: turnId
        )
    )
    #expect(
      try decodeRealtimeServerEvent(speechStarted)
        == .speechStarted(turnId: turnId)
    )
  }

  @Test
  func rejectsInvalidDeviceTokensBeforeKeychainAccess() {
    #expect(throws: DeviceTokenError.invalidValue) {
      try KeychainDeviceTokenProvider().store(deviceToken: "short")
    }
  }

  @Test
  @MainActor
  func configuresTunnelAndKeepsTestForwardingSilent() throws {
    let configuration = try VioletRuntimeConfiguration(
      environment: [
        "VIOLET_CORE_URL": "http://127.0.0.1:14310",
        "VIOLET_SSH_HOST": "violet-devbox",
        "VIOLET_TEST_MODE": "1",
      ],
      configurationFileURL: URL(fileURLWithPath: "/does-not-exist")
    )
    let forwarder = SilentPortForwarder()

    forwarder.start()
    forwarder.stop()

    #expect(configuration.sshTunnel?.host == "violet-devbox")
    #expect(configuration.testMode)
    #expect(forwarder.startCount == 1)
    #expect(forwarder.stopCount == 1)
  }

  @Test
  @MainActor
  func hidesUnknownTransportDetailsFromOfflineStatus() async {
    let model = PresenceModel(client: FailingCoreClient())

    await model.refresh()

    #expect(model.connectionState == .offline(message: "Violet Core is offline."))
  }
}

private struct FakeCoreClient: VioletCoreClientPort {
  let statusValue: VioletCoreStatus
  var deltas: [String] = []

  func status() async throws -> VioletCoreStatus {
    statusValue
  }

  func streamChat(
    message: String,
    requestId: UUID
  ) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      for delta in deltas {
        continuation.yield(delta)
      }
      continuation.finish()
    }
  }
}

private struct FailingCoreClient: VioletCoreClientPort {
  func status() async throws -> VioletCoreStatus {
    throw URLError(.cannotConnectToHost)
  }

  func streamChat(
    message: String,
    requestId: UUID
  ) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      continuation.finish(throwing: URLError(.cannotConnectToHost))
    }
  }
}

@MainActor
private final class FakeAudioIO: AudioIOPort {
  private var captureHandler: (@Sendable (VioletAudioFrame) -> Void)?
  let captureAccessGranted: Bool
  let captureAccessDelay: Duration?
  private(set) var captureAccessRequestCount = 0
  private(set) var isCapturing = false
  private(set) var isPlaying = false
  private(set) var playedFrames: [VioletAudioFrame] = []
  private(set) var preparedPlaybackFormats: [VioletAudioFormat] = []
  private(set) var startCaptureCount = 0
  private(set) var stopCaptureCount = 0
  private(set) var stopPlaybackCount = 0

  init(
    captureAccessGranted: Bool = true,
    captureAccessDelay: Duration? = nil
  ) {
    self.captureAccessGranted = captureAccessGranted
    self.captureAccessDelay = captureAccessDelay
  }

  func emit(_ frame: VioletAudioFrame) {
    captureHandler?(frame)
  }

  func finishPlayback() {
    isPlaying = false
  }

  func play(_ frame: VioletAudioFrame) {
    isPlaying = true
    playedFrames.append(frame)
  }

  func preparePlayback(format: VioletAudioFormat) {
    preparedPlaybackFormats.append(format)
  }

  func requestCaptureAccess() async -> Bool {
    captureAccessRequestCount += 1
    if let captureAccessDelay {
      try? await Task.sleep(for: captureAccessDelay)
    }
    return captureAccessGranted
  }

  func startCapture(handler: @escaping @Sendable (VioletAudioFrame) -> Void) {
    captureHandler = handler
    isCapturing = true
    startCaptureCount += 1
  }

  func stopCapture() {
    captureHandler = nil
    isCapturing = false
    stopCaptureCount += 1
  }

  func stopPlayback() {
    isPlaying = false
    stopPlaybackCount += 1
  }
}

private actor FakeRealtimeSessionClient: RealtimeSessionClientPort {
  let capabilities: RealtimeCapabilities
  let eventInterval: Duration
  let events: [RealtimeServerEvent]
  private(set) var cancelResponseCount = 0
  private(set) var connectCount = 0
  private var frames: [VioletAudioFrame] = []
  private var streamFailureCount: Int

  init(
    capabilities: RealtimeCapabilities,
    events: [RealtimeServerEvent] = [],
    eventInterval: Duration = .zero,
    streamFailureCount: Int = 0
  ) {
    self.capabilities = capabilities
    self.eventInterval = eventInterval
    self.events = events
    self.streamFailureCount = streamFailureCount
  }

  func cancelResponse() async {
    cancelResponseCount += 1
  }

  func close() async {}

  func connect() async throws -> RealtimeCapabilities {
    connectCount += 1
    return capabilities
  }

  func receivedFrames() -> [VioletAudioFrame] {
    frames
  }

  func streamAudio(
    _ frames: AsyncStream<VioletAudioFrame>
  ) async -> AsyncThrowingStream<RealtimeServerEvent, Error> {
    let events = self.events
    let eventInterval = self.eventInterval
    let shouldFail = streamFailureCount > 0
    if shouldFail {
      streamFailureCount -= 1
    }
    return AsyncThrowingStream { continuation in
      let frameTask = Task {
        for await frame in frames {
          self.record(frame)
        }
      }
      let eventTask = Task {
        try? await Task.sleep(for: .milliseconds(10))
        for event in events {
          continuation.yield(event)
          try? await Task.sleep(for: eventInterval)
        }
        if shouldFail {
          continuation.finish(throwing: TestError.streamFailure)
        }
      }
      continuation.onTermination = { _ in
        frameTask.cancel()
        eventTask.cancel()
      }
    }
  }

  func streamText(_ text: String) async -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      continuation.finish()
    }
  }

  private func record(_ frame: VioletAudioFrame) {
    frames.append(frame)
  }
}

@MainActor
private final class FakeAcceptanceRecorder: RealtimeAcceptanceRecording {
  private(set) var marks: [RealtimeAcceptanceMark] = []

  func flush() {}

  func record(_ mark: RealtimeAcceptanceMark) {
    marks.append(mark)
  }
}

private let audioCapabilities = RealtimeCapabilities(
  inputAudio: .init(sampleRate: 16_000),
  inputModalities: ["audio", "text"],
  interruption: false,
  outputAudio: .init(sampleRate: 24_000),
  outputModalities: ["audio", "text"],
  runtimeKind: "integrated",
  transcription: true,
  turnDetection: "smart_turn",
  voiceKind: "preset"
)

@MainActor
private func waitUntil(
  timeout: Duration = .seconds(1),
  condition: @escaping @MainActor () -> Bool
) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: timeout)
  while !condition() {
    guard clock.now < deadline else {
      throw TestError.timeout
    }
    try await clock.sleep(for: .milliseconds(10))
  }
}

private enum TestError: Error {
  case streamFailure
  case timeout
}
