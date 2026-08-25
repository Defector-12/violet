import AppKit
import Foundation
import VioletMacCore

@main
enum VioletApplication {
  @MainActor
  static func main() {
    let application = NSApplication.shared
    let delegate = VioletApplicationDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    application.run()
  }
}

@MainActor
private final class VioletApplicationDelegate: NSObject, NSApplicationDelegate {
  private var acceptanceRecorder: (any RealtimeAcceptanceRecording)?
  private var model: PresenceModel?
  private var portForwarder: (any PortForwarderPort)?
  private var statusController: StatusItemController?
  private var wakeWord: WakeWordCoordinator?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let acceptanceRecorder = configuredRealtimeAcceptanceRecorder()
    let dependencies:
      (
        configuration: VioletRuntimeConfiguration,
        client: any VioletCoreClientPort,
        contextClient: any ContextClientPort,
        realtimeClient: (any RealtimeSessionClientPort)?
      )
    do {
      let configuration = try VioletRuntimeConfiguration()
      let token = try RuntimeDeviceTokenProvider().deviceToken()
      dependencies = (
        configuration,
        GeneratedVioletCoreClient(
          serverURL: configuration.coreURL,
          deviceToken: token
        ),
        configuration.testMode
          ? SilentContextClient()
          : URLSessionContextClient(
            coreURL: configuration.coreURL,
            deviceToken: token
          ),
        configuration.testMode
          ? nil
          : URLSessionRealtimeClient(
            coreURL: configuration.coreURL,
            deviceToken: token
          )
      )
    } catch {
      guard let fallbackURL = URL(string: "http://127.0.0.1:14310") else {
        NSApplication.shared.terminate(nil)
        return
      }
      dependencies = (
        VioletRuntimeConfiguration(
          coreURL: fallbackURL,
          testMode: true
        ),
        UnavailableCoreClient(error: error),
        SilentContextClient(),
        nil
      )
    }

    let audioIO: any AudioIOPort =
      dependencies.configuration.testMode
      ? SilentAudioIO()
      : AVAudioEngineIO()
    let contextCapture: any ContextCapturePort =
      dependencies.configuration.testMode
      ? SilentContextCapture()
      : SystemContextCapture(
        excludedBundleIds: defaultExcludedBundleIds.union(
          dependencies.configuration.excludedContextBundleIds
        )
      )
    let model = PresenceModel(
      client: dependencies.client,
      audioIO: audioIO,
      contextCapture: contextCapture,
      contextClient: dependencies.contextClient,
      contextPrivacyFilter: LocalContextPrivacyFilter(
        excludedBundleIds: defaultExcludedBundleIds.union(
          dependencies.configuration.excludedContextBundleIds
        )
      ),
      deviceId: LocalDeviceIdentity().deviceId(),
      realtimeClient: dependencies.realtimeClient,
      acceptanceRecorder: acceptanceRecorder
    )
    let shortcut: any GlobalShortcutPort =
      dependencies.configuration.testMode
      ? SilentGlobalShortcut()
      : CarbonGlobalShortcut()
    let portForwarder: any PortForwarderPort =
      dependencies.configuration.testMode
      ? SilentPortForwarder()
      : dependencies.configuration.sshTunnel.map(SSHPortForwarder.init)
        ?? SilentPortForwarder()
    let wakeDetector: any WakeWordDetectorPort =
      dependencies.configuration.testMode
      ? SilentWakeWordDetector()
      : SherpaWakeWordDetector(
        assetsURL: Bundle.main.resourceURL?
          .appendingPathComponent("WakeWord", isDirectory: true)
          ?? URL(fileURLWithPath: "/nonexistent")
      )
    let wakeWord = WakeWordCoordinator(detector: wakeDetector)

    self.model = model
    self.acceptanceRecorder = acceptanceRecorder
    self.portForwarder = portForwarder
    self.wakeWord = wakeWord
    statusController = StatusItemController(
      model: model,
      shortcut: shortcut,
      wakeWord: wakeWord,
      acceptanceRecorder: acceptanceRecorder
    )
    registerSystemLifecycleObservers()
    try? portForwarder.start()
    model.startMonitoring()
    Task {
      await model.refresh()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    NSWorkspace.shared.notificationCenter.removeObserver(self)
    model?.stop(reason: .appTermination)
    acceptanceRecorder?.flush()
    model?.stopMonitoring()
    wakeWord?.suspend()
    portForwarder?.stop()
    statusController?.stop()
  }

  private func registerSystemLifecycleObservers() {
    let center = NSWorkspace.shared.notificationCenter
    for name in [
      NSWorkspace.screensDidSleepNotification,
      NSWorkspace.sessionDidResignActiveNotification,
      NSWorkspace.willSleepNotification,
    ] {
      center.addObserver(
        self,
        selector: #selector(stopSensitiveActivity),
        name: name,
        object: nil
      )
    }
    for name in [
      NSWorkspace.didWakeNotification,
      NSWorkspace.screensDidWakeNotification,
      NSWorkspace.sessionDidBecomeActiveNotification,
    ] {
      center.addObserver(
        self,
        selector: #selector(resumeAfterSystemActivity),
        name: name,
        object: nil
      )
    }
  }

  @objc
  private func stopSensitiveActivity() {
    wakeWord?.suspend()
    model?.stop(reason: .systemLifecycle)
    acceptanceRecorder?.flush()
  }

  @objc
  private func resumeAfterSystemActivity() {
    try? portForwarder?.start()
    Task {
      await model?.refresh()
    }
    wakeWord?.resume()
  }
}

private struct UnavailableCoreClient: VioletCoreClientPort {
  let error: Error

  func status() async throws -> VioletCoreStatus {
    throw error
  }

  func streamChat(
    message: String,
    requestId: UUID
  ) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream { continuation in
      continuation.finish(throwing: error)
    }
  }
}
