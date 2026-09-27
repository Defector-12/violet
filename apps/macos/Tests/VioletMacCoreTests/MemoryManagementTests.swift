import Foundation
import Testing
@testable import VioletMacCore

@Suite("Memory management")
@MainActor
struct MemoryManagementTests {
  @Test func previewRetentionIsPerVersionNotPerMemoryId() async throws {
    let client = MemoryFixtureClient()
    let eventA = UUID().uuidString.lowercased()
    let eventB = UUID().uuidString.lowercased()
    var v1 = client.memory
    v1.state = .superseded
    v1.sources = [.init(eventId: eventA, startByte: 0, endByte: 1)]
    var v2 = client.memory
    v2.version = 2
    v2.sources = [.init(eventId: eventB, startByte: 0, endByte: 1)]
    var preview = try await client.preview(id: UUID().uuidString.lowercased())
    preview.memories = [v1, v2]
    preview.eventIds = [eventB]
    preview.retainedMemoryIds = [v1.id]
    #expect(preview.retainsSources(for: v1))
    #expect(!preview.retainsSources(for: v2))
    v2.sources.append(.init(eventId: eventA, startByte: 0, endByte: 1))
    #expect(preview.retainsSources(for: v2))
    preview.eventIds = [eventA, eventB]
    #expect(!preview.retainsSources(for: v1))
    #expect(!preview.retainsSources(for: v2))
    #expect(!preview.retainsSources(for: client.memory))
  }

  @Test(arguments: [false, true], [1, 2, 3])
  func hidingDropsLateDeletionPreview(readExisting: Bool, trial: Int) async {
    let client = MemoryFixtureClient()
    let model = MemoryManagementModel(client: client, epochs: FixtureEpochStore())
    await model.refresh()
    let id = UUID().uuidString.lowercased()
    client.beforePreview = {
      await Task.yield()
      model.hideDetails()
      await Task.yield()
    }
    if readExisting {
      model.receive(.init(memoryDeletionPreviewId: id))
      await model.refresh()
      #expect(model.pendingPreviewId == id)
    } else {
      await model.prepareDeletion(.all)
    }
    #expect(model.preview == nil)
    #expect(!model.busy)
    #expect(model.errorMessage == nil)
    client.beforePreview = nil
    if readExisting {
      await model.refresh()
      #expect(model.preview?.id == id)
      #expect(model.pendingPreviewId == nil)
    } else {
      await model.prepareDeletion(.all)
      #expect(model.preview != nil)
    }
  }

  @Test func hidingDuringRefreshDoesNotStartPendingPreviewRead() async {
    let client = MemoryFixtureClient()
    let model = MemoryManagementModel(client: client, epochs: FixtureEpochStore())
    let id = UUID().uuidString.lowercased()
    model.receive(.init(memoryDeletionPreviewId: id))
    client.beforeList = { model.hideDetails() }
    var readPreview = false
    client.beforePreview = { readPreview = true }
    await model.refresh()
    #expect(!readPreview)
    #expect(model.preview == nil)
    #expect(model.pendingPreviewId == id)
  }

  @Test(arguments: [false, true])
  func confirmedDeletionClearsPresenceBeforeLocalCompletionWrite(failWrite: Bool) async throws {
    let client = MemoryFixtureClient()
    let store = FixtureEpochStore()
    let model = MemoryManagementModel(client: client, epochs: store)
    let presence = PresenceModel(client: MemoryChatFixtureClient())
    await presence.refresh()
    presence.send("Synthetic source")
    #expect(!presence.messages.isEmpty)
    model.onDeletionConfirmed = { presence.invalidateDeletedConversation() }
    await model.refresh()
    await model.prepareDeletion(.all)
    client.beforeConfirm = {
      model.hideDetails()
      store.failWrites = failWrite
    }
    await model.confirmDeletion()
    #expect(client.confirmations.count == 1)
    #expect(presence.messages.isEmpty)
    #expect(!presence.isResponding)
    #expect(presence.connectionState == .ready(version: "test"))
    #expect(model.pendingConfirmation == failWrite)
  }

  @Test func keychainFailurePreventsDeletionRequest() async throws {
    let client = MemoryFixtureClient()
    let store = FixtureEpochStore()
    let model = MemoryManagementModel(client: client, epochs: store)
    var notifications = 0
    model.onDeletionConfirmed = { notifications += 1 }
    await model.refresh()
    await model.prepareDeletion(.all)
    store.failWrites = true
    await model.confirmDeletion()
    #expect(client.confirmations.isEmpty)
    #expect(model.preview != nil)
    #expect(model.errorMessage != nil)
    #expect(notifications == 0)
  }

