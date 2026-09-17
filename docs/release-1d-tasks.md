# Release 1D：任务拆分

> 状态：方案已批准；Phase 1 代码已在本地实现并通过自动化合并门，尚未提交或部署。
> Phase 2/3 未开始。
> 产品合同见 [最终规格](./release-1d-spec.md)，放行条件见
> [验收清单](./release-1d-acceptance.md)。

## 1. 切分原则

- 按 Phase 1 → Phase 2 → Phase 3 实施，每阶段独立合并和回滚。
- PostgreSQL 始终是唯一事实源，不增加服务、运行时或外部依赖。
- 协议先改 Schema/OpenAPI，再生成 TypeScript 与 Swift 客户端。
- 每阶段先跑聚焦测试，再跑受影响的完整回归。
- 所有测试通过 `.local-acceptance/test-runs/` 留证。
- 未经用户另行授权，不提交、推送、部署或修改机器配置。

## 2. Phase 1：统一有界上下文

**独立价值**

先解决现有文字全量发送账本、语音固定截取 40 条的分叉。该阶段不创建长期记忆，现有
短对话、重启和语音体验保持可用。

### 1D-01 领域和存储

修改：

- `packages/domain/src/model-gateway.ts`
- `packages/domain/src/conversation-ledger.ts`
- `packages/domain/src/context-checkpoint.ts`
- `packages/domain/src/index.ts`
- `infra/migrations/0002_context_checkpoints.sql`
- `services/core/src/conversation/context-epoch-manager.ts`

新增最小合同：

- 模型 context window、最大输出和 token 估算；
- 按 sequence 读取完整逻辑轮次；
- `context_epochs`、事件的可空 `context_epoch_id` 和 30 分钟边界；
- 单一滚动 checkpoint 及 deletion revision。

测试：

- 空库和 `0001` 数据库都可升级。
- 并发写入顺序稳定，同一 `request_id` 的用户/助手轮次不被拆开。
- checkpoint 正文使用现有加密信封。

### 1D-02 ContextAssembler

新增：

- `services/core/src/conversation/context-assembler.ts`
- `services/core/src/storage/postgres-context-checkpoint-repository.ts`
- 对应单元与数据库测试。

实现：

- 预留输出和 4,096-token 安全余量；
- 缺失最大输出时按 16,384 tokens；
- 保留最近 20,000 tokens 完整轮次；
- 最旧完整前缀压入唯一 checkpoint；
- 二次压缩仍失败时明确报错；
- 大型工具/视觉文本在入口截断并保留引用。
- checkpoint 复用当前文字模型；保存前校验覆盖范围和 deletion revision 未变化。

### 1D-03 接入文字和语音

修改：

- `services/core/src/conversation/chat-service.ts`
- `services/core/src/realtime/realtime-session.ts`
- `services/core/src/realtime/pipeline-realtime-conversation.ts`
- `services/core/src/realtime/qwen-audio-realtime-conversation.ts`
- `services/core/src/model/*-model-gateway.ts`
- `services/core/src/main.ts`

要求：

- 删除文字全量 `ledger.list()` 和语音 `.slice(-40)`。
- 三条路径只使用 ContextAssembler 输出。
- Qwen 保留 `max_history_turns = 20`。
- 已绑定 epoch 的 Realtime 连接跨过 30 分钟空闲边界时，在新输入到达供应商前明确
  失败并关闭；重连后进入新 epoch，不沿用旧供应商历史。
- 不改变 Natural Pointing 的当前轮、新鲜度、取消和隐私门禁。

**Phase 1 合并门**

- 长历史只产生一个滚动 checkpoint。
- 文字、Pipeline、Qwen 使用同一装配顺序和预算。
- Release 1C 的视觉、取消、结束意图和隐私回归通过。
- 可以关闭 checkpoint 回到有界完整轮次，不回滚数据库迁移。

## 3. Phase 2：明确记忆和治理闭环

**独立价值**

用户可以明确要求记住，并在 Mac 查看、纠正和删除。普通轮次仍不自动提取，因此不会
在治理能力完成前产生隐藏记忆。

