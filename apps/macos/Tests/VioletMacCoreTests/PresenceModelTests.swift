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
  func streamsUserStartedAudioAndRendersRealtimeOutput() async throws {
    let turnId = UUID()
    let responseId = UUID()
    let outputAudio = Data([0, 0])
    let audio = FakeAudioIO()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .transcript(text: "Hello Violet", final: true, turnId: turnId),
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
    model.finishAudioInput()
    try await waitUntil { model.audioState == .idle }

    #expect(await realtime.receivedFrames() == [inputFrame])
    #expect(audio.captureAccessRequestCount == 1)
    #expect(audio.startCaptureCount == 1)
    #expect(audio.stopCaptureCount >= 1)
    #expect(audio.playedFrames.map(\.data) == [outputAudio])
    #expect(audio.playedFrames.map(\.format) == [VioletAudioFormat(sampleRate: 24_000)])
    #expect(model.messages.map(\.text) == ["Hello Violet", "Hello"])
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
    let realtime = FakeRealtimeSessionClient(capabilities: audioCapabilities)
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      realtimeClient: realtime
    )
    await model.refresh()
    model.startAudioSession()
    try await waitUntil { model.audioState == .listening }

    model.cancelAudioSession()

    #expect(model.audioState == .idle)
    #expect(!audio.isCapturing)
    #expect(audio.stopCaptureCount >= 1)
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

    #expect(
      try decodeRealtimeServerEvent(ready)
        == .ready(
          .init(
            inputModalities: ["text"],
            interruption: true,
            outputModalities: ["text"],
            runtimeKind: "deterministic",
            transcription: false,
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
  private(set) var captureAccessRequestCount = 0
  private(set) var isCapturing = false
  private(set) var playedFrames: [VioletAudioFrame] = []
  private(set) var startCaptureCount = 0
  private(set) var stopCaptureCount = 0

  init(captureAccessGranted: Bool = true) {
    self.captureAccessGranted = captureAccessGranted
  }

  func emit(_ frame: VioletAudioFrame) {
    captureHandler?(frame)
  }

  func play(_ frame: VioletAudioFrame) {
    playedFrames.append(frame)
  }

  func requestCaptureAccess() async -> Bool {
    captureAccessRequestCount += 1
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

  func stopPlayback() {}
}

private actor FakeRealtimeSessionClient: RealtimeSessionClientPort {
  let capabilities: RealtimeCapabilities
  let events: [RealtimeServerEvent]
  private var frames: [VioletAudioFrame] = []

  init(
    capabilities: RealtimeCapabilities,
    events: [RealtimeServerEvent] = []
  ) {
    self.capabilities = capabilities
    self.events = events
  }

  func close() async {}

  func connect() async throws -> RealtimeCapabilities {
    capabilities
  }

  func receivedFrames() -> [VioletAudioFrame] {
    frames
  }

  func streamAudio(
    _ frames: AsyncStream<VioletAudioFrame>
  ) async -> AsyncThrowingStream<RealtimeServerEvent, Error> {
    let events = self.events
    return AsyncThrowingStream { continuation in
      Task {
        for await frame in frames {
          self.record(frame)
        }
        for event in events {
          continuation.yield(event)
        }
        continuation.finish()
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

private let audioCapabilities = RealtimeCapabilities(
  inputAudio: .init(sampleRate: 16_000),
  inputModalities: ["audio", "text"],
  interruption: false,
  outputAudio: .init(sampleRate: 24_000),
  outputModalities: ["audio", "text"],
  runtimeKind: "integrated",
  transcription: true,
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
  case timeout
}