  @Test func lostConfirmationIsRetriedWithSameIdAfterRestart() async throws {
    let client = MemoryFixtureClient()
    let store = FixtureEpochStore()
    var model = MemoryManagementModel(client: client, epochs: store)
    var notifications = 0
    model.onDeletionConfirmed = { notifications += 1 }
    await model.refresh()
    await model.prepareDeletion(.all)
    let preview = try #require(model.preview)
    client.beforeConfirm = {
      #expect(store.records[client.instanceId]?.minimumRestoreEpoch == 1)
      #expect(store.records[client.instanceId]?.pendingDeletionId == preview.id)
    }
    client.loseConfirmation = true
    await model.confirmDeletion()
    #expect(model.pendingConfirmation)
    #expect(notifications == 0)
    model = MemoryManagementModel(client: client, epochs: store)
    model.onDeletionConfirmed = { notifications += 1 }
    await model.refresh()
    #expect(client.confirmations == [preview.id, preview.id])
    #expect(client.restoreEpoch == 1)
    #expect(store.records[client.instanceId]?.pendingDeletionId == nil)
    #expect(store.records[client.instanceId]?.lastDeletionId == preview.id)
    #expect(model.memories.isEmpty)
    #expect(model.cleanup?.status == .pending)
    #expect(notifications == 1)
  }

  @Test func conflictingPreviewKeepsRestoreFloorAndAllowsNewPreview() async throws {
    let client = MemoryFixtureClient()
    let store = FixtureEpochStore()
    let model = MemoryManagementModel(client: client, epochs: store)
    var notifications = 0
    model.onDeletionConfirmed = { notifications += 1 }
    await model.refresh()
    await model.prepareDeletion(.all)
    client.rejectConfirmation = true
    await model.confirmDeletion()
    #expect(model.preview == nil)
    #expect(!model.pendingConfirmation)
    #expect(notifications == 0)
    #expect(store.records[client.instanceId]?.minimumRestoreEpoch == 1)
    await model.refresh()
    #expect(model.errorMessage == nil)
    await model.prepareDeletion(.all)
    client.rejectConfirmation = false
    await model.confirmDeletion()
    #expect(model.cleanup?.restoreEpoch == 1)
    #expect(notifications == 1)
  }

