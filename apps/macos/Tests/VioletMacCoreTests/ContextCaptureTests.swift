@preconcurrency import ApplicationServices
import Foundation
import Testing

@testable import VioletMacCore

@Suite("Context capture")
struct ContextCaptureTests {
  @Test
  @MainActor
  func readsSelectionFromApplicationPreparedBeforeVioletTakesFocus() async throws {
    let source = ContextApplicationTarget(
      bundleIdentifier: "com.example.Editor",
      processIdentifier: 101
    )
    let violet = ContextApplicationTarget(
      bundleIdentifier: "dev.violet.app",
      processIdentifier: 202
    )
    var activeApplication = source
    let preparedElement = AXUIElementCreateSystemWide()
    var receivedPreparedElement = false
    var requestedProcessIdentifier: pid_t?
    let capture = SystemContextCapture(
      excludedBundleIds: [],
      currentProcessIdentifier: violet.processIdentifier,
      activeApplication: { activeApplication },
      accessibilityAccess: { true },
      focusedElementReader: { _ in preparedElement },
      selectionReader: { processIdentifier, element in
        requestedProcessIdentifier = processIdentifier
        receivedPreparedElement = element != nil
        return .text("selected source text")
      }
    )

    capture.prepareSelectedTextCapture()
    activeApplication = violet
    capture.prepareSelectedTextCapture()
    let result = try await capture.capture(.selectedText)

    #expect(requestedProcessIdentifier == source.processIdentifier)
    #expect(receivedPreparedElement)
    #expect(
      result
        == .text(
          appBundleId: source.bundleIdentifier,
          text: "selected source text"
        ))
  }
}
