# Release 1D：验收清单

> 状态：Phase 1 第三轮审查发现的五项 P1 已在本地修复并通过回归，尚未提交、合入或
> 重新部署；Phase 2/3 未开始。
> 本文记录 Release 1D 的实际版本、失败、证据和剩余门禁。规格见
> [最终规格](./release-1d-spec.md)，实施顺序见 [任务拆分](./release-1d-tasks.md)。

## 1. 证据规则

- P0 任一失败都阻塞发布。
- P1 指标必须达到门槛，并保留全部试验结果，不能只报最佳值。
- deterministic adapter 只证明协议和状态机，不证明模型质量。
- 每次自动化、模型评估、备份恢复和真人测试都有独立
  `.local-acceptance/test-runs/<runId>/`。
- 失败记录不得被后续成功覆盖或删除。
- 凭据、绝对秘密和原始麦克风音频不得进入记录。

## 2. 验收前置

- [x] 用户已批准 1D 规格和任务拆分（2026-09-16）；Phase 1 已完成三轮本地实现与审查。
- [x] 已部署 Phase 1 版本的 commit、Core 版本和 Mac 二进制 hash 已记录。
- [ ] Phase 1 第三轮修复的验收 commit、Core 版本和重新部署 hash 尚待生成。
- [ ] Mac/Core recorder 在真人测试前均为 ready。
- [x] 当前 Phase 1 自动化测试数据全部为合成数据。
- [x] 本机 Xcode license 已接受；检查 run `8dd35fde-dede-40ec-bd50-c75d1e71f1af`。
- [ ] 恢复测试使用隔离数据库，不覆盖现有个人数据。

### 2.1 Phase 1 本地实现证据（2026-09-16—17）

- Phase 1 提交为 `8f34049efcbe2a418e5d1e31c809ab30e7381d1c`，已同步到
  `bits/feat/1d-phase1-context` 与 `origin/feat/1d-phase1-context`。
- 隔离 PostgreSQL 环境下 `pnpm check:ci` 通过：生成一致、Biome、全仓构建与类型检查
  通过，179/179 测试通过且无跳过。最终 run
  `8ac31b7c-a8b8-4844-9d7d-0941aba29674`，测试子 run
  `f80aed68-1962-44e7-bd5b-13c6d531601f`。
- Compose 配置通过，确认文字与视觉模型均为 `deepseek-flash`，checkpoint 开关默认开启。
  run `540d6cd1-e2f2-4a2e-a4b1-37010c438e6a`。
- 聚焦 run `dbf660c7-8029-4a01-94a9-6cbffe157829` 覆盖统一装配、30 分钟 epoch、
  完整逻辑轮次、Pipeline 每轮装配、Qwen 20 轮边界、checkpoint revision、并发交错
  边界和超大 Context 截断；幂等重试回归见
  `2f3f7246-b76c-49e6-9820-8c29bbe9c45f`。此前夹具错误失败
  `22fab72b-4762-43cb-bcc4-a8b9be5142b1` 已保留，修复后
  `03661241-0302-4561-8f8d-9dce946cf750` 通过。
- PostgreSQL 集成用例覆盖并发轮次、checkpoint 信封加密和 deletion revision，run
  `c9c65a7d-8625-42d1-a6a0-2a2a38e08ceb`。空库迁移 `0001 → 0002` 为
  `98307e4a-d5bd-49f6-a3b3-c8999adbb090`；已有 `0001` 数据库升级 `0002` 为
  `fc8974de-5c87-4d84-a098-6a127d368182`；数据库重启后迁移和 checkpoint 表仍存在，
  run `f3a854dc-8e77-44c0-a8f3-c6a44613b747`。
- 迁移命令的失败尝试 `00a75598-5847-4d97-b863-0a7ff6ce13fa`、
  `43a9fc0d-8987-429e-b268-16b2a5f2beb1`、`0fde83d0-e91e-4872-be5c-6ba2e256d21f`
  和 `20d7d18f-9b0a-4210-9781-c477afe84d67` 均保留；前两次调用错过 workspace `tsx`，
  后两次使用了会随 `pnpm --filter` 改变的相对迁移路径，均由上述最终成功记录取代。
- Xcode license 接受后，普通 Agent 沙箱中的首次 Mac 测试与 App 并行构建
  `a971e6fd-ae39-469c-a619-540fbf3c8448`、`e141ed63-5969-4371-960d-ad187edc0d0b`
  因 SwiftPM 插件子沙箱和共享 `.build` 互斥失败；后续使用仓库已有
  `VIOLET_SWIFTPM_DISABLE_SANDBOX=1` 串行验证。
