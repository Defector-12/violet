import Foundation
import Testing
import VioletProtocolClient

@testable import VioletMacCore

@Suite("Core client decoding", .serialized)
struct CoreClientDecodingTests {
  @Test
  func decodesFractionalSecondStatusTimestamp() async throws {
    URLProtocol.registerClass(FractionalStatusURLProtocol.self)
    defer {
      URLProtocol.unregisterClass(FractionalStatusURLProtocol.self)
    }

    let client = VioletProtocolClientFactory.make(
      serverURL: try #require(URL(string: "http://violet.test"))
    )
    let output = try await client.getCoreStatus(.init())
    let response = try output.ok
    let status = try response.body.json

    #expect(status.state == .ready)
    #expect(status.version == "test")
  }

  @Test
  func typedChatDoesNotFinishSuccessfullyWhenCoreTraceCollectionFails() async throws {
    let directory = try traceFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    TraceFailureURLProtocol.configure(runId: recorder.runId)
    URLProtocol.registerClass(TraceFailureURLProtocol.self)
    defer {
      URLProtocol.unregisterClass(TraceFailureURLProtocol.self)
      TraceFailureURLProtocol.reset()
    }
    let client = GeneratedVioletCoreClient(
      serverURL: try #require(URL(string: "http://trace-client.test")),
      deviceToken: "test-device-token",
      testTrace: recorder
    )
    var chunks: [String] = []

    do {
      for try await chunk in client.streamChat(message: "Hello", requestId: UUID()) {
        chunks.append(chunk)
      }
      Issue.record("Expected trace collection failure")
    } catch {
      #expect(error is TestTraceFailure)
    }

    #expect(chunks == ["Hello from Core"])
    let trace = try traceLog(directory)
    #expect(trace.contains("chat.failed"))
    #expect(!trace.contains(#""type":"chat.completed""#))
  }

  @Test
  func deletesAcceptedContextWhenPostSubmitTraceCollectionFails() async throws {
    let directory = try traceFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recorder = try TestTraceRecorder(directory: directory)
    let contextSessionId = UUID()
    TraceFailureURLProtocol.configure(
      runId: recorder.runId,
      contextSessionId: contextSessionId
    )
    URLProtocol.registerClass(TraceFailureURLProtocol.self)
    defer {
      URLProtocol.unregisterClass(TraceFailureURLProtocol.self)
      TraceFailureURLProtocol.reset()
    }
    let client = URLSessionContextClient(
      coreURL: try #require(URL(string: "http://trace-client.test")),
      deviceToken: "test-device-token",
      testTrace: recorder
    )

    do {
      _ = try await client.submitContext(
        FilteredContext(
          appBundleId: "com.example.Reader",
          completeness: 1,
          confidence: 1,
          payload: .text("Authorized test context"),
          redactions: [],
          sensitivity: "personal"
        ),
        deviceId: UUID(),
        sessionId: contextSessionId
      )
      Issue.record("Expected trace collection failure")
    } catch {
      #expect(error is TestTraceFailure)
    }

    #expect(
      TraceFailureURLProtocol.requestedPaths().contains(
        "DELETE /v1/context/sessions/\(contextSessionId.uuidString.lowercased())"
      )
    )
  }

  private func traceFixture() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let runId = UUID().uuidString.lowercased()
    try JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1,
      "purpose": "violet-test-trace",
      "runId": runId,
      "activeUntil": Date().addingTimeInterval(300).ISO8601Format(),
      "expiresAt": Date().addingTimeInterval(3_600).ISO8601Format(),
    ]).write(to: directory.appendingPathComponent("manifest.json"))
    return directory
  }

  private func traceLog(_ directory: URL) throws -> String {
    let path = try #require(
      FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        .first { $0.lastPathComponent.hasPrefix("mac-") }
    )
    return try String(contentsOf: path, encoding: .utf8)
  }
}

private final class FractionalStatusURLProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "violet.test"
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    guard
      let url = request.url,
      let response = HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }

    client?.urlProtocol(
      self,
      didReceive: response,
      cacheStoragePolicy: .notAllowed
    )
    client?.urlProtocol(
      self,
      didLoad: Data(
        """
        {
          "service": "violet-core",
          "state": "ready",
          "time": "2026-08-21T05:51:00.123Z",
          "version": "test"
        }
        """.utf8
      )
    )
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

private final class TraceFailureURLProtocol: URLProtocol {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var runId = ""
  nonisolated(unsafe) private static var contextSessionId: UUID?
  nonisolated(unsafe) private static var paths: [String] = []

  static func configure(runId: String, contextSessionId: UUID? = nil) {
    lock.lock()
    self.runId = runId
    self.contextSessionId = contextSessionId
    paths = []
    lock.unlock()
  }

  static func reset() {
    configure(runId: "")
  }

  static func requestedPaths() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return paths
  }

  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "trace-client.test"
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    let method = request.httpMethod ?? "GET"
    Self.lock.lock()
    Self.paths.append("\(method) \(url.path)")
    let runId = Self.runId
    let contextSessionId = Self.contextSessionId
    Self.lock.unlock()

    let response: (status: Int, contentType: String, data: Data)
    switch (method, url.path) {
    case ("POST", "/v1/test-traces"):
      response = (
        200,
        "application/json",
        json([
          "status": "ready",
          "runId": runId,
          "activeUntil": Date().addingTimeInterval(300).ISO8601Format(),
        ])
      )
    case ("POST", "/v1/chat/stream"):
      let requestId = UUID().uuidString.lowercased()
      let eventId = UUID().uuidString.lowercased()
      let messageId = UUID().uuidString.lowercased()
      response = (
        200,
        "application/x-ndjson",
        Data(
          """
          {"content":"Hello from Core","eventId":"\(eventId)","requestId":"\(requestId)","type":"delta"}
          {"eventId":"\(UUID().uuidString.lowercased())","messageId":"\(messageId)","requestId":"\(requestId)","type":"complete","usage":{"inputTokens":1,"outputTokens":1}}

          """.utf8
        )
      )
    case ("POST", "/v1/context/envelopes"):
      response = (
        200,
        "application/json",
        json([
          "sessionId": contextSessionId?.uuidString.lowercased() ?? "",
          "expiresAt": Date().addingTimeInterval(300).ISO8601Format(),
        ])
      )
    case ("GET", _) where url.path.hasPrefix("/v1/test-traces/"):
      response = (500, "application/json", json(["error": "synthetic failure"]))
    case ("DELETE", _) where url.path.hasPrefix("/v1/context/sessions/"):
      response = (204, "application/json", Data())
    default:
      response = (404, "application/json", json(["error": "not found"]))
    }

    guard
      let http = HTTPURLResponse(
        url: url,
        statusCode: response.status,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": response.contentType]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    if !response.data.isEmpty {
      client?.urlProtocol(self, didLoad: response.data)
    }
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private func json(_ value: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: value)) ?? Data()
  }
}
