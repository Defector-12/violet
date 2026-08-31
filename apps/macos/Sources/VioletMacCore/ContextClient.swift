import CryptoKit
import Foundation

public enum ContextPayload: Equatable, Sendable {
  case appState(bundleId: String, appName: String?)
  case image(
    data: Data,
    focusPoint: NormalizedContextPoint?,
    height: Int,
    localText: String?,
    mediaType: String,
    region: NormalizedContextRect?,
    sha256: String,
    width: Int
  )
  case text(String)
}

public struct NormalizedContextPoint: Codable, Equatable, Sendable {
  public let x: Double
  public let y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

public struct NormalizedContextRect: Codable, Equatable, Sendable {
  public let height: Double
  public let width: Double
  public let x: Double
  public let y: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

public struct ContextRedaction: Codable, Equatable, Sendable {
  public enum Category: String, Codable, Sendable {
    case absoluteSecret = "absolute_secret"
    case controlledSensitive = "controlled_sensitive"
    case secureField = "secure_field"
  }

  public let category: Category
  public let count: Int

  public init(category: Category, count: Int) {
    self.category = category
    self.count = count
  }
}

public struct FilteredContext: Equatable, Sendable {
  public let appBundleId: String?
  public let completeness: Double
  public let confidence: Double
  public let payload: ContextPayload
  public let redactions: [ContextRedaction]
  public let sensitivity: String

  public init(
    appBundleId: String?,
    completeness: Double,
    confidence: Double,
    payload: ContextPayload,
    redactions: [ContextRedaction],
    sensitivity: String
  ) {
    self.appBundleId = appBundleId
    self.completeness = completeness
    self.confidence = confidence
    self.payload = payload
    self.redactions = redactions
    self.sensitivity = sensitivity
  }
}

public struct ContextReceipt: Equatable, Sendable {
  public let expiresAt: Date
  public let sessionId: UUID
}

public struct LocalDeviceIdentity {
  private let defaults: UserDefaults
  private let key: String

  public init(
    defaults: UserDefaults = .standard,
    key: String = "violet.device-id"
  ) {
    self.defaults = defaults
    self.key = key
  }

