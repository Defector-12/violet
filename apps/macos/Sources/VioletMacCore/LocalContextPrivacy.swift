import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct RecognizedContextText: Equatable, Sendable {
  public let confidence: Double
  public let normalizedBounds: NormalizedContextRect
  public let text: String

  public init(
    text: String,
    confidence: Double,
    normalizedBounds: NormalizedContextRect
  ) {
    self.text = text
    self.confidence = confidence
    self.normalizedBounds = normalizedBounds
  }
}

public enum CapturedContext: Equatable, Sendable {
  case image(
    appBundleId: String?,
    data: Data,
    focusPoint: NormalizedContextPoint?,
    height: Int,
    recognizedText: [RecognizedContextText],
    region: NormalizedContextRect?,
    width: Int
  )
  case text(appBundleId: String?, text: String)
}

public enum LocalContextPrivacyError: Error, Equatable, LocalizedError {
  case blockedApplication
  case blockedSensitiveContent
  case emptyContext
  case imageEncodingFailed

  public var errorDescription: String? {
    switch self {
    case .blockedApplication:
      "Violet cannot read this application."
    case .blockedSensitiveContent:
      "Violet blocked an absolute secret before upload."
    case .emptyContext:
      "No readable context was selected."
    case .imageEncodingFailed:
      "Violet could not prepare the selected image."
    }
  }
}

public protocol LocalContextPrivacyFiltering: Sendable {
  func filter(_ context: CapturedContext) throws -> FilteredContext
}

public struct LocalContextPrivacyFilter: LocalContextPrivacyFiltering {
  private let excludedBundleIds: Set<String>

  public init(excludedBundleIds: Set<String> = defaultExcludedBundleIds) {
    self.excludedBundleIds = excludedBundleIds
  }

  public func filter(_ context: CapturedContext) throws -> FilteredContext {
    switch context {
    case .text(let appBundleId, let text):
      try ensureAllowed(appBundleId)
      let result = redact(text)
      if result.categories.contains(.absoluteSecret) {
        throw LocalContextPrivacyError.blockedSensitiveContent
      }
      guard !result.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw LocalContextPrivacyError.emptyContext
      }
      return FilteredContext(
        appBundleId: appBundleId,
        completeness: result.count == 0 ? 1 : 0.8,
        confidence: 1,
        payload: .text(result.value),
        redactions: redactionCounts(result.categories),
        sensitivity: "personal"
      )

    case .image(
      let appBundleId,
      let data,
      let focusPoint,
      let height,
      let recognizedText,
      let region,
      let width
    ):
      try ensureAllowed(appBundleId)
      let combined = redact(recognizedText.map(\.text).joined(separator: "\n"))
      if combined.categories.contains(.absoluteSecret) {
        throw LocalContextPrivacyError.blockedSensitiveContent
      }
      let sensitiveRegions = recognizedText.compactMap { observation -> SensitiveRegion? in
        let result = redact(observation.text)
        guard result.count > 0 else {
          return nil
        }
        return SensitiveRegion(
          categories: result.categories,
          normalizedBounds: observation.normalizedBounds
        )
      }
      let preparedImage =
        sensitiveRegions.isEmpty && isBoundedJPEG(data)
          && focusPoint == nil
        ? data
        : try prepareImage(
          data,
          focusPoint: focusPoint,
          height: height,
          regions: sensitiveRegions,
          width: width
        )
      let safeText = prioritizedLocalText(
        recognizedText,
        focusPoint: focusPoint
      )
      let categories = sensitiveRegions.flatMap(\.categories)
      return FilteredContext(
        appBundleId: appBundleId,
        completeness: sensitiveRegions.isEmpty ? 1 : 0.8,
        confidence: 1,
        payload: .image(
          data: preparedImage,
          focusPoint: focusPoint,
          height: height,
          localText: safeText.isEmpty ? nil : safeText,
          mediaType: "image/jpeg",
          region: region,
          sha256: contextImageHash(preparedImage),
          width: width
        ),
        redactions: redactionCounts(categories),
        sensitivity: "personal"
      )
    }
  }

  private func ensureAllowed(_ bundleId: String?) throws {
    if let bundleId, excludedBundleIds.contains(bundleId) {
      throw LocalContextPrivacyError.blockedApplication
    }
  }
}

