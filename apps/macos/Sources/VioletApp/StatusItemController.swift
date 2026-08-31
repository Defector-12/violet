import AVFoundation
import AppKit
import SwiftUI
import VioletMacCore

@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
  private let acceptanceRecorder: any RealtimeAcceptanceRecording
  private let model: PresenceModel
  private var acknowledgement: AVAudioPlayer?
  private var isStopping = false
  private var outsideClickMonitor: Any?
  private var pendingTriggerId: UUID?
  private var wakeConversationPending = false
  private var wakeStartTask: Task<Void, Never>?
  private let popover = NSPopover()
  private let shortcut: any GlobalShortcutPort
  private let wakeWord: WakeWordCoordinator
  private let statusItem = NSStatusBar.system.statusItem(
    withLength: NSStatusItem.variableLength
  )

  init(
    model: PresenceModel,
    shortcut: any GlobalShortcutPort,
    wakeWord: WakeWordCoordinator,
    acceptanceRecorder: any RealtimeAcceptanceRecording
  ) {
    self.acceptanceRecorder = acceptanceRecorder
    self.model = model
    self.shortcut = shortcut
    self.wakeWord = wakeWord
    super.init()
    if let acknowledgementURL = Bundle.main.url(
      forResource: "wake-ack-longanqian",
      withExtension: "wav"
    ) {
      acknowledgement = try? AVAudioPlayer(contentsOf: acknowledgementURL)
      acknowledgement?.delegate = self
      acknowledgement?.prepareToPlay()
    }

    if let button = statusItem.button {
      button.image = NSImage(
        systemSymbolName: "sparkles",
        accessibilityDescription: "Violet"
      )
      button.target = self
      button.action = #selector(togglePopover)
    }

    popover.animates = false
    popover.behavior = .transient
    popover.delegate = self
    popover.contentSize = NSSize(width: 400, height: 520)
    popover.contentViewController = NSHostingController(
      rootView: PresenceView(model: model, wakeWord: wakeWord)
    )
    NSWorkspace.shared.notificationCenter.addObserver(
      self,
      selector: #selector(activeApplicationDidChange),
      name: NSWorkspace.didActivateApplicationNotification,
      object: nil
    )
    outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
      matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.closePopoverAfterOutsideClick()
      }
    }
    model.onContextSelectionStarted = { [weak self] kind in
      guard let self else {
        return
      }
      self.popover.behavior = .applicationDefined
      if case .region = kind {
        self.popover.performClose(nil)
      }
    }
    model.onContextSelectionFinished = { [weak self] kind in
      guard let self, case .region = kind else {
        return
      }
      self.showPopover()
    }
    model.onContextProcessingFinished = { [weak self] in
      guard let self else {
        return
      }
      self.popover.behavior = .transient
    }
    model.onAudioSessionStarted = { [weak wakeWord] in
      wakeWord?.suspend()
    }
    model.onAudioSessionEnded = { [weak wakeWord] in
      wakeWord?.resume()
    }
    wakeWord.onDetection = { [weak self] in
      self?.handleWakeWord()
    }

    do {
      try shortcut.start { [weak self] in
        self?.toggle(source: .shortcut)
      }
    } catch {
      // The menu bar button remains a reliable entry if registration fails.
    }
    wakeWord.resume()
  }

  func stop() {
    isStopping = true
    cancelWakeAcknowledgement()
    shortcut.stop()
    popover.close()
    wakeWord.suspend()
    wakeStartTask?.cancel()
    wakeStartTask = nil
    if let outsideClickMonitor {
      NSEvent.removeMonitor(outsideClickMonitor)
      self.outsideClickMonitor = nil
    }
    NSWorkspace.shared.notificationCenter.removeObserver(
      self,
      name: NSWorkspace.didActivateApplicationNotification,
      object: nil
    )
    NSStatusBar.system.removeStatusItem(statusItem)
  }

  func popoverDidClose(_ notification: Notification) {
    cancelWakeAcknowledgement()
    model.cancelAudioSession(reason: .popoverClosed)
    if !model.isSelectingContext {
      model.clearContext()
    }
    if !isStopping {
      wakeWord.resume()
    }
  }

  func popoverDidShow(_ notification: Notification) {
    guard let pendingTriggerId else {
      return
    }
    acceptanceRecorder.record(
      .init(type: .presencePresented, triggerId: pendingTriggerId)
    )
    self.pendingTriggerId = nil
  }

  @objc
  private func togglePopover() {
    toggle(source: .menuBar)
  }

  @objc
  private func activeApplicationDidChange(_ notification: Notification) {
    guard
      popover.isShown,
      !model.isSelectingContext,
      let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
        as? NSRunningApplication,
      application.processIdentifier != ProcessInfo.processInfo.processIdentifier
    else {
      return
    }
    popover.performClose(nil)
  }

  private func closePopoverAfterOutsideClick() {
    guard popover.isShown, !model.isSelectingContext else {
      return
    }
    popover.performClose(nil)
  }

  private func toggle(source: RealtimeAcceptanceReason) {
    if source == .shortcut, !popover.isShown, model.isAudioSessionActive {
      model.cancelAudioSession(reason: .shortcut)
      model.clearContext()
      return
    }
    if popover.isShown {
      popover.performClose(nil)
      return
    }
    let triggerId = UUID()
    pendingTriggerId = triggerId
    acceptanceRecorder.record(
      .init(type: .presenceTriggered, reason: source, triggerId: triggerId)
    )

    model.prepareSelectedTextCapture()
    showPopover()
    Task {
      await model.refresh()
    }
  }

  private func showPopover() {
    guard !popover.isShown, let button = statusItem.button else {
      return
    }
    popover.show(
      relativeTo: button.bounds,
      of: button,
      preferredEdge: .minY
    )
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

  private func handleWakeWord() {
    wakeConversationPending = true
    acknowledgement?.currentTime = 0
    if acknowledgement?.play() != true {
      startWakeConversation()
    }
  }

  private func cancelWakeAcknowledgement() {
    wakeConversationPending = false
    wakeStartTask?.cancel()
    wakeStartTask = nil
    acknowledgement?.stop()
    acknowledgement?.currentTime = 0
  }

  private func startWakeConversation() {
    guard wakeConversationPending else {
      return
    }
    wakeConversationPending = false
    wakeStartTask?.cancel()
    wakeStartTask = Task { [weak self] in
      guard let self else {
        return
      }
      guard !Task.isCancelled else {
        return
      }
      self.model.startAudioSession()
      if !self.model.isAudioSessionActive {
        self.wakeWord.resume()
      }
      self.wakeStartTask = nil
    }
  }
}

extension StatusItemController: AVAudioPlayerDelegate {
  nonisolated func audioPlayerDidFinishPlaying(
    _ player: AVAudioPlayer,
    successfully flag: Bool
  ) {
    Task { @MainActor [weak self] in
      self?.startWakeConversation()
    }
  }
}
