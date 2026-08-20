import AppKit
import SwiftUI
import VioletMacCore

@MainActor
final class StatusItemController: NSObject {
  private let model: PresenceModel
  private let popover = NSPopover()
  private let shortcut: any GlobalShortcutPort
  private let statusItem = NSStatusBar.system.statusItem(
    withLength: NSStatusItem.variableLength
  )

  init(
    model: PresenceModel,
    shortcut: any GlobalShortcutPort
  ) {
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

    popover.behavior = .transient
    popover.contentSize = NSSize(width: 400, height: 520)
    popover.contentViewController = NSHostingController(
      rootView: PresenceView(model: model)
    )

    do {
      try shortcut.start { [weak self] in
        self?.toggle()
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

  @objc
  private func togglePopover() {
    toggle()
  }

  private func toggle() {
    if popover.isShown {
      popover.performClose(nil)
      return
    }
    guard let button = statusItem.button else {
      return
    }

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
