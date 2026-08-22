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
  private var model: PresenceModel?
  private var portForwarder: (any PortForwarderPort)?
  private var statusController: StatusItemController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let dependencies:
      (
        configuration: VioletRuntimeConfiguration,
        client: any VioletCoreClientPort,
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
        nil
      )
    }

    let audioIO: any AudioIOPort =
      dependencies.configuration.testMode
      ? SilentAudioIO()
      : AVAudioEngineIO()
    let model = PresenceModel(
      client: dependencies.client,
      audioIO: audioIO,
      realtimeClient: dependencies.realtimeClient
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

    self.model = model
    self.portForwarder = portForwarder
    statusController = StatusItemController(
      model: model,
      shortcut: shortcut
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
    model?.stop()
    model?.stopMonitoring()
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
    model?.stop()
  }

  @objc
  private func resumeAfterSystemActivity() {
    try? portForwarder?.start()
    Task {
      await model?.refresh()
    }
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
