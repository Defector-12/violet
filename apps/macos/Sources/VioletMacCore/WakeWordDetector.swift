@preconcurrency import AVFoundation
import CVioletWake
import Foundation

@MainActor
public protocol WakeWordDetectorPort: AnyObject {
  var isRunning: Bool { get }
  func requestAccess() async -> Bool
  func start(
    onDetection: @escaping @MainActor @Sendable () -> Void,
    onAudioConfigurationInvalidated: @escaping @MainActor @Sendable () -> Void
  ) throws
  func stop()
}

@MainActor
public final class SilentWakeWordDetector: WakeWordDetectorPort {
  public private(set) var isRunning = false
  public private(set) var startCount = 0

  public init() {}

  public func requestAccess() async -> Bool {
    true
  }

  public func start(
    onDetection: @escaping @MainActor @Sendable () -> Void,
    onAudioConfigurationInvalidated: @escaping @MainActor @Sendable () -> Void
  ) {
    startCount += 1
    isRunning = true
  }

  public func stop() {
    isRunning = false
  }
}

public enum WakeWordDetectorError: Error, Equatable, LocalizedError {
  case assetsMissing
  case engineCreationFailed(String)
  case unsupportedInputFormat

  public var errorDescription: String? {
    switch self {
    case .assetsMissing:
      "Wake word assets are not installed."
    case .engineCreationFailed(let message):
      "Wake word engine failed: \(message)"
    case .unsupportedInputFormat:
      "The microphone format is unavailable for wake word detection."
    }
  }
}

@MainActor
public final class SherpaWakeWordDetector: WakeWordDetectorPort {
  public private(set) var isRunning = false

  private let assetsURL: URL
  private let audioEngine = AVAudioEngine()
  private var audioConfigurationInvalidated: (@MainActor @Sendable () -> Void)?
  private var configurationObserver: NSObjectProtocol?
  private var processor: WakeWordProcessor?

  public init(assetsURL: URL) {
    self.assetsURL = assetsURL
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: audioEngine,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        guard let self else { return }
        guard
          self.isRunning,
          !self.audioEngine.isRunning,
          let invalidated = self.audioConfigurationInvalidated
        else {
          return
        }
        self.audioConfigurationInvalidated = nil
        invalidated()
      }
    }
  }

  deinit {
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
    }
  }

  public func requestAccess() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      true
    case .notDetermined:
      await AVCaptureDevice.requestAccess(for: .audio)
    case .denied, .restricted:
      false
    @unknown default:
      false
    }
  }

  public func start(
    onDetection: @escaping @MainActor @Sendable () -> Void,
    onAudioConfigurationInvalidated: @escaping @MainActor @Sendable () -> Void
  ) throws {
    guard !isRunning else {
      return
    }
    guard FileManager.default.fileExists(atPath: assetsURL.path) else {
      throw WakeWordDetectorError.assetsMissing
    }
    let processor = try WakeWordProcessor(assetsURL: assetsURL) {
      Task { @MainActor in
        onDetection()
      }
    }
    let input = audioEngine.inputNode
    let inputFormat = input.inputFormat(forBus: 0)
    guard
      inputFormat.sampleRate > 0,
      let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
      ),
      let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
    else {
      throw WakeWordDetectorError.unsupportedInputFormat
    }
    input.installTap(
      onBus: 0,
      bufferSize: 1_024,
      format: inputFormat,
      block: makeWakeWordTapHandler(
        converter: converter,
        processor: processor,
        targetFormat: targetFormat
      )
    )
    do {
      audioConfigurationInvalidated = onAudioConfigurationInvalidated
      try audioEngine.start()
      self.processor = processor
      isRunning = true
    } catch {
      audioConfigurationInvalidated = nil
      input.removeTap(onBus: 0)
      throw error
    }
  }

  public func stop() {
    guard isRunning else {
      return
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
    processor?.invalidate()
    processor = nil
    audioConfigurationInvalidated = nil
    isRunning = false
  }
}

private final class WakeWordProcessor: @unchecked Sendable {
  private let detection: @MainActor @Sendable () -> Void
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "com.violet.wake-word")
  private var active = true
  private var engine: OpaquePointer?
  private var detectionPending = false

  init(
    assetsURL: URL,
    detection: @escaping @MainActor @Sendable () -> Void
  ) throws {
    self.detection = detection
    var errorBuffer = [CChar](repeating: 0, count: 1024)
    engine = assetsURL.path.withCString { assetsPath in
      "▁VI OL ET :2.0 #0.25 @VIOLET".withCString { keyword in
        VioletWakeCreate(
          assetsPath,
          keyword,
          &errorBuffer,
          Int32(errorBuffer.count)
        )
      }
    }
    guard engine != nil else {
      let message = String(
        decoding: errorBuffer.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)),
        as: UTF8.self
      )
      throw WakeWordDetectorError.engineCreationFailed(message)
    }
  }

  deinit {
    if let engine {
      VioletWakeDestroy(engine)
    }
  }

  func accept(_ samples: Data) {
    queue.async { [weak self] in
      guard let self else {
        return
      }
      lock.lock()
      guard active, let engine, !detectionPending else {
        lock.unlock()
        return
      }
      let result = samples.withUnsafeBytes { bytes in
        guard let baseAddress = bytes.bindMemory(to: Int16.self).baseAddress else {
          return Int32(-1)
        }
        return VioletWakeAcceptInt16(
          engine,
          baseAddress,
          Int32(bytes.count / MemoryLayout<Int16>.size),
          16_000
        )
      }
      if result == 1 {
        detectionPending = true
      }
      lock.unlock()
      if result == 1 {
        Task { @MainActor [weak self] in
          guard let self else {
            return
          }
          let shouldDeliver = lock.withLock {
            let shouldDeliver = active && detectionPending
            detectionPending = false
            return shouldDeliver
          }
          if shouldDeliver {
            detection()
          }
        }
      }
    }
  }

  func invalidate() {
    lock.withLock {
      active = false
      detectionPending = false
    }
  }
}

private func makeWakeWordTapHandler(
  converter: AVAudioConverter,
  processor: WakeWordProcessor,
  targetFormat: AVAudioFormat
) -> AVAudioNodeTapBlock {
  { buffer, _ in
    guard
      let converted = convertWakeWordAudio(buffer, using: converter, to: targetFormat)
    else {
      return
    }
    processor.accept(converted)
  }
}

private func convertWakeWordAudio(
  _ source: AVAudioPCMBuffer,
  using converter: AVAudioConverter,
  to targetFormat: AVAudioFormat
) -> Data? {
  let ratio = targetFormat.sampleRate / source.format.sampleRate
  let capacity = max(1, AVAudioFrameCount(Double(source.frameLength) * ratio) + 1)
  guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
    return nil
  }
  let provider = WakeWordInputProvider(source: source)
  var conversionError: NSError?
  let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
    provider.next(status: inputStatus)
  }
  guard
    conversionError == nil,
    status != .error,
    output.frameLength > 0,
    let data = output.audioBufferList.pointee.mBuffers.mData
  else {
    return nil
  }
  return Data(
    bytes: data,
    count: Int(output.frameLength) * MemoryLayout<Int16>.size
  )
}

private final class WakeWordInputProvider: @unchecked Sendable {
  private let lock = NSLock()
  private let source: AVAudioPCMBuffer
  private var supplied = false

  init(source: AVAudioPCMBuffer) {
    self.source = source
  }

  func next(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
    lock.lock()
    defer { lock.unlock() }
    if supplied {
      status.pointee = .noDataNow
      return nil
    }
    supplied = true
    status.pointee = .haveData
    return source
  }
}