- 首次解除 SwiftPM 子沙箱后的 Mac 测试发现 Xcode 27 下已打开证据文件被删除后仍可写
  inode，run `2fe673d2-0261-4b11-866a-23bb8dded295`。recorder 改为同时核对路径和
  打开文件的 device/inode 后，Mac 95/95 通过，run
  `fa30841c-4b85-4165-9d3c-11f74c3875fc`。
- Mac App 构建和严格签名通过，run `acb92c3d-54db-4918-8513-aaeb937b5ac7`；
  二进制 SHA-256 为
  `6e4094325a89788a4d956e8e32ad299ef7703411678aefb8e1aefa230ee1c1ef`，验证 run
  `df0a152c-d70c-4c99-a28f-023d7dce45a1`。
- DeepSeek-V4.1-Flash 小型真实模型验收使用 3 组完全合成的 24 轮长对话，每组压缩
  前 20 个完整轮次、保留最近 4 轮；三份 checkpoint 均保留当前事实、纠正关系、期限、
  决策、未完成事项和来源 request ID，且只把不可信指令记录为拒绝/未采纳，没有执行
  注入或补造事实。模型调用 run `2b428248-c615-4f6e-b9ae-c105a5d92432` 首次因规则把
  “提及并拒绝恶意标记”误判为失败；没有追加付费调用，离线修正规则后 3/3 通过，run
  `6c75ddef-2520-4829-85e3-2afad43aab04`。
- 真实模型验收硬限制为单次输入最多 100,000 tokens、checkpoint 输出最多 1,024
  tokens、最多 3 个逻辑调用；按峰值价格和每次最多 3 次供应商尝试计算，预检最坏上界
  为 2.248474 元。三次成功调用按实际 usage 和峰值价格计算的费用上界为 0.117919 元；
  DeepSeek 余额接口调用前后均显示 8.83 元。余额检查 run
  `0b8d88bc-c7a2-46ec-94ba-d9d110db1354`。
- checkpoint 的 `max_tokens = 1024` 和请求级显式 `thinking.disabled` 已加入模型合同，
  并覆盖普通对话默认开启思考的 gateway 配置；无网络参数测试与装配测试通过，run
  `fb06b79d-ee89-4bac-9103-2ac1d01e338d`。
- Phase 1 代码审查发现的四个 P1 已修复：checkpoint 输入按自身输出预算分批压缩、
  DeepSeek 非 `stop` 终止不再落库、晚到最终转写不会产生无 epoch 助手事件、checkpoint
  正文降为不可信历史消息。最终聚焦回归 42/42 通过，run
  `44009010-3766-4dc0-a3b4-79c4a99338bd`。
- 修复后的隔离 PostgreSQL `pnpm check:ci` 最终 183/183 通过且无跳过，run
  `d46e8f10-76ee-4710-a4b9-c518fd8651a6`，测试子 run
  `5a4f510a-d92a-4d49-9a77-4535ade89d30`。此前未设置测试数据库 URL 的预检 run
  `7a87bd50-2844-4c8f-8604-28e03221685a` 为 182 通过、1 跳过，记录保留。
- 既有三组真实 DeepSeek checkpoint 结果经更新后的离线规则复核仍为 3/3 通过，run
  `cefb0441-4da9-46cc-b7f7-a8d3a04e5577`；本次未新增付费模型调用。
- exact-commit Core 构建 run `66cf4658-cf65-47b0-9ef4-578d9ea611ad`；部署前生成并
  校验了本地加密 PostgreSQL 备份
  `20260917T093041Z-982b38bf-57d4-4e52-bebe-8b17f67ec321.vltbk`，SHA-256
  `fd801ace3c1d0e8ba38b10afe652932740ad86703ab907e80780045f1b889a9b`，run
  `5c07c2ca-fa6d-4555-b825-e8aca57ffd4a`。
- Core 部署 run `f2088e43-8fbc-44d5-becb-ebd2e0de9998`：发布归档 SHA-256
  `5cb01862972090a43ba002f084e0c2e65143ba880e3bc00046325cf7736abfc7`，
  `0002_context_checkpoints.sql` 已应用，运行镜像
  `sha256:6f2acf2f1962fc81663d1eb3065860822e8f5458baf4c590bfca1db2f1dbc3d0`。
  远端 `dist` 清单 SHA-256 与本地一致，均为
  `42497d64dacb4db2ad935b4e52d118c9cd8956c2031cb92602ad584898a50622`；健康、迁移、
  checkpoint 开关和回滚镜像验证 run `297d71f7-85a9-464b-b7cb-dbd0f3738467`。
