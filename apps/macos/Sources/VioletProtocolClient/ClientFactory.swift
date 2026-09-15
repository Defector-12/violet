import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

public enum VioletProtocolClientFactory {
  public static func make(
    serverURL: URL,
    deviceToken: String? = nil,
    testRunId: String? = nil,
    testRunActiveUntil: String? = nil
  ) -> Client {
    Client(
      serverURL: serverURL,
      configuration: .init(dateTranscoder: .iso8601WithFractionalSeconds),
      transport: URLSessionTransport(),
      middlewares: [
        RequestHeadersMiddleware(
          token: deviceToken,
          testRunId: testRunId,
          testRunActiveUntil: testRunActiveUntil
        )
      ]
    )
  }
}

private struct RequestHeadersMiddleware: ClientMiddleware {
  let token: String?
  let testRunId: String?
  let testRunActiveUntil: String?

  func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var request = request
    if let token {
      request.headerFields[.authorization] = "Bearer \(token)"
    }
    if let testRunId, let testRunActiveUntil {
      request.headerFields[HTTPField.Name("X-Violet-Test-Run")!] = testRunId
      request.headerFields[HTTPField.Name("X-Violet-Test-Until")!] = testRunActiveUntil
    }
    return try await next(request, body, baseURL)
  }
}
