@preconcurrency import AVFoundation
import Foundation

public struct VioletAudioFormat: Equatable, Sendable {
  public let channels: UInt32
  public let sampleRate: Double

  public init(sampleRate: Double, channels: UInt32 = 1) {
    self.sampleRate = sampleRate
    self.channels = channels
  }
}

public struct VioletAudioFrame: Equatable, Sendable {
  public let data: Data
  public let format: VioletAudioFormat

  public init(data: Data, format: VioletAudioFormat) {
    self.data = data
    self.format = format
  }
}

@MainActor
public protocol AudioIOPort: AnyObject {
  var isCapturing: Bool { get }
  var isPlaying: Bool { get }
  func play(_ frame: VioletAudioFrame) throws
  func preparePlayback(format: VioletAudioFormat) throws
  func requestCaptureAccess() async -> Bool
  func startCapture(handler: @escaping @Sendable (VioletAudioFrame) -> Void) throws
  func stopCapture()
  func stopPlayback()
}

@MainActor
public final class SilentAudioIO: AudioIOPort {
  public private(set) var isCapturing = false
  public var isPlaying: Bool { false }
  public private(set) var playedFrameCount = 0

  public init() {}

  public func requestCaptureAccess() async -> Bool {
    true
  }

  public func play(_ frame: VioletAudioFrame) {
    playedFrameCount += 1
  }

  public func preparePlayback(format: VioletAudioFormat) {}

  public func startCapture(handler: @escaping @Sendable (VioletAudioFrame) -> Void) {
    isCapturing = true
  }

  public func stopCapture() {
    isCapturing = false
  }

  public func stopPlayback() {}
}

@MainActor
public final class AVAudioEngineIO: AudioIOPort {
  public private(set) var isCapturing = false
  public var isPlaying: Bool {
    playbackEndsAt.map { $0 > Date() } ?? false
  }

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var playbackEndsAt: Date?
  private var playbackFormat: VioletAudioFormat?

  public init() {
    engine.attach(player)
  }

  public func requestCaptureAccess() async -> Bool {
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

  public func startCapture(
    handler: @escaping @Sendable (VioletAudioFrame) -> Void
  ) throws {
    guard !isCapturing else {
      return
    }

    let input = engine.inputNode
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
      throw AudioIOError.unsupportedInputFormat
    }

    input.installTap(
      onBus: 0,
      bufferSize: 1_024,
      format: inputFormat,
      block: makeCaptureTapHandler(
        converter: converter,
        targetFormat: targetFormat,
        handler: handler
      )
    )

    do {
      try startEngineIfNeeded()
      isCapturing = true
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
  }

  public func stopCapture() {
    guard isCapturing else {
      return
    }
    engine.inputNode.removeTap(onBus: 0)
    isCapturing = false
    stopEngineIfIdle()
  }

  public func play(_ frame: VioletAudioFrame) throws {
    guard
      frame.format.channels == 1,
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: frame.format.sampleRate,
        channels: 1,
        interleaved: true
      )
    else {
      throw AudioIOError.unsupportedOutputFormat
    }

    let bytesPerFrame = MemoryLayout<Int16>.size
    let frameCount = frame.data.count / bytesPerFrame
    guard
      frameCount > 0,
      frame.data.count.isMultiple(of: bytesPerFrame),
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: AVAudioFrameCount(frameCount)
      )
    else {
      throw AudioIOError.invalidAudioFrame
    }

    buffer.frameLength = AVAudioFrameCount(frameCount)
    let audioBuffer = buffer.mutableAudioBufferList.pointee.mBuffers
    guard let destination = audioBuffer.mData else {
      throw AudioIOError.invalidAudioFrame
    }
    frame.data.copyBytes(
      to: destination.assumingMemoryBound(to: UInt8.self), count: frame.data.count)
    let now = Date()
    let playbackStart = max(playbackEndsAt ?? now, now)
    playbackEndsAt = playbackStart.addingTimeInterval(
      Double(frameCount) / frame.format.sampleRate
    )

    if playbackFormat != frame.format {
      try preparePlayback(format: frame.format)
    }
    try startEngineIfNeeded()
    player.scheduleBuffer(buffer)
    if !player.isPlaying {
      player.play()
    }
  }

  public func stopPlayback() {
    player.stop()
    playbackEndsAt = nil
    stopEngineIfIdle()
  }

  public func preparePlayback(format: VioletAudioFormat) throws {
    guard !engine.isRunning else {
      if playbackFormat == format {
        return
      }
      throw AudioIOError.playbackFormatChangeWhileRunning
    }
    guard
      format.channels == 1,
      let audioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: format.sampleRate,
        channels: format.channels,
        interleaved: true
      )
    else {
      throw AudioIOError.unsupportedOutputFormat
    }
    if playbackFormat != nil {
      engine.disconnectNodeOutput(player)
    }
    engine.connect(player, to: engine.mainMixerNode, format: audioFormat)
    playbackFormat = format
  }

  private func startEngineIfNeeded() throws {
    if !engine.isRunning {
      try engine.start()
    }
  }

  private func stopEngineIfIdle() {
    if !isCapturing, !player.isPlaying {
      engine.stop()
    }
  }
}

public enum AudioIOError: Error, Equatable {
  case invalidAudioFrame
  case playbackFormatChangeWhileRunning
  case unsupportedInputFormat
  case unsupportedOutputFormat
}

private func makeCaptureTapHandler(
  converter: AVAudioConverter,
  targetFormat: AVAudioFormat,
  handler: @escaping @Sendable (VioletAudioFrame) -> Void
) -> AVAudioNodeTapBlock {
  { buffer, _ in
    guard let converted = convert(buffer, using: converter, to: targetFormat) else {
      return
    }
    handler(
      VioletAudioFrame(
        data: converted,
        format: VioletAudioFormat(sampleRate: targetFormat.sampleRate)
      )
    )
  }
}

private func convert(
  _ source: AVAudioPCMBuffer,
  using converter: AVAudioConverter,
  to targetFormat: AVAudioFormat
) -> Data? {
  let ratio = targetFormat.sampleRate / source.format.sampleRate
  let capacity = max(1, AVAudioFrameCount(Double(source.frameLength) * ratio) + 1)
  guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
    return nil
  }

  let inputProvider = ConverterInputProvider(source: source)
  var conversionError: NSError?
  let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
    inputProvider.next(status: inputStatus)
  }
  guard
    conversionError == nil,
    status != .error,
    output.frameLength > 0,
    let data = output.audioBufferList.pointee.mBuffers.mData
  else {
    return nil
  }

  let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
  return Data(bytes: data, count: byteCount)
}

private final class ConverterInputProvider: @unchecked Sendable {
  private let lock = NSLock()
  private let source: AVAudioPCMBuffer
  private var supplied = false

  init(source: AVAudioPCMBuffer) {
    self.source = source
  }

  func next(
    status: UnsafeMutablePointer<AVAudioConverterInputStatus>
  ) -> AVAudioBuffer? {
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
