import Carbon
import Foundation

@MainActor
public protocol GlobalShortcutPort: AnyObject {
  func start(action: @escaping @MainActor () -> Void) throws
  func stop()
}

@MainActor
public final class SilentGlobalShortcut: GlobalShortcutPort {
  public private(set) var startCount = 0

  public init() {}

  public func start(action: @escaping @MainActor () -> Void) {
    startCount += 1
  }

  public func stop() {}
}

@MainActor
public final class CarbonGlobalShortcut: GlobalShortcutPort, @unchecked Sendable {
  private var action: (@MainActor () -> Void)?
  private var eventHandler: EventHandlerRef?
  private var hotKey: EventHotKeyRef?

  public init() {}

  public func start(action: @escaping @MainActor () -> Void) throws {
    stop()
    self.action = action

    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )
    let status = InstallEventHandler(
      GetApplicationEventTarget(),
      Self.eventCallback,
      1,
      &eventType,
      Unmanaged.passUnretained(self).toOpaque(),
      &eventHandler
    )
    guard status == noErr else {
      throw GlobalShortcutError.registrationFailed(status)
    }

    let identifier = EventHotKeyID(
      signature: fourCharacterCode("VLT1"),
      id: 1
    )
    let modifiers = UInt32(controlKey | optionKey)
    let hotKeyStatus = RegisterEventHotKey(
      UInt32(kVK_Space),
      modifiers,
      identifier,
      GetApplicationEventTarget(),
      0,
      &hotKey
    )
    guard hotKeyStatus == noErr else {
      stop()
      throw GlobalShortcutError.registrationFailed(hotKeyStatus)
    }
  }

  public func stop() {
    if let hotKey {
      UnregisterEventHotKey(hotKey)
      self.hotKey = nil
    }
    if let eventHandler {
      RemoveEventHandler(eventHandler)
      self.eventHandler = nil
    }
    action = nil
  }

  private func trigger() {
    action?()
  }

  private nonisolated static let eventCallback: EventHandlerUPP = {
    _, _, userData in
    guard let userData else {
      return OSStatus(eventNotHandledErr)
    }
    let shortcut = Unmanaged<CarbonGlobalShortcut>
      .fromOpaque(userData)
      .takeUnretainedValue()
    DispatchQueue.main.async {
      shortcut.trigger()
    }
    return noErr
  }
}

public enum GlobalShortcutError: Error, Equatable {
  case registrationFailed(OSStatus)
}

private func fourCharacterCode(_ value: String) -> OSType {
  value.utf8.reduce(0) { result, character in
    (result << 8) + OSType(character)
  }
}
