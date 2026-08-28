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
  func convertsAndNormalizesNaturalPointingLocation() throws {
    let point = screenCapturePoint(
      from: CGPoint(x: 750, y: 700),
      primaryScreenFrame: CGRect(x: 0, y: 0, width: 1470, height: 956)
    )
    let normalized = try #require(
      normalizedPoint(
        point,
        in: CGRect(x: 500, y: 100, width: 500, height: 400)
      )
    )

    #expect(point == CGPoint(x: 750, y: 256))
    #expect(normalized == .init(x: 0.5, y: 0.39))
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

  @Test
  @MainActor
  func naturalPointingPrefersPreparedSelectedText() async throws {
    let source = ContextApplicationTarget(
      bundleIdentifier: "com.example.Reader",
      processIdentifier: 303
    )
    let capture = SystemContextCapture(
      excludedBundleIds: [],
      currentProcessIdentifier: 404,
      activeApplication: { source },
      accessibilityAccess: { true },
      focusedElementReader: { _ in AXUIElementCreateSystemWide() },
      selectionReader: { _, _ in .text("selected word") }
    )

    capture.prepareNaturalPointingCapture()
    let result = try await capture.capture(.naturalPointing)

    #expect(
      result
        == .text(
          appBundleId: source.bundleIdentifier,
          text: "selected word"
        ))
  }
}
