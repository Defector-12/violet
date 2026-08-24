import AppKit
import SwiftUI
import VioletMacCore

@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
  private let acceptanceRecorder: any RealtimeAcceptanceRecording
  private let model: PresenceModel
  private var pendingTriggerId: UUID?
  private let popover = NSPopover()
  private let shortcut: any GlobalShortcutPort
  private let statusItem = NSStatusBar.system.statusItem(
    withLength: NSStatusItem.variableLength
  )

  init(
    model: PresenceModel,
    shortcut: any GlobalShortcutPort,
    acceptanceRecorder: any RealtimeAcceptanceRecording
  ) {
    self.acceptanceRecorder = acceptanceRecorder
    self.model = model
    self.shortcut = shortcut
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
      rootView: PresenceView(model: model)
    )

    do {
      try shortcut.start { [weak self] in
        self?.toggle(source: .shortcut)
      }
    } catch {
      // The menu bar button remains a reliable entry if registration fails.
    }
  }

  func stop() {
    shortcut.stop()
    popover.close()
    NSStatusBar.system.removeStatusItem(statusItem)
  }

  func popoverDidClose(_ notification: Notification) {
    model.cancelAudioSession(reason: .popoverClosed)
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
    guard let button = statusItem.button else {
      return
    }
    let triggerId = UUID()
    pendingTriggerId = triggerId
    acceptanceRecorder.record(
      .init(type: .presenceTriggered, reason: source, triggerId: triggerId)
    )

    popover.show(
      relativeTo: button.bounds,
      of: button,
      preferredEdge: .minY
    )
    NSApplication.shared.activate(ignoringOtherApps: true)
    Task {
      await model.refresh()
    }
  }
}
