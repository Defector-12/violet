import Foundation
import Testing
@testable import VioletMacCore

@Suite("Restore epoch exclusion")
struct RestoreEpochLockTests {
  @Test(arguments: [1, 2, 3])
  func swiftWriterExcludesOfficialRestore(_ trial: Int) throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("violet-restore-lock-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let instanceId = UUID().uuidString.lowercased()
    let path = directory.appendingPathComponent("\(instanceId).lock").path
    try withRestoreEpochLock(instanceId: instanceId, directory: directory) {
      let status = try tryOfficialLock(path)
      #expect(status == 75)
    }
    #expect(FileManager.default.fileExists(atPath: path))
    #expect(try tryOfficialLock(path) == 0)
  }

  @Test func thrownWriteReleasesLock() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("violet-restore-lock-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let instanceId = UUID().uuidString.lowercased()
    #expect(throws: RestoreEpochError.self) {
      try withRestoreEpochLock(instanceId: instanceId, directory: directory) {
        throw RestoreEpochError.invalidRecord
      }
    }
    let path = directory.appendingPathComponent("\(instanceId).lock").path
    #expect(try tryOfficialLock(path) == 0)
  }

  private func tryOfficialLock(_ path: String) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/lockf")
    process.arguments = ["-k", "-s", "-t", "0", path, "/usr/bin/true"]
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  }
}
