import AppKit
import SwiftUI
import VioletMacCore

@MainActor
final class MemoryWindowController: NSWindowController, NSWindowDelegate {
  let model: MemoryManagementModel

  init(model: MemoryManagementModel) {
    self.model = model
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 920, height: 640),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false
    )
    window.title = "Violet · 记忆"
    window.isReleasedWhenClosed = false
    window.contentViewController = NSHostingController(rootView: MemoryManagementView(model: model))
    super.init(window: window)
    window.delegate = self
    window.center()
    model.onPreviewRequested = { [weak self] in self?.show() }
  }

  required init?(coder: NSCoder) { nil }

  func show() {
    showWindow(nil)
    window?.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    Task { await model.refresh() }
  }

  func windowWillClose(_ notification: Notification) {
    model.hideDetails()
  }
}
