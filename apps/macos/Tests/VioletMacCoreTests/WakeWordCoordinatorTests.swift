import Foundation
import Testing

@testable import VioletMacCore

@Suite("Wake word coordinator")
struct WakeWordCoordinatorTests {
  @Test
  @MainActor
  func remainsDisabledUntilTheUserOptsIn() {
    let defaults = isolatedDefaults()
    let detector = FakeWakeWordDetector()
    let coordinator = WakeWordCoordinator(
      detector: detector,
      defaults: defaults
    )

    coordinator.resume()

    #expect(coordinator.state == .disabled)
    #expect(detector.startCount == 0)
  }

  @Test
  @MainActor
  func enablesLocalDetectionAndPausesAfterWake() async throws {
    let defaults = isolatedDefaults()
    let detector = FakeWakeWordDetector()
    let coordinator = WakeWordCoordinator(
      detector: detector,
      defaults: defaults
    )
    var detectionCount = 0
    coordinator.onDetection = {
      detectionCount += 1
    }

    coordinator.setEnabled(true)
    try await waitUntil { coordinator.state == .listening }
    detector.trigger()

    #expect(detectionCount == 1)
    #expect(coordinator.state == .paused)
    #expect(!detector.isRunning)
    #expect(defaults.bool(forKey: "violet.wake-word-enabled"))
  }

  @Test
  @MainActor
  func reportsPermissionDenialWithoutStartingTheDetector() async throws {
    let defaults = isolatedDefaults()
    let detector = FakeWakeWordDetector(accessAllowed: false)
    let coordinator = WakeWordCoordinator(
      detector: detector,
      defaults: defaults
    )

    coordinator.setEnabled(true)
    try await waitUntil {
      if case .unavailable = coordinator.state {
        return true
      }
      return false
    }

    #expect(detector.startCount == 0)
    #expect(!detector.isRunning)
  }
}

@MainActor
private final class FakeWakeWordDetector: WakeWordDetectorPort {
  private let accessAllowed: Bool
  private var detection: (@MainActor @Sendable () -> Void)?
  private(set) var isRunning = false
  private(set) var startCount = 0

  init(accessAllowed: Bool = true) {
    self.accessAllowed = accessAllowed
  }

  func requestAccess() async -> Bool {
    accessAllowed
  }

  func start(onDetection: @escaping @MainActor @Sendable () -> Void) {
    detection = onDetection
    isRunning = true
    startCount += 1
  }

  func stop() {
    isRunning = false
  }

  func trigger() {
    detection?()
  }
}

private func isolatedDefaults() -> UserDefaults {
  let name = "violet-wake-word-tests-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: name) ?? .standard
  defaults.removePersistentDomain(forName: name)
  return defaults
}

@MainActor
private func waitUntil(
  timeout: Duration = .seconds(1),
  condition: @escaping @MainActor () -> Bool
) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: timeout)
  while !condition() {
    guard clock.now < deadline else {
      Issue.record("Condition was not met")
      return
    }
    try await clock.sleep(for: .milliseconds(10))
  }
}
