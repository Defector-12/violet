import Foundation
import VioletMacCore

@main
enum VioletCredentialTool {
  static func main() throws {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let token = String(data: data, encoding: .utf8) else {
      throw DeviceTokenError.invalidValue
    }
    try KeychainDeviceTokenProvider().store(deviceToken: token)
    FileHandle.standardOutput.write(Data("Violet device token stored in Keychain.\n".utf8))
  }
}
