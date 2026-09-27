import Foundation
import Testing

@testable import VioletMacCore

@Suite("Realtime transport", .serialized)
struct RealtimeTransportTests {
  @Test(arguments: [true, false], [1, 2, 3])
  func serverCloseDrainsOnlyAnExplicitMemoryEnd(expected: Bool, trial: Int) async throws {
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/realtime-close-server.mjs")
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", fixture.path, expected ? "memory" : "failure"]
    process.standardOutput = output
    try process.run()
    try output.fileHandleForWriting.close()
    defer {
      if process.isRunning { process.terminate() }
      try? output.fileHandleForReading.close()
    }
    let portData = output.fileHandleForReading.availableData
    let port = try #require(String(data: portData, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines))
    let client = URLSessionRealtimeClient(
      coreURL: try #require(URL(string: "http://127.0.0.1:\(port)")),
      deviceToken: "synthetic-transport-test"
    )
    _ = try await client.connect(contextSessionId: nil, onDemandContext: false)
    let (frames, source) = AsyncStream.makeStream(of: VioletAudioFrame.self)
    let sender = Task {
      while !Task.isCancelled {
        source.yield(VioletAudioFrame(
          data: Data(count: 3_200), format: VioletAudioFormat(sampleRate: 16_000)
        ))
        try? await Task.sleep(for: .milliseconds(1))
      }
    }
    defer {
      sender.cancel()
      source.finish()
    }
    var events: [RealtimeServerEvent] = []
    var failed = false
    do {
      for try await event in await client.streamAudio(frames) {
        events.append(event)
      }
    } catch {
      failed = true
    }
    await client.close()
    #expect(failed == !expected)
    #expect(events.contains { if case .responseAudio = $0 { true } else { false } })
    #expect(events.contains { if case .responseCompleted = $0 { true } else { false } })
    if expected {
      guard case .endRequested(_, .memoryChanged) = events.last else {
        Issue.record("Expected the final memory end event before closing")
        return
      }
    }
  }
}
