import Foundation
import VioletMacCore

// Explicit developer command, never invoked by the application or wake-word loop.
@main
enum ContextReplayCapture {
  @MainActor
  static func main() async throws {
    let arguments = CommandLine.arguments
    if arguments.count == 3, arguments[1] == "--purge-expired" {
      try NaturalPointingReplayRecorder.removeExpiredCase(
        in: URL(fileURLWithPath: arguments[2], isDirectory: true)
      )
      return
    }
    guard arguments.count == 4 || arguments.count == 6, arguments[1] == "--record" else {
      throw CaptureError.usage
    }
    var replayPoint: NormalizedContextPoint?
    if arguments.count == 6 {
      let parts = arguments[5].split(separator: ",", omittingEmptySubsequences: false)
      let coordinates = parts.compactMap { Double($0) }
      guard arguments[4] == "--point", parts.count == 2, coordinates.count == 2,
        coordinates.allSatisfy({ $0.isFinite && (0...1).contains($0) })
      else {
        throw CaptureError.usage
      }
      replayPoint = .init(x: coordinates[0], y: coordinates[1])
    }
    let directory = URL(fileURLWithPath: arguments[2], isDirectory: true)
    guard !FileManager.default.fileExists(atPath: directory.path) else {
      throw CaptureError.existingDirectory
    }
    let excluded = defaultExcludedBundleIds.union(
      try VioletRuntimeConfiguration().excludedContextBundleIds
    )
    let capture = SystemContextCapture(excludedBundleIds: excluded)
    guard capture.prepareNaturalPointingCapture() else {
      throw ContextCaptureError.unavailable
    }
    let captured = try await capture.capture(.naturalPointing)
    guard
      case .image(
        let app, let data, let point, let height, let recognizedText, let region, let width) =
        captured
    else {
      throw CaptureError.notImage
    }
    let focusPoint = replayPoint ?? point
    let filter = LocalContextPrivacyFilter(excludedBundleIds: excluded)
    let filtered = try filter.filter(
      .image(
        appBundleId: app, data: data, focusPoint: focusPoint, height: height,
        recognizedText: recognizedText, region: region, width: width
      )
    )
    try NaturalPointingReplayRecorder(directory: directory).record(
      context: filtered, question: arguments[3], turnId: UUID()
    )
  }
}

private enum CaptureError: Error {
  case usage
  case existingDirectory
  case notImage
}