  @Test(arguments: [false, true], [false, true])
  func generatedHTTPConflictRecoversPending(missingRequestId: Bool, resumePending: Bool) async throws {
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/memory-conflict-server.mjs")
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", fixture.path, missingRequestId ? "missing-request-id" : "valid"]
    process.standardOutput = output
    try process.run()
    defer {
      if process.isRunning { process.terminate() }
      try? output.fileHandleForReading.close()
    }
    try output.fileHandleForWriting.close()
    // This suite runs on MainActor; blocking pipe reads starve other UI tests.
    let portData = await Task.detached { output.fileHandleForReading.availableData }.value
    let port = try #require(String(data: portData, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines))
    let client = GeneratedMemoryClient(
      serverURL: try #require(URL(string: "http://127.0.0.1:\(port)")),
      deviceToken: "synthetic-memory-test"
    )
    let store = FixtureEpochStore()
    var model = MemoryManagementModel(client: client, epochs: store)
    await model.refresh()
    #expect(model.errorMessage == nil)
    await model.prepareDeletion(.all)
    let preview = try #require(model.preview)
    print("Memory HTTP case: missingRequestId=\(missingRequestId), resumePending=\(resumePending), instanceId=\(preview.instanceId)")

    // Exercise the generated decoder, not an injected MemoryClientError.
    do {
      _ = try await client.confirm(
        id: preview.id, instanceId: preview.instanceId, minimumEpoch: preview.nextRestoreEpoch
      )
      Issue.record("The fixture must reject its first deletion ID")
    } catch MemoryClientError.conflict {
      #expect(!missingRequestId)
    } catch MemoryClientError.unavailable {
      #expect(missingRequestId)
    }

    if resumePending {
      _ = try store.save(.init(
        instanceId: preview.instanceId, minimumRestoreEpoch: preview.nextRestoreEpoch,
        pendingDeletionId: preview.id
      ))
      model = MemoryManagementModel(client: client, epochs: store)
    }
    var notifications = 0
    model.onDeletionConfirmed = { notifications += 1 }
    if resumePending { await model.refresh() }
    else { await model.confirmDeletion() }
    #expect(model.errorMessage == (missingRequestId
      ? MemoryClientError.unavailable.errorDescription : MemoryClientError.conflict.errorDescription))
    #expect(model.preview == nil)
    #expect(model.pendingConfirmation == missingRequestId)
    #expect(store.records[preview.instanceId]?.minimumRestoreEpoch == preview.nextRestoreEpoch)
    #expect(store.records[preview.instanceId]?.pendingDeletionId == (missingRequestId ? preview.id : nil))
    #expect(store.records[preview.instanceId]?.lastDeletionId == nil)
    #expect(notifications == 0)

    if missingRequestId {
      model = MemoryManagementModel(client: client, epochs: store)
      model.onDeletionConfirmed = { notifications += 1 }
      await model.refresh()
      #expect(model.errorMessage == MemoryClientError.unavailable.errorDescription)
      #expect(model.pendingConfirmation)
      await model.prepareDeletion(.all)
      #expect(model.preview == nil)
      #expect(model.errorMessage == RestoreEpochError.pendingDeletion.errorDescription)
      #expect(store.records[preview.instanceId]?.pendingDeletionId == preview.id)
      #expect(store.records[preview.instanceId]?.minimumRestoreEpoch == preview.nextRestoreEpoch)
      #expect(notifications == 0)
    } else {
      await model.refresh()
      #expect(model.errorMessage == nil)
      await model.prepareDeletion(.all)
      let fresh = try #require(model.preview)
      #expect(fresh.id != preview.id)
      await model.confirmDeletion()
      #expect(model.errorMessage == nil)
      #expect(!model.pendingConfirmation)
      #expect(model.cleanup?.id == fresh.id)
      #expect(model.cleanup?.status == .pending)
      #expect(store.records[preview.instanceId]?.pendingDeletionId == nil)
      #expect(store.records[preview.instanceId]?.lastDeletionId == fresh.id)
      #expect(store.records[preview.instanceId]?.minimumRestoreEpoch == preview.nextRestoreEpoch)
      #expect(notifications == 1)
    }
  }

  @Test func postCommitKeychainFailureDoesNotKeepDeletedBodyVisible() async throws {
    let client = MemoryFixtureClient()
    let store = FixtureEpochStore()
    let model = MemoryManagementModel(client: client, epochs: store)
    await model.refresh()
    await model.select(client.memory.id, reveal: true)
    await model.prepareDeletion(.all)
    client.beforeConfirm = { store.failWrites = true }
    await model.confirmDeletion()
    #expect(client.restoreEpoch == 1)
    #expect(model.memories.isEmpty)
    #expect(model.detail == nil)
    #expect(model.preview == nil)
    #expect(model.pendingConfirmation)
    #expect(model.cleanup?.status == .pending)
  }

  @Test func sensitiveContentRequiresRevealAndIsClearedOnClose() async {
    let client = MemoryFixtureClient()
    let model = MemoryManagementModel(client: client, epochs: FixtureEpochStore())
    await model.refresh()
    #expect(model.memories.first?.redacted == true)
    await model.select(client.memory.id)
    #expect(model.detail?.versions.first?.redacted == true)
    await model.select(client.memory.id, reveal: true)
    #expect(model.detail?.versions.first?.content == "合成敏感事实")
    #expect(model.memories.first?.content == "受控敏感内容")
    model.hideDetails()
    #expect(model.detail == nil)
  }

  @Test func closingWindowDropsLateReveal() async {
    let client = MemoryFixtureClient()
    let model = MemoryManagementModel(client: client, epochs: FixtureEpochStore())
    await model.refresh()
    client.beforeDetail = { model.hideDetails() }
    await model.select(client.memory.id, reveal: true)
    #expect(model.detail == nil)
    #expect(model.selectedId == nil)
  }

  @Test func correctionRetryReusesRequestId() async {
    let client = MemoryFixtureClient()
    let model = MemoryManagementModel(client: client, epochs: FixtureEpochStore())
    await model.refresh()
    await model.select(client.memory.id)
    client.failCorrection = true
    await model.correct(content: "更正后的合成事实")
    client.failCorrection = false
    await model.correct(content: "更正后的合成事实")
    #expect(client.corrections.count == 2)
    #expect(Set(client.corrections).count == 1)
    #expect(model.hasChanges)
  }

  @Test func recordRejectsAnotherInstanceAndInvalidEpoch() throws {
    let instanceId = UUID().uuidString.lowercased()
    #expect(throws: RestoreEpochError.self) {
      try RestoreEpochRecord(instanceId: instanceId, minimumRestoreEpoch: -1).validated(for: instanceId)
    }
    #expect(throws: RestoreEpochError.self) {
      try RestoreEpochRecord(instanceId: instanceId).validated(for: UUID().uuidString)
    }
  }

  @Test func textAndRealtimeCompletionPreserveChangesAndPreview() async throws {
    let id = UUID().uuidString.lowercased()
    let body = """
      "memoryChanges":[{"id":"\(id)","version":2,"kind":"corrected"}],"memoryDeletionPreviewId":"\(id)"
      """
    let client = MemoryFixtureClient()
    let model = MemoryManagementModel(client: client, epochs: FixtureEpochStore())
    var opened = 0
    model.onPreviewRequested = { opened += 1 }
    let (_, continuation) = AsyncThrowingStream<String, Error>.makeStream()
    let delta = try await decodeChatLine(
      Data("{\"type\":\"complete\",\(body)}".utf8), continuation: continuation,
      onMemoryCompletion: { model.receive($0) }
    )
    #expect(delta.isEmpty)
    #expect(model.hasChanges)
    #expect(model.pendingPreviewId == id)
    #expect(opened == 1)
    let event = try decodeRealtimeServerEvent(Data("""
      {"type":"response.completed","sequence":1,"sessionId":"\(id)","responseId":"\(id)","turnId":"\(id)",\(body)}
      """.utf8))
    guard case .responseCompleted(_, _, let memory) = event else {
      Issue.record("Completion metadata lost"); return
    }
    #expect(memory.memoryChanges?.first?.version == 2)
    #expect(memory.memoryDeletionPreviewId == id)
  }
}

