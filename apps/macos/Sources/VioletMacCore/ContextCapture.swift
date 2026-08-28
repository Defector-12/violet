import AppKit
@preconcurrency import ApplicationServices
import Foundation
import ImageIO
@preconcurrency import ScreenCaptureKit
import Vision

public enum ContextCaptureKind: Equatable, Sendable {
  case naturalPointing
  case region
  case selectedText
  case window
}

public enum ContextCaptureError: Error, Equatable, LocalizedError {
  case accessibilityPermissionDenied
  case cancelled
  case screenRecordingPermissionDenied
  case unavailable

  public var errorDescription: String? {
    switch self {
    case .accessibilityPermissionDenied:
      "Accessibility permission is required. Reopen Violet after granting it."
    case .cancelled:
      "Context selection was cancelled."
    case .screenRecordingPermissionDenied:
      "Screen Recording permission is required. Reopen Violet after granting it."
    case .unavailable:
      "No readable context is available."
    }
  }
}

@MainActor
public protocol ContextCapturePort: AnyObject {
  func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext
  func cancel()
  func prepareNaturalPointingCapture()
  func prepareSelectedTextCapture()
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

  public func prepareNaturalPointingCapture() {}

  public func prepareSelectedTextCapture() {}
}

struct ContextApplicationTarget: Equatable {
  let bundleIdentifier: String?
  let processIdentifier: pid_t
}

enum AccessibilitySelectionResult: Equatable {
  case secureField
  case text(String)
  case unavailable
}

@MainActor
public final class SystemContextCapture: NSObject, ContextCapturePort {
  private let accessibilityAccess: () -> Bool
  private let activeApplication: () -> ContextApplicationTarget?
  private let currentProcessIdentifier: pid_t
  private let excludedBundleIds: Set<String>
  private let focusedElementReader: (pid_t) -> AXUIElement?
  private var pickerContinuation: CheckedContinuation<SelectedFilter, Error>?
  private var regionSelector: RegionSelectionController?
  private var naturalPointingLocation: CGPoint?
  private var selectedTextElement: AXUIElement?
  private var selectedTextTarget: ContextApplicationTarget?
  private let selectionReader: (pid_t?, AXUIElement?) -> AccessibilitySelectionResult

  public convenience init(excludedBundleIds: Set<String> = defaultExcludedBundleIds) {
    self.init(
      excludedBundleIds: excludedBundleIds,
      currentProcessIdentifier: ProcessInfo.processInfo.processIdentifier,
      activeApplication: {
        guard let application = NSWorkspace.shared.frontmostApplication else {
          return nil
        }
        return ContextApplicationTarget(
          bundleIdentifier: application.bundleIdentifier,
          processIdentifier: application.processIdentifier
        )
      },
      accessibilityAccess: requestAccessibilityAccess,
      focusedElementReader: focusedAccessibilityElement,
      selectionReader: readAccessibilitySelection
    )
  }

  init(
    excludedBundleIds: Set<String>,
    currentProcessIdentifier: pid_t,
    activeApplication: @escaping () -> ContextApplicationTarget?,
    accessibilityAccess: @escaping () -> Bool,
    focusedElementReader: @escaping (pid_t) -> AXUIElement?,
    selectionReader: @escaping (pid_t?, AXUIElement?) -> AccessibilitySelectionResult
  ) {
    self.accessibilityAccess = accessibilityAccess
    self.activeApplication = activeApplication
    self.currentProcessIdentifier = currentProcessIdentifier
    self.excludedBundleIds = excludedBundleIds
    self.focusedElementReader = focusedElementReader
    self.selectionReader = selectionReader
    super.init()
  }

  public func prepareSelectedTextCapture() {
    guard
      let application = activeApplication(),
      application.processIdentifier != currentProcessIdentifier
    else {
      return
    }
    selectedTextTarget = application
    selectedTextElement = focusedElementReader(application.processIdentifier)
  }