这一阶段横跨 Core、协议、Mac 和备份，不能再拆成“先能写、以后再能删”的生产阶段。

### 1D-04 明确记忆数据模型

修改或新增：

- `infra/migrations/0003_explicit_memory.sql`
- `packages/domain/src/memory.ts`
- `packages/domain/src/conversation-ledger.ts`
- `packages/domain/src/index.ts`
- `services/core/src/storage/postgres-memory-repository.ts`

迁移包含：

- 原子 memories、sources、summary；
- 最小墓碑和 `restore_epoch`。

要求：

- 上线前事件不回填长期记忆。
- 复用 Phase 1 已建立的 epoch，旧事件继续保持无 epoch。
- 所有语义字段加密，来源指向最终用户事件及原文位置。

### 1D-05 明确记忆、纠正和 summary

新增：

- `services/core/src/memory/memory-service.ts`
- `services/core/src/memory/memory-proposal.ts`
- `services/core/src/memory/memory-summary.ts`
- `packages/policy/src/memory-content.ts`
- 对应测试。

要求：

- 明确记住和纠正同步完成。
- 模型提议长期价值和原子内容；Core 校验 Schema、来源、引用、秘密、版本和幂等。
- 记忆影响范围固定为 Violet 对话理解与回答，不新增任何工具或行动权限。
- 自动提议不能 supersede；明确纠正创建新版本并立即失效旧版本。
- 绝对秘密拒绝；明确受控敏感内容按原话保存且不调用提取模型。
- summary 确定性生成、不超过 8,900 bytes；revision 不匹配时停用。

### 1D-06 `recall_memory`

修改或新增：

- `packages/domain/src/model-gateway.ts`
- `packages/domain/src/realtime-conversation.ts`
- `services/core/src/memory/memory-search.ts`
- `services/core/src/memory/recall-memory-tool.ts`
- `services/core/src/model/deepseek-model-gateway.ts`
- `services/core/src/realtime/pipeline-realtime-conversation.ts`
- `services/core/src/realtime/qwen-audio-realtime-conversation.ts`
- 对应测试。

要求：

- query + 可选时间范围，最多 5 条；
- 规范化文本和时间检索，不建向量或明文索引；
- 可以按需搜索未删除旧事件；
- 文字、Pipeline、Qwen 使用同一结果；
- 无结果时明确 `not_found`；
- 保持 Qwen 现有 `inspect_current_view` 行为不变。

### 1D-07 管理 API 和 Mac 窗口

修改或新增：

- `packages/protocol/openapi/v1.yaml`
- `packages/protocol/schemas/v1/` 中的最小 memory request/response Schema
- `packages/protocol/src/types.ts`
- `packages/sdk/src/client.ts`
- `services/core/src/http/app.ts`
- `apps/macos/Sources/VioletMacCore/MemoryClient.swift`
- `apps/macos/Sources/VioletMacCore/MemoryManagementModel.swift`
- `apps/macos/Sources/VioletApp/MemoryManagementView.swift`
- `apps/macos/Sources/VioletApp/MemoryWindowController.swift`
- 现有 `PresenceView`、`StatusItemController`、`VioletApplication`
- 对应 TypeScript 与 Swift 测试。

API 只覆盖：

- 列表和详情；
- 纠正；
- 删除预览、确认和清理状态。

Mac 窗口只覆盖：

- 当前记忆、近期变化、搜索、筛选和来源；
- 纠正和删除；
- 记忆入口变化标记；
- 受控敏感默认遮挡。

### 1D-08 删除传播和官方恢复

修改：

- `services/core/src/memory/memory-deletion-service.ts`
- `services/core/src/storage/postgres-conversation-ledger.ts`
- `packages/backup/src/backup-envelope.ts`
- `services/backup/src/main.ts`
- `scripts/backup-devbox.sh`
- `scripts/restore-backup.sh`
- `infra/compose/compose.yaml`
- 对应数据库、备份和脚本测试。

要求：

