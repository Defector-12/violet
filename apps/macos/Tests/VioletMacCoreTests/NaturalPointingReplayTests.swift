import Foundation
import Testing

@testable import VioletMacCore

@Suite("One-shot natural pointing replay")
struct NaturalPointingReplayTests {
  @Test
  @MainActor
  func recordsOneFilteredImageWithoutOCRAndNeverOverwrites() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let recorder = NaturalPointingReplayRecorder(directory: directory, now: now)
    let turnId = UUID()
    #expect(
      try recorder.record(
        context: imageContext(), question: "Selected code?", turnId: turnId, now: now))
    let file = directory.appendingPathComponent("case.json")
    let original = try Data(contentsOf: file)
    let object = try #require(JSONSerialization.jsonObject(with: original) as? [String: Any])
    #expect(object["question"] as? String == "Selected code?")
    #expect(object["turnId"] as? String == turnId.uuidString)
    #expect(object["schemaVersion"] as? Int == 1)
    #expect(object["expiresAt"] is String)
    #expect(object["localText"] == nil)
    let image = try #require(object["image"] as? [String: Any])
    #expect(image["data"] as? String == Data("image".utf8).base64EncodedString())
    #expect(image["localText"] == nil)
    let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
    #expect(attributes[.posixPermissions] as? Int == 0o600)
    #expect(
      try !recorder.record(context: imageContext(), question: "Another?", turnId: UUID(), now: now))
    let restarted = NaturalPointingReplayRecorder(directory: directory, now: now)
    #expect(throws: (any Error).self) {
      try restarted.record(context: imageContext(), question: "Another?", turnId: UUID(), now: now)
    }
    #expect(try Data(contentsOf: file) == original)
  }

  @Test
  @MainActor
  func expiresTheRecordingGrantAndPrunesOnlyExpiredReplayData() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let expired = NaturalPointingReplayRecorder(directory: directory, now: now)
    #expect(
      try !expired.record(
        context: imageContext(), question: "Selected?", turnId: UUID(),
        now: now.addingTimeInterval(901)
      ))
    #expect(!FileManager.default.fileExists(atPath: directory.path))
    let active = NaturalPointingReplayRecorder(directory: directory, now: now)
    #expect(
      try active.record(context: imageContext(), question: "Selected?", turnId: UUID(), now: now))
    let unrelated = directory.appendingPathComponent("keep.txt")
    try Data("keep".utf8).write(to: unrelated)
    try NaturalPointingReplayRecorder.removeExpiredCase(in: directory, now: now)
    #expect(
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("case.json").path))
    try NaturalPointingReplayRecorder.removeExpiredCase(
      in: directory, now: now.addingTimeInterval(86_401))
    #expect(
      !FileManager.default.fileExists(atPath: directory.appendingPathComponent("case.json").path))
    #expect(try Data(contentsOf: unrelated) == Data("keep".utf8))
  }
}

private func imageContext() -> FilteredContext {
  let data = Data("image".utf8)
  return FilteredContext(
    appBundleId: nil, completeness: 1, confidence: 1,
    payload: .image(
      data: data, focusPoint: .init(x: 0.1, y: 0.9), height: 100,
      localText: "do not record OCR", mediaType: "image/jpeg", region: nil,
      sha256: contextImageHash(data), width: 200
    ),
    redactions: [], sensitivity: "public"
  )
}
