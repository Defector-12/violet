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

  @Test(arguments: [
    NormalizedContextPoint(x: 0.039123456789, y: 0.907987654321),
    NormalizedContextPoint(x: 0, y: 0),
    NormalizedContextPoint(x: 1, y: 1),
  ])
  func preservesBoundedJPEGAndCoordinatesWithFocusPoint(
    focusPoint: NormalizedContextPoint
  ) throws {
    let image = try #require(noisyImage(width: 128, height: 96))
    let source = try #require(
      NSBitmapImageRep(cgImage: image).representation(
        using: .jpeg, properties: [.compressionFactor: 0.85]
      )
    )
    try #require(source.count < 8 * 1024 * 1024)
    let region = NormalizedContextRect(x: 0.12, y: 0.23, width: 0.56, height: 0.45)
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])

    let result = try filter.filter(
      .image(
        appBundleId: "com.example.Terminal",
        data: source,
        focusPoint: focusPoint,
        height: 96,
        recognizedText: [],
        region: region,
        width: 128
      )
    )

    guard
      case .image(
        let data, let returnedPoint, let height, let text, let mediaType,
        let returnedRegion, let sha256, let width
      ) = result.payload
    else {
      Issue.record("Expected a filtered image")
      return
    }
    #expect(
      data.elementsEqual(source),
      "A focus point is metadata, not a reason to redraw a bounded JPEG"
    )
    #expect(returnedPoint == focusPoint)
    #expect(returnedRegion == region)
    #expect(width == 128)
    #expect(height == 96)
    #expect(text == nil)
    #expect(mediaType == "image/jpeg")
    #expect(sha256 == contextImageHash(source))
    #expect(result.redactions.isEmpty)
    #expect(result.completeness == 1)
    #expect(result.confidence == 1)
  }

  @Test(
    arguments: [false, true],
    [
      nil,
      NormalizedContextPoint(x: 0.75, y: 0.5),
      NormalizedContextPoint(x: 0.25, y: 0.71),
    ] as [NormalizedContextPoint?]
  )
  func preservesTextPixelsAndPrivacyMasksWhenEncodingWithFocusPoint(
    hasSensitiveText: Bool,
    focusPoint: NormalizedContextPoint?
  ) throws {
    let source = try imageWithSyntheticText()
    let region = NormalizedContextRect(x: 0.12, y: 0.23, width: 0.56, height: 0.45)
    let observations: [RecognizedContextText] =
      hasSensitiveText
      ? [
        .init(
          text: "ID 11010519491231002X",
          confidence: 0.99,
          normalizedBounds: .init(x: 0.125, y: 1.0 / 6, width: 0.25, height: 0.25)
        )
      ] : []
    let filter = LocalContextPrivacyFilter(excludedBundleIds: [])
    let unpointed = try filter.filter(
      .image(
        appBundleId: "com.example.Terminal", data: source, focusPoint: nil,
        height: 96, recognizedText: observations, region: region, width: 128
      )
    )
    let result = try filter.filter(
      .image(
        appBundleId: "com.example.Terminal", data: source, focusPoint: focusPoint,
        height: 96, recognizedText: observations, region: region, width: 128
      )
    )

    guard
      case .image(let unpointedData, _, _, _, _, _, _, _) = unpointed.payload,
      case .image(
        let data, let returnedPoint, let height, let text, let mediaType,
        let returnedRegion, let sha256, let width
      ) = result.payload
    else {
      Issue.record("Expected filtered images")
      return
    }
    #expect(
      data.elementsEqual(unpointedData),
      "Adding coordinates must not paint over text or privacy masks"
    )
    #expect(data != source)
    #expect(data.count <= 8 * 1024 * 1024)
    #expect(returnedPoint == focusPoint)
    #expect(returnedRegion == region)
    #expect(width == 128)
    #expect(height == 96)
    #expect(mediaType == "image/jpeg")
    #expect(sha256 == contextImageHash(data))
    #expect(
      result.redactions
        == (hasSensitiveText ? [.init(category: .controlledSensitive, count: 1)] : [])
    )
    #expect(result.completeness == (hasSensitiveText ? 0.8 : 1))
    #expect(hasSensitiveText ? text?.contains("ID [REDACTED]") == true : text == nil)
    #expect(text?.contains("11010519491231002X") != true)

    let decoded = try #require(NSBitmapImageRep(data: data))
    #expect(decoded.pixelsWide == width)
    #expect(decoded.pixelsHigh == height)
    let glyph = try #require(decoded.colorAt(x: 85, y: 48)?.usingColorSpace(.deviceRGB))
    #expect(
      glyph.redComponent < 0.1 && glyph.greenComponent < 0.1 && glyph.blueComponent < 0.1,
      "The black letter stroke under the pointer must remain visible"
    )
    // Vision bounds are bottom-origin; bitmap samples are top-origin.
    for x in [20, 32, 44] {
      for y in [60, 68, 76] {
        let pixel = try #require(decoded.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB))
        let expected: CGFloat = hasSensitiveText ? 0 : 1
        #expect(
          abs(pixel.redComponent - expected) < 0.1
            && abs(pixel.greenComponent - expected) < 0.1
            && abs(pixel.blueComponent - expected) < 0.1,
          "Sensitive pixels must be black only when redaction is required, at (\(x), \(y))"
        )
      }
    }
    let outside = try #require(decoded.colorAt(x: 32, y: 28)?.usingColorSpace(.deviceRGB))
    #expect(
      outside.redComponent > 0.9 && outside.greenComponent > 0.9 && outside.blueComponent > 0.9,
      "Redaction must not mask the vertically mirrored non-sensitive region"
    )
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

    guard case .image(let data, let focusPoint, _, let text, _, _, _, _) = result.payload else {
      Issue.record("Expected a filtered image")
      return
    }
    #expect(
      data.elementsEqual(source),
      "OCR prioritization must not draw a focus marker into the JPEG"
    )
    #expect(
      text?.hasPrefix(
        "Pointer-adjacent OCR candidate (not proof of selection):\npkill -x Violet"
      ) == true
    )
    #expect(text?.contains("Other OCR text in the authorized window:\nRestore history") == true)
    #expect(focusPoint == .init(x: 0.25, y: 0.75))
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

  @Test
  func keepsOriginalDimensionsWhenTheJPEGFits() throws {
    let image = try #require(noisyImage(width: 64, height: 32))

    let encoded = try encodeBoundedContextImage(image, maximumBytes: 8 * 1024 * 1024)

    #expect(encoded.width == 64)
    #expect(encoded.height == 32)
    #expect(encoded.data.count <= 8 * 1024 * 1024)
  }

  @Test
  func uniformlyScalesOnlyWhenTheJPEGExceedsTheLimit() throws {
    let image = try #require(noisyImage(width: 512, height: 256))

    let encoded = try encodeBoundedContextImage(image, maximumBytes: 20 * 1024)
    let decoded = try #require(NSBitmapImageRep(data: encoded.data))

    #expect(encoded.data.count <= 20 * 1024)
    #expect(encoded.width < 512)
    #expect(encoded.height < 256)
    #expect(abs(Double(encoded.width) / Double(encoded.height) - 2) < 0.02)
    #expect(decoded.pixelsWide == encoded.width)
    #expect(decoded.pixelsHigh == encoded.height)
  }

  @Test
  func preservesTopOriginPointerInTheEncodedOnDemandEnvelope() throws {
    let filtered = try LocalContextPrivacyFilter(excludedBundleIds: []).filter(
      .image(
        appBundleId: nil, data: imageWithSyntheticText(),
        focusPoint: .init(x: 0.039, y: 0.907), height: 96,
        recognizedText: [], region: nil, width: 128
      )
    )
    let envelope = makeContextEnvelope(
      filtered.withoutLocalOCR(), deviceId: UUID(), sessionId: UUID()
    )
    let object = try #require(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope)) as? [String: Any]
    )
    let payload = try #require(object["payload"] as? [String: Any])
    let point = try #require(payload["focusPoint"] as? [String: Double])
    #expect(point["x"] == 0.039)
    #expect(point["y"] == 0.907)
    #expect(payload["localText"] == nil)
  }
}

