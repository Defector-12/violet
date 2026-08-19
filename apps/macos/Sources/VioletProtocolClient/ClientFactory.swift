import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

public enum VioletProtocolClientFactory {
    public static func make(serverURL: URL) -> Client {
        Client(
            serverURL: serverURL,
            transport: URLSessionTransport()
        )
    }
}
