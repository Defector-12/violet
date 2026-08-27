@preconcurrency import ApplicationServices
import Foundation
import Testing

@testable import VioletMacCore

@Suite("Context capture")
struct ContextCaptureTests {
  @Test
  func convertsAppKitRegionToTopOriginDisplaySpace() {
    let result = screenCaptureRect(
      from: CGRect(x: 54.45703125, y: 781.4609375, width: 236.66015625, height: 33.83984375),
      primaryScreenFrame: CGRect(x: 0, y: 0, width: 1470, height: 956)
    )

    #expect(
      result
        == CGRect(x: 54.45703125, y: 140.69921875, width: 236.66015625, height: 33.83984375)
    )
  }

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