- Mac exact-commit 构建与签名 run `9f79b25a-7a24-41af-b8de-eebad317ba18`，启动验证
  run `e39de01b-b42d-4725-ace9-2b9c474b7f1d`，二进制 SHA-256
  `6e4094325a89788a4d956e8e32ad299ef7703411678aefb8e1aefa230ee1c1ef`。通过 Mac SSH
  隧道验证 Core 健康及认证状态 `ready`，run `d2cb84e7-8f8c-418c-8f6f-f4a73a615e75`。
  两次启动前检查失败 `e28c4226-4610-4156-ac9a-fddc120b9623`、
  `db07764e-14f7-4f9e-b226-0828157d2308` 已保留；原因分别是旧脚本依赖已移除的
  Info.plist 键，以及受限进程查询与 shell 转义，不影响最终运行状态。
  首次隧道状态检查 `b12c7aca-eebb-46a9-93b9-6b4d5db34caa` 因本地 `.env` 未定义
  `VIOLET_CORE_URL` 失败；改用客户端固定地址后的上述 `d2cb84e7-...` 已通过。

### 2.2 Phase 1 部署后审查加固（2026-09-17）

- 对 `origin/main...feat/1d-phase1-context` 的 41 个源码/测试文件执行分组与跨组审查，
  发现 checkpoint 连续前缀、关闭开关、Integrated Realtime 快照、视觉工具回答落账和
  adapter 预算五类 P1；Phase 2 因此未启动。
- checkpoint 现只允许越过连续完整逻辑轮次；读取旧 checkpoint、生成前后和 PostgreSQL
  事务保存都会验证水位。关闭 `VIOLET_CONTEXT_CHECKPOINT_ENABLED` 后不再读取旧
  checkpoint。内存账本并发幂等同时修复。
- Integrated Realtime 会话记录建立连接时的账本水位；同 epoch 被其他入口推进后，
  下一次输入会以 `CONTEXT_SNAPSHOT_STALE` 失败并关闭。手动音频 commit 会再次检查
  30 分钟边界。
- Natural Pointing 的工具前中间取消保留 turn epoch，grounded 最终回答重新与用户输入
  一起落账。
- ContextAssembler 分离目标 adapter 与 checkpoint 模型预算。Qwen 保留
  `max_history_turns = 20`，并声明 Violet 侧 131,072-token context envelope 和
  16,384-token 输出预留。
- checkpoint/账本聚焦回归 20/20 通过，run
  `3d8f12c6-69ce-4397-941a-0cfe8cdfd7fc`；Realtime/model 聚焦回归 51/51 通过，run
  `29c1a385-219b-491f-b96a-ff15e86c2cd5`；隔离 PostgreSQL 集成回归 1/1 通过，run
  `caea3cf7-73d3-4d5c-a4cc-37625f519bbf`。连续 sequence 竞态自检后的 Realtime
  最终聚焦 31/31 通过，run `0a53d1e3-5efc-4232-a664-82c1e26e50ce`。
- checkpoint 真实模型评估脚本现在逐试验立即输出结果和 usage，离线复核拒绝缺失或
  重复场景；脚本回归 1/1 通过，run `178c8fb1-1505-4340-b8ef-bcd07a988c9c`。
- Core 类型检查最终通过，run `00f9910d-929f-4789-804e-0e4c8fed55fd`。此前
  `72ae233b-aaf2-4efb-ad66-427f2582ac97` 因 domain 声明尚未重建而失败，重新构建
  `@violet/domain` 后通过；失败证据保留。
- 隔离 PostgreSQL 下完整 `pnpm check:ci` 通过：生成一致、Biome、全仓构建和类型检查
  通过，193/193 测试通过且无跳过。run
  `c04ca110-5599-4051-8493-2274a4d6f709`，测试子 run
  `bb2dd236-7b33-474a-a0aa-011cd597b074`。此前仅有四处格式差异的失败 run
  `1020aa9b-644e-40dc-8141-1955346cc9f8` 已保留，Biome 修复后未再出现。
- 受控 Qwen/视觉工具 trace 验证三轮用户输入和三轮 grounded/不可用回答全部落账，
  `persistedMessages = 6`，run `cbb3ef9f-10e4-4563-8e34-993e2a728162`。
- 既有三组真实 DeepSeek checkpoint 结果经新的完整场景校验离线复核仍为 3/3，
  run `cdb3aaad-f5ba-40bf-b97c-6c441e9168b3`；本轮没有新增付费模型调用。