  public func prepareNaturalPointingCapture() {
    prepareSelectedTextCapture()
    naturalPointingLocation = NSEvent.mouseLocation
  }

  public func capture(_ kind: ContextCaptureKind) async throws -> CapturedContext {
    switch kind {
    case .naturalPointing:
      return try await captureNaturalPointing()
    case .selectedText:
      return try captureSelectedText()
    case .window:
      return try await capturePickedWindow()
    case .region:
      guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
        throw ContextCaptureError.screenRecordingPermissionDenied
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
    selectedTextElement = nil
    selectedTextTarget = nil
    naturalPointingLocation = nil
    SCContentSharingPicker.shared.isActive = false
    SCContentSharingPicker.shared.remove(self)
  }

  private func captureSelectedText() throws -> CapturedContext {
    guard accessibilityAccess() else {
      throw ContextCaptureError.accessibilityPermissionDenied
    }
    let target =
      selectedTextTarget
      ?? activeApplication().flatMap {
        $0.processIdentifier == currentProcessIdentifier ? nil : $0
      }
    if let bundleIdentifier = target?.bundleIdentifier,
      excludedBundleIds.contains(bundleIdentifier)
    {
      throw LocalContextPrivacyError.blockedApplication
    }

    switch selectionReader(target?.processIdentifier, selectedTextElement) {
    case .secureField:
      throw LocalContextPrivacyError.blockedApplication
    case .unavailable:
      throw ContextCaptureError.unavailable
    case .text(let text):
      return .text(
        appBundleId: target?.bundleIdentifier,
        text: text
      )
    }
  }

  private func captureNaturalPointing() async throws -> CapturedContext {
    let target = selectedTextTarget ?? activeApplication()
    guard
      let target,
      target.processIdentifier != currentProcessIdentifier
    else {
      throw ContextCaptureError.unavailable
    }
    if let bundleIdentifier = target.bundleIdentifier,
      excludedBundleIds.contains(bundleIdentifier)
    {
      throw LocalContextPrivacyError.blockedApplication
    }

    if accessibilityAccess() {
      switch selectionReader(target.processIdentifier, selectedTextElement) {
      case .secureField:
        throw LocalContextPrivacyError.blockedApplication
      case .text(let text):
        return .text(appBundleId: target.bundleIdentifier, text: text)
      case .unavailable:
        break
      }
    }

    guard CGPreflightScreenCaptureAccess() else {
      throw ContextCaptureError.screenRecordingPermissionDenied
    }
    let content = try await SCShareableContent.excludingDesktopWindows(
      false,
      onScreenWindowsOnly: true
    )
    let pointer: CGPoint?
    if let naturalPointingLocation,
      let primaryScreenFrame = NSScreen.screens.first?.frame
    {
      pointer = screenCapturePoint(
        from: naturalPointingLocation,
        primaryScreenFrame: primaryScreenFrame
      )
    } else {
      pointer = nil
    }
    guard
      let window = preferredNaturalPointingWindow(
        content.windows,
        processIdentifier: target.processIdentifier,
        pointer: pointer
      )
    else {
      throw ContextCaptureError.unavailable
    }
    let focusPoint = pointer.flatMap { normalizedPoint($0, in: window.frame) }
    return try await capture(
      filter: SCContentFilter(desktopIndependentWindow: window),
      appBundleId: target.bundleIdentifier,
      focusPoint: focusPoint,
      region: nil
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
    return try await capture(
      filter: filter.value,
      appBundleId: nil,
      focusPoint: nil,
      region: nil
    )
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
    guard let primaryScreenFrame = NSScreen.screens.first?.frame else {
      throw ContextCaptureError.unavailable
    }
    let captureRect = screenCaptureRect(
      from: rect,
      primaryScreenFrame: primaryScreenFrame
    )
    let image: CGImage
    if #available(macOS 15.2, *) {
      image = try await SCScreenshotManager.captureImage(in: captureRect)
    } else {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )
      guard let display = content.displays.first(where: { $0.frame.intersects(captureRect) }) else {
        throw ContextCaptureError.unavailable
      }
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let configuration = SCStreamConfiguration()
      configuration.sourceRect = CGRect(
        x: captureRect.minX - display.frame.minX,
        y: captureRect.minY - display.frame.minY,
        width: captureRect.width,
        height: captureRect.height
      )
      configuration.width = min(Int(captureRect.width * 2), 2048)
      configuration.height = min(Int(captureRect.height * 2), 2048)
      image = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: configuration
      )
    }
    return try await makeCapturedImage(
      image,
      appBundleId: appBundleId,
      focusPoint: nil,
      region: normalized(rect)
    )
  }

  private func capture(
    filter: SCContentFilter,
    appBundleId: String?,
    focusPoint: NormalizedContextPoint?,
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
    return try await makeCapturedImage(
      image,
      appBundleId: appBundleId,
      focusPoint: focusPoint,
      region: region
    )
  }

  private func makeCapturedImage(
    _ image: CGImage,
    appBundleId: String?,
    focusPoint: NormalizedContextPoint?,
    region: NormalizedContextRect?
  ) async throws -> CapturedContext {
    let preparedImage = contextSizedImage(image)
    let sendableImage = SendableCGImage(value: preparedImage)
    async let data = Task.detached(priority: .userInitiated) {
      try encodeContextImage(sendableImage.value)
    }.value
    async let recognizedText = Task.detached(priority: .userInitiated) {
      recognizeText(in: sendableImage.value)
    }.value
    let encodedData = try await data
    let observations = await recognizedText
    return .image(
      appBundleId: appBundleId,
      data: encodedData,
      focusPoint: focusPoint,
      height: preparedImage.height,
      recognizedText: observations,
      region: region,
      width: preparedImage.width
    )
  }
}

