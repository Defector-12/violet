import Foundation
import Security

public enum DeviceTokenError: Error, Equatable, LocalizedError {
  case invalidValue
  case notFound
  case unexpectedStatus(OSStatus)

  public var errorDescription: String? {
    switch self {
    case .invalidValue:
      "The Violet device token is invalid."
    case .notFound:
      "The Violet device token is not available in Keychain."
    case .unexpectedStatus(let status):
      "Keychain returned status \(status)."
    }
  }
}

public protocol DeviceTokenProvider: Sendable {
  func deviceToken() throws -> String
}

public struct KeychainDeviceTokenProvider: DeviceTokenProvider {
  private let account: String
  private let service: String

  public init(
    service: String = "com.violet.device-token",
    account: String = "violet"
  ) {
    self.service = service
    self.account = account
  }

  public func deviceToken() throws -> String {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
      kSecMatchLimit: kSecMatchLimitOne,
      kSecReturnData: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      throw DeviceTokenError.notFound
    }
    guard status == errSecSuccess else {
      throw DeviceTokenError.unexpectedStatus(status)
    }
    guard
      let data = item as? Data,
      let token = String(data: data, encoding: .utf8)?.trimmingCharacters(
        in: .whitespacesAndNewlines),
      token.count >= 32
    else {
      throw DeviceTokenError.invalidValue
    }
    return token
  }

  public func store(deviceToken: String) throws {
    let token = deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)
    guard token.count >= 32, let data = token.data(using: .utf8) else {
      throw DeviceTokenError.invalidValue
    }

    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
    ]
    let updateStatus = SecItemUpdate(
      query as CFDictionary,
      [kSecValueData: data] as CFDictionary
    )
    if updateStatus == errSecSuccess {
      return
    }
    guard updateStatus == errSecItemNotFound else {
      throw DeviceTokenError.unexpectedStatus(updateStatus)
    }

    var item = query
    item[kSecValueData] = data
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw DeviceTokenError.unexpectedStatus(addStatus)
    }
  }
}

public struct RuntimeDeviceTokenProvider: DeviceTokenProvider {
  private let environment: [String: String]
  private let keychain: KeychainDeviceTokenProvider

  public init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    keychain: KeychainDeviceTokenProvider = .init()
  ) {
    self.environment = environment
    self.keychain = keychain
  }

  public func deviceToken() throws -> String {
    if let token = environment["VIOLET_DEVICE_TOKEN"]?.trimmingCharacters(
      in: .whitespacesAndNewlines
    ), token.count >= 32 {
      return token
    }
    return try keychain.deviceToken()
  }
}

public struct VioletRuntimeConfiguration: Equatable, Sendable {
  public let coreURL: URL
  public let excludedContextBundleIds: Set<String>
  public let sshTunnel: SSHTunnelConfiguration?
  public let testMode: Bool

  public init(
    coreURL: URL,
    excludedContextBundleIds: Set<String> = [],
    testMode: Bool,
    sshTunnel: SSHTunnelConfiguration? = nil
  ) {
    self.coreURL = coreURL
    self.excludedContextBundleIds = excludedContextBundleIds
    self.sshTunnel = sshTunnel
    self.testMode = testMode
  }

  public init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    configurationFileURL: URL? = nil
  ) throws {
    let fileURL =
      configurationFileURL
      ?? environment["VIOLET_CLIENT_CONFIG"].map(URL.init(fileURLWithPath:))
      ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".config/violet/client.json")
    let fileConfiguration = try loadClientConfiguration(from: fileURL)
    let environmentTunnel = environment["VIOLET_SSH_HOST"].map {
      SSHTunnelConfiguration(host: $0)
    }
    sshTunnel = environmentTunnel ?? fileConfiguration?.sshTunnel

    let rawURL =
      environment["VIOLET_CORE_URL"]
      ?? fileConfiguration?.coreURL
      ?? "http://127.0.0.1:\(sshTunnel?.localPort ?? 14_310)"
    guard
      let coreURL = URL(string: rawURL),
      let scheme = coreURL.scheme,
      ["http", "https"].contains(scheme),
      coreURL.host != nil
    else {
      throw VioletCoreClientError.invalidResponse
    }
    self.coreURL = coreURL
    excludedContextBundleIds = Set(fileConfiguration?.excludedContextBundleIds ?? [])
    testMode = environment["VIOLET_TEST_MODE"] == "1"
  }
}

private struct ClientConfigurationFile: Decodable {
  let coreURL: String?
  let excludedContextBundleIds: [String]?
  let sshTunnel: SSHTunnelConfiguration?
}

private func loadClientConfiguration(from url: URL) throws -> ClientConfigurationFile? {
  guard FileManager.default.fileExists(atPath: url.path) else {
    return nil
  }
  return try JSONDecoder().decode(
    ClientConfigurationFile.self,
    from: Data(contentsOf: url)
  )
}
