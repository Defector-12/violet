import AppKit
import SwiftUI
import VioletMacCore

struct PresenceView: View {
  @ObservedObject var model: PresenceModel
  @State private var draft = ""

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      conversation
      Divider()
      composer
    }
    .frame(minWidth: 360, minHeight: 440)
    .background(.regularMaterial)
  }

  private var header: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle()
          .fill(statusColor.opacity(0.16))
          .frame(width: 30, height: 30)
        Image(systemName: statusSymbol)
          .foregroundStyle(statusColor)
      }

      VStack(alignment: .leading, spacing: 2) {
        Text("Violet")
          .font(.headline)
        Text(statusLabel)
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Spacer()

      Button {
        Task {
          await model.refresh()
        }
      } label: {
        Image(systemName: "arrow.clockwise")
      }
      .buttonStyle(.plain)
      .help("Refresh connection")

      Button {
        NSApplication.shared.terminate(nil)
      } label: {
        Image(systemName: "power")
      }
      .buttonStyle(.plain)
      .help("Quit Violet")
    }
    .padding(14)
  }

  private var conversation: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 12) {
          if model.messages.isEmpty {
            VStack(spacing: 8) {
              Image(systemName: "waveform")
                .font(.system(size: 24))
                .foregroundStyle(.secondary)
              Text("I’m here.")
                .font(.title3)
            }
            .frame(maxWidth: .infinity, minHeight: 260)
          } else {
            ForEach(model.messages) { message in
              MessageRow(message: message)
                .id(message.id)
            }
          }
        }
        .padding(14)
      }
      .onChange(of: model.messages) {
        if let id = model.messages.last?.id {
          proxy.scrollTo(id, anchor: .bottom)
        }
      }
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let audioStatusLabel {
        Text(audioStatusLabel)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }

      HStack(alignment: .bottom, spacing: 10) {
        Button {
          model.toggleAudioSession()
        } label: {
          Image(systemName: audioButtonSymbol)
            .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .foregroundStyle(audioButtonColor)
        .disabled(!canControlAudio)
        .help(audioButtonHelp)

        TextField("Message Violet", text: $draft, axis: .vertical)
          .textFieldStyle(.plain)
          .lineLimit(1...4)
          .disabled(model.isAudioSessionActive)
          .onSubmit(send)

        if model.isResponding {
          Button {
            model.stop()
          } label: {
            Image(systemName: "stop.fill")
          }
          .buttonStyle(.plain)
          .help("Stop response")
        } else {
          Button(action: send) {
            Image(systemName: "arrow.up.circle.fill")
              .font(.title2)
          }
          .buttonStyle(.plain)
          .disabled(!canSend)
          .help("Send")
        }
      }
    }
    .padding(12)
    .background(Color(nsColor: .controlBackgroundColor))
  }

  private var audioButtonColor: Color {
    if case .listening = model.audioState {
      return .red
    }
    return .primary
  }

  private var audioButtonHelp: String {
    switch model.audioState {
    case .connecting, .processing:
      "Cancel audio session"
    case .listening:
      "Stop listening"
    case .failed, .idle, .unavailable:
      "Start audio session"
    }
  }

  private var audioButtonSymbol: String {
    switch model.audioState {
    case .connecting, .processing:
      "xmark.circle.fill"
    case .listening:
      "stop.circle.fill"
    case .failed, .idle, .unavailable:
      "mic.fill"
    }
  }

  private var audioStatusLabel: String? {
    switch model.audioState {
    case .connecting:
      "Connecting audio"
    case .failed(let message), .unavailable(let message):
      message
    case .idle:
      nil
    case .listening:
      "Listening"
    case .processing:
      "Responding"
    }
  }

  private var canControlAudio: Bool {
    if model.isAudioSessionActive {
      return true
    }
    guard case .ready = model.connectionState else {
      return false
    }
    return !model.isResponding
  }

  private var canSend: Bool {
    guard case .ready = model.connectionState else {
      return false
    }
    return
      !model.isAudioSessionActive
      && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var statusColor: Color {
    switch model.connectionState {
    case .ready:
      .green
    case .checking:
      .secondary
    case .offline:
      .red
    case .sealed:
      .orange
    }
  }

  private var statusLabel: String {
    switch model.connectionState {
    case .checking:
      "Checking connection"
    case .offline(let message):
      message
    case .ready:
      "Ready"
    case .sealed:
      "Sealed"
    }
  }

  private var statusSymbol: String {
    switch model.connectionState {
    case .ready:
      "checkmark"
    case .checking:
      "ellipsis"
    case .offline:
      "exclamationmark"
    case .sealed:
      "lock.fill"
    }
  }

  private func send() {
    guard canSend else {
      return
    }
    let message = draft
    draft = ""
    model.send(message)
  }
}

private struct MessageRow: View {
  let message: PresenceMessage

  var body: some View {
    HStack {
      if message.role == .user {
        Spacer(minLength: 36)
      }
      Text(message.text.isEmpty ? "…" : message.text)
        .textSelection(.enabled)
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
      if message.role == .assistant {
        Spacer(minLength: 36)
      }
    }
  }

  private var background: Color {
    message.role == .user
      ? Color.accentColor.opacity(0.16)
      : Color(nsColor: .controlBackgroundColor)
  }
}