private func requestAccessibilityAccess() -> Bool {
  if AXIsProcessTrusted() {
    return true
  }
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
  _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
  return false
}

private func focusedAccessibilityElement(processIdentifier: pid_t) -> AXUIElement? {
  let application = AXUIElementCreateApplication(processIdentifier)
  var focusedValue: CFTypeRef?
  let initialApplicationFocusedResult = AXUIElementCopyAttributeValue(
    application,
    kAXFocusedUIElementAttribute as CFString,
    &focusedValue
  )
  var applicationFocusedResult = initialApplicationFocusedResult
  if applicationFocusedResult != .success {
    let manualAccessibilityResult = AXUIElementSetAttributeValue(
      application,
      "AXManualAccessibility" as CFString,
      kCFBooleanTrue
    )
    if manualAccessibilityResult == .success {
      focusedValue = nil
      applicationFocusedResult = AXUIElementCopyAttributeValue(
        application,
        kAXFocusedUIElementAttribute as CFString,
        &focusedValue
      )
    }
  }
  guard
    applicationFocusedResult == .success,
    let focusedValue
  else {
    return nil
  }
  return unsafeDowncast(focusedValue, to: AXUIElement.self)
}

private func readAccessibilitySelection(
  processIdentifier: pid_t?,
  preparedElement: AXUIElement?
) -> AccessibilitySelectionResult {
  let element: AXUIElement
  let focusedResult: AXError
  if let preparedElement {
    element = preparedElement
    focusedResult = .success
  } else {
    let root =
      processIdentifier.map(AXUIElementCreateApplication)
      ?? AXUIElementCreateSystemWide()
    var focusedValue: CFTypeRef?
    focusedResult = AXUIElementCopyAttributeValue(
      root,
      kAXFocusedUIElementAttribute as CFString,
      &focusedValue
    )
    guard focusedResult == .success, let focusedValue else {
      return .unavailable
    }
    element = unsafeDowncast(focusedValue, to: AXUIElement.self)
  }
  var roleValue: CFTypeRef?
  let roleResult = AXUIElementCopyAttributeValue(
    element,
    kAXRoleAttribute as CFString,
    &roleValue
  )
  if roleResult == .success,
    let role = roleValue as? String,
    role == "AXSecureTextField"
  {
    return .secureField
  }

  var selectedValue: CFTypeRef?
  let selectedResult = AXUIElementCopyAttributeValue(
    element,
    kAXSelectedTextAttribute as CFString,
    &selectedValue
  )
  if selectedResult == .success,
    let text = selectedValue as? String,
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  {
    return .text(text)
  }

  var value: CFTypeRef?
  var rangeValue: CFTypeRef?
  let valueResult = AXUIElementCopyAttributeValue(
    element,
    kAXValueAttribute as CFString,
    &value
  )
  let rangeResult = AXUIElementCopyAttributeValue(
    element,
    kAXSelectedTextRangeAttribute as CFString,
    &rangeValue
  )
  guard
    valueResult == .success,
    let text = value as? String,
    rangeResult == .success,
    let rangeValue,
    CFGetTypeID(rangeValue) == AXValueGetTypeID()
  else {
    return .unavailable
  }
  let rangeAXValue = unsafeDowncast(rangeValue, to: AXValue.self)
  var range = CFRange()
  guard
    AXValueGetType(rangeAXValue) == .cfRange,
    AXValueGetValue(rangeAXValue, .cfRange, &range),
    range.location >= 0,
    range.length > 0,
    range.location + range.length <= (text as NSString).length
  else {
    return .unavailable
  }
  let selectedText = (text as NSString).substring(
    with: NSRange(location: range.location, length: range.length)
  )
  return selectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    ? .unavailable
    : .text(selectedText)
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

private struct SendableCGImage: @unchecked Sendable {
  let value: CGImage
}

private func contextSizedImage(_ image: CGImage) -> CGImage {
  let maximumDimension = 2_048
  let largestDimension = max(image.width, image.height)
  guard largestDimension > maximumDimension else {
    return image
  }
  let scale = Double(maximumDimension) / Double(largestDimension)
  let width = max(1, Int((Double(image.width) * scale).rounded()))
  let height = max(1, Int((Double(image.height) * scale).rounded()))
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
    return image
  }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return context.makeImage() ?? image
}

