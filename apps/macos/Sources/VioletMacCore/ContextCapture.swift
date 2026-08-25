import AppKit
@preconcurrency import ApplicationServices
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import Vision

public enum ContextCaptureKind: Sendable {
  case region
  case selectedText
  case window
}

public enum ContextCaptureError: Error, Equatable, LocalizedError {
  case cancelled
  case permissionDenied
  case unavailable

  public var errorDescription: String? {
    switch self {
    case .cancelled:
      "Context selection was cancelled."
    case .permissionDenied:
      "Screen Recording or Accessibility permission is required."
    case .unavailable:
      "No readable context is available."
    }
  }
}

@MainActor
public protocol ContextCapturePort: AnyObject {
  func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext
  func cancel()
}

@MainActor
public final class SilentContextCapture: ContextCapturePort {
  public private(set) var captureCount = 0

  public init() {}

  public func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext {
    captureCount += 1
    return .text(appBundleId: "com.violet.test", text: "Synthetic selected context")
  }

  public func cancel() {}
}

@MainActor
public final class SystemContextCapture: NSObject, ContextCapturePort {
  private let excludedBundleIds: Set<String>
  private var pickerContinuation: CheckedContinuation<SelectedFilter, Error>?
  private var regionSelector: RegionSelectionController?

  public init(excludedBundleIds: Set<String> = defaultExcludedBundleIds) {
    self.excludedBundleIds = excludedBundleIds
    super.init()
  }

  public func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext {
    switch kind {
    case .selectedText:
      return try captureSelectedText()
    case .window:
      return try await capturePickedWindow()
    case .region:
      guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
        throw ContextCaptureError.permissionDenied
      }
      let rect = try await selectRegion()
      return try await captureRegion(rect, appBundleId: nil)
    }
  }

  public func cancel() {
    pickerContinuation?.resume(throwing: ContextCaptureError.cancelled)
    pickerContinuation = nil
    regionSelector?.cancel()
    regionSelector = nil
    SCContentSharingPicker.shared.isActive = false
    SCContentSharingPicker.shared.remove(self)
  }

  private func captureSelectedText() throws -> CapturedContext {
    guard AXIsProcessTrusted() else {
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
      _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
      throw ContextCaptureError.permissionDenied
    }
    let system = AXUIElementCreateSystemWide()
    var focusedValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        system,
        kAXFocusedUIElementAttribute as CFString,
        &focusedValue
      ) == .success,
      let focusedValue
    else {
      throw ContextCaptureError.unavailable
    }
    let element = unsafeDowncast(focusedValue, to: AXUIElement.self)
    var roleValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue)
      == .success,
      let role = roleValue as? String,
      role == "AXSecureTextField"
    {
      throw LocalContextPrivacyError.blockedApplication
    }
    var selectedValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextAttribute as CFString,
        &selectedValue
      ) == .success,
      let text = selectedValue as? String,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      throw ContextCaptureError.unavailable
    }
    return .text(
      appBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
      text: text
    )
  }

  private func capturePickedWindow() async throws -> CapturedContext {
    let picker = SCContentSharingPicker.shared
    guard pickerContinuation == nil else {
      throw ContextCaptureError.unavailable
    }
    var configuration = SCContentSharingPickerConfiguration()
    configuration.allowedPickerModes = [.singleWindow, .singleDisplay]
    configuration.allowsChangingSelectedContent = false
    configuration.excludedBundleIDs = Array(
      excludedBundleIds.union([Bundle.main.bundleIdentifier].compactMap { $0 })
    )
    picker.defaultConfiguration = configuration
    picker.maximumStreamCount = 1
    picker.add(self)
    picker.isActive = true

    let filter = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<SelectedFilter, Error>) in
        pickerContinuation = continuation
        picker.present()
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.cancel()
      }
    }
    return try await capture(filter: filter.value, region: nil)
  }

  private func selectRegion() async throws -> CGRect {
    let selector = RegionSelectionController()
    regionSelector = selector
    defer {
      regionSelector = nil
    }
    return try await selector.select()
  }

  private func captureRegion(
    _ rect: CGRect,
    appBundleId: String?
  ) async throws -> CapturedContext {
    let image: CGImage
    if #available(macOS 15.2, *) {
      image = try await SCScreenshotManager.captureImage(in: rect)
    } else {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      guard let display = content.displays.first(where: { $0.frame.intersects(rect) }) else {
        throw ContextCaptureError.unavailable
      }
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let configuration = SCStreamConfiguration()
      configuration.sourceRect = CGRect(
        x: rect.minX - display.frame.minX,
        y: rect.minY - display.frame.minY,
        width: rect.width,
        height: rect.height
      )
      configuration.width = min(Int(rect.width * 2), 2048)
      configuration.height = min(Int(rect.height * 2), 2048)
      image = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: configuration
      )
    }
    return try makeCapturedImage(
      image,
      appBundleId: appBundleId,
      region: normalized(rect)
    )
  }

  private func capture(
    filter: SCContentFilter,
    region: NormalizedContextRect?
  ) async throws -> CapturedContext {
    let configuration = SCStreamConfiguration()
    configuration.width = min(Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)), 2048)
    configuration.height = min(
      Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)),
      2048
    )
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter,
      configuration: configuration
    )
    return try makeCapturedImage(image, appBundleId: nil, region: region)
  }

  private func makeCapturedImage(
    _ image: CGImage,
    appBundleId: String?,
    region: NormalizedContextRect?
  ) throws -> CapturedContext {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
      throw LocalContextPrivacyError.imageEncodingFailed
    }
    return .image(
      appBundleId: appBundleId,
      data: data,
      height: image.height,
      recognizedText: recognizeText(in: image),
      region: region,
      width: image.width
    )
  }
}

