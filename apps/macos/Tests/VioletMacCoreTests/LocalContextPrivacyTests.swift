import AppKit
import Foundation
import Testing

@testable import VioletMacCore

@Suite("Local context privacy")
struct LocalContextPrivacyTests {
  @Test
  func redactsControlledSensitiveTextBeforeItLeavesTheDevice() throws {
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .text(
        appBundleId: "com.example.Reader",
        text: "ID 11010519491231002X"
      )
    )

    guard case .text(let text) = result.payload else {
      Issue.record("Expected filtered text")
      return
    }
    #expect(!text.contains("11010519491231002X"))
    #expect(text == "ID [REDACTED]")
    #expect(
      result.redactions
        == [
          .init(category: .controlledSensitive, count: 1)
        ])
  }

  @Test
  func blocksAbsoluteSecretsInsteadOfUploadingRedactedSurroundings() {
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    #expect(throws: LocalContextPrivacyError.blockedSensitiveContent) {
      try filter.filter(
        .text(
          appBundleId: "com.example.Reader",
          text: "token: sk-abcdefghijklmnop"
        )
      )
    }
  }

  @Test
  func rejectsExcludedApplicationsWithoutReturningTheirContent() {
    let filter = LocalContextPrivacyFilter(
      excludedBundleIds: ["com.example.confidential"]
    )

    #expect(throws: LocalContextPrivacyError.blockedApplication) {
      try filter.filter(
        .text(appBundleId: "com.example.confidential", text: "confidential")
      )
    }
  }

  @Test
  func leavesOrdinarySelectedTextIntact() throws {
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .text(appBundleId: "com.apple.Preview", text: "Context Envelope")
    )

    #expect(result.payload == .text("Context Envelope"))
    #expect(result.redactions.isEmpty)
  }

  @Test
  func preservesBoundedJPEGWhenNoRedactionIsNeeded() throws {
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: 32,
      pixelsHigh: 32,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
    let source = try #require(
      bitmap?.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    )
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .image(
        appBundleId: "com.apple.Preview",
        data: source,
        focusPoint: nil,
        height: 32,
        recognizedText: [],
        region: nil,
        width: 32
      )
    )

    guard case .image(let data, _, _, _, let mediaType, _, _, _) = result.payload else {
      Issue.record("Expected a filtered image")
      return
    }
    #expect(data == source)
    #expect(mediaType == "image/jpeg")
    #expect(result.confidence == 1)
  }

  @Test
  func prioritizesSafeOCRTextNearestThePointer() throws {
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: 32,
      pixelsHigh: 32,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
    let source = try #require(
      bitmap?.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    )
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .image(
        appBundleId: "com.example.Terminal",
        data: source,
        focusPoint: .init(x: 0.25, y: 0.75),
        height: 32,
        recognizedText: [
          .init(
            text: "Restore history",
            confidence: 0.99,
            normalizedBounds: .init(x: 0.1, y: 0.45, width: 0.2, height: 0.1)
          ),
          .init(
            text: "pkill -x Violet",
            confidence: 0.99,
            normalizedBounds: .init(x: 0.1, y: 0.2, width: 0.4, height: 0.1)
          ),
        ],
        region: nil,
        width: 32
      )
    )

    guard case .image(let data, _, _, let text, _, _, _, _) = result.payload else {
      Issue.record("Expected a filtered image")
      return
    }
    #expect(data != source)
    #expect(
      text?.hasPrefix(
        "Pointer-adjacent OCR candidate (not proof of selection):\npkill -x Violet"
      ) == true
    )
    #expect(text?.contains("Other OCR text in the authorized window:\nRestore history") == true)
    #expect(
      contextImagePoint(.init(x: 0.25, y: 0.75), width: 32, height: 32)
        == CGPoint(x: 8, y: 8)
    )
    guard case .image(_, _, _, let onDemandText, _, _, _, _) =
      result.withoutLocalOCR().payload
    else {
      Issue.record("Expected an on-demand image")
      return
    }
    #expect(onDemandText == nil)
  }

  @Test
  func doesNotPromoteOCRTextThatIsOnlyNearThePointer() throws {
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: 32,
      pixelsHigh: 32,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
    let source = try #require(
      bitmap?.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
    )
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .image(
        appBundleId: "com.example.Terminal",
        data: source,
        focusPoint: .init(x: 0.25, y: 0.56),
        height: 32,
        recognizedText: [
          .init(
            text: "loads/self/Violet/apps/macos/.build/app/Violet.app",
            confidence: 0.99,
            normalizedBounds: .init(x: 0.1, y: 0.36, width: 0.4, height: 0.02)
          )
        ],
        region: nil,
        width: 32
      )
    )

    guard case .image(_, _, _, let text, _, _, _, _) = result.payload else {
      Issue.record("Expected a filtered image")
      return
    }
    #expect(text == "loads/self/Violet/apps/macos/.build/app/Violet.app")
  }

  @Test
  func masksSensitiveImageRegionsAndBoundsTheUploadFormat() throws {
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: 32,
      pixelsHigh: 32,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
    let source = try #require(bitmap?.representation(using: .png, properties: [:]))
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .image(
        appBundleId: "com.apple.Preview",
        data: source,
        focusPoint: .init(x: 0.25, y: 0.75),
        height: 32,
        recognizedText: [
          .init(
            text: "ID 11010519491231002X",
            confidence: 0.99,
            normalizedBounds: .init(x: 0, y: 0, width: 1, height: 1)
          )
        ],
        region: nil,
        width: 32
      )
    )

    guard
      case .image(let data, let focusPoint, _, let text, let mediaType, _, _, _) = result.payload
    else {
      Issue.record("Expected a filtered image")
      return
    }
    #expect(mediaType == "image/jpeg")
    #expect(data != source)
    #expect(
      text == "Pointer-adjacent OCR candidate (not proof of selection):\nID [REDACTED]"
    )
    #expect(focusPoint == .init(x: 0.25, y: 0.75))
    #expect(result.redactions == [.init(category: .controlledSensitive, count: 1)])
  }
}
