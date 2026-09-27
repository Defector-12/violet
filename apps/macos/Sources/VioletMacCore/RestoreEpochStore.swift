import Foundation
import Security

public struct RestoreEpochRecord: Codable, Equatable, Sendable {
  public let instanceId: String
  public var minimumRestoreEpoch: Int
  public var pendingDeletionId: String?
  public var lastDeletionId: String?

  public init(instanceId: String, minimumRestoreEpoch: Int = 0,
    pendingDeletionId: String? = nil, lastDeletionId: String? = nil
  ) {
    self.instanceId = instanceId.lowercased()
    self.minimumRestoreEpoch = minimumRestoreEpoch
    self.pendingDeletionId = pendingDeletionId
    self.lastDeletionId = lastDeletionId
  }

  func validated(for instanceId: String) throws -> Self {
    guard UUID(uuidString: self.instanceId) != nil,
      self.instanceId == instanceId.lowercased(),
      minimumRestoreEpoch >= 0,
      minimumRestoreEpoch <= 9_007_199_254_740_991,
      pendingDeletionId.map({ UUID(uuidString: $0) != nil }) ?? true,
      lastDeletionId.map({ UUID(uuidString: $0) != nil }) ?? true
    else { throw RestoreEpochError.invalidRecord }
    return self
  }
}

public enum RestoreEpochError: Error, LocalizedError {
  case invalidRecord
  case keychain(OSStatus)
  case pendingDeletion
  case protectionBusy

  public var errorDescription: String? {
    switch self {
    case .invalidRecord: "恢复保护记录缺失或不匹配，操作已停止。"
    case .keychain(let status): "无法保存 Keychain 恢复保护（\(status)），尚未发送新的删除请求。"
    case .pendingDeletion: "上一次删除尚未确认完成，请先重试该请求。"
    case .protectionBusy: "恢复保护正被另一操作使用或暂时不可用，请稍后重试。"
    }
  }
}

@MainActor
public protocol RestoreEpochStore: AnyObject {
  func load(instanceId: String) throws -> RestoreEpochRecord?
  @discardableResult func save(_ record: RestoreEpochRecord) throws -> RestoreEpochRecord
}

/// A single instance is shared by the Mac management model. No semantic content is stored.
@MainActor
public final class KeychainRestoreEpochStore: RestoreEpochStore {
  public static let service = "com.violet.restore-epoch"

  public init() {}

  public func load(instanceId: String) throws -> RestoreEpochRecord? {
    guard UUID(uuidString: instanceId) != nil else { throw RestoreEpochError.invalidRecord }
    var query = key(instanceId)
    query[kSecMatchLimit] = kSecMatchLimitOne
    query[kSecReturnData] = true
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw RestoreEpochError.keychain(status) }
    guard let data = item as? Data else { throw RestoreEpochError.invalidRecord }
    return try JSONDecoder().decode(RestoreEpochRecord.self, from: data).validated(for: instanceId)
  }

  @discardableResult
  public func save(_ record: RestoreEpochRecord) throws -> RestoreEpochRecord {
    try withRestoreEpochLock(instanceId: record.instanceId) {
      var next = try record.validated(for: record.instanceId)
      let previous = try load(instanceId: next.instanceId)
      next.minimumRestoreEpoch = max(next.minimumRestoreEpoch, previous?.minimumRestoreEpoch ?? 0)
      let data = try JSONEncoder().encode(next)
      let query = key(next.instanceId)
      let update = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
      if update == errSecItemNotFound {
        var item = query
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let add = SecItemAdd(item as CFDictionary, nil)
        guard add == errSecSuccess else { throw RestoreEpochError.keychain(add) }
      } else if update != errSecSuccess {
        throw RestoreEpochError.keychain(update)
      }
      // Never send a confirmation based solely on an attempted Keychain write.
      guard try load(instanceId: next.instanceId) == next else { throw RestoreEpochError.invalidRecord }
      return next
    }
  }

  private func key(_ instanceId: String) -> [CFString: Any] {
    [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: instanceId.lowercased(),
    ]
  }
}
