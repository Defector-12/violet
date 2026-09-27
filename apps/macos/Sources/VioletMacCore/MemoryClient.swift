import Foundation
import VioletProtocolClient

public typealias VioletMemory = Components.Schemas.memory
public typealias MemoryList = Components.Schemas.list
public typealias MemoryDetail = Components.Schemas.detail
public typealias MemoryChange = Components.Schemas.change
public typealias MemoryDeletionPreview = Components.Schemas.preview
public typealias MemoryDeletionStatus = Components.Schemas.deletionStatus

public extension MemoryDeletionPreview {
  func retainsSources(for memory: VioletMemory) -> Bool {
    memory.sources.contains { !eventIds.contains($0.eventId) }
  }
}

public enum MemoryDeletionTarget: Sendable {
  case memory(id: String, version: Int)
  case source(eventId: String)
  case all

  fileprivate var wire: Components.Schemas.target {
    switch self {
    case .memory(let id, let version):
      .case1(.init(kind: "memory", id: id, version: version))
    case .source(let eventId):
      .case2(.init(kind: "source", eventId: eventId))
    case .all:
      .case3(.init(kind: "all"))
    }
  }
}

public enum MemoryClientError: Error, LocalizedError {
  case conflict
  case unavailable

  public var errorDescription: String? {
    switch self {
    case .conflict: "内容或删除范围已变化，请刷新后重新查看。"
    case .unavailable: "记忆服务暂时不可用，请检查连接后重试。"
    }
  }
}

public protocol MemoryClientPort: Sendable {
  func list() async throws -> MemoryList
  func detail(id: String, reveal: Bool) async throws -> MemoryDetail
  func correct(id: String, requestId: String, version: Int, content: String) async throws
  func preview(id: String, target: MemoryDeletionTarget) async throws -> MemoryDeletionPreview
  func preview(id: String) async throws -> MemoryDeletionPreview
  func confirm(id: String, instanceId: String, minimumEpoch: Int) async throws -> MemoryDeletionStatus
  func status(id: String, retry: Bool) async throws -> MemoryDeletionStatus
}

public struct GeneratedMemoryClient: MemoryClientPort {
  private let client: Client
  private let serverURL: URL
  private let deviceToken: String
  private let testTrace: TestTraceRecorder?

  public init(serverURL: URL, deviceToken: String, testTrace: TestTraceRecorder? = nil) {
    self.serverURL = serverURL
    self.deviceToken = deviceToken
    self.testTrace = testTrace
    client = VioletProtocolClientFactory.make(
      serverURL: serverURL, deviceToken: deviceToken,
      testRunId: testTrace?.runId, testRunActiveUntil: testTrace?.activeUntil
    )
  }

  public func list() async throws -> MemoryList {
    try await traced("list") {
      try await client.listMemories(.init()).ok.body.json
    }
  }

  public func detail(id: String, reveal: Bool) async throws -> MemoryDetail {
    try await traced("detail", id: id) {
      try await client.getMemory(.init(path: .init(memoryId: id), query: .init(reveal: reveal))).ok.body.json
    }
  }

  public func correct(id: String, requestId: String, version: Int, content: String) async throws {
    try await traced("correct", id: requestId) {
      let output = try await client.correctMemory(.init(
        path: .init(memoryId: id),
        body: .json(.init(requestId: requestId, expectedVersion: version, content: content))
      ))
      if case .conflict = output { throw MemoryClientError.conflict }
      _ = try output.ok.body.json
    }
  }

  public func preview(id: String, target: MemoryDeletionTarget) async throws -> MemoryDeletionPreview {
    try await traced("preview", id: id) {
      let output = try await client.previewMemoryDeletion(.init(
        body: .json(.init(id: id, target: target.wire))
      ))
      if case .conflict = output { throw MemoryClientError.conflict }
      return try output.ok.body.json
    }
  }

  public func preview(id: String) async throws -> MemoryDeletionPreview {
    try await traced("preview.read", id: id) {
      let output = try await client.getMemoryDeletionPreview(.init(path: .init(deletionId: id)))
      if case .undocumented(let status, _) = output, status == 409 { throw MemoryClientError.conflict }
      return try output.ok.body.json
    }
  }

  public func confirm(id: String, instanceId: String, minimumEpoch: Int) async throws -> MemoryDeletionStatus {
    try await traced("confirm", id: id) {
      let output = try await client.confirmMemoryDeletion(.init(
        path: .init(deletionId: id),
        body: .json(.init(instanceId: instanceId, minimumRestoreEpoch: minimumEpoch))
      ))
      if case .conflict = output { throw MemoryClientError.conflict }
      return try output.ok.body.json
    }
  }

  public func status(id: String, retry: Bool = false) async throws -> MemoryDeletionStatus {
    try await traced(retry ? "cleanup.retry" : "cleanup.status", id: id) {
      if retry {
        return try await client.retryMemoryBackupCleanup(.init(path: .init(deletionId: id))).ok.body.json
      }
      return try await client.getMemoryDeletionStatus(.init(path: .init(deletionId: id))).ok.body.json
    }
  }

  private func traced<T>(_ operation: String, id: String = "", body: () async throws -> T) async throws -> T {
    try await testTrace?.prepareCore(coreURL: serverURL, deviceToken: deviceToken)
    try testTrace?.record("memory.send", fields: ["operation": operation, "id": id])
    do {
      let value = try await body()
      try await testTrace?.collectCore(coreURL: serverURL, deviceToken: deviceToken)
      try testTrace?.record("memory.received", fields: ["operation": operation, "id": id])
      return value
    } catch {
      try? testTrace?.record("memory.failed", fields: ["operation": operation, "id": id])
      if error is MemoryClientError || error is TestTraceFailure { throw error }
      throw MemoryClientError.unavailable
    }
  }
}

public struct MemoryCompletion: Codable, Equatable, Sendable {
  public let memoryChanges: [MemoryChange]?
  public let memoryDeletionPreviewId: String?

  public init(memoryChanges: [MemoryChange]? = nil, memoryDeletionPreviewId: String? = nil) {
    self.memoryChanges = memoryChanges
    self.memoryDeletionPreviewId = memoryDeletionPreviewId
  }
}
