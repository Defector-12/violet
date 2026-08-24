import AVFoundation
import AppKit
import SwiftUI
import VioletMacCore

@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
  private let acceptanceRecorder: any RealtimeAcceptanceRecording
  private let model: PresenceModel
  private let acknowledgement = AVSpeechSynthesizer()
  private var pendingTriggerId: UUID?
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
    model.onContextSelectionFinished = { [weak self] in
      self?.showPopover()
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
    wakeStartTask?.cancel()
    wakeWord.suspend()
    shortcut.stop()
    popover.close()
    NSStatusBar.system.removeStatusItem(statusItem)
  }

  func popoverDidClose(_ notification: Notification) {
    wakeStartTask?.cancel()
    wakeStartTask = nil
    model.cancelAudioSession(reason: .popoverClosed)
    if !model.isSelectingContext {
      model.clearContext()
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

  private func toggle(source: RealtimeAcceptanceReason) {
    if popover.isShown {
      popover.performClose(nil)
      return
    }
    let triggerId = UUID()
    pendingTriggerId = triggerId
    acceptanceRecorder.record(
      .init(type: .presenceTriggered, reason: source, triggerId: triggerId)
    )

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
    showPopover()
    let utterance = AVSpeechUtterance(string: "我在")
    utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
    acknowledgement.speak(utterance)
    wakeStartTask?.cancel()
    wakeStartTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(650))
      guard !Task.isCancelled, let self else {
        return
      }
      model.startAudioSession()
      if !model.isAudioSessionActive {
        wakeWord.resume()
      }
      wakeStartTask = nil
    }
  }
}
