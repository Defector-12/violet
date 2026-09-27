import SwiftUI
import VioletMacCore

struct MemoryManagementView: View {
  @ObservedObject var model: MemoryManagementModel
  @State private var correction = ""

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        TextField("搜索记忆", text: $model.search)
          .textFieldStyle(.roundedBorder)
          .accessibilityLabel("搜索记忆")
        Picker("类型", selection: $model.kind) {
          Text("全部类型").tag("")
          Text("偏好").tag("preference")
          Text("事实").tag("fact")
          Text("目标").tag("goal")
          Text("关系").tag("relationship")
        }.frame(width: 150)
        Toggle("近七天变化", isOn: $model.recentOnly)
        Button("刷新", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
          .keyboardShortcut("r", modifiers: .command)
          .disabled(model.busy)
      }.padding()
      if let error = model.errorMessage {
        Text(error).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal)
      }
      if model.pendingConfirmation {
        HStack {
          Text("上一次删除的结果尚未确认。")
          Button("重试确认") { Task { await model.refresh() } }.disabled(model.busy)
        }.padding(8)
      }
      if model.pendingPreviewId != nil {
        Button("查看对话中提出的删除预览") { Task { await model.refresh() } }
          .disabled(model.busy).padding(8)
      }
      Divider()
      HSplitView {
        VStack(alignment: .leading) {
          Toggle("最近更新优先", isOn: $model.newestFirst).padding(.horizontal)
          List(selection: Binding(
            get: { model.selectedId },
            set: { id in if let id { Task { await model.select(id) } } }
          )) {
            ForEach(model.visibleMemories, id: \.id) { memory in
              VStack(alignment: .leading, spacing: 6) {
                Text(memory.redacted == true ? "受控敏感内容 · 已遮挡" : memory.content)
                  .lineLimit(3)
                Text("v\(memory.version) · \(memory.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                  .font(.caption).foregroundStyle(.secondary)
              }.tag(memory.id).padding(.vertical, 4)
            }
          }
          .overlay {
            if model.memories.isEmpty && !model.busy {
              Text("还没有明确记住的内容").foregroundStyle(.secondary)
            }
          }
        }.frame(minWidth: 260, idealWidth: 310)
        ScrollView {
          if let detail = model.detail {
            VStack(alignment: .leading, spacing: 16) {
              if detail.versions.contains(where: { $0.redacted == true }) {
                Button("显示此条敏感内容") {
                  if let id = model.selectedId { Task { await model.select(id, reveal: true) } }
                }.disabled(model.busy)
              }
              ForEach(detail.versions, id: \.version) { memory in
                VStack(alignment: .leading, spacing: 6) {
                  Text(memory.state == .current ? "当前 · v\(memory.version)" : "已被纠正 · v\(memory.version)")
                    .font(.headline)
                  Text(memory.content).textSelection(.enabled)
                  Text("明确记住 · \(memory.updatedAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
                  if memory.state == .current {
                    Button("删除这条记忆…", role: .destructive) {
                      Task { await model.prepareDeletion(.memory(id: memory.id, version: memory.version)) }
                    }.disabled(model.busy || model.pendingConfirmation)
                  }
                }
              }
              if detail.versions.contains(where: { $0.state == .current }) {
                Divider()
                Text("纠正为").font(.headline)
                TextField("输入完整、正确的内容", text: $correction, axis: .vertical)
                  .lineLimit(3...8).textFieldStyle(.roundedBorder)
                Button("保存纠正") {
                  Task {
                    await model.correct(content: correction)
                    if model.errorMessage == nil { correction = "" }
                  }
                }.disabled(model.busy || correction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
              }
              Divider()
              Text("来源轮次").font(.headline)
              ForEach(detail.events, id: \.id) { event in
                VStack(alignment: .leading, spacing: 6) {
                  Text("\(event.role == .user ? "你" : "Violet") · \(event.occurredAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
                  Text(event.content).textSelection(.enabled)
                  if event.role == .user {
                    Button("删除这个来源轮次…", role: .destructive) {
                      Task { await model.prepareDeletion(.source(eventId: event.id)) }
                    }.disabled(model.busy || model.pendingConfirmation)
                  }
                }
              }
            }.padding()
          } else {
            Text("选择一条记忆，查看内容和来源。")
              .foregroundStyle(.secondary).padding(32)
          }
        }.frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
      }
      Divider()
      HStack {
        Button("清空已学习记忆…", role: .destructive) { Task { await model.prepareDeletion(.all) } }
          .disabled(model.busy || model.memories.isEmpty || model.pendingConfirmation)
        Spacer()
        if model.busy { ProgressView().controlSize(.small).accessibilityLabel("正在处理记忆") }
        if let cleanup = model.cleanup {
          Text(cleanupLabel(cleanup)).font(.caption)
          Button(cleanup.status == .failed ? "重试备份清理" : "更新清理状态") {
            Task { await model.refreshCleanup(retry: cleanup.status == .failed) }
          }.disabled(model.busy)
        }
      }.padding()
    }
    .onChange(of: model.selectedId) { correction = "" }
    .sheet(isPresented: Binding(
      get: { model.preview != nil }, set: { if !$0 { model.cancelPreview() } }
    )) {
      if let preview = model.preview { deletionPreview(preview) }
    }
    .frame(minWidth: 820, minHeight: 560)
  }

  private func deletionPreview(_ preview: MemoryDeletionPreview) -> some View {
    let clearAll: Bool = { if case .case3 = preview.target { return true }; return false }()
    return VStack(alignment: .leading, spacing: 14) {
      Text(clearAll ? "确认清空已学习记忆" : "确认删除范围").font(.title2)
      Text("将删除以下来源轮次，包括你的输入和 Violet 的回复，以及失去来源的记忆。此操作无法撤销。")
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          Text("删除 \(preview.requestIds.count) 个完整轮次").font(.headline)
          ForEach(preview.events, id: \.id) { event in
            Text("\(event.role == .user ? "你" : "Violet")：\(event.content)").textSelection(.enabled)
          }
          Divider()
          Text("受影响的记忆").font(.headline)
          ForEach(Array(preview.memories.enumerated()), id: \.offset) { _, memory in
            Text("\(preview.retainsSources(for: memory) ? "保留其他来源" : "删除") · v\(memory.version)：\(memory.content)")
              .textSelection(.enabled)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
      HStack {
        Spacer()
        Button("取消") { model.cancelPreview() }.keyboardShortcut(.cancelAction).disabled(model.busy)
        Button(clearAll ? "确认清空" : "确认删除", role: .destructive) {
          Task { await model.confirmDeletion() }
        }.disabled(model.busy)
      }
    }.padding(24).frame(width: 620, height: 500).interactiveDismissDisabled(model.busy)
  }

  private func cleanupLabel(_ status: MemoryDeletionStatus) -> String {
    switch status.status {
    case .pending: "在线删除完成；备份清理排队中"
    case .running: "在线删除完成；正在清理备份"
    case .complete: "在线删除和备份清理完成"
    case .failed: "在线删除完成；备份清理失败"
    }
  }
}
