# Release 1D：任务拆分

> 状态：方案已批准；Phase 1 复盘修复已合入双主线并重新部署；用户于 2026-09-20
> 批准开始 Phase 2 实现，A—D 本地实现及 E 自动化/评估工具已完成；
> 真实模型质量、Keychain/TOS 恢复及 Mac 故事覆盖已通过，最终真人缺口见 2.24。
> 交付收尾完成，边界缺陷已修复，550 项 TS/脚本、116 项 Mac 全量回归及打包验签通过；
> 最终复核与交付边界见 2.25。Phase 2 已合入双主线，Core、0003 与新版备份调度
> 已部署；本机恢复保护初始化、官方隔离恢复和 Mac 启动待普通终端完成（2.26）。
> Phase 3 未开始。当前部署版本见验收清单 2.26。
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
- `infra/migrations/0002b_context_turn_failures.sql`
- `infra/migrations/0002c_context_event_ids.sql`
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
- checkpoint 水位不能跨过更早的未完成 request；读取和事务保存都验证连续完整前缀。
- 文字请求失败或取消后写入无正文终止标记；终止轮次不进入历史，也不再阻塞水位。
- 相同 request 重试会清除终止标记，成功助手事件也会原子清除标记。
- 并发文字请求按输入到达顺序分配 epoch，时间水位不能回拨。
- 带临时 Context 的文字请求持久化 context session/event 复合身份；相同 request
  不得改用另一份 Context。

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
- adapter 的输入预算与 checkpoint 生成预算分离；Qwen 使用自己的保守文本预算和
  `max_history_turns = 20`。

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
- 已打开的 Integrated Realtime 连接若发现同一 epoch 被其他入口推进，在新输入到达
  供应商前明确失败并关闭；重连后读取最新统一上下文。
- Pipeline 在模型装配前保证当前最终用户事件已落账，并使用其 sequence 作为读取上界。
- Integrated Realtime 自动 VAD 回答在最终转写落账和快照复核前不得对客户端可见。
- 视觉工具调用的中间取消不清除 turn epoch，grounded 最终回答必须与用户输入一起落账。
- 同一 turn 的持久化串行执行并规范化 UUID；重试使用 attempt ID 隔离，旧 attempt 的
  迟到输出和取消不能影响当前 attempt。
- Qwen 文字重试不重复创建 provider item，只补发尚未成功的 `response.create`。
- 失败终止标记由跨会话共享恢复器重试；Core 启动时终止化遗留 user-only 轮次。
- Core 关闭前有界排空 Realtime 会话，再关闭数据库；生产数据库使用 advisory lease
  拒绝第二个并发 Core 进程。
- 不改变 Natural Pointing 的当前轮、新鲜度、取消和隐私门禁。

**Phase 1 合并门**

- 长历史只产生一个滚动 checkpoint。
- 文字、Pipeline、Qwen 使用同一装配顺序和预算。
- Release 1C 的视觉、取消、结束意图和隐私回归通过。
- 可以关闭 checkpoint 回到有界完整轮次，不回滚数据库迁移。
- 关闭 checkpoint 后既不创建也不读取此前持久化的 checkpoint。

## 3. Phase 2：明确记忆和治理闭环

**独立价值**

用户可以明确要求记住，并在 Mac 查看、纠正和删除。普通轮次仍不自动提取，因此不会
在治理能力完成前产生隐藏记忆。

这一阶段横跨 Core、协议、Mac 和备份，不能再拆成“先能写、以后再能删”的生产阶段。

### 本轮审阅摘要（2026-09-20，已确认）

**交付目标**：用户明确要求记住后，Violet 在重启、跨天和文字/语音切换后仍能正确
使用；用户可以查原话、纠正、删除及清空，已删除内容不能通过官方恢复流程复活。
这也是本阶段的最小完整交付单位。普通聊天可以继续使用短期上下文，但不会自动
新增长期记忆；自动提取及其开关留在 Phase 3。

**开发思路**：沿用 PostgreSQL 事件账本、`EnvelopeCipher` 和共享 `ContextAssembler`，
在现有 Core 内完成记忆服务。模型理解用户的明确意图并提出结构化内容，Core 校验来源、
隐私、版本和幂等后执行。记忆只影响理解与回答，不赋予行动权限。新增持久结构、
一个召回工具和一个 Mac 窗口；不增加服务、依赖、模型供应商或向量检索。

