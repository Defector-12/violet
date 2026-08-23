import Foundation
import Testing

@testable import VioletMacCore

@Suite("Realtime acceptance recording")
struct RealtimeAcceptanceTests {
  @Test
  @MainActor
  func writesOnlyMetadataToJSONLines() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let fileURL = directory.appendingPathComponent("acceptance.ndjson")
    defer { try? FileManager.default.removeItem(at: directory) }
    let sessionId = UUID()
    let turnId = UUID()
    var recorder: JSONLinesRealtimeAcceptanceRecorder? =
      try JSONLinesRealtimeAcceptanceRecorder(fileURL: fileURL)

    recorder?.record(
      .init(type: .speechStopped, sessionId: sessionId, turnId: turnId)
    )
    recorder = nil

    let line = try #require(
      String(contentsOf: fileURL, encoding: .utf8)
        .split(whereSeparator: \.isNewline)
        .first
    )
    let object = try #require(
      JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    )

    #expect(object["schemaVersion"] as? Int == 1)
    #expect(object["type"] as? String == "speech.stopped")
    #expect(object["sessionId"] as? String == sessionId.uuidString)
    #expect(object["turnId"] as? String == turnId.uuidString)
    #expect(object["runId"] is String)
    #expect(object["text"] == nil)
    #expect(object["audio"] == nil)
    #expect(object["message"] == nil)
  }
}