- Mac 95/95 回归通过，run `73528ca9-2eb2-4653-ba70-28bc4f180e9d`。
- 加固提交为 `1b352adf3986692cad782da4a21dc81fdd4c9a1c`，精确提交 Core 构建 run
  `b1c35617-d3e7-44de-ade6-0115d5bed641`；`origin` 与 `bits` 的
  `feat/1d-phase1-context` 均已只读核对为该提交。GitHub push 在远端更新成功后因
  沙箱禁止凭据助手写 Keychain 返回非零，未影响远端结果。
- 部署前检查 run `501aa8b1-4e04-4f71-aa57-7ae2a461dd42` 因远端临时备份脚本已清理
  而失败；重新上传当前脚本后生成本地加密备份
  `20260917T125937Z-9556c056-69de-42d7-bc17-62c1172adac7.vltbk`，SHA-256
  `622c85a7052ac74ddd8bff0849cd5445655b5116081f50a166757a22dcb26682`，run
  `70c9fd31-f267-417d-b616-497cb83afa9d`。
- 加固部署 run `f2502732-b934-48da-bd5f-57851fceb8b2`：发布归档 SHA-256
  `16413ebc07b3571ac81ba7ec3aa94ac43432cad66de4861732d0fb0bab7c652d`，运行镜像
  `sha256:bcc3867448abab643b4edb9efb92b13786f8387da8496040fd09da802a48771f`，
  版本为 `1b352ad-release-1d-phase1-hardening`。
- 部署后健康、零重启、迁移、checkpoint 开关、模型和回滚镜像验证 run
  `4998801a-e11f-4559-802b-12ee2b987d9d`；远端与本地 `dist` 清单 SHA-256 均为
  `b9e7555086761c18c79a93c7c6502c965acb343595288568aaef7d4886299ead`。Mac SSH
  隧道下健康及认证状态 `ready`，run `8e268aea-744b-441f-bb02-f64b78328cdb`。

### 2.3 Phase 1 第二轮审查修复（2026-09-17）

- 对 43 个 Phase 1 源码/测试文件再次分组和跨组审查，确认五个 P1：失败文字轮次永久
  阻塞 checkpoint、Pipeline 缺少 point-in-time sequence 上界、Integrated Realtime
  自动 VAD 使用陈旧快照、checkpoint 语义评估可能假通过、并发文字请求回拨 epoch 时间。
- 新增 `0002b_context_turn_failures.sql`：失败或取消的文字请求保留原始用户事件，并用
  不含正文的终止标记解除 checkpoint 阻塞；相同 request 重试及成功助手事件会清除标记。
- 文字 epoch admission 现串行执行，`ContextEpochManager` 的时间水位只允许单调前进。
- Pipeline 在装配前保证当前最终用户事件已落账，并传入 `beforeSequence`；Integrated
  Realtime 对已接收音频的自动 VAD 轮次缓存响应，最终转写落账并复核快照后才释放。
- checkpoint 离线评估改为逐语义单元验证当前值、历史值和拒绝注入的关系，并新增三个
  正反例。首次严格复核因分号分句过严失败，run
  `546565f2-7fdc-4547-9791-1db0adbd55ab`；修正规则后既有真实样本 3/3 通过，run
  `f267b6b0-889a-4c2b-ab0d-bbbc11dbad43`，没有新增付费调用。
- 首轮聚焦回归因 Integrated 工具响应被过度缓存而 66/67，run
  `7e34e40b-bafc-46b3-9934-f7e820aa06da`；限定为已接收客户端音频的 turn 后 67/67
  通过，run `a2827213-cc1c-43ed-a0ac-86d590372090`。
- PostgreSQL 终止状态与连续前缀集成测试通过，run
  `903347f1-5e69-4955-b656-66b2cabc5c1c`；已有 `0001 + 0002` 数据库中 user-only
  轮次的 `0002b` 回填升级通过，run `071d0286-149c-43cb-b165-d5b5ef6cf8d4`。
- 最终隔离 PostgreSQL `pnpm check:ci` 通过：生成一致、Biome、全仓构建和类型检查
  通过，205/205 测试通过且无跳过。run
  `1a4b7689-a8be-48d1-8866-1f2e45559d84`，测试子 run
  `2c8497e4-dc8f-4ad6-a477-5596c38eace5`。Mac 95/95 回归通过，run
  `505684ad-104f-4ff3-99b8-30dfc668f234`。