| 工作包 | 开发任务 | 可审阅交付物 | 工作量与主要风险 |
|---|---|---|---|
| A 数据与协议 | 1D-04，加 1D-07/08 的版本、来源、纠正和删除合同 | `0003`、领域合同、加密存储、Schema/OpenAPI 与生成客户端；事务和幂等测试 | 中；来源引用、版本与事务一致性 |
| B 同步记忆与召回 | 1D-05/06，接入文字、Pipeline、Qwen | 本轮确认的记住/纠正结果、最多 8,900 bytes 的确定性 summary、最多 5 条的 `recall_memory` | 高；语音提前报成功、旧上下文和工具往返 |
| C Mac 治理 | 1D-07 与 Keychain 接入 | 独立窗口、近期变化、来源、纠正、删除预览、单独确认清空、入口变化标记 | 中；流事件到 UI、敏感遮挡和最低纪元持久化 |
| D 删除与恢复 | 1D-08，贯穿 A—C | 整轮删除、在途内容失效、认证恢复纪元、干净备份验证、旧副本清理及可查询状态 | 高；删除与备份并发、失败恢复 |
| E 验收与交付 | Phase 2 合并门及 1D-10 的相关样本 | 自动化与真实样本结果、Mac 十步故事、迁移/恢复/回滚记录和验收文档 | 中；真实供应商质量与跨模块证据 |

工作量用于安排顺序，不构成固定工期承诺。A—E 是一个 Phase 内的工作包；
删除合同从 A 开始实现，D 闭合恢复链路后一起验收。每完成一个工作包，报告产物、
验证结果和下一步；不为尚未完成治理的写入能力安排独立生产上线。

**本地交付状态（2026-09-25）**：A—E 的实现、模型和真人覆盖已完成。交付自检
13 个独立问题已修复；最终全仓 550 项 TS/脚本（含真实 PostgreSQL 和备份恢复）、
116 项 Mac 测试通过，App 已重建签名。Mac 采用显式串行调度，竞态用例另保留
受控交错和三次验证，之前的并行失败与挂起不计为通过。详细证据及迁移/回滚交接见
验收清单 **2.25**。

真实模型明确写入 120/120、纠正 30/30；历史来源 146/150（97.3%，三轮
48、49、49/50），无关、删除预览、普通聊天及负例见 2.19。最后提示微调仅定向
21/21，不冒称又完整跑过矩阵。Qwen 五次故事三次完整通过、两次初始化超时保留；
纠正确认专项 3/3，真实 Keychain/TOS 和真人故事见 2.16、2.20—2.24。
来源、键盘/VoiceOver、取消删除已获用户确认；短验收补齐重启文字召回、跨模态
纠正、完整播放和删除后问答，记录与体感一致，不要求重复实机故事。

累计文字模型费用上界 **8.958104/10 元**，收尾未新增付费调用。用户于 2026-09-27
明确授权提交与部署，实现已合入双主线，云端运行 `b3fa62c-release-1d-phase2`。
生产迁移、新版备份、调度及只读验证完成；Mac 激活的沙箱限制和普通终端收尾见
验收清单 **2.26**。Phase 3 未开始。

**需要在实现中保持的关键决定**

- 普通用户原话是来源；助手、视觉、工具、临时转写和取消轮次不是用户事实。
  明确记住和纠正必须在成功回复可见前提交；失败返回真实状态。同一请求重试复用
  原结果，不能再造一条记忆或新版本。敏感内容先过策略，明确受控敏感正文按原话
  保存并跳过提取模型。
- 记忆变更由同一 Core 服务处理。纠正追加版本并废止旧版本；同时失效派生上下文，
  取消仍使用旧版本的回答并关闭持有旧上下文的实时连接。重连重新装配，用户无需
  选择“新会话”。Qwen 继续使用原有视觉路径和 20 轮上限。
- 删除一条记忆会删除支撑它的来源轮次，包括对应用户输入、助手回复及受影响派生物；
  预览列出连带影响和仍有其他来源的记忆。用户也能只删一个来源。自然语言“忘掉”
  只打开同一预览路径，最终确认由 Mac 发起。
- 备份复用 PostgreSQL 17 的同步快照能力：读取恢复纪元的事务导出快照，`pg_dump`
  使用该快照，事务保持到 dump 完成。使用现有 AES-GCM 格式能力认证实例与纪元；
  解密验证阶段不落明文，认证和最低纪元检查通过后才写出 dump。旧格式视为纪元 0。
- 关闭记忆注入是能力回滚，管理、纠正和删除仍可使用。数据迁移向前保留；部署后
  不能退回不理解恢复纪元的旧程序，也不能通过恢复删除前数据库实现回滚。

最脆弱的前提是：Qwen 会在最终转写和 Core 记忆处理完成前产生回答。实现必须使用
现有延迟输出、取消和后续响应机制，只释放依据 Core 结果生成的成功答复；不能把
供应商事件顺序当作保证。如果无法获得可靠的最终转写或完成写入，该轮明确失败。
真实语音样本同时记录记忆处理耗时与首音频延迟，不以先播成功回执掩盖等待。

**本阶段的交付门槛**

