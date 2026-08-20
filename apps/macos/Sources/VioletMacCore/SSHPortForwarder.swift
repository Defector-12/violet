import Foundation

public struct SSHTunnelConfiguration: Codable, Equatable, Sendable {
  public let host: String
  public let localPort: UInt16
  public let remoteHost: String
  public let remotePort: UInt16

  public init(
    host: String,
    localPort: UInt16 = 14_310,
    remoteHost: String = "127.0.0.1",
    remotePort: UInt16 = 4_310
  ) {
    self.host = host
    self.localPort = localPort
    self.remoteHost = remoteHost
    self.remotePort = remotePort
  }
}

@MainActor
public protocol PortForwarderPort: AnyObject {
  func start() throws
  func stop()
}

@MainActor
public final class SilentPortForwarder: PortForwarderPort {
  public private(set) var startCount = 0
  public private(set) var stopCount = 0

  public init() {}

  public func start() {
    startCount += 1
  }

  public func stop() {
    stopCount += 1
  }
}

@MainActor
public final class SSHPortForwarder: PortForwarderPort, @unchecked Sendable {
  private let configuration: SSHTunnelConfiguration
  private var process: Process?
  private var shouldRun = false

  public init(configuration: SSHTunnelConfiguration) {
    self.configuration = configuration
  }

  public func start() throws {
    shouldRun = true
    guard process?.isRunning != true else {
      return
    }
    try launch()
  }

  public func stop() {
    shouldRun = false
    process?.terminationHandler = nil
    if process?.isRunning == true {
      process?.terminate()
    }
    process = nil
  }

  private func launch() throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
    process.arguments = [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      "\(configuration.localPort):\(configuration.remoteHost):\(configuration.remotePort)",
      configuration.host,
    ]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self] _ in
      Task { @MainActor in
        guard let self, self.shouldRun else {
          return
        }
        self.process = nil
        try? await Task.sleep(for: .seconds(3))
        if self.shouldRun {
          try? self.launch()
        }
      }
    }
    try process.run()
    self.process = process
  }
}