private func imageWithSyntheticText() throws -> Data {
  let context = try #require(
    CGContext(
      data: nil,
      width: 128,
      height: 96,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
  )
  context.setFillColor(CGColor(gray: 1, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: 128, height: 96))
  // A deterministic H glyph around (96, 48), without fonts or screen access.
  context.setFillColor(CGColor(gray: 0, alpha: 1))
  context.fill(CGRect(x: 84, y: 36, width: 4, height: 24))
  context.fill(CGRect(x: 104, y: 36, width: 4, height: 24))
  context.fill(CGRect(x: 84, y: 46, width: 24, height: 4))
  let image = try #require(context.makeImage())
  return try #require(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
}

private func noisyImage(width: Int, height: Int) -> CGImage? {
  var bytes = [UInt8](repeating: 0, count: width * height * 4)
  var state: UInt32 = 0x1234_5678
  for index in bytes.indices {
    state = 1_664_525 &* state &+ 1_013_904_223
    bytes[index] = index % 4 == 3 ? 255 : UInt8(truncatingIfNeeded: state >> 24)
  }
  guard let provider = CGDataProvider(data: Data(bytes) as CFData) else {
    return nil
  }
  return CGImage(
    width: width,
    height: height,
    bitsPerComponent: 8,
    bitsPerPixel: 32,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
    provider: provider,
    decode: nil,
    shouldInterpolate: false,
    intent: .defaultIntent
  )
}