- 明确记住 40 条、纠正 10 条、删除与迟到写入 20 条、秘密/助手/工具负例 20 条；
  属于真实模型的每例运行 3 次并保留全部结果。明确记住成功率 100%，来源正确，
  秘密写入、虚假成功、旧版本或删除内容继续使用均为 0。
- 50 条明确历史召回 Top-5 不低于 90%，当前记忆召回不低于 80%；20 条无关历史中
  错误使用不超过 1 条。无结果明确 `not_found`。本地检索 p95 不超过 300 ms，
  报告 p50/p95/p99/最大值；增加十倍合成数据规模测量，标明数据量，不预建索引链路。
- 20 个普通完成轮次新增长期记忆为 0；summary 过期、取消、超时、数据库失败、
  并发纠正/删除、Keychain 失败和备份清理失败都有明确结果与证据。
- Mac 独立窗口可查看、纠正和删除，敏感正文默认遮挡；键盘与 VoiceOver 可完成
  主要操作。完成验收清单第 11 节的跨重启、跨模态、纠正、删除及隔离恢复十步故事。
- 全量回归覆盖受影响的 Phase 1 与 Natural Pointing 合同；不以增加评估器措辞规则
  或反复运行不变测试代替产品证据。失败只在证据指向的范围内修复和复验。

**交接与依赖**：文件接入点、开发顺序和验证命令见下文。继续使用已有 DeepSeek Key、
DashScope Key/业务空间、TOS 桶与最小权限凭据、Mac 设备令牌、内容密钥及备份恢复
密钥，不引入新账号或凭据。官方文档确认 DeepSeek 和 Qwen 支持工具调用，
PostgreSQL 支持同步快照；文档可访问不等于当前账号和新功能验收通过。
真实模型、TOS 清理、Keychain 写入和生产部署各自保留对应验收与授权边界。