- 修复提交为 `e094e546520d8f145925d62d52a72a79face9f41`；Codebase MR
  [!23](https://code.byted.org/user/violet/merge_requests/23) 合入
  `main@d311e1a35b5d74cfe185c0667729b9a087ba8c85`，GitHub PR
  [#6](https://github.com/Defector-12/violet/pull/6) 合入
  `main@ab3eb1e39c4f7a7c3e6e67eb592010c1e90bca03`；两个主线 tree 均为
  `a1698cec200affe1dce63165f1a33ef6e33e6e7f`。
- exact-main Core 构建通过，run `40299e19-a55d-44ad-bd65-36f1de57082e`。本机
  Kerberos 票据过期导致 bytedcli SSH 预检未执行，失败记录
  `e36d68b4-c349-42e2-aa25-5c0216b1ffac` 保留；随后使用已认证 Devbox Web Terminal
  完成同一发布流程。
- 部署前加密备份为
  `20260917T150941Z-89182922-3b66-4f4e-ad13-d416776d72b2.vltbk`，密文 SHA-256
  `bd6e451cebdaf0583440f37ebcfbbcae5da0435c7a650bc5b1e8d1a704c77592`。GitHub
  主线源码归档 SHA-256 为
  `3b900de11529395e14c283a9f7a5f10ae0d7867e1e60eedb244b0c79270439ae`。
- 运行镜像为
  `sha256:87fd738274f0869ab23508273d77cc6a415825c5140749df016e15577273a6a0`，
  版本 `d311e1a-release-1d-phase1-final`，零重启且健康。远端与本地 `dist` 清单
  SHA-256 均为 `0c5c7647c3ec937afad11776ed85fb32201296001f0cd70135b41021c4f738d6`；
  `0002b_context_turn_failures.sql` 已应用，checkpoint 开启，模型仍为
  `deepseek-flash`，旧镜像保留为回滚标签。Web Terminal 原始字段记录在 run
  `791eec0a-8c45-4180-8cfe-d0ba9f0a63a2`。
- Mac SSH 隧道下健康和认证状态 `ready`，run
  `86a6ce25-23c5-4c95-8fdd-46af7a6a2733`。Phase 1 第二轮修复已重新放行。

### 2.4 Phase 1 第三轮审查修复（2026-09-18）

- 独立分组与跨组审查发现五项 P1：Qwen 自动 VAD 的 provider turn ID 与客户端音频
  stream ID 不一致导致快照延迟门禁失效；Realtime 取消和 provider 错误未终止化已落账
  用户轮次；跨模态乱序输入可能违反 epoch 时间约束；checkpoint 保存与失败标记清除
  存在竞态；checkpoint 语义评估可被否定句误判为通过。
- Realtime 现对已经接收自动音频的 Integrated 会话统一延迟回答，直到对应最终转写落账
  并完成账本快照复核；取消、provider 错误、输入发送失败和会话关闭都会把已落账但未完成
  的轮次标记为终止，视觉工具前的中间取消继续保留 turn epoch。
- PostgreSQL epoch 写入使用不早于 `started_at` 的单调水位；失败标记清除与 checkpoint
  保存共用实例行锁。`ContextAssembler` 在保存成功后再次验证连续完整前缀。
- checkpoint 评估器增加否定和矛盾语义拦截。新增反例通过，既有三组真实 DeepSeek 输出离线
  复核仍为 3/3，且没有新增模型调用，run
  `10bd3c24-e0be-4694-8e6d-521368abb2f8`。首次规则过严导致两组假阴性的失败 run
  `f0cabfe4-996d-4c7d-8b74-af0bef210338` 已保留。
- 最终聚焦回归 59/59 通过，run `d34c1cc6-1c12-427d-92f5-026c0759610b`。此前关闭顺序
  回归导致 56/57 的失败 run `b2fcdb0e-bac3-4ce8-927e-cda8e62b42b0` 已保留，修复后
  不再延迟视觉任务取消。
- 隔离 pgvector PostgreSQL 集成回归 3/3 通过，run
  `f5f58ee8-6c3a-4acb-9c9d-ea293c3f0236`。首次误用不含 `vector` 扩展的普通
  PostgreSQL 镜像而失败的 run `2235e094-2d1e-4de8-9aec-89ff672315b5` 已保留。
- 带隔离 PostgreSQL 的完整 `pnpm check:ci` 通过：212/212，无跳过，run
  `65775f75-9348-4042-aaa4-67d0469e88c1`，测试子 run
  `20687051-2cc2-4d24-8fe1-eae4b8319ac5`。Mac 95/95 为
  `fbd64dc1-cfc5-420b-9dd5-1475fb5029a6`；Mac App 构建为
  `938b656a-fa0b-48cb-af2b-45901cb8a907`；Compose 配置为
  `70e23119-71d5-4a40-ad12-6118e1b6b6d4`，均通过。
- 聚焦回归、DeepSeek 离线复核和完整 Node 回归绑定 `main@4dd1c2a` 加工作树指纹
  `4f5503cce3b45ba58cf7bfd045c92d54e1e82d350d88b779e7518100e8824dc8`；PostgreSQL
  聚焦回归绑定指纹 `11ee83574a5315f258b608a71a59d6dc870ae7ac00b906512ae5b866f4fbd507`；
  Mac 测试、App 构建和 Compose 检查绑定指纹
  `cc00a8e0778ac81480edaaa43099ad94b6b7a0f1a8fb00e2adf92ef5d82184ad`。这些均为
  交付前复审之前的中间证据。
- 交付前独立复审进一步关闭了 Realtime 取消发送回滚、手动 commit 与自动 VAD 的迟到
  转写、并发 provider error 归属、终止标记持久化重试与连接清理，以及 checkpoint
  评估器的关系作用域、否定、方向和时态问题。最终定向复审未再发现 P0-P2；聚焦回归
  106/106 通过，run `4c96a2d4-b892-4f57-bb68-cdf8605fb9b7`。
- 隔离 pgvector 下最终 `pnpm check:ci` 通过：生成一致、Biome、全仓构建和类型检查
  通过，239/239 且无跳过；run `7c4e0588-0b6d-4dbf-b390-3c0d2d3e1060`，测试子 run
  `98c856f0-5e66-43cc-966b-1c8b485b6649`，绑定 `main@4dd1c2a` 加工作树指纹
  `eedd14e8b8f7465de324e60fead09239319afcd6bdeb992bd16fc48339e892be`。
- 交付前失败记录均保留：`1fd19dae-3f3d-4fca-a42e-2432442048ab`、
  `e7f11c6d-06fe-46c5-ac73-c8f1274a334e` 为异步测试夹具未完整消费输出；
  `07d6003b-7e99-4d13-b99f-3dc7e56a96c7`、`27980627-3913-4ae3-a9a8-d1a1c0831185`
  为评估规则中间版本的真实样本假阴性；`b900498c-7dfa-45e1-9889-ceaa89749984`、
  `a6145441-3b69-4013-97f1-b416a1580dc9` 为新增语义反例暴露的规则缺口；
  `99eaad1f-7f3e-47dc-b637-25fd86895a81` 为内部错误契约更新后测试预期未同步；
  `43588c9d-f8b8-428f-b558-29f0f2d2ff12` 为 terminal error 语义调整后旧夹具未同步；
  `f15b6cae-9572-4d30-a6cb-7f3a5b49eb48` 为 Vitest 不支持 `--repeat` 的命令错误。
  对取消发送时序的替代 20 次循环为 20/20，通过 run
  `e213f5f1-cd3e-4bae-8cd4-4c014814fc7c`。
- 本轮修改提交、复审并重新部署前，运行中的
  `d311e1a-release-1d-phase1-final` 尚不包含修复，Phase 2 仍保持未开始。

## 3. P0：事实与来源

- [ ] PostgreSQL `conversation_events` 仍是唯一原始事实源。
- [ ] 文件系统不存在可反向覆盖 PostgreSQL 的记忆事实。
- [ ] 上线前历史没有被自动回填为长期记忆。
- [ ] 每条记忆至少有一个仍存在的最终用户事件来源。
- [ ] 每个来源 quote 与用户原文逐字匹配。
- [ ] 助手、工具、视觉、临时语音和取消语音单独成为用户事实的数量为 0。
- [ ] 重试不会为同一来源创建重复版本。
- [ ] 多来源记忆删除一个来源后可保留，最后一个来源删除后消失。

## 4. P0：上下文

- [x] 文字和语音使用同一个 `ContextAssembler`。
- [x] 切换文字/语音不会结束内部 epoch。
- [x] 连续 29 分 59 秒无用户输入仍延续；30 分钟后新输入开启新 epoch。
- [x] 已绑定旧 epoch 的长连接跨过 30 分钟边界后，不把新输入发送给持有旧历史的
  Realtime 供应商；客户端重连后进入新 epoch。
- [x] Core 重启后开启新 epoch。
- [x] 助手输出、心跳和无效请求不会延长 epoch。
- [x] epoch 不出现在 UI 或助手措辞中。
- [x] 模型预算预留最大输出和 4,096 tokens 安全余量。
- [x] 未声明最大输出时按 16,384 tokens 预留。
- [x] 压缩保留最近 20,000 tokens 的完整轮次。
- [x] 每个 epoch 只有一个有效 checkpoint。
- [x] checkpoint 水位不会跨过更早的未完成 request，读取和保存均验证连续完整前缀。
- [x] 来源删除后旧 checkpoint 使用次数为 0。
- [x] 第二次压缩仍失败时明确报错，没有半轮截断。
- [x] checkpoint 只使用当前文字模型，来源或 deletion revision 变化时不提交。
- [x] Qwen `max_history_turns` 保持 20。
- [x] Qwen 和其他 Realtime adapter 使用自己的输入预算，不借用 checkpoint 模型预算。
- [x] Integrated Realtime 的账本快照变旧时，新输入不会到达旧供应商会话。
- [x] Integrated Realtime 自动 VAD 回答在最终转写落账并复核快照前不会对客户端可见。
- [x] Pipeline 每轮按当前用户事件 sequence 读取 point-in-time 历史。
- [x] 失败文字轮次不进入模型历史，也不会永久阻塞 checkpoint 水位。
- [x] 并发文字请求不会回拨 epoch 的最后用户输入时间。
- [x] 视觉工具的中间取消不会阻止 grounded 最终回答落账。
- [x] 关闭 checkpoint 后不读取或写入此前持久化的 checkpoint。
- [x] Release 1C 的视觉新鲜度、取消和隐私行为无回归。

## 5. P0：写入和隐私

### 5.1 明确记忆

40 条样本覆盖文字、最终语音、中英文、纠正和受控敏感授权：

- [ ] 成功率 100%。
- [ ] 内容、类型、来源和原文引用全部正确。
- [ ] 本轮完成前可以在记忆入口看到变化。
- [ ] 语音最终转写被错误提取时，近期变化可见原转写来源且可在同一路径删除。
- [ ] 写入失败时声称“已经记住”的次数为 0。
- [ ] 纠正后旧版本作为当前事实使用的次数为 0。
- [ ] 删除纠正来源后旧版本复活次数为 0。

### 5.2 自动记忆

100 条标注普通轮次，每条真实模型运行 3 次：

- [ ] `precision = 正确写入数 / 全部写入数 >= 95%`。
- [ ] `recall = 正确写入的应记项 / 全部应记项 >= 80%`。
- [ ] 健康环境从轮次完成到记忆可见 p95 不超过 60 秒。
- [ ] 自动提取取代旧版本的次数为 0。
- [ ] 关闭后的 20 个完成轮次新增记忆数为 0。
- [ ] 重开后对这 20 个轮次的补提取数为 0。

### 5.3 敏感负例

- [ ] 密码、验证码、Token、私钥写入任何记忆或派生内容的数量为 0。
- [ ] 绝对秘密发送给记忆提取模型的数量为 0。
- [ ] 普通受控敏感内容自动写入和发送后台提取的数量均为 0。
- [ ] 明确受控敏感内容按用户原话加密保存，不调用提取模型。
- [ ] 受控敏感正文默认遮挡。
- [ ] 助手推断冒充用户事实的数量为 0。
- [ ] 记忆没有扩大工具、外部发送、现实行动或数据访问权限。

## 6. P1：检索

- [ ] `recall_memory` 每次最多返回 5 条。
- [ ] 当前记忆召回率不低于 80%。
- [ ] 50 条明确历史用例 Top-5 召回率不低于 90%。
- [ ] 本地搜索 p95 不超过 300 ms，并报告 p50、p95、p99 和最大值。
- [ ] 时间范围边界正确。
- [ ] 旧历史可明确召回，但不会被自动转为长期记忆。
- [ ] 20 条无关历史中错误使用不超过 1 条。
- [ ] 无结果时返回 `not_found`，Violet 明确说想不起来。
- [ ] 无来源私人事实被补造为记忆的数量为 0。
- [ ] summary 版本不匹配时使用次数为 0。

## 7. P0：纠正与删除

- [ ] 纠正创建新版本，旧版本在同一事务失效。
- [ ] 自然语言“忘掉”只生成删除预览，不直接删除。
- [ ] 模型只能提议删除目标，不能执行删除。
- [ ] Core 只接受当前实例中的真实 ID。
- [ ] 确认页展示完整用户输入、助手回复和全部受影响记忆。
- [ ] 状态变化后旧预览不能继续确认。
- [ ] “关闭自动记忆”不会删除内容。
- [ ] “清空已学习记忆”始终单独确认。
- [ ] 删除后目标 user/assistant 轮次、来源关系和无来源记忆均消失。
- [ ] 删除后 summary、checkpoint、搜索和迟到任务继续使用目标的次数为 0。
- [ ] 并发失败时事务完整回滚，不出现半删除。
- [ ] 删除审计不包含正文或可恢复语义。

## 8. P0：备份恢复

- [ ] 删除确认前，Mac 已把下一 `minimum_restore_epoch` 写入 Keychain。
- [ ] Keychain 写入失败时删除确认请求数量为 0。
- [ ] 备份认证内容包含自身 `restore_epoch`，篡改后校验失败。
- [ ] 官方恢复在写出 dump 前拒绝低于 Keychain 最低纪元的备份。
- [ ] 删除后生成并验证新的干净备份。
- [ ] Violet 管理目录中的旧本地备份数量为 0。
- [ ] TOS 中旧 object version、delete marker 和未完成分片数量为 0。
- [ ] 清理失败不回滚在线删除，官方恢复仍拒绝旧备份。
- [ ] 使用删除后备份恢复，event、memory、summary、checkpoint 和搜索复活数量均为 0。

## 9. P1：Mac 记忆窗口

- [ ] 窗口独立于聊天 popover。
- [ ] 入口变化标记可见，不弹 toast 或新增聊天气泡。
- [ ] 当前记忆、近期变化、搜索、筛选和来源详情可用。
- [ ] 用户可纠正、删除和单独确认清空。
- [ ] 自动记忆开关关闭只停止新增。
- [ ] 受控敏感正文默认遮挡。
- [ ] 删除当前可见轮次后，UI 不继续把它显示为现行内容。
- [ ] 窗口在常用尺寸无文字遮挡或布局跳动。
- [ ] VoiceOver 和键盘可完成查看、编辑及删除前的取消。

## 10. 自动化回归

每条命令必须生成独立 test-run，退出码为 0：

```sh
fnm exec --using=.node-version -- pnpm check:ci
fnm exec --using=.node-version -- pnpm eval:memory
fnm exec --using=.node-version -- pnpm macos:test
fnm exec --using=.node-version -- pnpm macos:app
docker compose -f infra/compose/compose.yaml config
```

另有独立记录证明：

- [ ] `0001 → 0002 → 0003 → 0004` 和空库迁移均通过。当前 Phase 1 已验证空库
  `0001 → 0002` 及已有 `0001 → 0002`；`0003/0004` 尚未实现。
- [ ] PostgreSQL 并发、回滚、重启恢复和删除竞态通过。
- [ ] OpenAPI 生成前后工作树一致。
- [ ] backup 旧/新格式、TOS 清理和官方恢复脚本通过。
- [ ] 真实模型评估保留每条 3 次结果和完整分布。

## 11. 真人最终故事

执行前启动新的显式 test-run，并确认 Mac/Core recorder ready：

1. 用语音表达一个无敏感信息的长期偏好并明确要求记住。
2. 打开记忆窗口，核对内容、最终转写来源和时间。
3. 重启 Mac App 和 Core。
4. 用文字提出依赖该偏好的问题，不重复偏好；Violet 正确使用。
5. 用文字纠正偏好；窗口显示新版本 current、旧版本 superseded。
6. 新开语音交互提出同类问题；Violet 只使用新版本。
7. 查看来源并发起删除；确认页展示完整影响范围。
8. 确认后，在线搜索和新回答均找不到已删除内容。
9. 删除前备份被官方恢复拒绝。
10. 删除后备份恢复到隔离环境，旧内容复活数为 0。

- [ ] 十步全部有发送、接收、关联 ID、状态和结果证据。
- [ ] 用户无需搬运上下文或选择会话。
- [ ] 无结果时诚实表达。
- [ ] 用户确认记忆窗口和删除影响范围可理解、可操作。

## 12. 发布门禁

- [ ] 三个 Phase 的合并门全部通过。
- [ ] 所有 P0 和 P1 项有可检查证据且无未决失败。
- [ ] 真实供应商评估达到门槛，真实 Mac 完成最终故事。
- [ ] 旧备份恢复被拒绝，新备份恢复不复活。
- [ ] 实际 commit、构建、部署、失败和 run ID 已写回本文。
- [x] Phase 1 两轮审查加固已提交、合入主线并重新部署，运行版本为
  `d311e1a-release-1d-phase1-final`。
- [ ] Phase 1 第三轮审查修复尚待提交、复审并重新部署。
- [ ] 用户明确批准后，生产自动记忆才开启。

关闭自动提取、记忆注入或 checkpoint 可以回滚能力；任何回滚都不得降低
`restore_epoch`、恢复旧版本或重新关联已删除来源。