private func encodeContextImage(_ image: CGImage) throws -> Data {
  guard
    let data = NSBitmapImageRep(cgImage: image).representation(
      using: .jpeg,
      properties: [.compressionFactor: 0.85]
    ),
    data.count <= 8 * 1024 * 1024
  else {
    throw LocalContextPrivacyError.imageEncodingFailed
  }
  return data
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

func normalizedPoint(
  _ point: CGPoint,
  in frame: CGRect
) -> NormalizedContextPoint? {
  guard frame.width > 0, frame.height > 0, frame.contains(point) else {
    return nil
  }
  return .init(
    x: (point.x - frame.minX) / frame.width,
    y: (point.y - frame.minY) / frame.height
  )
}

private func preferredNaturalPointingWindow(
  _ windows: [SCWindow],
  processIdentifier: pid_t,
  pointer: CGPoint?
) -> SCWindow? {
  let candidates = windows.filter {
    $0.owningApplication?.processID == processIdentifier
      && $0.isOnScreen
      && $0.windowLayer == 0
      && $0.frame.width >= 4
      && $0.frame.height >= 4
  }
  if let pointer,
    let pointed = candidates.first(where: { $0.frame.contains(pointer) })
  {
    return pointed
  }
  return candidates.max {
    $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
  }
}

func screenCapturePoint(
  from appKitPoint: CGPoint,
  primaryScreenFrame: CGRect
) -> CGPoint {
  return CGPoint(
    x: appKitPoint.x,
    y: primaryScreenFrame.maxY - appKitPoint.y
  )
}

func screenCaptureRect(
  from appKitRect: CGRect,
  primaryScreenFrame: CGRect
) -> CGRect {
  CGRect(
    x: appKitRect.minX,
    y: primaryScreenFrame.maxY - appKitRect.maxY,
    width: appKitRect.width,
    height: appKitRect.height
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