extension SystemContextCapture: SCContentSharingPickerObserver {
  nonisolated public func contentSharingPicker(
    _ picker: SCContentSharingPicker,
    didCancelFor stream: SCStream?
  ) {
    Task { @MainActor [weak self] in
      self?.finishPicker(.failure(ContextCaptureError.cancelled))
    }
  }

  nonisolated public func contentSharingPicker(
    _ picker: SCContentSharingPicker,
    didUpdateWith filter: SCContentFilter,
    for stream: SCStream?
  ) {
    Task { @MainActor [weak self] in
      self?.finishPicker(.success(SelectedFilter(value: filter)))
    }
  }

  nonisolated public func contentSharingPickerStartDidFailWithError(_ error: Error) {
    Task { @MainActor [weak self] in
      self?.finishPicker(.failure(error))
    }
  }

  private func finishPicker(_ result: Result<SelectedFilter, Error>) {
    let continuation = pickerContinuation
    pickerContinuation = nil
    SCContentSharingPicker.shared.isActive = false
    SCContentSharingPicker.shared.remove(self)
    continuation?.resume(with: result)
  }
}

private struct SelectedFilter: @unchecked Sendable {
  let value: SCContentFilter
}

private func recognizeText(in image: CGImage) -> [RecognizedContextText] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.automaticallyDetectsLanguage = true
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: image)
  guard
    (try? handler.perform([request])) != nil,
    let observations = request.results
  else {
    return []
  }
  return observations.compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }
    return RecognizedContextText(
      text: candidate.string,
      confidence: Double(candidate.confidence),
      normalizedBounds: .init(
        x: observation.boundingBox.minX,
        y: observation.boundingBox.minY,
        width: observation.boundingBox.width,
        height: observation.boundingBox.height
      )
    )
  }
}

private func normalized(_ rect: CGRect) -> NormalizedContextRect {
  guard
    let screen = NSScreen.screens.first(where: { $0.frame.intersects(rect) }),
    screen.frame.width > 0,
    screen.frame.height > 0
  else {
    return .init(x: 0, y: 0, width: 1, height: 1)
  }
  return .init(
    x: (rect.minX - screen.frame.minX) / screen.frame.width,
    y: (rect.minY - screen.frame.minY) / screen.frame.height,
    width: rect.width / screen.frame.width,
    height: rect.height / screen.frame.height
  )
}

@MainActor
private final class RegionSelectionController {
  private var continuation: CheckedContinuation<CGRect, Error>?
  private var windows: [NSWindow] = []

  func select() async throws -> CGRect {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<CGRect, Error>) in
        self.continuation = continuation
        windows = NSScreen.screens.map { screen in
          let window = NSWindow(
            contentRect: screen.frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
          )
          window.backgroundColor = NSColor.black.withAlphaComponent(0.12)
          window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
          window.isOpaque = false
          window.level = .screenSaver
          window.contentView = RegionSelectionView { [weak self] rect in
            self?.finish(rect)
          }
          window.makeKeyAndOrderFront(nil)
          return window
        }
        NSCursor.crosshair.push()
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.cancel()
      }
    }
  }

  func cancel() {
    guard continuation != nil else {
      return
    }
    finish(nil)
  }

  private func finish(_ rect: CGRect?) {
    let continuation = continuation
    self.continuation = nil
    windows.forEach { $0.orderOut(nil) }
    windows.removeAll()
    NSCursor.pop()
    if let rect, rect.width >= 4, rect.height >= 4 {
      continuation?.resume(returning: rect)
    } else {
      continuation?.resume(throwing: ContextCaptureError.cancelled)
    }
  }
}

@MainActor
private final class RegionSelectionView: NSView {
  private var currentPoint: CGPoint?
  private var origin: CGPoint?
  private let completion: (CGRect?) -> Void

  init(completion: @escaping (CGRect?) -> Void) {
    self.completion = completion
    super.init(frame: .zero)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    nil
  }

  override var acceptsFirstResponder: Bool { true }

  override func mouseDown(with event: NSEvent) {
    origin = convert(event.locationInWindow, from: nil)
    currentPoint = origin
    needsDisplay = true
  }

  override func mouseDragged(with event: NSEvent) {
    currentPoint = convert(event.locationInWindow, from: nil)
    needsDisplay = true
  }

  override func mouseUp(with event: NSEvent) {
    guard let origin, let window else {
      completion(nil)
      return
    }
    let end = convert(event.locationInWindow, from: nil)
    let localRect = CGRect(
      x: min(origin.x, end.x),
      y: min(origin.y, end.y),
      width: abs(end.x - origin.x),
      height: abs(end.y - origin.y)
    )
    completion(
      window.convertToScreen(localRect)
    )
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard let origin, let currentPoint else {
      return
    }
    let selection = CGRect(
      x: min(origin.x, currentPoint.x),
      y: min(origin.y, currentPoint.y),
      width: abs(currentPoint.x - origin.x),
      height: abs(currentPoint.y - origin.y)
    )
    NSColor.controlAccentColor.withAlphaComponent(0.16).setFill()
    selection.fill()
    NSColor.controlAccentColor.setStroke()
    let path = NSBezierPath(rect: selection)
    path.lineWidth = 2
    path.stroke()
  }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 53 {
      completion(nil)
    } else {
      super.keyDown(with: event)
    }
  }
}
