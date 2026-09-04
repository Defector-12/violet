import CoreAudio
import Foundation
import Testing

@testable import VioletMacCore

@Suite("Presence model")
struct PresenceModelTests {
  @Test
  func suppressesPlaybackCaptureOnlyForBuiltInOutput() {
    #expect(
      shouldSuppressCaptureDuringPlayback(
        outputTransportType: kAudioDeviceTransportTypeBuiltIn
      )
    )
    #expect(
      !shouldSuppressCaptureDuringPlayback(
        outputTransportType: kAudioDeviceTransportTypeBuiltIn,
        outputDataSource: headphoneOutputDataSource
      )
    )
    #expect(
      !shouldSuppressCaptureDuringPlayback(
        outputTransportType: kAudioDeviceTransportTypeBluetooth
      )
    )
    #expect(
      !shouldSuppressCaptureDuringPlayback(
        outputTransportType: nil
      )
    )
  }

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
  func explicitVoiceExitStopsCaptureAndClearsContext() async throws {
    let turnId = UUID()
    let audio = FakeAudioIO()
    let contextClient = FakeContextClient()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: turnId),
        .transcript(text: "Violet，结束对话。", final: true, turnId: turnId),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      contextCapture: FakeContextCapture(
        result: .text(appBundleId: "com.example.Reader", text: "Temporary context")
      ),
      contextClient: contextClient,
      realtimeClient: realtime
    )
    await model.refresh()
    model.captureContext(.selectedText)
    await model.waitForContextPreparation()

    model.startAudioSession()
    try await waitUntil {
      model.messages.map(\.text) == ["Violet，结束对话。"]
        && model.audioState == .idle
    }
    try await Task.sleep(for: .milliseconds(20))

    #expect(audio.stopCaptureCount >= 1)
    #expect(model.contextState == .idle)
    #expect(await contextClient.deletedSessionCount == 1)
    #expect(await realtime.connectCount == 1)
  }

  @Test
  @MainActor
  func modelIntentExitStopsCaptureAndClearsContext() async throws {
    let turnId = UUID()
    let responseId = UUID()
    let audio = FakeAudioIO()
    let contextClient = FakeContextClient()
    let recorder = FakeAcceptanceRecorder()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: turnId),
        .transcript(text: "拜拜，就先这样吧", final: true, turnId: turnId),
        .responseStarted(responseId: responseId, turnId: turnId),
        .responseText(responseId: responseId, text: "拜拜，下次见。", turnId: turnId),
        .responseAudio(responseId: responseId, audio: Data([0, 0]), turnId: turnId),
        .responseCompleted(responseId: responseId, turnId: turnId),
        .endRequested(turnId: turnId),
      ],
      eventInterval: .milliseconds(2)
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      contextCapture: FakeContextCapture(
        result: .text(appBundleId: "com.example.Reader", text: "Temporary context")
      ),
      contextClient: contextClient,
      realtimeClient: realtime,
      acceptanceRecorder: recorder
    )
    await model.refresh()
    model.captureContext(.selectedText)
    await model.waitForContextPreparation()

    model.startAudioSession()
    try await waitUntil {
      model.messages.map(\.text) == ["拜拜，就先这样吧", "拜拜，下次见。"]
        && model.audioState == .listening
        && audio.isPlaying
    }
    #expect(audio.isCapturing)
    audio.finishPlayback()
    try await waitUntil { model.audioState == .idle }
    try await Task.sleep(for: .milliseconds(20))

    #expect(!isConversationExitCommand("拜拜，就先这样吧"))
    #expect(audio.stopCaptureCount >= 1)
    #expect(model.contextState == .idle)
    #expect(await contextClient.deletedSessionCount == 1)
    #expect(
      recorder.marks.contains {
        $0.type == .sessionEnded && $0.reason == .modelIntent
      }
    )
  }

  @Test
  @MainActor
  func inactivityTimeoutStopsCaptureAndClearsContext() async throws {
    let audio = FakeAudioIO()
    let contextClient = FakeContextClient()
    let recorder = FakeAcceptanceRecorder()
    let realtime = FakeRealtimeSessionClient(capabilities: audioCapabilities)
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: audio,
      audioInactivityTimeout: .milliseconds(30),
      contextCapture: FakeContextCapture(
        result: .text(appBundleId: "com.example.Reader", text: "Temporary context")
      ),
      contextClient: contextClient,
      realtimeClient: realtime,
      acceptanceRecorder: recorder
    )
    await model.refresh()
    model.captureContext(.selectedText)
    await model.waitForContextPreparation()

    model.startAudioSession()
    try await waitUntil { audio.startCaptureCount == 1 }
    try await waitUntil { model.audioState == .idle }
    try await Task.sleep(for: .milliseconds(20))

    #expect(audio.stopCaptureCount >= 1)
    #expect(model.contextState == .idle)
    #expect(await contextClient.deletedSessionCount == 1)
    #expect(
      recorder.marks.contains {
        $0.type == .sessionEnded && $0.reason == .inactivityTimeout
      }
    )
  }

  @Test
  func matchesOnlyExplicitConversationExitCommands() {
    #expect(isConversationExitCommand("结束对话"))
    #expect(!isConversationExitCommand("Violet，先这样吧。"))
    #expect(!isConversationExitCommand("再见"))
    #expect(isConversationExitCommand("Stop listening"))
    #expect(!isConversationExitCommand("请解释如何实现结束对话功能"))
    #expect(!isConversationExitCommand("停止播放当前回复"))
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
  @MainActor
  func realtimeStreamFailureCancelsAnActiveContextCapture() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      captureDelays: [.milliseconds(50)],
      result: .text(appBundleId: "com.apple.Safari", text: "Late result")
    )
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
      ],
      streamFailureCount: 1
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons == [.cancelled] }

    #expect(await realtime.captureSuccessCount == 0)
    #expect(!model.isAudioSessionActive)
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
    let endRequested = Data(
      """
      {
        "eventId": "\(UUID())",
        "reason": "user_intent",
        "sequence": 4,
        "sessionId": "\(sessionId)",
        "turnId": "\(turnId)",
        "type": "session.end_requested"
      }
      """.utf8
    )
    let captureRequestId = UUID()
    let captureRequested = Data(
      """
      {
        "eventId": "\(UUID())",
        "expiresAt": "2026-08-31T12:00:00.000Z",
        "requestId": "\(captureRequestId)",
        "sequence": 5,
        "sessionId": "\(sessionId)",
        "turnId": "\(turnId)",
        "type": "context.capture.requested"
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
    #expect(
      try decodeRealtimeServerEvent(endRequested)
        == .endRequested(turnId: turnId)
    )
    #expect(
      try decodeRealtimeServerEvent(captureRequested)
        == .contextCaptureRequested(
          requestId: captureRequestId,
          turnId: turnId,
          expiresAt: Date(timeIntervalSince1970: 1_788_177_600)
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

  @Test
  @MainActor
  func reportsRegionSelectionBeforeContextProcessingCompletes() async throws {
    let capture = FakeContextCapture(
      result: .text(appBundleId: nil, text: "Selected region")
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      contextCapture: capture,
      contextClient: FakeContextClient()
    )
    let callbacks = ContextCallbackRecorder()
    model.onContextSelectionStarted = { kind in
      guard case .region = kind else {
        Issue.record("Expected Region selection")
        return
      }
      #expect(model.isSelectingContext)
      callbacks.events.append("selection-started")
    }
    model.onContextSelectionFinished = { kind in
      guard case .region = kind else {
        Issue.record("Expected Region selection")
        return
      }
      callbacks.events.append("selection-finished")
    }
    model.onContextProcessingFinished = {
      callbacks.events.append("processing-finished")
    }
    await model.refresh()

    model.captureContext(.region)
    try await waitUntil {
      if case .ready = model.contextState {
        return true
      }
      return false
    }

    #expect(
      callbacks.events
        == ["selection-started", "selection-finished", "processing-finished"]
    )
  }

  @Test
  @MainActor
  func capturesFiltersAndDeletesAnExplicitContextSession() async throws {
    let capture = FakeContextCapture(
      result: .text(
        appBundleId: "com.apple.Preview",
        text: "Read this ID: 11010519491231002X"
      )
    )
    let contextClient = FakeContextClient()
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      contextCapture: capture,
      contextClient: contextClient,
      contextPrivacyFilter: LocalContextPrivacyFilter(excludedBundleIds: []),
      deviceId: UUID()
    )
    await model.refresh()

    model.captureContext(.selectedText)
    try await waitUntil {
      if case .ready = model.contextState {
        return true
      }
      return false
    }

    let submitted = await contextClient.submittedContexts
    guard case .text(let text) = submitted.first?.payload else {
      Issue.record("Expected one text context")
      return
    }
    #expect(text == "Read this ID: [REDACTED]")
    #expect(capture.captureCount == 1)

    model.clearContext()
    try await Task.sleep(for: .milliseconds(20))
    #expect(await contextClient.deletedSessionCount == 1)
    #expect(model.contextState == .idle)
  }

  @Test
  @MainActor
  func deletesAContextAcceptedAfterItsSubmissionWasCancelled() async throws {
    let capture = FakeContextCapture(
      result: .text(appBundleId: "com.apple.Preview", text: "Transient")
    )
    let contextClient = FakeContextClient(submitDelay: .milliseconds(50))
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      contextCapture: capture,
      contextClient: contextClient
    )
    await model.refresh()

    model.captureContext(.selectedText)
    try await waitUntilAsync { await contextClient.submitStartedCount == 1 }
    model.clearContext()
    try await waitUntilAsync { await contextClient.deletedSessionCount == 1 }

    #expect(model.contextState == .idle)
    #expect(await contextClient.submittedContexts.count == 1)
  }

  @Test
  @MainActor
  func capturesNaturalPointingOnlyAfterRealtimeRequestsIt() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      result: .text(appBundleId: "com.apple.Safari", text: "Pointed article")
    )
    let requestId = UUID()
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStarted(turnId: turnId),
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: requestId,
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        )
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    #expect(!model.isNaturalPointingEnabled)
    #expect(capture.captureCount == 0)
    model.setNaturalPointingEnabled(true)
    #expect(defaults.bool(forKey: "violet.natural-pointing-enabled"))

    model.startAudioSession()
    try await waitUntil { model.audioState == .listening }
    try await waitUntilAsync { await realtime.captureSuccessCount == 1 }

    #expect(capture.capturedKinds == [.naturalPointing])
    #expect(capture.prepareNaturalPointingCaptureCount == 1)
    #expect(await realtime.captureSuccessCount == 1)
    #expect(await realtime.connectedOnDemandContextValues() == [true])
    #expect(await realtime.connectedContextSessionIds() == [nil])
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func refusesRealtimeContextCaptureWithoutMatchingTurnAnchor() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      result: .text(appBundleId: "com.apple.Safari", text: "Wrong turn")
    )
    let anchoredTurnId = UUID()
    let requestedTurnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: anchoredTurnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: requestedTurnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons == [.unavailable] }

    #expect(capture.prepareNaturalPointingCaptureCount == 1)
    #expect(capture.captureCount == 0)
    #expect(await realtime.captureSuccessCount == 0)
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func consumesANaturalPointingTurnAnchorOnlyOnce() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      result: .text(appBundleId: "com.apple.Safari", text: "Pointed article")
    )
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync {
      let successCount = await realtime.captureSuccessCount
      let failureReasons = await realtime.captureFailureReasons
      return successCount == 1 && failureReasons == [.unavailable]
    }

    #expect(capture.prepareNaturalPointingCaptureCount == 1)
    #expect(capture.captureCount == 1)
    #expect(await realtime.captureSuccessCount == 1)
    #expect(await realtime.captureFailureReasons == [.unavailable])
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func refusesRealtimeContextCaptureWhenTheTurnTargetCannotBePrepared() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      canPrepareNaturalPointingCapture: false,
      result: .text(appBundleId: "com.apple.Safari", text: "Unanchored")
    )
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons == [.unavailable] }

    #expect(capture.captureCount == 0)
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func refusesRealtimeContextCaptureAfterTheTurnAnchorExpires() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      result: .text(appBundleId: "com.apple.Safari", text: "Stale")
    )
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      naturalPointingAnchorLifetime: .zero,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons == [.unavailable] }

    #expect(capture.captureCount == 0)
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func refusesRealtimeContextCaptureWhenTheAnchorExpiresDuringCapture() async throws {
    let defaults = isolatedPresenceDefaults()
    let capture = FakeContextCapture(
      captureDelays: [.milliseconds(30)],
      result: .text(appBundleId: "com.apple.Safari", text: "Expired during capture")
    )
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      naturalPointingAnchorLifetime: .milliseconds(10),
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons == [.cancelled] }

    #expect(capture.captureCount == 1)
    #expect(await realtime.captureSuccessCount == 0)
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func lateCancelledCaptureCannotDetachTheCurrentCaptureTask() async throws {
    let defaults = isolatedPresenceDefaults()
    let firstTurnId = UUID()
    let secondTurnId = UUID()
    let thirdTurnId = UUID()
    let capture = FakeContextCapture(
      captureDelays: [.milliseconds(55), .milliseconds(100)],
      result: .text(appBundleId: "com.apple.Safari", text: "Delayed")
    )
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: firstTurnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: firstTurnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
        .speechStarted(turnId: secondTurnId),
        .speechStopped(turnId: secondTurnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: secondTurnId,
          expiresAt: Date().addingTimeInterval(10)
        ),
        .transcript(text: "wait", final: false, turnId: secondTurnId),
        .transcript(text: "wait", final: false, turnId: secondTurnId),
        .transcript(text: "wait", final: false, turnId: secondTurnId),
        .speechStarted(turnId: thirdTurnId),
      ],
      eventInterval: .milliseconds(10)
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons.count == 2 }

    #expect(capture.captureCount == 2)
    #expect(await realtime.captureSuccessCount == 0)
    #expect(await realtime.captureFailureReasons == [.cancelled, .cancelled])
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func refusesRealtimeContextCaptureWhenLookIsDisabled() async throws {
    let capture = FakeContextCapture(
      result: .text(appBundleId: "com.apple.Safari", text: "Must not leave the device")
    )
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: UUID(),
          expiresAt: Date().addingTimeInterval(10)
        )
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: isolatedPresenceDefaults(),
      realtimeClient: realtime
    )
    await model.refresh()

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureFailureReasons == [.unavailable] }

    #expect(capture.captureCount == 0)
    #expect(await realtime.connectedOnDemandContextValues() == [false])
    #expect(await realtime.captureFailureReasons == [.unavailable])
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func stripsLocalOCRFromOnDemandImageEvidence() async throws {
    let turnId = UUID()
    let capture = FakeContextCapture(
      result: .image(
        appBundleId: "com.example.Editor",
        data: Data([0x01, 0x02, 0x03]),
        focusPoint: nil,
        height: 100,
        recognizedText: [
          .init(
            text: "Visible but not model evidence",
            confidence: 0.99,
            normalizedBounds: .init(x: 0.1, y: 0.1, width: 0.4, height: 0.1)
          )
        ],
        region: nil,
        width: 100
      )
    )
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: UUID(),
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        )
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: isolatedPresenceDefaults(),
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try await waitUntilAsync { await realtime.captureImageLocalTexts == [nil] }

    #expect(await realtime.captureImageLocalTexts == [nil])
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func reportsUnavailableAutomaticContextToRealtime() async {
    let defaults = isolatedPresenceDefaults()
    let capture = FailingContextCapture(error: ContextCaptureError.unavailable)
    let requestId = UUID()
    let turnId = UUID()
    let realtime = FakeRealtimeSessionClient(
      capabilities: audioCapabilities,
      events: [
        .speechStopped(turnId: turnId),
        .contextCaptureRequested(
          requestId: requestId,
          turnId: turnId,
          expiresAt: Date().addingTimeInterval(10)
        )
      ]
    )
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      audioIO: FakeAudioIO(),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: defaults,
      realtimeClient: realtime
    )
    await model.refresh()
    model.setNaturalPointingEnabled(true)

    model.startAudioSession()
    try? await waitUntilAsync { await realtime.captureFailureReasons == [.unavailable] }
    #expect(model.contextState == .idle)
    #expect(await realtime.captureFailureReasons == [.unavailable])
    model.cancelAudioSession()
  }

  @Test
  @MainActor
  func reportsUnavailableManualContextInTheUI() async {
    let capture = FailingContextCapture(error: ContextCaptureError.unavailable)
    let model = PresenceModel(
      client: FakeCoreClient(statusValue: .init(state: .ready, version: "test")),
      contextCapture: capture,
      contextClient: FakeContextClient(),
      defaults: isolatedPresenceDefaults()
    )
    await model.refresh()
    model.captureContext(.selectedText)
    await model.waitForContextPreparation()
    #expect(model.contextState == .failed(message: "No readable context is available."))
  }
}

@MainActor
private final class ContextCallbackRecorder {
  var events: [String] = []
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
private final class FakeContextCapture: ContextCapturePort {
  private let canPrepareNaturalPointingCapture: Bool
  private let captureDelays: [Duration]
  private let result: CapturedContext
  private(set) var captureCount = 0
  private(set) var capturedKinds: [ContextCaptureKind] = []
  private(set) var prepareNaturalPointingCaptureCount = 0

  init(
    canPrepareNaturalPointingCapture: Bool = true,
    captureDelays: [Duration] = [],
    result: CapturedContext
  ) {
    self.canPrepareNaturalPointingCapture = canPrepareNaturalPointingCapture
    self.captureDelays = captureDelays
    self.result = result
  }

  func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext {
    let index = captureCount
    captureCount += 1
    capturedKinds.append(kind)
    if captureDelays.indices.contains(index) {
      try? await Task.sleep(for: captureDelays[index])
    }
    return result
  }

  func cancel() {}

  func prepareNaturalPointingCapture() -> Bool {
    prepareNaturalPointingCaptureCount += 1
    return canPrepareNaturalPointingCapture
  }

  func prepareSelectedTextCapture() {}
}

@MainActor
private final class FailingContextCapture: ContextCapturePort {
  private let error: Error

  init(error: Error) {
    self.error = error
  }

  func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext {
    throw error
  }

  func cancel() {}

  func prepareNaturalPointingCapture() -> Bool {
    true
  }

  func prepareSelectedTextCapture() {}
}

private actor FakeContextClient: ContextClientPort {
  private(set) var deletedSessionCount = 0
  private(set) var submitStartedCount = 0
  private(set) var submittedContexts: [FilteredContext] = []
  private let submitDelay: Duration

  init(submitDelay: Duration = .zero) {
    self.submitDelay = submitDelay
  }

  func deleteContext(sessionId: UUID) async {
    deletedSessionCount += 1
  }

  func submitContext(
    _ context: FilteredContext,
    deviceId: UUID,
    sessionId: UUID
  ) async throws -> ContextReceipt {
    submitStartedCount += 1
    submittedContexts.append(context)
    try? await Task.sleep(for: submitDelay)
    return ContextReceipt(
      expiresAt: Date().addingTimeInterval(300),
      sessionId: sessionId
    )
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
  private(set) var captureFailureReasons: [RealtimeContextCaptureFailure] = []
  private(set) var captureImageLocalTexts: [String?] = []
  private(set) var captureSuccessCount = 0
  private(set) var connectCount = 0
  private var contextSessionIds: [UUID?] = []
  private var onDemandContextValues: [Bool] = []
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

  func connect(
    contextSessionId: UUID?,
    onDemandContext: Bool
  ) async throws -> RealtimeCapabilities {
    connectCount += 1
    contextSessionIds.append(contextSessionId)
    onDemandContextValues.append(onDemandContext)
    return capabilities
  }

  func connectedOnDemandContextValues() -> [Bool] {
    onDemandContextValues
  }

  func connectedContextSessionIds() -> [UUID?] {
    contextSessionIds
  }

  func sendContextCaptureResult(
    _ result: RealtimeContextCaptureResult,
    deviceId: UUID,
    requestId: UUID,
    turnId: UUID
  ) async throws {
    switch result {
    case .failed(let reason):
      captureFailureReasons.append(reason)
    case .succeeded(let context):
      captureSuccessCount += 1
      if case .image(_, _, _, let localText, _, _, _, _) = context.payload {
        captureImageLocalTexts.append(localText)
      }
    }
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

private func waitUntilAsync(
  timeout: Duration = .seconds(1),
  condition: @escaping @Sendable () async -> Bool
) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: timeout)
  while !(await condition()) {
    if clock.now >= deadline {
      throw TestError.timeout
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}

private func isolatedPresenceDefaults() -> UserDefaults {
  let name = "violet-presence-tests-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: name) ?? .standard
  defaults.removePersistentDomain(forName: name)
  return defaults
}
