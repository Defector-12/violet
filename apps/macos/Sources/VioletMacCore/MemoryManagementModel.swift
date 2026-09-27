import Combine
import Foundation

@MainActor
public final class MemoryManagementModel: ObservableObject {
  @Published public private(set) var memories: [VioletMemory] = []
  @Published public private(set) var detail: MemoryDetail?
  @Published public private(set) var selectedId: String?
  @Published public private(set) var preview: MemoryDeletionPreview?
  @Published public private(set) var cleanup: MemoryDeletionStatus?
  @Published public private(set) var errorMessage: String?
  @Published public private(set) var busy = false
  @Published public private(set) var hasChanges = false
  @Published public private(set) var pendingPreviewId: String?
  @Published public private(set) var pendingConfirmation = false
  @Published public var search = ""
  @Published public var kind = ""
  @Published public var recentOnly = false
  @Published public var newestFirst = true
  public var onPreviewRequested: (@MainActor @Sendable () -> Void)?
  public var onDeletionConfirmed: (@MainActor @Sendable () -> Void)?
  private let client: any MemoryClientPort
  private let epochs: any RestoreEpochStore
  private var instanceId: String?
  private var detailGeneration = 0
  private var correctionAttempt: (id: String, version: Int, content: String, requestId: String)?

  public init(client: any MemoryClientPort, epochs: any RestoreEpochStore) {
    self.client = client
    self.epochs = epochs
  }

  public var visibleMemories: [VioletMemory] {
    memories.filter {
      (kind.isEmpty || $0.kind.rawValue == kind)
        && (search.isEmpty || $0.content.localizedStandardContains(search))
        && (!recentOnly || $0.updatedAt >= Date().addingTimeInterval(-7 * 86_400))
    }.sorted { newestFirst ? $0.updatedAt > $1.updatedAt : $0.updatedAt < $1.updatedAt }
  }

  public func receive(_ completion: MemoryCompletion) {
    if !(completion.memoryChanges ?? []).isEmpty { hasChanges = true }
    if let id = completion.memoryDeletionPreviewId {
      pendingPreviewId = id
      onPreviewRequested?()
    }
  }

  public func refresh() async {
    await perform {
      self.hideDetails()
      let generation = self.detailGeneration
      try await self.reload()
      if let instanceId = self.instanceId,
        let record = try self.epochs.load(instanceId: instanceId) {
        if record.pendingDeletionId != nil {
          try await self.sendPendingConfirmation(record)
          try await self.reload()
        } else if let id = record.lastDeletionId {
          self.cleanup = try await self.client.status(id: id, retry: false)
        }
      }
      if generation == self.detailGeneration, let id = self.pendingPreviewId {
        let result = try await self.client.preview(id: id)
        guard generation == self.detailGeneration else { return }
        self.preview = result
        if self.pendingPreviewId == id { self.pendingPreviewId = nil }
      }
      self.hasChanges = false
    }
  }

  public func select(_ id: String, reveal: Bool = false) async {
    await perform {
      self.detail = nil
      self.selectedId = id
      let generation = self.detailGeneration
      let result = try await self.client.detail(id: id, reveal: reveal)
      guard result.instanceId == self.instanceId else { throw RestoreEpochError.invalidRecord }
      guard generation == self.detailGeneration else { return }
      self.detail = result
    }
  }

  public func correct(content: String) async {
    guard let current = detail?.versions.first(where: { $0.state == .current }),
      !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    await perform {
      let attempt = self.correctionAttempt
      let requestId = attempt?.id == current.id && attempt?.version == current.version && attempt?.content == content
        ? attempt!.requestId : UUID().uuidString.lowercased()
      self.correctionAttempt = (current.id, current.version, content, requestId)
      try await self.client.correct(id: current.id, requestId: requestId, version: current.version, content: content)
      self.correctionAttempt = nil
      self.hideDetails()
      try await self.reload()
      self.hasChanges = true
    }
  }

  public func prepareDeletion(_ target: MemoryDeletionTarget) async {
    await perform {
      guard !self.pendingConfirmation else { throw RestoreEpochError.pendingDeletion }
      self.preview = nil
      let generation = self.detailGeneration
      let result = try await self.client.preview(id: UUID().uuidString.lowercased(), target: target)
      guard generation == self.detailGeneration else { return }
      self.preview = result
    }
  }

  public func cancelPreview() {
    guard !busy else { return }
    preview = nil
  }

  public func confirmDeletion() async {
    guard let preview else { return }
    await perform {
      guard preview.instanceId == self.instanceId else { throw RestoreEpochError.invalidRecord }
      var record = try self.epochs.load(instanceId: preview.instanceId)
        ?? RestoreEpochRecord(instanceId: preview.instanceId)
      guard record.pendingDeletionId == nil || record.pendingDeletionId == preview.id else {
        throw RestoreEpochError.pendingDeletion
      }
      record.minimumRestoreEpoch = max(record.minimumRestoreEpoch, preview.nextRestoreEpoch)
      record.pendingDeletionId = preview.id
      let stored = try self.epochs.save(record)
      self.pendingConfirmation = true
      self.hideDetails()
      self.memories = []
      try await self.sendPendingConfirmation(stored)
      self.hideDetails()
      try await self.reload()
      self.hasChanges = true
    }
  }

  public func refreshCleanup(retry: Bool = false) async {
    guard let id = cleanup?.id else { return }
    await perform { self.cleanup = try await self.client.status(id: id, retry: retry) }
  }

  public func hideDetails() {
    detailGeneration += 1
    detail = nil
    selectedId = nil
    preview = nil
  }

  private func reload() async throws {
    let snapshot = try await client.list()
    instanceId = snapshot.instanceId
    var record = try epochs.load(instanceId: snapshot.instanceId)
      ?? RestoreEpochRecord(instanceId: snapshot.instanceId)
    pendingConfirmation = record.pendingDeletionId != nil
    record.minimumRestoreEpoch = max(record.minimumRestoreEpoch, snapshot.restoreEpoch)
    _ = try epochs.save(record)
    memories = snapshot.memories
  }

  private func sendPendingConfirmation(_ stored: RestoreEpochRecord) async throws {
    guard let id = stored.pendingDeletionId else { return }
    do {
      let status = try await client.confirm(
        id: id, instanceId: stored.instanceId, minimumEpoch: stored.minimumRestoreEpoch
      )
      guard status.id == id, status.instanceId == stored.instanceId,
        status.restoreEpoch <= stored.minimumRestoreEpoch else { throw RestoreEpochError.invalidRecord }
      cleanup = status
      hideDetails()
      memories = []
      // Online deletion has committed even if the local completion write fails.
      onDeletionConfirmed?()
      var finished = stored
      finished.pendingDeletionId = nil
      finished.lastDeletionId = id
      _ = try epochs.save(finished)
      pendingConfirmation = false
      preview = nil
    } catch MemoryClientError.conflict {
      // The server definitively rejected this preview. The restore floor never decreases.
      var rejected = stored
      rejected.pendingDeletionId = nil
      _ = try epochs.save(rejected)
      pendingConfirmation = false
      preview = nil
      throw MemoryClientError.conflict
    }
  }

  private func perform(_ operation: () async throws -> Void) async {
    guard !busy else { return }
    busy = true
    errorMessage = nil
    defer { busy = false }
    do { try await operation() }
    catch { errorMessage = error.localizedDescription }
  }
}