  public func deviceId() -> UUID {
    if let value = defaults.string(forKey: key),
      let id = UUID(uuidString: value)
    {
      return id
    }
    let id = UUID()
    defaults.set(id.uuidString.lowercased(), forKey: key)
    return id
  }
}

public protocol ContextClientPort: Sendable {
  func deleteContext(sessionId: UUID) async
  func submitContext(
    _ context: FilteredContext,
    deviceId: UUID,
    sessionId: UUID
  ) async throws -> ContextReceipt
}

public actor SilentContextClient: ContextClientPort {
  public private(set) var submittedContextCount = 0

  public init() {}

  public func submitContext(
    _ context: FilteredContext,
    deviceId: UUID,
    sessionId: UUID
  ) async throws -> ContextReceipt {
    submittedContextCount += 1
    return ContextReceipt(
      expiresAt: Date().addingTimeInterval(300),
      sessionId: sessionId
    )
  }

  public func deleteContext(sessionId: UUID) async {}
}

public actor URLSessionContextClient: ContextClientPort {
  private let coreURL: URL
  private let deviceToken: String
  private let session: URLSession

  public init(
    coreURL: URL,
    deviceToken: String,
    session: URLSession = .shared
  ) {
    self.coreURL = coreURL
    self.deviceToken = deviceToken
    self.session = session
  }

  public func submitContext(
    _ context: FilteredContext,
    deviceId: UUID,
    sessionId: UUID
  ) async throws -> ContextReceipt {
    let envelope = makeContextEnvelope(
      context,
      deviceId: deviceId,
      sessionId: sessionId
    )
    var request = URLRequest(url: contextURL(path: "/v1/context/envelopes"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(envelope)

    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw VioletCoreClientError.invalidResponse
    }
    guard http.statusCode == 200 else {
      throw VioletCoreClientError.requestFailed(code: http.statusCode)
    }
    let receipt = try JSONDecoder().decode(ContextReceiptWire.self, from: data)
    guard
      let id = UUID(uuidString: receipt.sessionId),
      let expiresAt = parseISO8601(receipt.expiresAt)
    else {
      throw VioletCoreClientError.invalidResponse
    }
    return ContextReceipt(expiresAt: expiresAt, sessionId: id)
  }

  public func deleteContext(sessionId: UUID) async {
    var request = URLRequest(
      url: contextURL(path: "/v1/context/sessions/\(sessionId.uuidString.lowercased())")
    )
    request.httpMethod = "DELETE"
    request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
    _ = try? await session.data(for: request)
  }

  private func contextURL(path: String) -> URL {
    var components = URLComponents(url: coreURL, resolvingAgainstBaseURL: false)
    components?.path = path
    components?.query = nil
    components?.fragment = nil
    return components?.url ?? coreURL
  }
}

struct ContextEnvelopeWire: Encodable {
  struct Authorization: Encodable {
    let controlledSensitiveAllowed: Bool
    let grantId: UUID
    let mode: String
    let purpose: String
    let retention: String
  }

  struct Source: Encodable {
    let appBundleId: String?
    let deviceId: UUID
    let modality: String
  }

  let authorization: Authorization
  let capturedAt: String
  let completeness: Double
  let confidence: Double
  let eventId: UUID
  let expiresAt: String
  let payload: ContextPayloadWire
  let protocolVersion: String
  let redactions: [ContextRedaction]
  let sensitivity: String
  let sequence: Int
  let sessionId: String
  let source: Source
}

enum ContextPayloadWire: Encodable {
  case appState(bundleId: String, appName: String?)
  case image(
    data: Data,
    focusPoint: NormalizedContextPoint?,
    height: Int,
    localText: String?,
    mediaType: String,
    region: NormalizedContextRect?,
    sha256: String,
    width: Int
  )
  case text(String)

  init(_ payload: ContextPayload) {
    switch payload {
    case .appState(let bundleId, let appName):
      self = .appState(bundleId: bundleId, appName: appName)
    case .image(
      let data,
      let focusPoint,
      let height,
      let localText,
      let mediaType,
      let region,
      let sha256,
      let width):
      self = .image(
        data: data,
        focusPoint: focusPoint,
        height: height,
        localText: localText,
        mediaType: mediaType,
        region: region,
        sha256: sha256,
        width: width
      )
    case .text(let text):
      self = .text(text)
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .appState(let bundleId, let appName):
      try container.encode(bundleId, forKey: .appBundleId)
      try container.encodeIfPresent(appName, forKey: .appName)
      try container.encode("app.state", forKey: .type)
    case .image(
      let data,
      let focusPoint,
      let height,
      let localText,
      let mediaType,
      let region,
      let sha256,
      let width):
      try container.encodeIfPresent(focusPoint, forKey: .focusPoint)
      try container.encode(
        ImageWire(
          data: data.base64EncodedString(),
          height: height,
          mediaType: mediaType,
          sha256: sha256,
          width: width
        ),
        forKey: .image
      )
      try container.encodeIfPresent(localText, forKey: .localText)
      if let region {
        try container.encode(region, forKey: .region)
        try container.encode("focus.region", forKey: .type)
      } else {
        try container.encode("screen.snapshot", forKey: .type)
      }
    case .text(let text):
      try container.encode(text, forKey: .text)
      try container.encode("focus.text", forKey: .type)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case appBundleId
    case appName
    case focusPoint
    case image
    case localText
    case region
    case text
    case type
  }
}

struct ImageWire: Encodable {
  let data: String
  let height: Int
  let mediaType: String
  let sha256: String
  let width: Int
}

private struct ContextReceiptWire: Decodable {
  let expiresAt: String
  let sessionId: String
}

extension ContextPayload {
  fileprivate var modality: String {
    switch self {
    case .appState, .text:
      "accessibility"
    case .image:
      "screen"
    }
  }
}

func makeContextEnvelope(
  _ context: FilteredContext,
  deviceId: UUID,
  sessionId: UUID,
  capturedAt: Date = Date()
) -> ContextEnvelopeWire {
  ContextEnvelopeWire(
    authorization: .init(
      controlledSensitiveAllowed: false,
      grantId: UUID(),
      mode: "explicit",
      purpose: "conversation",
      retention: "ephemeral"
    ),
    capturedAt: iso8601String(capturedAt),
    completeness: context.completeness,
    confidence: context.confidence,
    eventId: UUID(),
    expiresAt: iso8601String(capturedAt.addingTimeInterval(300)),
    payload: .init(context.payload),
    protocolVersion: "1",
    redactions: context.redactions,
    sensitivity: context.sensitivity,
    sequence: 1,
    sessionId: sessionId.uuidString.lowercased(),
    source: .init(
      appBundleId: context.appBundleId,
      deviceId: deviceId,
      modality: context.payload.modality
    )
  )
}

private func iso8601String(_ date: Date) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: date)
}

func parseISO8601(_ value: String) -> Date? {
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

public func contextImageHash(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