public let defaultExcludedBundleIds: Set<String> = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.apple.keychainaccess",
  "com.bitwarden.desktop",
]

private struct RedactionResult {
  let categories: [ContextRedaction.Category]
  let count: Int
  let value: String
}

extension FilteredContext {
  func withoutLocalOCR() -> FilteredContext {
    guard
      case .image(
        let data,
        let focusPoint,
        let height,
        _,
        let mediaType,
        let region,
        let sha256,
        let width
      ) = payload
    else {
      return self
    }
    return FilteredContext(
      appBundleId: appBundleId,
      completeness: completeness,
      confidence: confidence,
      payload: .image(
        data: data,
        focusPoint: focusPoint,
        height: height,
        localText: nil,
        mediaType: mediaType,
        region: region,
        sha256: sha256,
        width: width
      ),
      redactions: redactions,
      sensitivity: sensitivity
    )
  }
}

private struct SensitiveRegion {
  let categories: [ContextRedaction.Category]
  let normalizedBounds: NormalizedContextRect
}

private struct RedactedOCRText {
  let normalizedBounds: NormalizedContextRect
  let text: String
}

private let absoluteSecretPatterns: [NSRegularExpression] = [
  regex(#"(?i)\b(?:password|passwd|token|secret|验证码)\s*[:=：]\s*\S+"#),
  regex(#"-----BEGIN [A-Z ]*PRIVATE KEY-----"#),
  regex(#"\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b"#),
  regex(#"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#),
]

private let controlledSensitivePatterns: [NSRegularExpression] = [
  regex(#"\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b"#),
  regex(#"\b(?:\d[ -]?){13,19}\b"#),
]

private func redact(_ value: String) -> RedactionResult {
  var result = value
  var categories: [ContextRedaction.Category] = []
  for pattern in absoluteSecretPatterns {
    let range = NSRange(result.startIndex..., in: result)
    let count = pattern.numberOfMatches(in: result, range: range)
    if count > 0 {
      result = pattern.stringByReplacingMatches(
        in: result,
        range: range,
        withTemplate: "[REDACTED]"
      )
      categories.append(contentsOf: repeatElement(.absoluteSecret, count: count))
    }
  }
  for pattern in controlledSensitivePatterns {
    let range = NSRange(result.startIndex..., in: result)
    let count = pattern.numberOfMatches(in: result, range: range)
    if count > 0 {
      result = pattern.stringByReplacingMatches(
        in: result,
        range: range,
        withTemplate: "[REDACTED]"
      )
      categories.append(contentsOf: repeatElement(.controlledSensitive, count: count))
    }
  }
  return RedactionResult(categories: categories, count: categories.count, value: result)
}

private func redactionCounts(_ categories: [ContextRedaction.Category]) -> [ContextRedaction] {
  Dictionary(grouping: categories, by: { $0 })
    .map { ContextRedaction(category: $0.key, count: $0.value.count) }
    .sorted { $0.category.rawValue < $1.category.rawValue }
}

private func prioritizedLocalText(
  _ recognizedText: [RecognizedContextText],
  focusPoint: NormalizedContextPoint?
) -> String {
  let observations = recognizedText.compactMap { observation -> RedactedOCRText? in
    let text = redact(observation.text).value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      return nil
    }
    return RedactedOCRText(
      normalizedBounds: observation.normalizedBounds,
      text: text
    )
  }
  let allText = observations.map(\.text).joined(separator: "\n")
  guard let focusPoint else {
    return allText
  }
  let nearestIndex = observations.indices.min {
    distanceSquared(
      from: focusPoint,
      toVisionBounds: observations[$0].normalizedBounds
    )
      < distanceSquared(
        from: focusPoint,
        toVisionBounds: observations[$1].normalizedBounds
      )
  }
  let nearestDistance = nearestIndex.map {
    distanceSquared(from: focusPoint, toVisionBounds: observations[$0].normalizedBounds)
  }
  guard
    let nearestIndex,
    let nearestDistance,
    nearestDistance <= 0.0004
  else {
    return allText
  }

  let otherText = observations.enumerated()
    .filter { $0.offset != nearestIndex }
    .map { $0.element.text }
    .joined(separator: "\n")
  return [
    "Pointer-adjacent OCR candidate (not proof of selection):\n\(observations[nearestIndex].text)",
    otherText.isEmpty ? nil : "Other OCR text in the authorized window:\n\(otherText)",
  ]
  .compactMap { $0 }
  .joined(separator: "\n\n")
}

private func distanceSquared(
  from point: NormalizedContextPoint,
  toVisionBounds bounds: NormalizedContextRect
) -> Double {
  let minimumX = bounds.x
  let maximumX = bounds.x + bounds.width
  let minimumY = 1 - bounds.y - bounds.height
  let maximumY = 1 - bounds.y
  let deltaX = point.x < minimumX ? minimumX - point.x : max(0, point.x - maximumX)
  let deltaY = point.y < minimumY ? minimumY - point.y : max(0, point.y - maximumY)
  return deltaX * deltaX + deltaY * deltaY
}

private func prepareImage(
  _ data: Data,
  focusPoint: NormalizedContextPoint?,
  height: Int,
  regions: [SensitiveRegion],
  width: Int
) throws -> Data {
  guard
    let source = CGImageSourceCreateWithData(data as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    return data
  }
  guard
    let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
  else {
    throw LocalContextPrivacyError.imageEncodingFailed
  }

  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  context.setFillColor(NSColor.black.cgColor)
  for region in regions {
    let bounds = region.normalizedBounds
    context.fill(
      CGRect(
        x: bounds.x * Double(width),
        y: bounds.y * Double(height),
        width: bounds.width * Double(width),
        height: bounds.height * Double(height)
      )
    )
  }
  if let focusPoint {
    drawFocusMarker(
      in: context,
      point: contextImagePoint(focusPoint, width: width, height: height),
      width: width,
      height: height
    )
  }
  guard
    let redacted = context.makeImage(),
    let encoded = NSBitmapImageRep(cgImage: redacted).representation(
      using: .jpeg,
      properties: [.compressionFactor: 0.9]
    ),
    encoded.count <= 8 * 1024 * 1024
  else {
    throw LocalContextPrivacyError.imageEncodingFailed
  }
  return encoded
}

func contextImagePoint(
  _ point: NormalizedContextPoint,
  width: Int,
  height: Int
) -> CGPoint {
  CGPoint(
    x: min(max(point.x, 0), 1) * Double(width),
    y: (1 - min(max(point.y, 0), 1)) * Double(height)
  )
}

private func drawFocusMarker(
  in context: CGContext,
  point: CGPoint,
  width: Int,
  height: Int
) {
  let radius = max(12, Double(min(width, height)) * 0.015)
  let markerBounds = CGRect(
    x: point.x - radius,
    y: point.y - radius,
    width: radius * 2,
    height: radius * 2
  )
  context.setFillColor(NSColor.clear.cgColor)
  context.setStrokeColor(NSColor.white.withAlphaComponent(0.95).cgColor)
  context.setLineWidth(max(5, radius * 0.35))
  context.strokeEllipse(in: markerBounds)
  context.setStrokeColor(NSColor.systemPink.cgColor)
  context.setLineWidth(max(2, radius * 0.16))
  context.strokeEllipse(in: markerBounds)
}

private func isBoundedJPEG(_ data: Data) -> Bool {
  guard
    data.count <= 8 * 1024 * 1024,
    let source = CGImageSourceCreateWithData(data as CFData, nil),
    let type = CGImageSourceGetType(source)
  else {
    return false
  }
  return UTType(type as String)?.conforms(to: .jpeg) == true
}

private func regex(_ pattern: String) -> NSRegularExpression {
  // Patterns are compile-time constants and failures are programmer errors.
  try! NSRegularExpression(pattern: pattern)
}