参考：[DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、
[Qwen 实时语音](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)、
[PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)、
[Node.js 22 认证解密](https://nodejs.org/docs/latest-v22.x/api/crypto.html#decipherupdatedata-inputencoding-outputencoding)。

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

### Phase 2 开工顺序与接入说明

沿用已批准的 1D-04—08，不重新设计记忆体系。以下是同一 Phase 内的开发顺序，
不是可以单独上线的产品阶段；明确写入、治理和恢复防复活一起通过合并门。
本阶段涉及超过 8 个文件，横跨 Core、协议、Mac 和既有备份程序，不增加服务或依赖。

```text
Mac 文字 / 语音 / 记忆窗口
             ↓ /v1
Core：明确记忆与治理 → PostgreSQL 事件、记忆、来源、revision
             ↓
共享 ContextAssembler / recall_memory → DeepSeek / Pipeline / Qwen

Mac Keychain 最低恢复纪元 → 删除确认 → PostgreSQL restore_epoch
                                           ↓
                                既有备份程序 → 本地 / TOS
Mac Keychain 最低恢复纪元 → 官方恢复校验 ← 备份认证纪元
```

| 顺序 | 对应任务 | 可检查产物 |
|---|---|---|
| 1 | 1D-04、1D-08 数据事务、1D-07 协议合同 | `0003`、领域合同、加密存储及来源校验；纠正和整轮删除事务；版本、幂等、删除预览与确认的 Schema/OpenAPI |
| 2 | 1D-05—06、文字/语音接入 | 同步明确记忆、确定性 summary、同一 `recall_memory`；三条对话路径只使用 Core 确认的结果 |
| 3 | 1D-07 Mac | 独立窗口、来源、纠正、删除预览、清空、变化标记；Keychain 写入失败不发送删除确认 |
| 4 | 1D-08 备份与恢复 | 认证恢复纪元、干净备份验证、旧版本清理及清理状态；旧备份拒绝、新备份隔离恢复 |
| 5 | Phase 2 合并门 | 聚焦与跨模块回归、真实模型样本、Mac 十步故事及各自 test-run |

**在原任务文件清单上补齐这些接入点**

- `services/core/src/main.ts`、`config.ts`：组装共享记忆服务，提供规格要求的记忆注入
  回滚开关；关闭注入不关闭管理和删除。
- `services/core/src/conversation/chat-service.ts`、`pipeline-context.ts`、
  `context-assembler.ts` 与 `realtime/realtime-session.ts`：同步写入和治理结果进入
  现有请求生命周期；summary 纳入既有预算与不可信数据边界。保留请求终止化、
  attempt 隔离、完整轮次和 snapshot 校验。
- `packages/domain/src/model-gateway.ts` 开工前只有文本消息及 delta/complete；
  本阶段已为 DeepSeek 补齐请求、工具调用与结果回传，
  同步更新 deterministic adapter；复用原有聊天运行时。
- Qwen 开工前仅有 `inspect_current_view` 的专用请求/结果路径。新增召回按工具名
  分派，保留视觉行为和 `max_history_turns = 20`。明确记忆应在成功措辞及音频对用户
  可见前得到 Core 结果，不能只在 `response.completed` 后补写。
- `packages/protocol/src/validation.ts`、`index.ts`、两个 stream event Schema：
  增加校验与导出；先更新 Schema/OpenAPI，再生成 TypeScript 和 Swift 输入文档。
- `apps/macos/Sources/VioletMacCore/CoreClient.swift`、`RealtimeSessionClient.swift`、
  `PresenceModel.swift`：已把不含正文的 `memoryChanges` 和删除预览引用
  从文字/语音完成事件传到管理模型与记忆入口。
- 新增 `apps/macos/Sources/VioletMacCore/RestoreEpochStore.swift`，沿用
  `RuntimeConfiguration.swift` 的 Security.framework 用法；最低恢复纪元与设备 Token
  分项保存，按实例绑定，只允许增加。

**必须随实现一起闭合的约束**

- 存储沿用现有实例行锁及 `EnvelopeCipher`；`memory_revision` 用于记忆视图，
  `deletion_revision` 用于派生内容失效，`restore_epoch` 用于恢复防复活，职责不混用。
  来源只存最终用户事件引用和 UTF-8 byte offset，解密后逐字验证；多字节中文和
  emoji 必须覆盖。
- 明确写入失败必须反馈失败；相同 request 重试不能增加重复版本。普通陈述、
  助手推断、工具和视觉结果不能进入本阶段写入路径。敏感内容在提取模型调用前校验；
  明确受控敏感记忆按原话保存，不额外调用提取模型。
- 纠正和删除不仅使下一次 summary 失效，也须阻止已打开的 Qwen 连接和正在生成的
  旧回答继续使用被废止内容。沿用现有取消、关闭、重连装配机制，覆盖在途召回、
  checkpoint 与迟到写入。
- 删除预览绑定版本与完整影响范围；Mac 先保存最低恢复纪元再确认。确认请求失败后
  保留已经增加的本地纪元，以同一删除 ID 查询/重试；不降低纪元来掩盖失败。
- 备份的纪元必须与 dump 属于同一数据库快照，不能给删除前 dump 标记删除后纪元。
  旧格式按纪元 0 处理；最低纪元缺失或认证失败时，官方恢复明确失败。通过认证和
  最低纪元检查前不得写出明文 dump。
- 删除完成后的清理状态可查询、失败可重试；先验证干净备份，再清理受管旧副本、
  TOS versions、delete markers 和 multipart uploads。清理失败不撤销在线删除。
- 独立“清空已学习记忆”属于本阶段治理，复用删除预览与确认。自动提取任务、
  自动记忆开关及其默认开启仍属于 1D-09—10；Phase 2 普通轮次新增记忆必须为 0。

**验证安排**

先验证存储事务、来源、版本和秘密负例，再验证三条对话路径、协议、Mac 与备份。
复用现有 PostgreSQL 集成测试方式，使用独立 `pgvector` 测试库；扩展名来自 `0001`
迁移，不代表启用向量检索。迁移覆盖空库及 `0001 → 0002 → 0002b → 0002c → 0003`。

提前使用 1D-10 中属于 Phase 2 的明确记住、历史召回、纠正、删除和敏感负例；
真实模型每例 3 次保留全部输出，语义结果按事实和来源核对。不要通过继续增加
checkpoint 评估器措辞规则来证明记忆正确。`eval:memory` 已实现并完成本地固定提议、
真实 PostgreSQL 与性能验证。早期真实模型写入 117/120、纠正 28/30、
历史来源 102/150 的失败保留在 2.15；最新修复结果为写入 120/120、纠正 30/30、
历史来源 146/150，见 2.19。真实 Keychain/TOS 官方恢复组合见 2.16。
重启记忆、语音分段和纠正确认收尾问题已分别在 2.17、2.18、2.21 修复；
窗口观察见 2.22，最终短验收已补齐文字、跨模态、完整播放及删除后问答。
证据与限制以[验收记录 2.24](./release-1d-acceptance.md#224-三项短验收通过记录与真人体感一致2026-09-25)
及其引用为准；不能把本地给定关键词命中率当作真实模型质量。
自动提取指标留到 Phase 3。

开发验证使用第 5 节命令及 `pnpm test:record`，Mac 测试与 App 构建串行运行。
真实模型、TOS 和恢复验证各自记录，不以 mock 替代真实通过。发布前完成验收清单
第 11 节故事；数据库恢复使用隔离库。回滚保留治理 API、删除能力与全部单调纪元，
不回退到不理解 `0003` 和恢复纪元的旧二进制。

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
fnm exec --using=.node-version -- pnpm eval:phase1-checkpoints
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