- 模型只提议目标，Core 解析 ID 并返回完整影响预览。
- 自然语言“忘掉”和 Mac 删除按钮进入同一预览/确认路径。
- 确认后事务删除整个来源轮次、关联来源、孤儿记忆并失效 summary/checkpoint。
- 迟到提取和检索在提交/返回前检查事件及墓碑。
- 删除增加 `restore_epoch`；Mac 先把最低纪元写入 Keychain 再确认。
- 备份格式记录 epoch；官方恢复拒绝旧 epoch。
- 删除后生成并验证干净备份，再清理 Violet 管理的旧本地和 TOS 版本。
- 不建立逐记录密钥系统。

**Phase 2 合并门**

- 明确记住、纠正、查看来源和删除在文字/语音路径一致。
- 用户可从独立 Mac 窗口治理全部新记忆。
- 删除后在线召回为 0，删除前备份被官方恢复拒绝。
- 普通陈述不会自动产生记忆。
- 回滚可以关闭记忆注入；已有记忆和删除能力必须继续可用。

## 4. Phase 3：自动记忆和评估

**独立价值**

在 Phase 2 治理闭环上开启普通完成轮次的自动学习。

### 1D-09 异步提取

新增或修改：

- `infra/migrations/0004_memory_jobs.sql`
- `services/core/src/memory/memory-job-runner.ts`
- `services/core/src/memory/memory-proposal.ts`
- `services/core/src/conversation/chat-service.ts`
- `services/core/src/realtime/realtime-session.ts`
- `packages/protocol`、`packages/sdk` 和 Mac 记忆窗口的自动记忆设置；
- `services/core/src/main.ts`
- 对应测试。

要求：

- 任务持久化在 PostgreSQL，由现有 Core 内部处理，不增加服务。
- 只有最终用户输入和完整助手回复组成的轮次入队。
- 关闭自动记忆后停止新增，重开不补提取。
- 写前检查来源和墓碑；Core 重启后未完成任务可恢复。
- 健康环境从轮次完成到可见 p95 不超过 60 秒。

### 1D-10 评估集和默认开启

新增：

- `services/core/src/memory/fixtures/release-1d-memory.jsonl`
- `services/core/src/memory/release-1d-memory.eval.test.ts`
- 根 `package.json` 的 `eval:memory` 命令。

评估集至少覆盖：

- 40 条明确记住；
- 100 条自动提取正负例；
- 50 条明确历史召回；
- 20 条无关历史；
- 10 条纠正；
- 20 条删除和迟到任务；
- 20 条秘密、助手推断和工具内容负例。

真实模型用例每条运行 3 次并保留全部结果。全部门槛通过后，生产自动记忆才从关闭改为
默认开启。

**Phase 3 合并门**

- 自动记忆精确率不低于 95%，召回率不低于 80%。
- 明确历史 Top-5 召回率不低于 90%。
- 秘密写入、助手推断、旧版本复活和删除后复活均为 0。
- 关闭后的 20 个完成轮次新增为 0，重开后补提取为 0。
- 可单独关闭自动提取，Phase 2 继续工作。

## 5. 验证命令

通过仓库固定的 Node 版本运行：

```sh
fnm exec --using=.node-version -- pnpm check:ci
fnm exec --using=.node-version -- pnpm eval:memory
fnm exec --using=.node-version -- pnpm macos:test
fnm exec --using=.node-version -- pnpm macos:app
docker compose -f infra/compose/compose.yaml config
```

每条命令由 `pnpm test:record` 或现有包装脚本生成独立 test-run。数据库迁移、真实模型、
TOS 清理、官方恢复和真人故事各自单独留证。

## 6. 完成定义

- 三个 Phase 的合并门全部通过。
- [验收清单](./release-1d-acceptance.md)所有 P0/P1 项有可检查证据。
- 真实 Mac 完成跨重启、跨模态、纠正、删除和恢复的最终故事。
- 实际 commit、构建、部署、失败和 run ID 写回验收文档。
- 用户明确批准发布后，才开启生产自动记忆。
