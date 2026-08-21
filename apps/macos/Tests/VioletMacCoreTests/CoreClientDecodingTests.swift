import Foundation
import Testing
import VioletProtocolClient

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
