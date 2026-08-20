import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

public enum VioletProtocolClientFactory {
  public static func make(serverURL: URL, deviceToken: String? = nil) -> Client {
    Client(
      serverURL: serverURL,
      transport: URLSessionTransport(),
      middlewares: deviceToken.map { [BearerTokenMiddleware(token: $0)] } ?? []
    )
  }
}

private struct BearerTokenMiddleware: ClientMiddleware {
  let token: String

  func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    var request = request
    request.headerFields[.authorization] = "Bearer \(token)"
    return try await next(request, body, baseURL)
  }
}
