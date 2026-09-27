import Darwin
import Foundation

/// Matches the official restore CLI's lockf descriptor lock. Never unlink this inode.
func withRestoreEpochLock<T>(
  instanceId: String, directory: URL? = nil, operation: () throws -> T
) throws -> T {
  guard UUID(uuidString: instanceId) != nil else { throw RestoreEpochError.invalidRecord }
  let directory = directory ?? FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Violet/restore-locks", isDirectory: true)
  try FileManager.default.createDirectory(
    at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
  )
  let path = directory.appendingPathComponent("\(instanceId.lowercased()).lock").path
  let descriptor = Darwin.open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
  guard descriptor >= 0 else { throw RestoreEpochError.protectionBusy }
  defer { Darwin.close(descriptor) }
  guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw RestoreEpochError.protectionBusy }
  return try operation()
}
