import Combine
import Foundation

public enum WakeWordState: Equatable, Sendable {
  case disabled
  case listening
  case paused
  case unavailable(message: String)
}

@MainActor
public final class WakeWordCoordinator: ObservableObject {
  @Published public private(set) var isEnabled: Bool
  @Published public private(set) var state: WakeWordState

  public var onDetection: (@MainActor @Sendable () -> Void)?

  private let defaults: UserDefaults
  private let detector: any WakeWordDetectorPort
  private let preferenceKey: String
  private var startTask: Task<Void, Never>?

  public init(
    detector: any WakeWordDetectorPort,
    defaults: UserDefaults = .standard,
    preferenceKey: String = "violet.wake-word-enabled"
  ) {
    self.defaults = defaults
    self.detector = detector
    self.preferenceKey = preferenceKey
    let enabled = defaults.bool(forKey: preferenceKey)
    isEnabled = enabled
    state = enabled ? .paused : .disabled
  }

  deinit {
    startTask?.cancel()
  }

  public func setEnabled(_ enabled: Bool) {
    isEnabled = enabled
    defaults.set(enabled, forKey: preferenceKey)
    if enabled {
      resume()
    } else {
      startTask?.cancel()
      startTask = nil
      detector.stop()
      state = .disabled
    }
  }

  public func resume() {
    guard isEnabled, !detector.isRunning, startTask == nil else {
      return
    }
    state = .paused
    startTask = Task { [weak self, detector] in
      guard let self else {
        return
      }
      let allowed = await detector.requestAccess()
      guard !Task.isCancelled, self.isEnabled else {
        self.startTask = nil
        return
      }
      guard allowed else {
        self.state = .unavailable(message: "Microphone access is required for wake word.")
        self.startTask = nil
        return
      }
      do {
        try detector.start { [weak self] in
          guard let self, self.isEnabled else {
            return
          }
          self.detector.stop()
          self.state = .paused
          self.onDetection?()
        }
        self.state = .listening
      } catch {
        self.state = .unavailable(
          message: (error as? LocalizedError)?.errorDescription
            ?? "Wake word is unavailable."
        )
      }
      self.startTask = nil
    }
  }

  public func suspend() {
    startTask?.cancel()
    startTask = nil
    detector.stop()
    state = isEnabled ? .paused : .disabled
  }
}
