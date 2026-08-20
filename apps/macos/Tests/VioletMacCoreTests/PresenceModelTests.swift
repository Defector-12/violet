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
  func silentAdaptersHaveNoDeviceSideEffects() {
    let audio = SilentAudioIO()
    let shortcut = SilentGlobalShortcut()

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