@MainActor
private final class FixtureEpochStore: RestoreEpochStore {
  var records: [String: RestoreEpochRecord] = [:]
  var failWrites = false
  func load(instanceId: String) throws -> RestoreEpochRecord? { records[instanceId] }
  func save(_ record: RestoreEpochRecord) throws -> RestoreEpochRecord {
    if failWrites { throw RestoreEpochError.keychain(-1) }
    var next = record
    next.minimumRestoreEpoch = max(record.minimumRestoreEpoch, records[record.instanceId]?.minimumRestoreEpoch ?? 0)
    records[record.instanceId] = next
    return next
  }
}

@MainActor
private final class MemoryFixtureClient: MemoryClientPort {
  let instanceId = UUID().uuidString.lowercased()
  var memory = VioletMemory(
    id: UUID().uuidString.lowercased(), version: 1, state: .current, origin: "explicit",
    content: "受控敏感内容", kind: .fact, sensitivity: .controlled, redacted: true,
    createdAt: Date(), updatedAt: Date(), sources: []
  )
  var restoreEpoch = 0
  var confirmations: [String] = []
  var corrections: [String] = []
  var loseConfirmation = false
  var rejectConfirmation = false
  var failCorrection = false
  var beforeConfirm: (() -> Void)?
  var beforeDetail: (() -> Void)?
  var beforeList: (() -> Void)?
  var beforePreview: (() async -> Void)?

  func list() async throws -> MemoryList {
    beforeList?()
    return .init(instanceId: instanceId, revision: 1, deletionRevision: restoreEpoch,
      restoreEpoch: restoreEpoch, memories: restoreEpoch > 0 ? [] : [memory])
  }
  func detail(id: String, reveal: Bool) async throws -> MemoryDetail {
    beforeDetail?()
    var value = memory
    if reveal { value.content = "合成敏感事实"; value.redacted = false }
    return .init(instanceId: instanceId, revision: 1, versions: [value], events: [])
  }
  func correct(id: String, requestId: String, version: Int, content: String) async throws {
    corrections.append(requestId)
    if failCorrection { throw MemoryClientError.unavailable }
  }
  func preview(id: String, target: MemoryDeletionTarget) async throws -> MemoryDeletionPreview {
    try await preview(id: id)
  }
  func preview(id: String) async throws -> MemoryDeletionPreview {
    await beforePreview?()
    return .init(id: id, instanceId: instanceId, revision: 1, deletionRevision: restoreEpoch,
      restoreEpoch: restoreEpoch, nextRestoreEpoch: restoreEpoch + 1, eventSequence: 1,
      target: .case3(.init(kind: "all")), requestIds: [], eventIds: [],
      deletedMemoryIds: [memory.id], retainedMemoryIds: [], createdAt: Date(),
      events: [], memories: [memory])
  }
  func confirm(id: String, instanceId: String, minimumEpoch: Int) async throws -> MemoryDeletionStatus {
    beforeConfirm?()
    confirmations.append(id)
    if rejectConfirmation { throw MemoryClientError.conflict }
    restoreEpoch = 1
    if loseConfirmation {
      loseConfirmation = false
      throw MemoryClientError.unavailable
    }
    return try await status(id: id, retry: false)
  }
  func status(id: String, retry: Bool) async throws -> MemoryDeletionStatus {
    .init(id: id, instanceId: instanceId, restoreEpoch: restoreEpoch, status: .pending)
  }
}

private struct MemoryChatFixtureClient: VioletCoreClientPort {
  func status() async throws -> VioletCoreStatus { .init(state: .ready, version: "test") }
  func streamChat(message: String, requestId: UUID) -> AsyncThrowingStream<String, Error> {
    AsyncThrowingStream {
      $0.yield("Synthetic reply")
      $0.finish()
    }
  }
}
