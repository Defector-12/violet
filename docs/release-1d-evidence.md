# Release 1D：历史验收证据

本文保留 2026-09-16 至 2026-10-01 的逐次实现、失败、复验和交付记录。
各节中的“当前”“未开始”“下一步”仅指该节记录时点，不代表现在的待办或新授权。
当前交付结论见 [验收总览](./release-1d-acceptance.md)，稳定合同见
[最终规格](./release-1d-spec.md)。原章节编号保留，便于追溯既有引用。

## 1. 证据规则

- P0 任一失败都阻塞发布。
- P1 指标必须达到门槛，并保留全部试验结果，不能只报最佳值。
- deterministic adapter 只证明协议和状态机，不证明模型质量。
- 每次自动化、模型评估、备份恢复和真人测试都有独立
  `.local-acceptance/test-runs/<runId>/`。
- 失败记录不得被后续成功覆盖或删除。
- 凭据、绝对秘密和原始麦克风音频不得进入记录。

## 2. 验收前置

- [x] 用户已批准 1D 规格和任务拆分（2026-09-16）；Phase 1 已完成第五轮本地实现与审查。
- [x] 已部署 Phase 1 版本的 commit、Core 版本和 Mac 二进制 hash 已记录。
- [x] Phase 1 第三轮修复的验收 commit、Core 版本和重新部署 hash 已记录。
- [x] Phase 1 第四轮修复的验收 commit、双主线 merge commit、Core 版本、备份和
  重新部署 hash 已记录。
- [x] Mac/Core recorder 在真人测试前均为 ready（2.21、2.24，包含实际重启后再次核验）。
- [x] 当前 Phase 1 自动化测试数据全部为合成数据。
- [x] 本机 Xcode license 已接受；检查 run `8dd35fde-dede-40ec-bd50-c75d1e71f1af`。
- [x] 恢复测试使用隔离数据库，不覆盖现有个人数据（2.16、2.21）。

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
- 修复提交为 `472ea086deccf3a922061d40d8633dd9d4a9dd29`；Codebase MR
  [!25](https://code.byted.org/user/violet/merge_requests/25) 合入
  `main@a6389f6de14642e753748e019a65adad3efd20fa`，GitHub PR
  [#8](https://github.com/Defector-12/violet/pull/8) 合入
  `main@6f9f7a6686a39fa04759f9b8e2aad9f03b1a1d6a`；两个主线 tree 与修复提交 tree
  均为 `7788f08f1ddc5994e998aa578ae7555b25c30b01`。
- exact-main Core 构建通过，run `cf755f45-94be-4749-8bb3-e00c7437ffdc`。部署前加密
  PostgreSQL 备份 run `22c29e97-31d8-4752-a55b-7a2a52dd64cb`，文件
  `20260918T051419Z-c7c1a042-0494-41d3-b28b-c904427c9ab0.vltbk`，密文 SHA-256
  `7642c8febd441b2a2b9faf60f3ebeca1fa83567502c151c2665cfda08ecffe6b`。
- Core 部署 run `4d76ce5e-f36b-45c4-b5df-dbcb1f298ff1`：发布归档 SHA-256
  `da8cca9abe211177178d360dd4c3a3bc9e1b91ca6c75e8dd6fd9fb781c9c400a`，运行镜像
  `sha256:20edbc4e03ad7b4da53a4393874b404020a997452e24649371f5bef3b51abaa1`，
  版本为 `a6389f6-release-1d-phase1-review3`。
- 部署后健康、零重启、三项迁移、checkpoint 开关、模型、备份和回滚镜像验证通过，
  run `747ca438-191e-4825-b1a8-669a61355d2b`；远端与本地 `dist` 清单 SHA-256
  均为 `96639c78bcad2b68096696f5b333eb62c7351e6ce2b0d80595223045d6e393b8`。
  首次验证仅因假定迁移名称排序而失败的 run
  `b69031b0-2c78-4c27-aedd-4bf5e6eff329` 已保留。
- Mac 源码和协议未变化，因此未重复构建或安装 App；现有 Mac 客户端经 SSH 隧道验证
  Core 健康且认证状态 `ready`，run `791a1919-75dc-461c-8d37-e4e7a67d9a06`。
  Phase 1 第三轮修复已重新放行，Phase 2 仍保持未开始。

### 2.5 Phase 1 第四轮审查修复（2026-09-18）

- 第四轮独立审查覆盖 Realtime 进程生命周期、失败补偿和供应商重试，发现关闭期间
  user-only 轮次可能遗留、失败标记瞬时写入失败后会被遗忘、两个 Core 可同时操作同一
  数据库、Qwen 文字重试可能重复创建 provider item 或 response，以及相同 turn 的新旧
  attempt 和迟到输出可能互相污染。评估器还存在跨语义单元、方向和未来时态误判。
- Core 现在启动时终止化遗留的 user-only 轮次；运行时使用跨会话共享、串行且带退避
  重试的失败恢复器。生产数据库由 PostgreSQL advisory lease 保证单活，关闭时先停止
  接收并有界排空 WebSocket 会话和持久化队列，再释放数据库连接。
- Realtime 对规范化 turn ID 串行持久化，并把单调 attempt ID 端到端传入 adapter；
  旧 attempt 的迟到转写、回答、取消或错误被拒绝，已拒绝 response ID 使用 tombstone
  防止后续分片重新进入。Qwen 对文字 item 创建和 response 请求分别保持幂等，只重试
  未完成步骤。
- PostgreSQL 和内存账本都支持启动恢复；失败标记只针对存在、同 epoch 且尚无助手事件
  的用户轮次。恢复、清除和成功助手写入保持串行，避免 checkpoint 连续前缀再次被永久
  阻塞。
- checkpoint 评估器补齐否定作用域、关系方向、已完成与未来计划的区分及中英文反例。
  新鲜 DeepSeek 三组输出 run `e6f39901-3024-43cb-80dc-cd161341a32b` 暴露两项规则
  假阴性；修正规则后对同一原始输出零新增模型调用复核 3/3，通过 run
  `4b757832-fa6f-496e-ba5d-50de3d0e2fe5`，最终代码下再次复核 3/3，通过 run
  `53a4fd00-bebf-4dde-acb0-7ede747d447c`。
- 隔离 pgvector PostgreSQL 下最终 `pnpm check:ci` 生成一致、Biome、全仓构建和类型
  检查均通过，299/299 且无跳过；run
  `11227219-288e-462b-9b15-5b048f32737c`，测试子 run
  `42d8ca18-9e0c-4a05-ad9a-01f1c6f475d0`。
- 六份状态文档同步后再次执行完整 `pnpm check:ci`，299/299 且无跳过；run
  `156ee99d-2e44-4dcc-a472-e7efce5221c4`，测试子 run
  `555d1df6-49f0-482c-8ee2-b97a66b7b492`。首次按不存在的容器用户变量推断连接串，
  导致 PostgreSQL 鉴权失败；外层 run `b4fdea1e-f507-4843-bee7-943947e47ae8` 和
  测试子 run `9f44f3b9-fa66-4cc1-9f88-2d3c28729239` 保留，未改代码，改用容器实际
  默认用户后通过。
- 六个关键竞态用例连续运行 20 次，每次 6/6 通过，run
  `cecdd021-667a-4fe2-a0c1-ac7d9b1b0cc1`。Mac 95/95 通过，run
  `9b2481b5-91e4-44be-9b74-1bcef3e9ccf6`；Mac App 构建通过，run
  `874029cc-0b6e-4855-a0f1-f92cc0d08742`，二进制 SHA-256 为
  `6e4094325a89788a4d956e8e32ad299ef7703411678aefb8e1aefa230ee1c1ef`，
  签名、hash 和 plist 验证 run `721c1bb4-d5a0-4f20-93e6-1170f3487a97`；Compose
  配置通过，run `a99c5b15-1a90-44c6-a271-ea48b0bf782b`。
- 最终代码与测试证据绑定 `main@97ed17a7feb2402efb9aeee24ec14cb687ee8c06` 加工作树
  指纹 `ee5efef23cc7c0792f180cb34b388fcfbf0f5ee08e7fd4b4e2574ba1691d478d`。
  分组与跨组独立复审未再发现 P0-P2。
- 修复提交为 `43bf6eae369d48062a63023a4ff0a03f2cbd21bd`；Codebase MR
  [!27](https://code.byted.org/user/violet/merge_requests/27) 合入
  `main@1ee90fe8021aff99b9a05f00f978809bdde2673d`，GitHub PR
  [#10](https://github.com/Defector-12/violet/pull/10) 合入
  `main@873e833474c330a8efcd7bd8fab61282e907e699`；两个主线与修复提交 tree 均为
  `259bf9a2da1b451dc9854ceaf56c521b672a0b20`。
- exact-main Core 构建通过，run `e6121bbf-1629-44f9-8924-e666d1b73de0`。部署前
  加密 PostgreSQL 备份 run `31d92f42-1806-4180-9166-4b62069d5e98`，文件
  `20260918T103333Z-8ffb7a3f-da2f-4764-b2a1-44c6f1646fec.vltbk`，密文 SHA-256
  `cf32a07984680331517bd7a8e3a8146959d4e621acf02e3292a82f4d3eaa9842`。
- Core 部署 run `ffb150ac-97a1-4a57-b67f-91c944e9fce6`：发布归档 SHA-256
  `812bda5e7669c9c2baa3d3d7d5157399b38e167d52649f02ac9567c4ea43a932`，运行镜像
  `sha256:899b5d840846e2b19195ed5238e31b200019c03708c5d1ff69644a832fd663a5`，
  版本为 `1ee90fe-release-1d-phase1-review4`。
- 部署后健康、零重启、三项迁移、checkpoint 开关、模型、备份、发布归档、回滚镜像、
  user-only 轮次收敛和 advisory lease 验证均通过，run
  `f777d4d3-468c-43e6-96fa-9e688676ce6d`；远端与本地 `dist` 清单 SHA-256 均为
  `6f8b3629ffd37de851499e130ef4eb74f62ec95d98bad9a29496eacc906c9909`。
  Mac SSH 隧道下健康及认证状态 `ready`，run
  `904fb9a6-cccc-405a-8b6f-cf494aad684f`。Phase 1 第四轮修复已重新放行，
  Phase 2 仍保持未开始。

### 2.6 Phase 1 第五轮最终门禁修复（2026-09-19）

- 第五轮从 HTTP 断流、跨入口幂等、Realtime 重试与关闭、PostgreSQL 前缀线性化和
  checkpoint 评估器重新审查 Phase 1，修复了客户端提前关闭后 user-only 轮次遗留、
  Pipeline 取消后误清 failure marker、相同 request 改写正文或视觉证据、已完成请求
  重复调用模型，以及否定/反转措辞绕过评估门禁。
- 文字请求现在按规范化 request ID 串行；完成结果直接从账本重放。临时 Context 的
  `context_source_id`（当前 Context session）与 `context_event_id` 复合身份随用户
  事件持久化且不保存 Context 正文；正文或任一引用变化都会返回冲突。
- Realtime 使用 generation 隔离旧 attempt；失败 marker 的 start/reopen/complete/fail
  串行化，服务关闭对既有队列和最终排空使用统一 5 秒 deadline，错误由 WebSocket、
  Fastify 和进程 signal handler 显式传播。
- 新增 `0002c_context_event_ids.sql`。新增列为空且无默认值，约束使用 `NOT VALID`
  避免部署时扫描历史事件表；新写入仍强制 Context 引用成对且只属于用户事件。
- checkpoint evaluator 改为 typed claim，并覆盖否定、双重否定、关系方向、未来时态、
  跨句反转、负责人状态、来源关联和注入拒绝。最终 evaluator 回归 90/90，通过 run
  `1ebcad7b-92ec-4925-811b-fdb7d9eb1475`。
- 最新 prompt 与 evaluator 下的新鲜 DeepSeek 三组 24 轮评估直接 3/3，通过 run
  `5793b6dc-6643-4f14-ae08-e0435f40bc03`；三次调用实际 usage 的费用上界为
  0.118898 元，余额检查前后均为 8.39 元；当前最终规则对该原始输出零调用复核仍为
  3/3，run `edefae5c-c6b9-42ba-9276-6a02680e7186`。中间规则假阴性 run 均保留。
- 隔离 pgvector PostgreSQL 5/5 通过，run
  `dd71d0be-75b2-4e7f-9ce2-c065fd0c6e56`；八个关键竞态连续 20 次共 160/160
  通过，run `c54ccde0-af88-4257-a785-92b4c66d8b8e`。
- 隔离 PostgreSQL 下最终 `pnpm check:ci` 的生成一致性、Biome、全仓构建和类型检查
  均通过，35 个文件共 347/347 且无跳过；run
  `0451cc53-b316-4574-bf35-7f26a0ce2a99`，测试子 run
  `0ef59349-89df-4be7-ae35-a1e3489564b9`。
- 受控 trace 验证 116 个事件、3 个完整轮次且无缺口，run
  `dbeeba29-e55f-461c-925c-a9c6f6cd4da5`；Compose 配置通过，run
  `d41f56b4-b681-4a5a-b04f-8a8e3b14e724`。
- Mac 首轮 95 项因测试在 `responseText` 与 `responseCompleted` 之间过早断言而失败，
  run `1264c83d-8655-495a-b799-f521bf11f7e2`；修正同步点后 95/95 通过，run
  `9842e333-c6e0-456d-8cc0-175124b58569`。App 构建通过，run
  `49f05a30-5de5-4ac6-97fc-1972fe90e9d2`；签名与 plist 校验通过，二进制 SHA-256
  为 `9e243259d1bf61e8fdab32cbe926d461d1b7c997429971b773421e9586b6f982`，run
  `ba113b72-4554-42e1-b5a9-740660d3a79d`。
- 分组、修复复核和跨组审查当前未发现未解决 P0-P2。全仓冗余审计仅删除未使用的
  `submittedContextCount` 与可重建的 SwiftPM 临时树；公共 SDK 和 provider transport
  等跨模块重构不混入本轮。
- 修复提交为 `608cbbf43c3b7ee2784cf08d75c80cca5204a9d6`；Codebase MR
  [!29](https://code.byted.org/user/violet/merge_requests/29) 合入
  `main@66ead8109015237de8dd46c3efcfd2f233625227`，GitHub PR
  [#12](https://github.com/Defector-12/violet/pull/12) 合入
  `main@093b5eb283c407ed7e2b49b41905028eba373c50`；两个主线与修复提交 tree 均为
  `d555250294b158a67b99340e13f700b702e9403d`。
- exact-main Core 构建通过，run `d893f6da-3f0a-4cf8-a965-705c75d1d109`。部署前加密
  PostgreSQL 备份为
  `20260919T115315Z-b1353d56-5ff6-43c4-a34f-364096904c34.vltbk`，密文 SHA-256
  `660d9f7a78f51e07aca7a9507dd19ac5f94b53869c02d58af24d6e95d680c948`；bytedcli
  在远端备份成功后因沙箱禁止更新本机 known_hosts 返回非零，run
  `291b6451-7ff8-45b8-a275-b6d3d918f91d`，固定主机键的独立 hash 复核 run
  `4327ee37-8b5b-4ab6-8583-bc568fc427e5` 通过。
- Core 部署 run `b4098c30-d980-48d0-ab93-48d403b0b9b5`：发布归档 SHA-256
  `1e041c8e080cca3449189af59cb307d9890e071e65b0142ff3306db90b0d4d8a`，运行镜像
  `sha256:4eef56e4f3daee4e3174285491732cd16ffe444509f28e37682b6039a0b7bb02`，
  版本为 `66ead81-release-1d-phase1-final-gate`。
- 部署后验证 run `1633cef1-5665-4a98-a94b-43c422b335d3`：健康、零重启、四项迁移、
  Context 两列及零非法引用、checkpoint 开关、`deepseek-flash`、零未终止请求、单活锁、
  备份、发布归档、回滚镜像和本地/远端 dist hash
  `b42ecfb3ff6566e3a92fd4d87c4387c2f6ada1c41c36f6f630a9bc5db43e6d55`
  均通过。Mac SSH 隧道下健康及认证状态 `ready`，run
  `41ffbdc1-7354-48f3-9a9e-a0e3856468a0`。Phase 1 第五轮修复已重新放行，
  Phase 2 可开始。

### 2.7 复盘后的运行时修复与精简（2026-09-19—20）

- 基线为 `main@c2d7d4f`。Chat 请求认领成功后，第二次助手事件查询若抛错，外层尚未
  收到用户事件和 generation，原先无法清理该请求。现在由认领所在作用域调用已有
  terminalize，保留失败标记重试机制，解除 checkpoint 前缀阻塞。首次请求和失败后
  重开两条回归均验证错误后终止、前缀可推进、同 ID 重试成功；初始聚焦 41/41，
  run `7905142e-0ef6-45d6-aca4-4d60d50704e7`。
- Pipeline 强制使用生产入口已有的共享 assembler，删除另一套本地历史、系统提示和
  回复累积路径；适配器测试改用真实共享组装链路，保留历史内容断言。
- 内存与 PostgreSQL 账本共用领域层的 Context 引用校验、完整轮次分组；有序输入无需
  再排序，内存读取仍复制事件与时间。PostgreSQL 失败标记删除复用现有事务内方法，
  原事务和锁不变。删除 Qwen 只写不读的 submitted attempt 字段与重复 epoch 判断。
- 评估测试改为逐例表格，删除脚本的单次转发函数与恒等布尔分支。对比改动前后的
  117 条输入和断言完全一致，run `fb4ed2d4-3625-43a0-b5f7-e65822c9fa64`；
  用例从 90 到 93 是拆开三个复合用例，没有增加语义规则或减少反例。
- 盘点 210 个受 Git 管理的文件后，未确认可整文件删除的废弃入口；定时备份安装、
  手动 trace 验证、Vitest 自动发现配置仍有用途。保留 SDK、Port、备份隔离与历史证据。
  本轮实现和测试净减少 216 行（不含本文）：运行时代码减少 76 行、评估脚本减少
  7 行、测试净减少 133 行；没有新增文件或依赖。
- 独立临时 pgvector PostgreSQL 下聚焦 231/231，通过 run
  `e3d94b9e-fc7d-44ff-ac5a-86a7aab3a421`。完整 `pnpm check:ci` 的生成一致性、
  Biome、构建和类型检查通过，35 文件 352/352 且无跳过；run
  `bc008f2c-63a8-4be8-911b-064e202f4691`，测试子 run
  `42f67ed5-3519-4a9e-8db0-53dcb768ba80`。上述验证后仅追加本文；Mac 源码与协议
  未改变，未重复构建 App，也未新增付费模型调用。
- 上次复盘已记录的评估器假通过、两份非原样录制夹具和 Qwen 取消后同 ID 重试 P2
  仍为独立已知项，本轮未扩大到这些修复。评估器的 `passed` 不能单独作为任意新输出
  的语义证明；保留对真实原始输出的人工判定，不以增加措辞覆盖为 Phase 2 新门禁。
- 修复提交为 `82b3167e7283c89307e9d9f465b1d92c66cd6d9b`；Codebase MR
  [!31](https://code.byted.org/user/violet/merge_requests/31) 合入
  `main@414fd541994d09d4116d4b5ec22bbeb9f7168330`，GitHub PR
  [#14](https://github.com/Defector-12/violet/pull/14) 合入
  `main@5b446be9528159b7b5898637f064569fe47c2f3d`；两个主线和修复提交 tree
  均为 `39a110282be09e26f92dfac7b484aeee7d100d47`。Codebase 自动检查和 Aime
  复审通过；主线 review 规则按既有个人仓库流程记录 `no_need_for_review` 后合入。
- exact-main Core 与共享包构建通过，run
  `cdc8ab55-9d5a-4930-8a23-a8047c72eb18`。部署前加密 PostgreSQL 备份为
  `20260919T132419Z-968ee8a6-758a-43db-a57b-aa91aeab42da.vltbk`，密文 SHA-256
  `daa096a9769af397a30bddb0421beb8300c05a9300f76080aa915bd328b01192`，且已上传
  TOS。首次命令在备份和上传成功后误用容器内路径校验宿主机文件而退出 1，run
  `047278b4-f898-4a43-8609-511bac0f9b31`；同一密文的宿主机独立校验 run
  `16c583e7-78f0-4e7c-9b1a-7bd3f6639454` 通过，没有重复生成备份。
- 首次部署 run `cdf21940-7e19-4d37-bcf9-84f74cc9c238` 未通过健康门禁：旧发布脚本
  只替换 Core `dist`，遗漏本次新增运行时导出的 `@violet/domain` 产物。自动回滚恢复
  `66ead81`，旧镜像健康、零重启；清理失败候选并确认回滚的 run
  `7b08c07e-762c-4487-b687-cb6b1e22123c` 通过。修正一次性发布包后，Core 与 domain
  产物共同部署成功，run `42804adb-78a0-4068-8bca-2a7417f3694d`。
- 最终发布归档 SHA-256 为
  `7a38a63d4ce58013d5b3ee7e14b163e199cc2f257da4fc14cdd1a537d1e0f678`，运行镜像
  `sha256:14bdc1ac4199d1b84b9cd99a210b6eb18eb914a0fcdd994165294d5d8ede1cf6`，
  版本为 `414fd54-release-1d-phase1-runtime-fix`。独立验证 run
  `2477fae0-9df1-4cd3-b02f-135a9344d868` 确认 Core/domain 本地与远端 hash 一致、
  新 domain 导出可加载、健康且零重启、四项迁移、Context 引用、checkpoint 开关、
  `deepseek-flash`、零未终止请求、单活锁、备份、发布归档和回滚镜像均通过。
- Mac 和协议源码未变化，因此未重复构建 App；临时 SSH 隧道下认证状态为 `ready`
  且返回新版本，run `e9617af4-1e9a-4fb2-b7c4-0a2f27b05170`。Phase 2 开发可开始。

### 2.8 Phase 2 开发准备（2026-09-19）

- 开工基线为本地 `main@82b3167`，工作树在准备前干净；相对本地追踪的 `bits/main`
  领先一个提交。本次没有刷新远端或重新探测生产环境，部署状态沿用 2.6—2.7 的证据。
- 已核对 2.7 的完整检查、测试子 run 和聚焦 run：记录目录及退出码 0 均存在，
  原始 stdout 分别确认完整测试 352/352、聚焦测试 231/231；本次没有重复执行测试。
- 已对照产品宪法、规格和代码完成接入盘点。长期记忆表、管理 API、记忆窗口、
  `recall_memory` 和恢复纪元尚未实现；现有 `deletion_revision`、共享上下文、
  加密信封、生成客户端和备份程序可复用。
- 开工顺序、补充接入文件、在途上下文失效、Keychain 确认顺序、备份快照一致性及
  验证安排当时已补入任务拆分第 3 节（现合并入[规格](./release-1d-spec.md)）。1D-04—08 作为完整闭环
  验收；自动提取和开关仍归 Phase 3，清空记忆属于 Phase 2 治理。
- 本机版本查询确认 Node `22.23.2`、pnpm `11.21.0`、Swift `6.4` 可调用。
  Docker 查询返回服务端版本 `29.4.3`，但因沙箱限制访问 Docker Desktop 日志而非零
  退出；本次未建立隔离数据库，不能据此宣称数据库测试环境就绪。
- 本次只更新准备文档，未修改运行时代码、安装依赖、提交、推送或部署。
  DeepSeek、Qwen、TOS 和 Keychain 复用既有集成；本次未进行真实模型调用、
  TOS 权限探测或 Keychain 写入，外部集成就绪和真人 recorder ready 仍由各自
  后续验收记录证明。Phase 1 已知 P2 沿用 2.7 的处理，不新增一轮全面加固门禁。

### 2.9 Phase 2 开发范围与交付目标复核（2026-09-20）

- 本次只进行阅读、方案整理和文档更新，按用户要求等待确认后开发。
  当前本地为 `main@7ea983a`，准备前工作树干净，与本地追踪的 `bits/main` 一致。
  相对 `82b3167` 只有六份文档变化，Phase 1 运行时代码未再变化；没有刷新远端。
- 已核对 2.7 的测试原始 stdout/result：`42f67ed5-3519-4a9e-8db0-53dcb768ba80`
  为 352/352、退出码 0；部署验证 `2477fae0-9df1-4cd3-b02f-135a9344d868`
  记录 `414fd54-release-1d-phase1-runtime-fix` 健康、退出码 0。
  这些是既有证据，本轮没有重复测试或重新探测生产。
- 源码核对确认长期记忆表、`recall_memory`、Mac 记忆窗口、管理 API 和恢复纪元均未
  实现。现有共享上下文、加密、请求终止化、实时取消、生成协议和备份程序继续复用。
- 当时的任务拆分第 3 节增加本轮审阅摘要（现合并入[规格](./release-1d-spec.md)）：五个工作包、关键决定、
  交付门槛、依赖和失败处理。保留 1D-04—08 原范围，清空记忆在 Phase 2，
  普通轮次自动提取及开关在 Phase 3。
- 只读取公开官方文档核对工具调用、数据库快照和认证解密能力；没有真实模型调用、
  TOS 操作、Keychain 写入、数据库迁移或 App 操作。新功能质量与外部集成仍须通过
  后续独立验收，未将计划内容勾选为已完成。

### 2.10 Phase 2 工作包 A：数据与管理协议（2026-09-20，开发中）

- 用户已批准开始实现 Phase 2。当前均为本地未提交改动，未部署或改动生产数据。
- 新增 `0003_explicit_memory.sql`、领域合同和 PostgreSQL 加密仓储：原子记忆、
  来源字节范围、版本、summary revision、恢复纪元、幂等结果、删除预览及最小墓碑。
  删除整轮来源；数据库触发器共享实例锁，拒绝已删除 request 的迟到事件。
- 纠正追加版本并失效 checkpoint/summary，不会因新版本来源删除而复活旧版本。
  明确受控敏感内容要求原话，秘密写入拒绝；模型调用前的门禁已在工作包 B 接入。
- Schema/OpenAPI、生成 TypeScript/Swift 输入文档、SDK 和 Core 管理路由已实现：
  列表、版本/来源详情、纠正、删除预览/确认/状态/重试。敏感列表和来源默认遮挡。
  对话内写入、召回与在途回答失效见工作包 B；真实 Mac Keychain 确认和备份清理待完成。
- 隔离 PostgreSQL 17 容器 `violet-phase2-postgres` 使用本机端口 `55436`；
  启动记录 `c3d51430-e165-4d76-b6e3-ef5a0f8073b4`。测试只在随机 schema 内操作。
- 首次测试 `7875bb67-871a-400e-b09b-804e0431a2dd` 保留两项失败：
  JSON 字段顺序导致预览重试误判（已改逐字段比较）；两个套件并发创建扩展冲突
  （数据库套件改串行执行）。没有清除失败证据。
- `3e836332-0bde-4c15-b298-edfb5ce38eec`：11 条记忆事务测试和 5 条既有上下文
  数据库测试通过。`df56b459-4eea-4ac0-a401-b659e2dce712`：加入升级前原话和
  SDK→管理 API→真实 PostgreSQL 治理路径后，12 条记忆测试及 11 条协议/SDK
  回归通过。`816016b9-5a82-475e-803b-deaa2fcd6346`：新增两条协议负例测试通过。
- 协议生成 `49823410-4d68-42c6-bd85-54932469c807`、Core 及依赖构建
  `687a8fe3-f5d4-4ac8-8862-f3cee86bc1ec` 通过。格式检查提示的非空断言已清理。
  尚未执行 Phase 2 全量回归、真实模型、Mac 窗口或恢复验收，以下放行门不提前勾选。

### 2.11 Phase 2 工作包 B：同步写入、共享上下文与召回（2026-09-20）

- 当前文字模型只对最终用户输入提出结构化明确记忆/纠正/删除预览意图。
  Core 校验字段、真实目标版本和逐字来源，并计算 UTF-8 引用；普通陈述不自动新增。
  受控敏感内容使用明确原话路径，跳过提取模型；秘密在文字入账、最终转写处理和
  模型提取前拒绝。受控记忆保持默认遮挡，不自动注入模型。
- `MemoryService` 提供同步提交、幂等结果、确定性 8,900-byte summary、当前/历史
  Top-5 文本与时间召回。纠正来源的旧轮次从近期上下文及召回排除；summary/
  checkpoint 仍受 revision 校验。`VIOLET_MEMORY_INJECTION_ENABLED=false` 停止
  摘要与召回注入，治理功能和旧来源排除保留。
- 文字和 Pipeline 使用 Core 确认的回执，完成事件携带不含正文的变化与预览 ID。
  Qwen 在最终转写提交和记忆处理前缓冲回答；需要回执时丢弃旧输出、取消旧 response
  并依据 Core 回执重新请求。覆盖回执早于 response.created、活动 response、已完成
  response 三种顺序。保留 `inspect_current_view` 和 `max_history_turns = 20`。
- DeepSeek 工具合同支持分片调用、调用 ID 和结果回传；文字与 Pipeline 共用有界
  `recall_memory` 往返，Qwen 按工具名分派。召回重查 revision 后才返回；
  中间模型猜测不会提前输出。记忆纠正/删除中断旧回答并关闭旧实时连接。
- 删除预览确认改为复核实际受影响事件集合；无关轮次（包括“已生成预览”的回执）
  不使预览失效，来源轮次的新事件仍必须重新预览。已删除轮次的失败清理接受墓碑，
  不再因缺失用户事件反复重试。
- 初次接入回归 `ff6b1f7b-2948-4229-94ff-69cf8dd40bb3`：100/108 通过，
  保留 7 条视觉路由退化及 1 条 Pipeline 取消失败。视觉工具恢复原分派时机；
  Pipeline 在 TTS 初始化后再次检查取消。后续 `76a9b9ef-e1d2-43b9-b7c4-fe65f85f8340`
  中视觉 52 条通过，剩余失败为测试替身在首次 yield 后才订阅 abort；
  已使订阅覆盖整次模型请求。`c076077e-2cc8-461e-90c0-667d9e838a33` 的
  37 条上下文、Pipeline、提前语音和 trace 测试通过。
- 数据库首次运行 `0251418f-e27d-4aad-b26b-c2f13b81796e` 因测试库名写错而未进入
  用例；改用容器实际数据库后，`de2c1d02-099c-4828-a575-bbd34c553997` 的 15 条
  通过。新增在途纠正用例后的 `fd27f5a8-168e-42f2-b141-56dc518b033d`：16 条通过，
  含真实 PostgreSQL 的先提交后回执、重试、20 普通轮次零新增、重启后旧来源排除、
  删除预览确认和忽略 abort 的模型迟到回答抑制。
- `f298a96a-c041-491d-b9d3-7effb4ec232c`：9 条提议、UTF-8 引用、summary、
  文本检索、工具往返和语音缓冲测试通过。构建 `210c4754-0213-4767-a62a-b7d38283a1f9`
  通过；格式检查 `0d16242e-2735-4676-8b55-6a5263a2537d` 通过。
- 回滚开关补齐后，`a1b8c03e-4e60-40cf-a818-73278386e59b` 构建通过；
  `e489f375-0923-4fd5-a183-76659c08fd2a` 的 5 条工具/语音测试通过；
  `f348f0cd-0adf-46cc-9c2e-ab20b8f373ed` 聚焦验证了 PostgreSQL 上关闭注入后的
  摘要为空、召回停用、治理仍可用及旧来源仍被排除（其余 15 条明确未重跑）。
- 上述模型/供应商事件为确定性测试替身，数据库为真实隔离 PostgreSQL。没有声称
  真实 DeepSeek/Qwen 的语义质量、语音回执准确性、首音频延迟或检索性能已验收。
  当前提议和工具往返增加等待；统一验收需保留真实模型三次样本和延迟分布。
  Mac、Keychain、TOS/备份清理与恢复仍待后续工作包；没有生产上线或提交。

### 2.12 Phase 2 工作包 C：Mac 治理与删除确认（2026-09-20）

- 基于生成的 Swift OpenAPI 客户端新增 `MemoryClient`，独立窗口提供当前记忆、
  近七天变化、搜索、类型/时间筛选、版本、来源轮次、纠正、删除预览及单独清空确认。
  受控敏感正文默认由 Core 遮挡，详情主动显示；关闭窗口或系统挂起清除详情，
  迟到的显示结果不能重新填回已关闭的详情。
- 文字 `complete` 与语音 `response.completed` 的无正文变化/预览元数据已传至管理模型。
  记忆入口显示变化标记，自然语言删除打开同一窗口与确认路径，不增加聊天气泡。
- Keychain 按实例 UUID 保存 `minimumRestoreEpoch`、待确认 ID 与最近删除 ID；
  与设备 Token 分项保存，使用 `WhenUnlockedThisDeviceOnly`。保存取原纪元与新纪元的
  最大值并读回核验，成功后才发送确认。网络结果丢失保留同一 ID，重开窗口继续重试；
  确定的预览冲突清除待确认 ID，但不降低恢复纪元。提交确认后清空本地详情；
  备份清理状态和失败重试保留独立入口。
- Swift 协议生成与原有解码基线 `114f3807-6efb-44fd-98b5-65c59750a6c4`：3/3。
  首次新增客户端编译 `cb7769d2-edef-4248-82b0-77d1aa973b99` 因
  `OpenAPIValueContainer` 初始化标签不符失败，已改用其字符串字面量合同。
- 修复后聚焦 `ab235994-df89-4582-a45d-b90ba7d19aaa`：56/56，含 9 条新增治理测试、
  原有文字/语音和 Natural Pointing 行为。最后全量 Mac 测试与目标编译
  `fed5138d-29dd-4d46-b9e3-3cebc80a2b67`：104/104、9 个 suite 通过。
- 治理状态测试使用合成数据、替身网络与替身 Keychain，覆盖写入失败不发删除、
  丢失回执重试、冲突后单调纪元、提交后 Keychain 失败、纠正幂等、敏感显示和完成事件。
  尚未调用真实 Keychain、执行真人键盘/VoiceOver 操作、重新打包签名或部署；
  这些结果不冒充第 11 节的 Mac 十步故事通过。

### 2.13 Phase 2 工作包 D：删除后的备份与恢复（2026-09-21）

- `backup-snapshot.sql` 使用 PostgreSQL 17 的 REPEATABLE READ 事务读取实例与纪元、
  导出 snapshot 并保持事务到 `pg_dump --snapshot` 退出。元数据前缀与 custom dump
  进入同一流；dump 非零退出或输入格式错误都不能上传。
- 新信封 schema 2 将实例 UUID、恢复纪元纳入 AES-GCM AAD。加密后使用尚未销毁的
  一次性数据密钥完整读回验证，不向服务器引入恢复私钥。旧格式读作纪元 0。
  解密对私有密文副本先完成全量认证、完整性和恢复门检查，再创建明文输出。
- 官方 `restore-backup.sh <input.vltbk> <output.dump> <instance-id>` 和 backup CLI
  的 `decrypt` 均要求当前 Mac Keychain 的 `com.violet.restore-epoch` 实例记录；
  缺失、无效、实例不匹配或纪元过旧时失败。密钥仍通过原有私钥环境/文件读取。
  低层格式测试直接传入合成恢复策略，不代表真实 Keychain 已验收。
- 备份脚本在 dump、upload、cleanup 全程持有同一 host flock。上传后验证 HEAD
  元数据及指定版本的完整 GET 密文 hash，成功后才清理受管本地文件和 TOS 全部分页的
  旧 versions、delete markers、multipart uploads；保留新验证版本并复查远端列表。
  非备份命名的本地文件及其他对象不删除。
- 复用现有 cron 安装脚本增加每分钟 `--cleanup-only`：无任务直接退出，
  `pending/running → running → complete`；任何备份/清理失败记为 `failed`，
  Mac 重试转回 `pending`，进程异常退出遗留的 `running` 可重新执行。
  后续并发删除保持 pending，不会被前一个快照的成功状态覆盖。在线删除不回滚。
- 聚焦备份、恢复策略、分页清理与脚本替身测试 15/15：
  `5aa03636-865f-409d-9c37-4d7102c6def3`。上传完整下载验证、损坏时禁止清理及真实
  PostgreSQL 隔离导出/恢复 3/3：`c6ca203e-9c43-41b3-876b-dfce3b8683e2`。
  隔离库证明导出期间的并发删除不会给旧内容打上新纪元；旧 dump 恢复得到 epoch 0
  及合成旧记录，floor 1 拒绝它；新 dump 恢复得到 epoch 1 且旧记录数为 0。
  pg_dump 失败也使 psql 非零退出。
- 首次隔离测试 `f2518840-0a7a-4052-b36e-be29c7e9bf9d` 因新测试的迁移相对路径多了
  一级而失败，已修正路径后执行上述通过记录。失败记录保留。
- 全仓构建与 TypeScript 类型检查（包括测试源码）通过：
  `2cd827cc-6d10-49ae-9d9e-b29a47111a8d`。
  未安装 cron、未调用真实 TOS 清理、未运行官方真实 Keychain 恢复、未部署；
  发版时需一并更新备份程序和 cron，不能继续使用旧版本上传或恢复入口。

### 2.14 Phase 2 工作包 E：本地评估与完整回归（2026-09-21）

- 新增固定 180 条合成语料及 `pnpm eval:memory`：明确记住 40、纠正 10、
  删除/迟到写入 20、秘密/助手/工具/视觉/取消负例 20、历史 50、无关历史 20、
  普通聊天 20。命令、证据含义与后续真实评估见
  [记忆评估说明](./testing/memory-evaluation.md)。
- `271a76f8-6970-4318-a4d8-601c5a089cee`：真实隔离 PostgreSQL 上 180/180
  合同用例通过，包含加密保存、逐字来源、幂等、纠正、整轮删除和迟到写入拒绝。
  给定关键词下当前非敏感记忆命中 36/36、历史 Top-5 命中 50/50、无关查询
  返回数 0/20。明确意图由固定提议提供，纠正/删除走治理服务；这些结果不证明
  真实模型理解、工具查询选择、最终回答或 Qwen 音频质量。
- 同一 run 测量整个 `MemoryService.recall`，包含 PostgreSQL、解密、过滤和
  revision 复核。每组 50 次，保留全部 200 次原始结果，不舍弃慢样本。
  短合成事件、Mac 本机隔离 PostgreSQL；不能外推生产网络或任意长事件。

| 记忆 / 事件数 | 范围 | p50 ms | p95 ms | p99 / max ms |
|---|---|---:|---:|---:|
| 100 / 1,000 | 当前记忆 | 4.32 | 6.43 | 7.35 |
| 100 / 1,000 | 含历史 | 17.92 | 22.44 | 27.03 |
| 1,000 / 10,000 | 当前记忆 | 25.06 | 31.72 | 34.76 |
| 1,000 / 10,000 | 含历史 | 156.63 | 179.13 | 182.61 |

- 四组本地 p95 均低于 300 ms；本轮未因性能添加索引、向量或新的检索路径。
- 首次评估启动 `177e4919-6d62-4fa8-89df-65e9c9e83a99` 因当前依赖环境没有
  `tsx` 命令而失败，未进入用例。入口改为构建 workspace 依赖后运行 JavaScript；
  没有安装依赖或改变锁文件。失败记录保留。
- `--model` 提议收集器支持每例三次，记录实际请求、可见输出、部分失败输出、
  usage、关联 ID 和每次 HTTP 尝试；强制显式尝试上限和输入/输出 token 上界。
  所有语义判定均保持 `requires_review`，不把 JSON 可解析或含有关键词算作正确。
  本阶段尚未执行付费模型调用；Phase 1 的费用授权不沿用。
- 无付费预检 `08361a14-2c67-49ae-98e0-f157e44f00af` 发现通用凭据脱敏器把
  含 `token` 的数值统计键遮挡，记录缺口保留。评估器改用 input/output/limit
  加 `unit: tokens` 记录数值，没有修改凭据脱敏策略。修复后构建与 `--plan`
  通过：`55df1b9f-f2ce-451b-b74e-2c6ab18acf83`，输出可解析且模型调用为 0；
  定向 Biome 通过：`3f0c6acb-3222-410e-b917-b92dbf79bf63`。
- 全仓生成、Biome、构建和类型检查通过：
  `27e7686b-8410-422e-ae55-1279c36827f1`。生成前后 TypeScript 与 Swift OpenAPI
  输入 SHA-256 均一致，分别为
  `60ac40cf3e00e3488fe5aed45c25d32b13df02bc80836435b50a44699408cace`、
  `08c08385e2a7fc7a0394d6a64677f848181f84109a40b91a36753c2c05c86eaa`。
  当前生成文件属于未提交的 Phase 2 改动，未将 `check:ci` 对 HEAD 的 diff 检查
  宣称为通过。
- 全量 TypeScript/脚本回归 `b31000dd-343f-4361-9d14-9d2fcf91f62e`：
  **400/400、44 个文件通过，无跳过**。开启隔离数据库和真实 PostgreSQL 快照测试，
  数据库套件串行；覆盖 Phase 1、Natural Pointing、记忆协议、同步语音、
  纠正失效、备份认证、损坏上传与删除前后隔离恢复。
- Mac 已有最终源码的 104/104 测试见 2.12，无变化未重复执行。
  App 打包和严格签名通过：`52c7d4f0-d27b-4b9f-aa66-d34905235772`。
  Compose（含 operations profile）、三个备份 shell 的语法、签名与二进制 hash
  核验通过：`38778835-d91e-4e24-96af-67ef516198f3`。
  二进制 SHA-256：
  `709f01c27870a9e4df4d7b5bd35379b2fb85a0a7a5c906e1f00e93ff761c95dd`。
  只生成本地构建产物，没有安装、启动或替换当前运行的 Mac。
- **剩余放行门**：真实 DeepSeek 提议与工具回答（每例三次）、Qwen 最终语音/提前
  成功抑制与延迟分布；真实 Mac Keychain/键盘/VoiceOver 和第 11 节十步故事；
  真实 TOS 分页版本/分片清理、官方 Keychain 恢复以及生产迁移/部署记录。
  执行前分别落实费用、实机交互和云端删除授权，核验 recorder ready。
  Phase 2 尚未合并或上线；关闭注入的回滚路径已验证，治理与恢复纪元保持生效。

### 2.15 Phase 2 真实验收（2026-09-21，09-23 完成离线复核）

**结论：不放行。** 以下全部使用合成数据、随机隔离数据库/schema 和测试云端前缀。
Qwen 的成功证据不替代 Mac 真人故事；库级恢复不替代真实 Keychain 官方入口。
没有提交、推送、部署或安装 cron。实机操作入口见
[真实验收交接](./testing/phase2-real-acceptance.md)。

**DeepSeek 提议。** 两轮均为 180 例 × 3 次、504 次实际 HTTP 尝试：
首轮 `0827439c-7e31-4138-8c3f-7d4d3527c9de`，
修复后 `0a5763f6-7916-4a64-9096-10275d8e2ed9`。
逐条语义及来源复核为 `c20767e2-d7af-4b2f-a442-e99494dae209`。

- 首轮 `negative-05/1` 把助手猜测“喜欢滑雪”转为用户事实；另有类型、纠正作用域及
  历史意图错误。提议指令已明确要求用户本人断言、保留限定词和完整引用，并区分
  事实、偏好、目标与关系。修复后助手/工具/视觉 36 次均澄清，秘密/取消 24 次拒绝，
  没有把这些负例写入。
- 修复后明确写入完整合同 **117/120**，剩余 3 次类型不符；纠正 **28/30**，
  `correct-10/2` 引用缺“周末”范围，`correct-10/3` 正文丢失该范围。
  不能因 JSON 合法、原话是子串或写库成功，就声称语义门通过。
- 删除目标提议 54/60，其余 6 次澄清，没有错删；普通聊天 60 次零写入，
  其中 2 次错误要求记忆澄清。历史意图识别 124/150。
- 两轮各 6 条秘密负例的 `case-start` 行被通用脱敏器破坏 JSON 结构，
  结果行仍在，缺口已记入复核报告；没有补造缺失原始输入。

**真实工具与最终回答。** `acbee489-f87e-4c84-822e-530d8e4520ca`
执行真实 `ChatService → recall_memory → 最终回答`，隔离 PostgreSQL 中保留同一组
50 条历史，每例三次，并加入 20 条无关问题各三次。210/210 完成、631 次 HTTP；
09-23 对全部实际查询、结果和答案零新增付费复核：
`4fc76c15-5e5a-4104-b249-a5813ba73820`。

| 指标 | 实测结论 |
|---|---|
| 历史来源 Top-5 命中 | **102/150（68%）**；三次分别 33/50、34/50、35/50，低于 90% |
| 48 次未命中 | 32 次历史开关为 false；5 次未调工具；8 次中文词匹配失败；3 次日期过滤失败 |
| 最终答案 | 101 次给出目标事实；另 1 次虽命中，却把两场不同讲座当成矛盾，拒绝回答 |
| 无关问题 | 60/60 未编造目标事实；其中 6 次仍把无关旧记录带入答案 |
| 其他已识别问题 | 10 次把 historical 推论为失效/被替代；6 次夸大实际搜索范围；1 次混淆记录日期和事件日期；1 次承诺以后绝不忘记 |
| 210 次端到端耗时 | p50 2,187 ms、p95 2,906 ms、p99 3,221 ms、max 3,294 ms |

固定语料的事件时间全为 2026-09-01，正文却含五月、六月、七月及“上周”。
日期用例因此存在夹具限制；模型也擅自使用了 2025 年范围。保留原始分母和结果，
不把日期失败全部归为产品或全部归为夹具。中文失败包括 `桶 摆放`、`桌游 选择`、
`夜跑 桥`：现有分词丢掉单字词，词序变化也会失配。隐式问题的历史范围判断和
不相关词命中需要继续修复；未放宽历史访问条件来凑达标率。

**Qwen。** 首轮 `b966899a-64de-43f7-873d-bcc3c6780081` 三组中两组失败：
自然完成后迟到的取消回执被当成新错误。适配器保留待确认取消的 provider response ID，
覆盖取消回执早于/晚于自然完成两种顺序。共享记忆指令同时明确使用当前记忆，
缺失时先召回再询问用户。

修复后 `92f0e2f7-7289-4725-ba42-91640afc207e` 三组全部完成：
9 个语音轮次、6 个文字轮次；语音记住紫色、重建服务对象后文字使用紫色、
纠正后新语音使用橙色、删除后承认没有记录。成功回执均在提交后释放。
首音频相对输入结束 p50 1,820 ms、p95/max 2,349 ms；相对最终转写
p50 1,078 ms、p95/max 1,384 ms。使用 Tingting 合成语音，无原始音频落盘；
没有验证真人麦克风/扬声器、真实进程重启或真实 Qwen 下的存储失败注入。
首轮自制日志也存在脱敏破坏 JSON 的缺口，`result.json` 与 Core 原始记录可交叉复核；
第二轮改用结构化 `sanitizeTrace`。

**真实 TOS 与恢复。** `697c2d6c-c729-4bed-9e38-4a8d9b104fb6`
在随机 `violet/tmp/phase2-<UUID>` 前缀调用生产上传及清理实现，将真实列表页限制为
1 项以覆盖分页。清除旧备份的 2 个版本、删除标记与 2 个未完成 multipart；
保留非受管 sentinel，验证新备份完整下载及密文 hash，恢复到另一隔离库后
事件、记忆、摘要、checkpoint 均为 0，召回 `not_found`。结束后清除了测试云端对象
及数据库。更早的夹具失败 `7e473e5d-858b-4253-9fa6-514a66a888ba`
缺少助手事件 epoch，修复夹具后通过，失败记录保留。

真实 Keychain run `43abd637-9a20-4700-a7b5-c93187e831f4`
被 Agent 文件沙箱拦截 `~/Library/Keychains` 写入（`OSStatus 100013`）。
官方入口在 Keychain 缺失时拒绝创建 dump 已验证。上述 TOS 成功 run 使用明确标注的
`--cloud-only` 合成最低纪元，只证明库级恢复；真实 Keychain 单调保存、重新读取、
旧备份拒绝与新备份官方恢复组合仍未通过。没有修改系统权限或绕过沙箱。

**本地回归与费用。** 修复后全仓生成、Biome、构建、类型检查通过；
`0792de02-5cf7-4f99-8943-1a5fc51ed833` 为 **402/402、44 文件、零跳过**。
外层 `e10e54cf-8090-4724-b411-c470a5d7fb66` 只在最后生成文件相对 HEAD
仍有未提交差异时返回非零，不能将整个 `check:ci` 称为通过。
最终格式检查 `728631f2-c4a0-4442-a2c1-1c9a6f671614`、Core 构建
`dad8da68-db28-4cf2-bb89-1502bb0d026c` 通过；Mac 源码未再变化，沿用 2.12—2.14
的 104/104 和签名证据。

文字模型按记录 usage 与峰值单价计算的累计费用上界为 **3.666544 元**
（两轮提议 1.175096 + 1.476588，Qwen 配套文字 0.012976 + 0.028716，
工具回答 0.973168），低于本轮 5 元上限；这不是 Qwen 语音或 TOS 的结算账单。
09-23 复核没有新增模型调用。

**剩余门：** 提议语义完整性、历史召回及答案质量；真实 Qwen 存储失败时提前成功抑制；
Mac 十步故事、键盘和 VoiceOver；真实 Keychain 与官方恢复组合；最终发布记录。
隔离 Mac Core 预检 `175e2ebe-943a-46de-bb5e-05b0ceae6901`
已证明服务/记录器可用，但没有启动 Mac 或代替真人操作。
09-23 交接脚本补齐新进程 ready 核验、中断清理与清理失败记录；复检
`d121a0d5-b703-4408-9f24-7007df04d83f` 仍为 Core/trace 通过、Mac 未启动、
付费调用 0。Keychain/TOS 脚本最终语法检查
`cd0134b8-0a15-4d61-9c0a-3340da92b157` 通过，不代表真实 Keychain 门已通过。

原始证据遵守 24 小时保留期。09-23 复核完毕后，按已有到期时间清除了上述八个
模型/云端 run 的 28 个过期原始文件；保留每次成功/失败结论、逐试验问题标注、
原文件 hash/大小和 run 目录，清理记录
`192a115f-5036-4048-86b5-2c5a7034d5b3`。原文已过期的位置不能再声称可读取；
后续人工脚本把自定义原始记录和备份放入既有清理器覆盖的 `server/` 目录。

### 2.16 用户实测：真实 Keychain 与官方恢复通过（2026-09-23）

用户在普通终端执行 `.local-acceptance/phase2-cloud-restore.mjs`，
run `6d9cff97-c67a-418b-87b7-8185e238004f`，`cloudOnly=false`、
`exitCode=0`、`passed=true`。此前 Agent 沙箱写入限制仍保留为历史失败，
本次没有更改沙箱或使用合成恢复策略。用户提交的终端输出与本地记录的
57 条事件逐条一致；独立离线复核 run
`119b3bd4-cb25-42b5-a692-2a1f401c7797`，没有新增模型或云端调用。

| 检查 | 实际证据与结论 |
|---|---|
| Keychain 缺失 | 官方入口退出 1，报告保护记录缺失，不创建 dump，符合预期 |
| 删除前可恢复 | 初始化最低纪元 0 后，同一旧备份经官方入口成功恢复 |
| 先保存再确认 | 13:38:39.031Z 保存最低纪元 1 与待删除 ID；13:38:39.057Z 才确认在线删除 |
| 单调持久化 | 独立 helper 进程重新读取、尝试保存 0 后仍为 1，最近删除 ID 一致 |
| 拒绝旧备份 | 官方入口退出 1，报告实例/纪元不允许，且没有生成旧备份 dump |
| 新备份官方恢复 | 纪元 1 的新备份上传、下载后经官方入口恢复；密文及 dump 的 SHA-256 与快照一致 |
| 不复活 | 隔离恢复后 event、memory、summary、checkpoint 全为 0，召回 `not_found` |
| 分页清理 | 真实 TOS 清除旧版本、删除标记及 2 个 multipart，非受管对象在产品清理后仍可读取 |
| 测试资源收尾 | 随后的测试收尾使前缀 versions/uploads 均为空，并删除两个隔离库和该实例 Keychain 项 |

日志中的两处 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` 对应明确预期拒绝的恢复负例，
不属于本次失败。录制源码 hash 与当前 `RestoreEpochStore.swift`、cleanup 构建匹配。
run 的 `source: agent` 是脚本固定的记录标签；本次实际由用户在普通终端发起。

本项证明真实 Keychain helper、官方恢复入口及隔离 TOS/数据库组合通过。
Mac 窗口先保存再确认的真实 UI 行为、Keychain 写入失败注入、cleanup worker 的
`pending → complete` 状态闭环仍不由该脚本证明。原始证据到期时间为
2026-09-24T13:38:24.586Z，继续遵守既有 24 小时保留策略。

**当前剩余门：** 2.15 已确认的提议语义、召回与答案质量问题；真实 Qwen 存储失败
抑制；Mac 十步故事及键盘/VoiceOver；最终发布记录。下一步实机入口见
[Mac 十步故事](./testing/phase2-real-acceptance.md#mac-十步故事)，无需重复本次恢复测试。

### 2.17 真人重启后语音未使用记忆：定位与本地修复（2026-09-23）

**原始失败。** 用户运行 Mac 故事脚本，语音记住紫色书签，输入 `restart` 后，
用语音询问书签颜色却被要求先提供偏好。这不符合预期；第 4 步用语音或文字均应
使用当前记忆。原始 run `0a85fdb8-7145-498b-a10d-32b7e105ac1d` 的
Mac、Core 与终端命令记录仍在，原始证据于 2026-09-24T13:46:40Z 到期。

| 环节 | 实际记录（UTC） |
|---|---|
| 最终输入 | “请记住，我喜欢紫色的书签。”；turn `e8a412e3-50d7-4c71-9e3d-313f6ab948a7` |
| 提交 | 13:47:44.956Z，记忆 `043d50a6-a636-484e-a478-a1c6ca09c651` v1 提交；随后完整回复“已记住。” |
| 真实重启 | Core PID 46583 → 47796；实例仍为 `f70a4be8-4df5-4c7c-9ea6-b5a430583c3b` |
| 重启后输入 | “按我的喜好推荐一种书签颜色。”；turn `a7dcde24-9a16-4d28-85d5-65e62be0112c` |
| 数据仍存在 | 重启后 DeepSeek 提议请求候选仍含“用户喜欢紫色的书签。” |
| 错误回答 | Qwen 未调用召回，回复“我需要了解您的喜好才能推荐合适的书签颜色……” |

因此该次写入成功，故障发生在语音上下文使用环节。原日志只记录了历史消息数量，
未记录连接初始化时种子消息的正文/角色，不能声称已经从原日志直接看到该次种子内容。
Mac 结束阶段曾记录 Core trace 收集失败，但脚本最终 `core.ndjson` 已收齐两个进程；
两个连接的 `trace.closed` 均存在。该收集告警不代表此次问答证据丢失。

**定位实验。** 复用原现场的 `smart_turn`、视觉工具与记忆工具配置，使用相同合成语音，
各执行三次。`145c8ac5-fa58-4225-9a25-caf92170f5e6` 的原始
`assistant/output_text` 记忆种子虽然获得供应商确认，三次均需另调召回才能回答紫色，
其中两次先说需要了解偏好。只改种子为 `user/input_text` 的
`39cd0b5c-0fec-4792-8f4d-960edca993f1` 三次均直接使用紫色、零召回。
首次响应报告的文本输入 tokens 分别固定为 976 和 1060。
这是 Qwen 对前置助手输出的有效上下文处理差异；两种格式均符合供应商协议。
上述实验只用于定位，种子与召回结果为合成数据，不作为存储验收。

**修复。** `ContextAssembler` 给派生记忆和 checkpoint 设置内部 `contextData` 标记；
Qwen 将有标记的数据通过 `user/input_text` 发送。实际历史发言保留原角色，文字模型
消息不带该标记；正文仍带 UNTRUSTED 边界，不进入 system、不构造账本用户事件。
测试覆盖伪造相同正文前缀不会改变角色、真实当前提问仍独立、记忆未进入系统指令。
有界记录器新增种子角色、数据标记与字节数，不记录无关历史正文。

**完整验证。** `.local-acceptance/phase2-core-restart-memory.mjs` 使用隔离 PostgreSQL、
真正停止/启动的 Core 子进程、HTTP/WebSocket、真实 DeepSeek/Qwen，以及 Tingting 合成语音。
配置仍为 `smart_turn`、`onDemandContext=true`。最终三组为：

| run | 语音记住 → 重启后语音/文字 | 文字纠正 → 新语音 | 删除 → 再次重启后语音 |
|---|---|---|---|
| `aba82267-c88b-4c2f-96e0-7e30bda7f229` | 紫色，通过 | 橙色，通过 | 未返回已删除颜色，通过 |
| `bb40f88a-882d-44d8-9756-d7275d4b5532` | 紫色，通过 | 橙色，通过 | 未返回已删除颜色，通过 |
| `c83409ca-d6d7-4a29-aa36-c4cb733069cd` | 紫色，通过 | 橙色，通过 | 未返回已删除颜色，通过 |

独立离线复核 `7ad0ec47-5bae-4640-b598-ac834a9eec74` 核对 12 个语音轮次、
6 个文字轮次、6 次进程重启及原始 trace hash：三次成功音频均晚于记忆提交；
重启后与纠正后的六次使用均直接采用当前摘要、零召回；删除后摘要为空，
三次召回仅找到不含具体颜色的历史提问，均未恢复紫色/橙色。最后一组原始 trace
与其他组均有独立记录，隔离库和临时凭据已清理。
语音轮次耗时（包括建连、合成音频发送与完整回答）p50 7,103 ms、
p95/max 13,141 ms，不等同于首音频延迟。

**保留的失败与限制。** 第一批 `edb3df19-660f-4386-a27d-e7965268f233`、
`13cfcf7e-d8ab-4eab-a2d5-bbdd04ceffaa` 已正确回答紫色，但验证脚本误将文字接口
NDJSON 当成 SSE，故未进入后续步骤；原始文字回答和 complete 均已保存，修正脚本后
才执行上述完整三组，原失败未覆盖。同批 `ea2fa3a5-77b7-4bc8-bdc4-cd89f44304fb`
在推荐问题被 Qwen 切成“按我的喜”和另一段转写时，第二个新 `item_id` 缺少
speech-started/stopped，适配器退回旧 turn ID，触发 `REALTIME_TURN_CONTENT_MISMATCH`。
该独立语音稳定性问题仍未修复，不能用后三组成功掩盖。两批重启后原问题合计
**5/6 正确完成，1/6 因分段冲突失败**。

本次未操作 Mac UI、麦克风、扬声器或 Keychain；删除确认仅用于隔离合成数据库，
cleanup 状态仍为 pending，不作为真实备份清理闭环通过。完整 Mac 故事、可访问性、
Qwen 存储失败注入，以及 2.15 的写入/纠正语义与历史召回指标仍待通过。

**回归与费用。** 聚焦测试 `af01e99a-46c9-492a-8204-d96a6cd21508` 为 49/49；
Core 依赖构建 `5dc5c12b-8f83-43bb-a73e-411cef5c41ec`、全仓类型检查
`b35baaa3-5c87-44da-80ca-d7cf5d264704`、最终 Biome
`79e308d2-d6b9-488d-bf05-827cbe6ac436` 均通过。第一次全仓
`4aa1bd38-b540-45c1-8b60-228bc74fcbd5` 为 403/404，已有备份脚本负例超时
（5,364 ms / 5,000 ms）；该项独立三次耗时 350/311/323 ms，均通过。
最终限制测试并发为 2 的 `d5c3592c-c495-4fc0-9dea-b09e76019592`
为 **404/404、44 文件、零跳过**，包含真实 PostgreSQL 与快照恢复测试。
前一次 Biome 的两处测试格式错误也保留于 `6ef71282-a867-4423-b3bc-1192c80965b4`。

文字模型新增费用上界：真人 run 0.006900 元、第一批 Core 验证 0.020772 元、
最终三组 0.042224 元，累计 **3.736440 元 / 5 元**。测试代理只约束最大输出
4,096 tokens、0.8 元批次上限并记录 usage，回答来自真实模型；不含 Qwen/TOS 账单。
本地 Core 构建已更新，原 Mac 故事入口下次启动即可使用；未提交、未部署，
不把本项修复称为 Phase 2 放行。

### 2.18 剩余问题修复与自主验证（2026-09-23 UTC）

用户要求“全部修复，我最后只做验证”。当前已修复已复现的问题并完成下列验证；
**尚未放行**，不能以重点样本替代最终完整模型矩阵。未提交、部署、安装依赖或改变
Keychain/系统设置；没有操作真人麦克风、扬声器或屏幕。

**语音轮次与失败收尾。**

- Qwen 自动模式遇到未知 `item_id` 时建立独立 turn；映射保留至连接关闭，迟到的
  重复转写继续归属原轮次。已映射 item 的迟到/重复 speech-start 不再取消当前回答。
  缺少 VAD、迟到 VAD、重复 final 和响应关联均有回归。
- 原失败 `ea2fa3a5-77b7-4bc8-bdc4-cd89f44304fb` 的真实事件按原 ID/顺序送入
  Qwen adapter 和 `RealtimeSession`，回放
  `e3354cea-a842-4b6c-97f8-5dd611f06ae5` 保存了两个不同用户轮次，无内容冲突。
  被原记录器省略的音频/文字碎片没有重建；初始化和记忆回复为明确标注的回放输入。
  首次回放因测试 workspace ID 格式错误失败，保留
  `c78d203a-d1b2-4e46-af2b-0e97d0dcc8a1`。
- 真实 Qwen + PostgreSQL 插入触发器注入存储错误：
  `d9637cd6-fb68-48bf-bbda-f64b380d48bf` 三次均无提前成功、无写入，但客户端收到
  error 后停止迭代，暴露“yield error 之后才 close”导致轮次未终止的问题。
  现改为先完成关闭和失败标记，再返回错误。加入收到 error 立即停止读取的回归；
  `086f94a9-97fc-4cfa-9ca6-ac111261bc0b` 三次均为 **零成功音频、零助手回复、
  零记忆，且用户轮次 failed**。不是模拟供应商输出。

**记忆提议与历史检索。**

- 区分引用/假设与真实授权、事实与喜好/目标；具体活动、作品或记录的问题可表达
  隐式历史意图，缺少答案不等于普通知识问题。类别描述可匹配唯一删除目标，
  当前候选中的旧纠正措辞不被误认为待处理指令。
- 纠正正文直接保存模型引用的**完整用户纠正分句**，保留主题及替换值，沿用目标类型；
  不再采用可能丢失“周末”等限定的改写。分句外的普通陈述不一并写入。
  引用字节、当前目标/版本和隐私仍由 Core 校验，语义范围仍纳入真实模型复核。
- 中文单字不再从分词中丢弃；分词器复用。召回要求全部查询词匹配，避免仅凭
  “实验”等通用词返回无关事件；候选排序仍可使用部分匹配。查空时提示保留主题、
  去掉待求细节；不增加向量检索、同义词表或第二个模型裁判。
- 明确 `historical` 表示原用户事件，`occurredAt` 为记录时间；事件日期用关键词，
  不擅自按记录时间过滤。上下文提供当前 UTC 时间。历史意图只加强已授权轮次的
  查询提示，不为所有问题打开历史读取。
- 工具循环最多三轮检索，另留一轮禁用工具的最终回答，避免第三轮查到结果后
  直接抛错丢失答案。重复试验暴露的失败保留如下。

| 真实模型 run | 结果与后续处理 |
|---|---|
| `6022efa2-2829-4566-bf2e-3304b795b905` | 构建失败后误用旧 dist 的 42 次调用；不作修复证据，0.128528 元仍计入预算 |
| `f827fed8-b239-4d69-b883-bf7350ab51cc` | 重点提议 32/42；仍有纠正范围、删除澄清及隐式历史误判，继续修复 |
| `0a390556-f29c-4748-b96c-399863dbf350` | 历史命中 26/33，39/39 完成；查询和意图仍有失败 |
| `2296108a-6ec6-4591-bcd3-c62b6086a66f` | 历史命中 31/33，但仅 35/39 完成；2 次查空未简化、4 次工具循环未留最终回答 |
| `ddbb2a03-90b8-482c-89ea-9efe09fff904` | 周末纠正、两个删除目标、隐式历史问题，各三次，12/12 通过 |
| `a4e2f2fd-b2a9-4893-bc03-5a4bdc4c0f82` | 循环修复后，旅行/工坊两题各三次，来源及答案 6/6；无关炼钢题三次均无披露，9/9 完成 |
| `cb8eb9db-9ca2-4c2e-b733-d7cb3d40e84d` | 全部明确写入 40×3，语义/类型/来源 **120/120**；108 次真实调用，12 次受控敏感走本地原话路径 |

逐条复核及原始文件 hash：`10301486-fc28-4dfe-a098-3908826d1c89`。
核对的是原问题、实际提议、工具结果与答案；不是按措辞正则自动判语义通过。
三次明确写入分别 40/40。历史重点集合经过选择，31/33 和最终 6/6 均不能代替
完整 50×3 的召回率门槛；20×3 无关问题和治理/负例矩阵同样待最终复验。

**最终真实进程链路。** 三组均使用真实 Core 子进程、PostgreSQL、HTTP/WebSocket、
DeepSeek/Qwen 与合成音频，配置 `smart_turn + onDemandContext`：
`c1cbc888-41dc-4abb-8efd-d22d729fa174`、
`4c3651e2-d6fc-4bea-8793-211e55959fd9`、
`ce7beb0a-d763-4f78-aae1-2196cb67f11d`。
12 个语音轮次、6 个文字轮次、6 次真实重启均通过：提交后才播“已记住”，重启后
语音/文字使用紫色，纠正后语音使用橙色，删除重启后未返回颜色。隔离库和临时凭据
已清理。离线复核 `c86e0425-e977-42f2-bc56-57c66763c343`；
完整语音轮次 p50 6,709 ms、p95/max 10,460 ms，不等同首音频延迟。
不将这些样本称为强制复现了供应商分段，也不替代 Mac/Keychain/备份验收。

**本地与预检。** 最终 Biome `02b32548-b4d0-4363-ad06-cc9fc53d6b88`、
构建/类型检查 `8dfea353-8c72-481a-a508-bab045357abd`、
全仓 `8b5dcb1f-845d-4e2f-a8a4-b160311f08c0` 均通过：
**409/409、44 文件、零跳过**。前次 407 通过/1 跳过因漏设备份容器环境变量；
已补跑并在最终全仓包含该项。早期类型、固定消息下标及格式失败均保留，未覆盖。
Mac 源码未变，沿用原 104 项；Core recorder 预检
`4ec973e5-bf75-4dbc-97cf-1c1497ff5914` 已通过，付费调用 0，未启动 Mac。

本地真实存储评估 `b5f29886-295e-40bb-ba54-3ab809839460`：
180/180，当前 36/36、历史 50/50、无关 0/20，使用固定关键词与提议。
100 条记忆/1,000 事件时查询 p95 当前/历史为 5.27/18.81 ms；
1,000 条/10,000 事件为 22.17/143.03 ms，历史 max 193.92 ms。
四组均保留全部 50 次，无剔除冷启动，不能推论生产网络或任意长正文。

**费用与剩余门。** 文字模型累计上界 **4.915406 元 / 5 元**，含全部失败和旧 dist
误调用，剩余 0.084594 元；不是 Qwen/TOS 账单。Core 测试代理曾并发覆盖费用文件，
离线复核 `01be1ccd-71ee-40a1-ba01-ab1e748f27a5` 因此失败。33 次原始 send/usage
全部一一对应，`7827af51-5cf7-40ac-914a-98b19700deeb` 保留损坏原件/hash 并据
实际 usage 核对恢复账本，新增 Core 费用 0.052110 元；脚本改为串行写费用快照。

剩余自动验收已准备：最终代码的 50 历史 + 20 无关问题各三次，以及
10 纠正 + 20 删除 + 20 负例 + 20 普通聊天各三次。按实测估算约 2.1 元，
需先取得将累计文字测试上限由 5 元提高至 8 元的授权；当前上限仍为 5 元。
不重跑已经通过且未受后续修改影响的 120 次写入。自动验收完成后，用户只需最终
Mac 十步故事及键盘/VoiceOver 验证；2.16 已通过的独立 Keychain/TOS 恢复不重复。

### 2.19 十元授权后的完整矩阵与复验（2026-09-24 UTC）

用户明确将累计文字模型测试上限提高至 **10 元**，授权记录
`7fb055e7-307a-4cd7-ab20-87ea4d140eab`。沿用全部既有费用和失败，不按 run 重置。
本节取代 2.18 的“追加预算待授权、完整矩阵待执行”状态；**阶段仍未放行**，
最新 Qwen 验证与 Mac 最终故事尚未完成。

**完整矩阵及发现的失败。**

| run | 实际结果 |
|---|---|
| `12821a89-13b5-4970-8bcd-0ea67e7f8b92` | 首次完整历史/无关 70×3：210/210 完成，历史 148/150，三轮 50、49、49/50；无关 60 次零目标编造、零无关披露 |
| `41654022-cd21-406f-a8b3-0d3f3685d503` | 治理/普通/负例 70×3：纠正 29/30；删除预览目标 60/60；普通聊天零写入 60/60；负例零写入 60/60 |
| `6365af9f-659d-4911-8da7-20e7ba10ea1f` | 完整纠正复测 10×3：**30/30**，三轮均 10/10；目标、版本、类型、原话字节引用与限定范围正确 |
| `dba10210-2ff8-4591-845e-46ea036f7da2` | 第二次完整历史/无关 70×3：**210/210** 完成，历史 **146/150（97.3%）**，三轮 **48、49、49/50**；无关 60 次零目标编造、零无关披露 |
| `85aba045-c7c3-44f3-b7de-ffad5a2246d9` | 最后两处回答表述修复后 7×3：**21/21** 事实/来源合同通过；12 次历史均命中，9 次无关均未编造、未披露 |

第一轮完整复核 `83643224-792b-4493-be1a-950efd8e5496` 逐条保留了失败：
`correct-10/2` 的模型引用仍丢“周末”，`history-04/1` 把事件时间当作当天记录，
无关问题中两次猜测未保存/用户记错、两次中文问题回英文。修复单条纠正时，
Core 使用 `Intl.Segmenter` 将引用扩到包含它的完整用户原句，保留冒号前的主题，
排除前后独立普通句；多条写入继续各自引用。短/长引用、前后普通句均有回归。
回复提示明确保持用户语言、区分记录时间与事件时间，查空不猜测缺失原因。

第二轮来源未命中完整保留，不挑选最好的一轮：

- `history-15/1、/2`：查询使用“学做菜/菜谱/做菜”，未匹配原文“学做的一道菜”。
- `history-16/1`：查询仍带“活动”，未匹配“社区旧书交换会”。
- `history-27/3`：历史意图偶发判为 false，四次工具调用只查当前记忆。

这四次都诚实说明未找到。三轮各自超过 90% 门槛，仍有上述统计漏召回；
没有添加固定题目答案或同义词表。此处命中定义为本轮真实工具查询所返回的 Top-5
中出现目标来源；允许最多三轮检索，不表示首个查询单次命中率。

逐条读回答还发现 `history-38/2` 为“火山玻璃”补上原文没有的“黑曜石”，以及
`irrelevant-12/2` 从查空推断“没有保存”。最后只收紧回答指导：历史事实引用或
紧贴原文翻译，不用常识补细节；查空仅描述检索结果。定向 21 次实际回答复核通过；
其中 `history-01/2` 仍附加准确的 9 月 1 日记录时间，属于冗余表述，未混淆事件时间，
不声称风格遵循完美。全量 146/150 是这次文字提示微调**之前**的测量，
21/21 是之后的定向回归，不合并分母、不冒称又完整跑了一轮。

未受最后改动影响的明确写入沿用 2.18 的 120/120；删除、普通和负例沿用本节
第一轮结果。负例中 12 次秘密、12 次取消在供应商调用前拒绝；36 次外源请求均未写入，
其中 35 次 clarify、1 次 none，不声称每个负例都进行了澄清。

**复核、本地检查与费用。**

最终逐条语义判定、实际问题/回答、原始文件 SHA-256、调用用量与账本核对：
`d1d32207-ceb3-422d-a165-297d3ecd706d`。语义由 Agent 对照原文阅读，
结构及费用另作断言，不按措辞正则判通过。合成语料不能代表任意真实世界历史。
第二轮完整对话耗时 p50 **2,029 ms**、p95 **3,207 ms**、p99 **3,595 ms**、
max **5,002 ms**；包括提议、工具和最终回复，不是单次本地检索耗时。

- 纠正原句修复后的 Biome `88a09ffc-5ebe-4def-b2b1-1cff297b8182`、
  构建/类型检查 `26e19ed9-7ca4-489b-b7cd-0f651838d47e`、
  全仓 `47751583-7b1c-4fa9-8624-68181aa598ae` 通过：
  **410/410、44 文件、零跳过**，含真实 PostgreSQL 和备份容器。
- 最后回复提示微调后的 Core 构建 `290ace61-4827-4353-b564-a008d0259621`、
  Biome `d2d401ed-035f-46ed-9afa-9810b82ef563`、
  共享记忆上下文/Realtime 回归 `9962a7f7-8a6f-4569-9ab6-7c3347ae3a35`
  **10/10** 通过；未为两句提示重跑不变的整仓测试。
- 累计文字费用上界 **8.828360/10 元**，剩余 **1.171640 元**。修复账本
  2,212 次尝试逐项金额求和与余额一致，没有未结算预留；本次最后三批的
  30、705、67 次供应商调用均与实际 usage 对齐，分别
  **0.124440、1.495752、0.143934 元**。全部先前失败/误调用仍计入。
  按既定峰值输入/输出每百万 2/8 元计算；这不是 Qwen/TOS 的供应商账单。

**环境阻塞及续跑入口。**

最终实机入口预检 `aea9fc0b-2011-45d9-a2ef-513e7a93a74d` 在读取 Qwen 凭据时失败，
`SSH exit 255`；尚未启动数据库/Core/Mac，付费调用 0，临时目录已清理。
独立连接诊断为 `Permission denied (gssapi-keyex,gssapi-with-mic)`。
`klist -s` 返回 1；票据已在本机 09-24 07:13 过期且没有 renewable 标志；
自动 `kinit -R` 返回 `Matching credential not found`。这些为失败后的实际诊断观察，
在最终复核中明确标记来源，未伪造为预检原始事件。

需用户在普通终端重新完成 `kinit` 登录（不发送口令给 Agent），恢复后由 Agent
串行运行 `.local-acceptance/phase2-core-restart-memory.mjs` 的三组真实 Qwen
进程重启故事，再用 `.local-acceptance/phase2-review-restart-memory.mjs <三个 run ID>`
复核；随后运行 `.local-acceptance/phase2-mac-story.mjs --preflight`。全部 Node
入口继续使用 `fnm exec --using=.node-version --`。既有预算足以继续，无需追加授权。
2.18 前一版三组真实重启已通过，但不替代最新共享回复提示的 Qwen 证据。
登录恢复前不要求用户启动 Mac 故事；恢复并通过预检后，用户仅做最终窗口、
键盘/VoiceOver 及十步故事。真实 Keychain/TOS 独立恢复不重复。

### 2.20 登录恢复后的语音收尾（2026-09-24 UTC）

用户已在普通终端恢复 `kinit`，Agent 验证 SSH 可读后继续既有预算。本节取代
2.19 的登录阻塞状态。没有修改产品代码、供应商超时或系统网络配置。

**本次五次尝试的全部结果：**

| run | 结果 |
|---|---|
| `5238ecf9-bb7e-46d0-a3e5-f7e56e8ba2cd` | 记住成功；重启后的 Qwen 初始化超时，尚未发送该轮音频 |
| `6065879c-4938-4442-b031-13d28e792d2f` | 完整故事通过 |
| `f899d4ef-3357-43ac-b6a5-8591c74a6549` | 完整故事通过 |
| `4a350ce6-4178-4d91-ae7c-2fad3335537a` | 第一次独立补跑：记住、重启后语音/文字召回及纠正通过；纠正后的 Qwen 初始化超时，尚未发送该轮音频 |
| `4735eb80-c217-440a-bb3e-6ec852a2033d` | 第二次独立补跑：完整故事通过 |

三组完整故事共 **12 个语音轮次、6 个文字轮次、6 次真实 Core 进程重启**：
成功落库后才播放确认，重启后语音/文字使用紫色，纠正后语音仅使用橙色，
删除再重启后调用召回且不返回已删除颜色。逐条回答已阅读，原始上下文角色、
版本状态、提交与首音频顺序及删除后空库均复核。使用真实 PostgreSQL、Core、
DeepSeek/Qwen 和 Tingting 合成音频；没有真人麦克风、扬声器或屏幕采集。
三组完整故事的完整语音轮次 p50 **7,590 ms**、p95/max **9,402 ms**；
不等同首音频延迟，也不包含失败初始化等待。

两次失败均在生产既有 10 秒初始化上限内触发 `realtime.failed`，Core 关闭连接，
没有释放该轮音频或成功回复。第一版测试脚本未监听 WebSocket close，额外等待到
55 秒；仅在本地验收脚本补上 close 监听后，第二次失败约 10 秒即准确记录
`1011 REALTIME_SESSION_FAILED`。两次失败的实际等待分别 **55,045 ms、10,060 ms**，
不从总体记录中删去。不能将“获得三组完整通过”表述为首次三组全通过。

连接诊断 `e0943511-1bdb-4e37-ad0b-97482270eda3` 连续六次到 `session.created`
均成功，耗时 **96–254 ms**，保留 DNS/TCP/TLS/HTTP 升级阶段信息；未发 session
update、音频或回复请求。该探针未复现失败，**不能证明此前网络/供应商故障的精确根因**。
偶发 Qwen 初始化超时仍是连接稳定性限制，不以调整超时或反复择优掩盖。

独立离线复核 `0ce4f8e1-2766-46a3-9df7-3dbcc856d84e` 保留上述五次尝试、
失败与成功的分布、实际回答、原始 trace hash 和费用；所有隔离库与临时私有目录
均已清理。通过的三组覆盖最后共享回复提示，未将 2.18 的旧版本证据移用。

**入口与费用。** 最新 Core 入口预检
`0c079949-3636-4239-aff9-69041f7d7821` 已通过，记录器 ready、两个隔离库清理通过，
付费调用 0，未启动 Mac。真实 Mac 记录器由用户每次启动现场验证。
本次新增文字调用 **42 次、0.067252 元**，含两次未完成故事的
**0.002844、0.012094 元**。累计文字费用上界 **8.895612/10 元**，
剩余 **1.104388 元**；修复账本 **2,254 次**，没有未结算预留。
Qwen/TOS 账单不包含在该文字用量估算内。

自动测试收集与复核已收尾，下一步是用户最终 Mac 十步故事及键盘/VoiceOver。
连接超时原始记录继续保留；实机中若遇到同类连接失败，记录原现象即可，无需重做
已经完成的全部步骤。Phase 2 未正式放行，未提交、推送或部署。

### 2.21 真人故事复核与语音纠正收尾修复（2026-09-24 UTC）

用户反馈“测试完毕”。真人 run `126864a2-e45b-4a13-a2eb-42e45d949a31`
的两次 Mac/Core recorder ready、两组实际进程 PID 和相同 instanceId 均有记录。
独立复核 `b2bdb7dc-cc07-4fd6-81bf-33074d93d5aa` 保留问题、回答、
关联 ID、原始文件 hash、恢复结果和观察缺口。

| 真人实际轮次 | Core/Mac 一致的结果 |
| --- | --- |
| `57654d49-1c53-403e-a5f4-d388d7980bab` | 语音记住紫色；v1 提交早于确认音频 |
| `067be201-2751-40ec-ab1b-57bf677e83fd` | Mac/Core 真重启后，语音推荐紫色 |
| `f95179af-8b5a-4928-af49-85f0c34aa657` | 语音纠正为橙色；v2 提交成功，但确认后的连接收尾触发 Mac 故障路径 |
| `c39a8b1c-9bbb-481e-8c18-73e3a3b27688` | 再次唤醒后推荐橙色，没有使用紫色 |

**发现与修复。** 纠正于 06:21:02.874 提交，Mac 首音频为 06:21:04.096，
收到 80,640 字节、约 1.68 秒 PCM；06:21:04.960 报 `Socket is not connected`，
06:21:05.008 结束会话并停止播放。Core 在最终回复后关闭旧会话，WebSocket 输出泵
却统一发 1011；Mac 因而走故障收尾，确认语音存在被截断的问题。
现在使用 `session.end_requested.reason = memory_changed` 明确正常收尾，
完整回复后关闭供应商会话并以 1000 关闭客户端连接；丢弃收尾时仍在途的麦克风帧。
Mac 收到后停止采音，等待已排队音频播完再结束。发送失败与最终事件竞争时，
以接收端的终止事件或错误判定，意外断连仍报错。取消等待任务不会再继续清理旧会话。
已更新 schema、生成协议和 Mac 解码器。

**验证与产物。**

- 定向 Core/协议 63/63：`149b966c-0555-4080-b360-cc83dd47cdfb`；
  Presence 46/46：`499ed5b0-273b-4279-8768-8e8f9af58b2b`。
- 真实 URLSession WebSocket 正常结束/意外断连各 3 次通过：
  `21aa1a62-edc7-4a1e-8ab5-3fcd0ad10a39`。首次测试辅助进程挂起的
  `a1094bfa-d426-4fe3-9d8e-22d721c3898d` 已终止并保留；辅助测试改为串行、
  关闭父进程管道写端后通过，不把该次挂起计作成功。
- 全仓 Biome、构建/类型检查通过：`d426ecf1-ebcc-4d7a-b533-0da9116e7248`、
  `f3dfe2d3-3f54-48f1-a64b-53b98ebb8905`；含真实 PostgreSQL/备份容器的
  **411/411、44 文件、零跳过**：`9bafefe3-2e9c-4517-aecf-f2c8154cf6c7`。
- Mac **107/107、10 suites**：`6a427cb2-75e3-41d4-bd96-588d2acfda99`。
  随后补齐正常停止采音的验收事件，定向播放/采音记录回归通过：
  `f8f3e38a-186a-4bd0-9820-2f9730ea0249`。
- 本地 App 重建、签名与严格验签通过：`cd7ed456-3e59-4eef-803f-ec361902975d`；
  产物仍为 `apps/macos/.build/app/Violet.app`。未部署或替用户重启普通 App。

真实 Qwen 专项使用独立 Core/PostgreSQL、真实文字模型和 Tingting 合成语音；
每组为文字建初始记忆 → **语音纠正** → 新语音会话召回，无真人采音。

| run | 结果 |
| --- | --- |
| `c63ae34c-766c-469e-80cf-e07e0f9f2443` | 提交早于首音频；完整确认后 `1000 MEMORY_CHANGED`；新版橙色 |
| `7125cc9c-69ac-4f56-8fc0-1c63988fad7e` | 同上 |
| `88c7fca7-18b7-479f-af52-d89cd3f1e176` | 同上 |

三次均交付 84,480 字节确认音频；从连接开始到纠正结束分别为
9.03、9.43、9.22 秒。独立语义与费用复核
`82cac70a-583a-47d9-b3d5-be64657d5b9a` 通过。这里证明服务端真实行为，
Mac 播放排空由上述 Swift 回归验证；不冒充修复后的真人听感验收，
也不据此宣称 2.20 的两次初始化超时已经消失。

**删除、备份和清理。** 真人记录有列表、详情、两次删除预览（首次未确认）及最后
确认 200。官方入口拒绝旧备份；新备份 hash 与 `clean.dump` 一致，
恢复纪元为 1，记忆、来源、摘要、checkpoint 均为 0，两个已删除来源轮次
不存在于恢复的 conversation_events。两个临时库已清理。
Keychain helper 清理曾报 `-25244`，系统 `security delete-generic-password`
按服务名和本次合成 instanceId 精确删除成功，证据
`170d4073-8b6d-4aee-b65f-1d693301e433`；验收脚本已改用该清理方式。
不修改产品 Keychain 权限。此轮备份为本地官方恢复，不重复冒称 TOS 验收。

两次 Mac 收集 Core trace 被取消，服务器两份原始 trace 仍完整保留；
合并快照 1,619 行，比原始 1,620 行仅少最后一次 trace GET 的完成事件。
自动报告列出的三个无问题/答案 ID 是麦克风传输流 ID，实际四个最终转写轮次
均有匹配回答，不能据此判成三次漏答。离线复核工具的 pg_restore 参数、
音频字节字段和并发费用顺序问题均保留原尝试，由上述最新复核取代。

**费用与剩余门禁。** 真人 8 次文字调用为 **0.012036 元**；
三次语音纠正专项的 15 次文字调用为 **0.025156 元**，按关联 attempt 对账。
累计 **8.932804/10 元**，剩余 **1.067196 元**，账本 **2,277 次**。
Qwen/TOS 账单不包含在文字用量估算中。全部临时私有目录已清理。

本次真人采用语音完成重启召回及纠正，没有文字请求，也没有删除后的新问题；
跨模态和删除后问答沿用 2.20 的自动证据，不标作本轮人工通过。
窗口来源可读性、键盘/VoiceOver、编辑及取消确认的人工观察尚未记录。
该时点待补收的来源显示、键盘/VoiceOver 与取消删除观察已由 2.22 补充，
不要求重跑整个故事。Phase 2 仍未正式放行。

### 2.22 用户补充确认窗口操作正常（2026-09-25）

针对“来源显示、键盘/VoiceOver、取消删除的操作体验是否正常”的补充询问，
用户回复 **“均正常”**，上述三项人工观察记为通过。
独立补充记录 `5ba50481-efc7-4d03-a2dd-ecbd6b0807b2` 保留问题、用户原话，
并关联真人 run `126864a2-e45b-4a13-a2eb-42e45d949a31`。

这是对已执行测试的事后反馈，本次未启动 App、未新增模型调用或费用。
2.21 中本轮真人文字路径、删除后新问题及修复后听感的证据边界保持不变；
已有自动回归继续有效。该反馈不表示批准提交、合并或部署，Phase 2 尚未正式放行。

### 2.23 三项短验收准备（2026-09-25）

用户批准开始准备剩余三项验收。复用 `.local-acceptance/phase2-mac-story.mjs --short`，
只创建一个隔离库，覆盖重启后文字召回、文字纠正后语音使用新版、
语音纠正确认完整性及删除后的新问题；窗口可访问性和备份恢复不重复。
具体步骤见[三项短验收](./testing/phase2-real-acceptance.md#三项短验收)。

产物检查 `1bffc67b-093f-449b-8324-e137e857d57d` 确认 Mac 二进制、
Core realtime-session 和 WebSocket 构建文件与 2.21 已验证 hash 一致。
PostgreSQL 运行正常；后续检查
`040d1952-6e8e-42db-87c7-bd9465296230` 确认本地端口可用、没有运行中的 Violet、
文字凭据存在。SSH 认证失败，`kinit -R` 返回缺少匹配票据；
需要用户在普通终端执行 `kinit` 后启动入口。

短验收复用既有本地代理预算方式，本轮文字上限 0.20 元，继续遵守原累计 10 元上限；
先预留、按 provider usage 结算，未返回 usage 的失败保留预留额。
`1a40b467-3229-4b23-a9ee-ea51b3001046` 用原代理代码块和本地 HTTP 完成
三次并发乱序结算、累计限额拒绝、缺失 usage 五种检查；使用合成上游响应，
不声称供应商或 Mac 已就绪。本次准备无付费调用，累计仍为 8.932804 元。

准备时 **Mac/Core 记录器尚未启动**，随后实际启动与验收结果见 2.24。普通终端启动脚本后必须现场确认两端 recorder
ready 才开始测试；使用普通终端是因为先前 Agent 沙箱已证实会拦截真实 Keychain 写入。
没有重新申请权限、修改系统配置或更换产品实现。

### 2.24 三项短验收通过，记录与真人体感一致（2026-09-25）

用户反馈“全部测试完成，体感上测试通过，你可以再看看记录是否符合体感”。
完整真人 run 为 `6748fad5-14dc-4f97-b04e-f3bb6d98947d`，
独立离线复核 `bfdabc1e-4456-415d-8785-47c49d36a76c` 通过。
本节仅复核真实记录，没有新增模型调用、重新采音或修改产品代码。

**完整性与问答。** 两次 Mac/Core recorder ready 均早于对应输入；
`restart` 后 Mac/Core PID 均变化，instanceId 保持
`5e246ffd-9c7a-498f-b110-12935006a081`。原始 Core 955 条、Mac 478 条，
各 recordingId 序号连续；67 条 Core → Mac 事件、280 条 Mac → Core 事件
逐条按 eventId 匹配。六个实际轮次为三次文字、三次语音，最终回答在两端完全一致。

| 实际轮次 ID | 操作 | 真实结果 |
| --- | --- | --- |
| `1e685133-b96b-4705-9a3e-dbdac6266bcd` | 语音记住紫色书签 | v1 提交后回答“已记住。” |
| `faff9f31-3dc9-4745-ae26-6ef3f99115d5` | 真重启后文字查询颜色 | “你偏好紫色的书签，所以推荐紫色。” |
| `2718a974-27d8-45bb-96af-3d7cbaf35e8e` | 文字纠正为橙色 | v2 提交后回答“已纠正这条记忆。” |
| `9c951968-65af-4195-b277-d08d3ed756db` | 新语音会话查询颜色 | “根据你当前的偏好，推荐橙色的书签。” |
| `c2294fb8-ebd8-40b8-bc73-ec513cad9af7` | 语音纠正为绿色 | v3 提交后完整确认，按 `memory_changed` 正常收尾 |
| `cdbb64ab-a35a-4978-a65e-b8a024ba5186` | 窗口确认删除后文字查询 | 未找到具体颜色偏好，不再回答紫色、橙色或绿色 |

三次记忆提交均早于相应首个可见确认。语音纠正于 01:39:36.426 提交，
Mac 首音频为 01:39:37.164，收到 84,480 字节，即 **1.760 秒** PCM。
01:39:37.295 收到 response.completed，随后收到 memory_changed；
01:39:37.303 停止采音，01:39:38.938 正常结束会话。
首音频至结束 **1.774 秒**，完成事件后仍等待 **1.643 秒**，没有再走 session.failed、
发送失败或故障停止播放路径。该时间线与用户完整播放的体感一致；未保存原始音频。

**删除后的实际含义。** 删除确认在 01:39:51.816 返回 200，
之后新问题的当前记忆 candidates 为空。历史检索先返回 0 条，缩短查询后返回 2 条；
两条均是“推荐书签颜色”的旧问题，没有颜色值，也不属于被删除的三个偏好来源。
因此不能把 `memory.recall.count = 2` 误判成删除偏好复活。最终回答为：

> 我在记忆里只找到你两次问“推荐书签颜色”的记录，没有找到你具体说明喜欢哪种书签颜色的内容——所以不好说记得你喜欢什么颜色。你能再告诉我一次吗？

**错误与中断记录。** 完整 run 没有功能错误。一次 Core trace 收集因取消失败，
服务器原始记录连续完整；合并快照 954 条仅少最后一条 trace GET 完成事件。
自动报告中两个 MISSING ID
`a4c8cf5e-245e-4999-abdc-2aa158954587`、
`e45ac5ee-96a4-4c79-b08d-28651682d774` 是音频上传流 ID，
不是最终用户轮次；实际六轮均有问题和完成回答，复核文件保留具体行号与 hash。

此前 `046103ab-9523-4c92-b987-9a9cb570704b`、
`7cbaa0f0-5bac-43b9-b69c-1018e77f9374` 在启动后被中断，
没有问答、音频上传或模型调用；Core 收集失败和 Keychain 不存在的退出码 44
均留在原记录中，不计为通过的故事，也没有归因成供应商失败。

**清理与费用。** 三次启动的隔离库均已删除，复核时直接查询 PostgreSQL 确认不存在；
完整 run 的测试 Keychain 删除成功，临时私有目录已清理。
本轮 13 次文字模型调用按 attempt ID 与 provider usage 全部对账，
费用 **0.025300 元**；累计 **8.958104/10 元**，剩余 **1.041896 元**，
账本 **2,290 次**，本轮没有未结算预留。Qwen 账单不包含在文字费用估算内。

**结论。** 记录支持用户“体感通过”的判断，2.21—2.23 保留的三项真人缺口已补齐。
结合 2.16、2.21 的恢复和治理证据，以及 2.22 的窗口观察，Phase 2 转入交付收尾。
无需继续重复实机故事；2.20 的两次供应商初始化超时仍作为历史稳定性限制保留。
正式提交、合并、部署与 Release 1D 全阶段发布门禁仍单独处理。

### 2.25 Phase 2 本地交付收尾完成（2026-09-25）

用户要求“Phase 2 交付收尾”，中断后又明确“继续”。真人故事不重跑，既有模型预算
保持 8.958104/10 元。对 HEAD 加全部未跟踪 Phase 2 源码按六组自检，并交叉核对
存储、模型、Realtime、Mac、备份和协议的调用契约；审查记录
`b718e933-43d2-43f8-b62d-26a6b855bc73`。

15 条初始发现合并为 **13 个独立问题**，均已实现修复；它们是对正常故事之外的
边界补查，不否定 2.24 已实际通过的六轮记录。

| 边界 | 最终行为 |
| --- | --- |
| 记忆与文字（4 项） | 敏感回忆问句不写入，明确保存的否定、不确定性及多句原话仍保留；取消信号贯穿事务；旧版本回答由数据库锁内检查拒绝；幂等回放恢复删除预览 ID，过期时明确要求重新预览 |
| Realtime（3 项，另覆盖共享落账边界） | 纠正确认完成、取消或失败均收尾；新轮不进入失效上下文；转写计时器随轮次清理；配置期间关闭也释放迟到建立的连接；Pipeline 和 Integrated 都把实际生成版本传到落账边界 |
| Mac（3 项） | 删除预览逐版本判断剩余来源；关窗后丢弃迟到预览；删除成功清空聊天展示缓存并阻止旧任务填回，不改服务器中无关历史 |
| HTTP（2 项） | 全部错误包含协议要求的 requestId，真实 409 可解除过期待确认状态；解析错误保持 400/413/415、不可重试且不回显正文 |
| 备份（1 项） | 官方恢复与 Mac 最低纪元写入持有同一个按实例的系统文件锁，恢复过程中不能并发提高最低纪元 |

数据库以 COMMIT 派发为取消边界：派发前取消回滚，派发后已经提交的明确写入不倒转。
普通语音记住/补来源后继续对话，只用该次提交的前后版本推进允许版本；
纠正仍等待固定确认播放排空后关闭旧连接。没有通过读取全局最新版本给旧回答重新标记。

**最终自动化证据。**

| 检查 | run | 结果 |
| --- | --- | --- |
| 生成客户端及幂等校验 | `9012b127-54ef-4ff5-8264-4a13eea243d2`、`9be1e5ae-29c7-48a7-b1ed-1d1bcb5b9fde` | 退出 0，TypeScript/Swift OpenAPI 输入生成前后 hash 一致 |
| 全仓 Biome | `830b5eac-9717-42ac-b4be-d11d236d86a9` | 165 文件通过，无自动修改 |
| 全仓构建与类型检查 | `10eec0a2-59f9-4943-b51a-70e903cb2555` | 全部通过 |
| 全仓 TS/脚本，含真实 PostgreSQL、快照恢复及锁 | `a78bb1fe-9d57-45e9-ae97-8091eec61e9f` | **550/550，49 文件，零跳过** |
| Mac 全量 | `f5b92682-ed67-44a8-8ace-5815550e12de` | **116 测试函数、11 suites 通过**，显式 `--no-parallel` |
| Mac 构建、签名与严格验签 | `f5ccaae4-d652-4037-8c3a-b266a0c58c6d` | 通过，产物 `apps/macos/.build/app/Violet.app` |
| Shell 语法与 Compose operations 配置 | `828c4f01-dc79-4fad-97de-0539c6a2e5c8`、`48bc03b5-3318-42d5-b940-0afdab252f94` | 通过 |

全仓 Biome `dea130e3-fa10-4f91-9906-19c4ca8a0bab` 只发现新增 HTTP 夹具的格式问题，
定向修正/检查 `a2687f7c-ad37-4c0b-a1cb-7549713c1bd1` 通过。先前局部类型检查因共享包
尚未重建而失败，已由最终全仓 build/typecheck 覆盖，不删除旧失败记录。

两次独立复核保留了敏感问句后接逗号、分号子句的残留问题。最终采用统一 Unicode
非字母/数字边界识别问句子句，补充全半角分号、破折号及符号负例，同时保留明确授权
的不确定、否定健康事实和多句原文。定向 `1c9190b2-5415-45c3-9f91-38922d25103f`
**73/73**（含真实 PostgreSQL）通过，随后执行了上表最终 550 项回归。
此前 544 项通过记录保留，不冒充已执行这些新增负例。`fixes_cross_review.json`、
`final_realtime_review.json` 保留修复前复核结论，最终处置在 `final_resolution.md`。

真实数据库在等连接、等行锁及 INSERT 内暂停的取消路径均保留三次；无失效通知时的
旧 revision 拒绝、纠正先提交后旧答案获锁、COMMIT 派发后的取消均分别验证。
最终语音版本/生命周期聚焦 135/135，时序专项三次各 23/23；各 run 见审查目录的
`repair_memory.md`、`repair_realtime.md`。这是可控时序证据，不冒称本轮新增真实 Qwen 调用。

**失败与证据边界。** 新增 Swift HTTP 夹具的同步等待曾阻塞 MainActor，已移至后台。
另一个既有取消测试靠 55/100 ms 休眠安排先后，已改为显式事件和 continuation，
三次定向验证通过。全量默认并行尝试分别有 37 项问题、1 项问题，以及 18 项问题伴随
传输测试挂起；三个失败 run 为 `11f739a3-3cc0-4040-8166-690bd252c337`、
`0e168bb8-3a9e-4485-aef1-1fc40ceac26b`、`24ca799d-0f30-4ffa-a4b1-925b1759b6ae`。
最后一个 helper 被有界终止，无法取得堆栈，精确挂起原因未确认。标准 Mac 测试入口
现显式采用已通过的 `--no-parallel`，避免独立 UI 夹具争用 MainActor；
竞态用例内部仍执行受控交错和重复试验，不把并行失败改记为成功，也未改产品超时。

恢复锁另经 Node 三次交错及 Swift→lockf 三次互斥验证，独立复核
`restore_fix_review.json` 未发现残留问题。Keychain 辅助程序按实际源码重新编译
（`30195a3d-696d-4bd4-81d9-dfb5d7ff9d86`），没有再次操作真实 Keychain 或 TOS。
历史模型质量、真实恢复及真人体验继续引用 2.16、2.19—2.24；本轮没有付费调用。
2.20 的两次 Qwen 初始化超时和 2.19 的四次历史未命中仍是已知限制。

交付核对 `490391eb-76b4-4514-b406-a3e169bba2c0` 通过：汇总各检查的实际退出码、
源码与构建产物 hash、文档链接、未变化的 2,290 次文字调用及累计费用。
当前仍为 `main@7ea983a` 上的未提交工作树；Mac 二进制 SHA-256 为
`2accc186f2e3cc65db69430f2f687f737a428fa3a3d991fd515275f2bdbd4b7f`。
完整文件指纹在该 run 的 `result.json`；这不是生产版本 hash。

**迁移与回滚交接。** 待明确授权后，按以下顺序执行，不从未提交工作树部署：

1. 提交并同步同一确定版本到两条主线；提交后的 CI 再检查生成文件相对 HEAD 无 diff。
   本轮只证明生成幂等和本地检查通过，没有将当前未提交状态的 `check:ci` 宣称为通过。
2. 在维护窗口停止旧 Core 写入及旧备份调度，保留当前可恢复备份；使用该版本的
   `migrate` 服务向前应用 `0003_explicit_memory.sql`（包含已部署的 `0002b/0002c`）。
3. Core、Mac、备份/官方恢复入口与 `install-backup-cron.sh` 一起更新；后者包含每日
   备份和每分钟清理任务。确认 Mac 对实际 instanceId 的最低纪元可持久化后，才开放删除。
4. 记录确定 commit、镜像/二进制 hash、健康状态、迁移和调度结果；验证干净备份后才
   清理受管旧副本。生产验证按实际环境单独留证，本地/TOS 隔离测试不能冒充生产部署。
5. 能力回滚使用 `VIOLET_MEMORY_INJECTION_ENABLED=false`，治理、删除和旧来源排除
   保持可用。保留迁移及所有单调纪元，不降纪元、不恢复删除前数据库、不退回不理解
   `0003` 或恢复纪元的旧程序。自动记忆及开关仍留在 Phase 3。

**交付结论：Phase 2 本地交付收尾完成，独立合并门具备证据，当前没有已确认但未修复的
P0—P2 自检问题。** 最终处置保留全部初始发现、复核反例和失败尝试；不把模型置信度
或单纯提示检查当作放行依据。代码、签名 App、迁移/回滚交接均可审阅，
无需用户重复真人故事。尚未提交、合并或部署；Phase 3 及全 Release 发布门禁继续独立保留。

### 2.26 Phase 2 提交、云端部署与 Mac 激活交接（2026-09-27）

用户明确要求“执行版本提交与部署”。发布前核对 **231 个源码文件**与 2.25 的
验收指纹完全一致，Mac 二进制 hash 不变；run
`6d2057d4-bca7-40ea-9f23-edafa2d2f7e9`。本轮没有重复真人故事或付费模型调用，
累计文字费用仍为 8.958104/10 元。

**提交与门禁。** 实现提交 `b3fa62c7bab9e3112f725e5882d076f759381ece`：

- Codebase [!33](https://code.byted.org/user/violet/merge_requests/33) 合入
  `a98036299850698edc71cb0b1ea73681329128e8`。
- GitHub [#16](https://github.com/Defector-12/violet/pull/16) 合入
  `e18e602ea23077bcb7c9c42ebb3464826ba91704`。
- 两条主线与实现提交 tree 均为 `8ba93fccaf319c4aea4deb9b8813d080ef1bbd83`，
  三方无内容差异，run `d9af3f31-cd12-49d9-8a93-1d02040e1cee`。
- 提交后重新生成 TypeScript/Swift 输入且相对 HEAD 无差异，run
  `36d3fdcc-2f1a-42cd-a364-853d692a848b`；确定提交构建全部通过，run
  `838e2aed-abe1-4f5c-9575-8ac37166d249`。550 项 TS/脚本和 116 项 Mac
  回归继续引用源码一致的 2.25，不冒称本轮重跑全量。
- Codebase 自动门禁放行；Pipeline Overview 明确没有流水线配置，Aime 为 `neutral`；
  GitHub 没有配置状态检查。默认 review 规则按既有个人仓库流程记录
  `no_need_for_review`，run `cd8e300f-3c6f-40e6-9bda-86c87ca0c91d`。
  合并队列接口返回 AccessDenied（`c992ff1a-0730-4a5b-bd89-b5007f0faa12`），
  MR 状态确认无需队列且全部门禁可合并后，普通 merge 接口成功，run
  `ccee95e5-8d68-4ac6-9510-1398216171c9`。没有修改保护规则。

**实际部署。** 运行版本为 **`b3fa62c-release-1d-phase2`**，目录
`/data00/home/baojunhan/violet-release-b3fa62c-release-1d-phase2`。

| 产物 | SHA-256 |
| --- | --- |
| 发布归档，含已提交源码及 467 个运行时产物指纹 | `8802d594f8aef3b9a0416c2adeb783d18eff328631e487786277b8f8dff9da80` |
| 运行中 Core 镜像 | `82409333e0bd71c4cdb88029a058f3a3edc63c80ad946a67966dc96e5e91d098` |
| 最终 backup / backup-upload 镜像 | `534b98904a1b6438f46fd987b2aaaae836e2eaa98f06cd4d13640e1f0cca91c0` |
| Mac 主二进制 | `2accc186f2e3cc65db69430f2f687f737a428fa3a3d991fd515275f2bdbd4b7f` |

先暂停旧调度和 Core，生成迁移前 schema 1 加密备份
`20260927T032704Z-75c1a5b6-b0e3-494b-8e4f-4e5cd06b48fb.vltbk`，
密文 hash `66a735453a18d01c5456f7e13052ef77563300f2ee814b1dd1f4da8c44bd27bf`。
随后向前应用 `0003_explicit_memory.sql`，更新 Core 及迁移镜像标签。
迁移前后 `conversation_events` 都为 **1,113 条**；未写入合成生产记忆或执行生产删除。

首次候选构建被原 `.dockerignore` 的 dist 排除规则阻止，run
`7266cad7-cfa1-4c6f-90d7-b9288c659359`；仅在发布构建目录放行已核验 dist 后，
Core/backup 模块加载通过，run `7960e478-0a07-428f-a578-1dcf4303311b`。
迁移及 Core 启动成功后，备份因本地产物权限只允许 node 用户读取而失败：
实际备份容器以宿主机 UID 执行，run `f841dcd5-4cc3-4e54-bd68-77e559de0619`。
保留新版 Core，未回退数据库；修正备份镜像中程序文件的读取/目录遍历权限，
以实际部署 UID 验证加载后，备份和调度交接成功，run
`21591e3c-9221-49ec-abd7-af64df97ed7d`。两次发布失败均保留。

新版 schema 2 备份为
`20260927T032842Z-beae0bc2-63c6-4ea4-9fef-343449ecab1e.vltbk`，
密文 hash `255774da547e54a97054d26383064141908a5a76bf0e10504592475aaa8826d4`；
绑定实际实例 `2938b3dd-6781-49cd-8b93-ab9e74f22ac2`、`restoreEpoch = 0`，
已上传 TOS 并通过 metadata、重新下载的完整密文 hash 校验。
48 份旧 `/data00/home/baojunhan/violet-data/backups` 受管备份移入当前
`/data00/violet/backups`，旧目录剩余 `.vltbk` 为 0。旧副本未因本次迁移被删除；
后续真实删除的清理由同一目录和 TOS 受管前缀执行。

cron 已指向本次发布目录与实际 `/data00/violet` 数据目录：每日 03:17 备份、
每分钟 `--cleanup-only`。清理入口执行成功，当前无待清理删除记录，cron 日志为
0 字节；不将本次空队列检查宣称为生产删除清理实测。

**部署后验证。** `506f1924-f173-4354-9e41-2b586d155749` 对比运行中 Core、
domain/policy/crypto/protocol、Schema、迁移及 backup 两个目录，全部与本地产物
hash 相同。使用 Mac Keychain 设备凭据经 SSH 隧道只读访问，健康 `ok`、认证状态
`ready`，记忆接口返回实际实例、revision/restoreEpoch 均为 0、记忆数为 0。
`c2fbbbf7-8d1b-48db-8eca-043349a2b5d8` 确认 Core `healthy`、零重启，
checkpoint 与记忆注入开启、模型 `deepseek-flash`、1,113 条事件及两条正确调度。

**当时的本机交接（现已在 2.27 完成）。** App 已严格验签，run
`41d0a991-c7c1-4ca3-962e-d4aaff9adb5e`，但本轮尚未启动。实际生产实例的
Keychain 最低恢复纪元尚无记录（`9f991098-7360-4a63-8188-f3ecce7271a0`）；
初始化被 Agent 沙箱拒绝创建
`~/Library/Application Support/Violet/restore-locks`，失败 run
`719c894d-0763-445c-bdbe-58d67868d90a`。未绕过该限制，也未发出删除请求。

普通终端执行仓库内 `.local-acceptance/phase2-finish-mac.mjs` 可完成剩余步骤：
校验 App/helper hash、读取当前生产纪元、写入并回读 Keychain、经官方入口解密上述
生产备份、恢复到唯一命名的本地隔离库并核对 1,113 条事件与 `0003`、清除临时库
和明文 dump、启动签名 App。每次执行建立独立 test-run；脚本语法检查通过
（`a60875b8-a1fb-4439-969d-5067285afff7`），**其实际执行尚未完成**。
未完成前不能宣称本轮生产备份的官方恢复或 Mac 激活已通过。

回滚继续遵守 2.25：保留 `0003` 及所有单调纪元，需要时仅关闭记忆注入；
不得退回不理解恢复纪元的 Phase 1 程序。Phase 3 未开始。

### 2.27 Mac 激活及生产备份官方恢复完成（2026-09-27）

用户在普通终端两次执行 `.local-acceptance/phase2-finish-mac.mjs`，run
`a57b2ad6-e805-47ef-88f1-819d74433d5b` 与
`ed48d01a-0d47-46ff-a85d-058af347600c` **均为 passed，全部 13 条命令退出 0**。
首次执行从缺失记录初始化 Keychain，第二次读取并保存相同的单调纪元：
实际实例 `2938b3dd-6781-49cd-8b93-ab9e74f22ac2`、`minimumRestoreEpoch = 0`，
写入后的回读均一致。

两次均通过签名及 App/helper hash 检查，经官方 `restore-backup.sh` 解密 2.26 的
schema 2 生产备份，密文和明文 hash 均匹配。恢复到各自唯一命名的本地隔离库后，
均为 **1,113 条事件、0 条记忆、restoreEpoch 0、0003 已应用且实例匹配**；
随后 `dropdb` 退出 0，明文 dump 已移除，没有覆盖生产数据库。

签名 Mac App 已启动，实际进程路径指向仓库内 `Violet.app/Contents/MacOS/Violet`。
脚本内的两个独立云端验证 run
`1343ce2b-66b7-41bb-8f55-f9dbbf4a15dc`、
`2c867c5c-eef8-490b-bb86-b6fb9537450e` 均通过：运行产物 hash 一致，健康 `ok`、
认证状态 `ready`，版本 `b3fa62c-release-1d-phase2`，实际实例及记忆接口状态正确。

用户看到的 `Test: evidence:: unexpected operator` 来自把整条命令包在反引号中：
Shell 先执行成功的脚本，再把 `Test evidence: ...` 等标准输出当作另一条命令执行。
这不是脚本或恢复失败；无需第三次重跑。证据复核 run
`f1d71e2d-026d-4b3d-bbdc-045d2352081e` 核对两次 result、全部命令退出码、
云端子 run 和临时明文清理，保留两次实际执行与用户报告的外层 Shell 报错。

**Phase 2 提交与部署收尾完成。** 2.26 的本机待办已全部补齐，本轮未新增模型调用，
无需重复真人故事。Phase 3 与 Release 1D 三阶段总门禁仍独立保留。

### 2.28 全仓内容一致性审计（2026-09-27）

按用户要求盘点 **257 个受版本控制文件、16 份 Markdown**，核对文档与源码、配置、
脚本、协议入口及当前交付证据。初次结构检查
`a68c7383-1ba5-4458-9518-88090be8d86e` 的 69 个本地链接/锚点、JSON 和命令入口通过。
本轮是内容一致性审计与局部修正，不代表对全部代码重新进行正确性或安全审查。

- 校准路线、规格、历史和验收交接：Phase 2 已部署，自动提取/设置仍属 Phase 3；
  已存在的评估入口在 Phase 3 扩展，不重复新建。历史失败、指标与延期门禁保留。
- 修正 Mac 自然指向、Keychain 秘密范围、官方恢复写出明文时机、双远端内容一致性
  和旧版本回滚说明；验证命令使用仓库 Node 与 test-run。产品宪法只移出过时进度，
  产品原则不变。持久项目记忆移除陈旧状态、测试数字与预算余额，改查本验收文档。
- `.env.example` 补齐记忆注入开关。启动脚本经 sudo 清理环境后丢失记忆注入和
  checkpoint 开关，可能把显式 `false` 变回 Compose 默认 `true`；现已在两条路径
  显式传递。新增 8 项隔离测试，仅使用 Docker/sudo stub，不启停真实服务。
- 修前 run `97e406da-12df-4c9f-b521-db2b1afbc481` 为 3 通过、5 失败，其中 3 项
  复现 sudo 丢失显式配置，另 2 项检查默认值显式传递。修后
  `a6923acb-61dc-45d5-b498-6a47b21af14d` 全部 8 项通过；Shell 语法
  `a71abff0-afee-408c-a7b2-ee89f5b52d67` 通过。Biome 首次仅格式失败
  `5d449e85-8cad-4f9a-8e5e-76d52ca9cf71` 保留，修正后
  `83cbb253-034c-4512-bd93-c174c703ed19` 通过。
- 文档修正后的结构复核 `1d142465-7980-461f-8db2-fafb794ad9e7` 通过：257 个
  tracked 文件及新增回归文件、16 份 Markdown、85 个本地链接/锚点、JSON 和脚本
  入口均无缺失。差异检查 `66e16317-2de8-49f8-b89b-c36e8f062794` 通过。
  外部 URL 可用性不在本轮结构检查范围内。

审计完成时上述改动保留本地；用户随后明确授权提交并推送远程仓库，交付分支为
`docs/phase2-content-audit`，同步到 `bits` 与 `origin`。本次范围为 Git 提交与推送，
未部署或调用付费模型。此前 550 项 TS/脚本与 116 项 Mac 是 2.25—2.26 的交付证据，
本轮未重复全量回归或真人故事。
下一步按任务拆分 1D-09—10 实现普通完成轮次的自动记忆、持久提取任务与开关，并扩展
100 条自动提取正负例。验收和生产启用授权完成前保持关闭；模型测试另定当次预算。

### 2.29 1D-09 持久任务、提交边界与开关合同（2026-09-28）

用户授权推进 1D-09。本轮已完成本地实现及自动化回归，未提交、推送、部署或启用生产
自动记忆；未调用付费模型或 TOS，不沿用 Phase 2 的模型预算。线上版本仍以
2.26—2.27 为准，Phase 3 合并门与全阶段发布门禁尚未通过。

实现边界：

- `0004` 默认关闭，不回填历史；任务只保存来源 ID、设置/删除版本、认领、尝试次数和
  无正文状态。最终用户事件绑定开启版本，助手与任务原子入账，失败、取消、重放及
  跨关闭/重开期间的轮次不能补队。文字、Integrated 与 Pipeline 语音完成点均已接入。
- Core 复用现有模型、仓储及单活租约处理持久任务，串行轮询间隔 1 秒；模型尝试
  有界 30 秒，失败延后 5 秒重试，最多三次。关闭服务中止调用，遗留认领在重启后恢复。
- 提交重验认领、开启版本、来源、墓碑与纠正/删除纪元；记忆、幂等结果和任务完成
  同事务。关闭使排队及在途任务失效；来源删除级联清除任务，迟到结果不能复活。
  自动任务结果不冒充明确记忆操作的重放回执。
- 自动路径只接受最终用户原话，秘密和受控敏感内容在后台模型调用前排除，解析和
  仓储均拒绝自动纠正与敏感写入。自动新增不抬高回答提交的最低上下文版本；明确
  写入和治理变更仍抬高该版本。摘要继续限制 8,900 bytes，并优先明确记忆。
- 认证的版本化设置 API、Schema/OpenAPI、SDK 和 Swift 合同一致。Mac 展示真实开关
  状态、自动来源及异步变化；丢失回执时刷新、失败保持错误提示，未知状态不可操作。
  旧轮询不能覆盖新设置，重试 ID 和版本下限绑定实例。交互后只观察最多一分钟元数据。

验证使用合成内容、本机 PostgreSQL 隔离 schema 和确定性模型；TS 并行 worker 上限为 2，
Mac 通过既有脚本 `--no-parallel` 串行运行：

| 检查 | 结果 | test-run |
|---|---|---|
| 全仓 TS/脚本及真实本地 PostgreSQL | 51 文件、587 项全部通过；无跳过 | `7a08b22f-d567-4d46-b5ca-4dcef7655733` |
| Mac 全量串行测试及 Swift 编译 | 11 suites、121 tests 通过，包含新增 5 项开关/来源测试 | `6cac0fb2-4e72-4882-ba24-b975b16b2e26` |
| 全仓构建与类型检查 | 通过 | `986df652-40a8-4761-aecf-d4cc15bc60fe` |
| Biome | 168 文件通过 | `2b44e8b9-d46a-4f88-8e0f-4a3ecb60e7ea` |
| OpenAPI 再生成一致性 | TS 生成物及 Swift OpenAPI bundle 前后 SHA-256 一致 | `3bc6dc02-a061-475d-8612-ea57a5e51e0a` |
| 文档结构复核 | 16 份 Markdown、86 个本地链接/锚点及 JSON/命令入口通过 | `d5f40c48-ffd9-4661-9c19-becd20d77560` |

新增任务数据库套件共 25 项，包括 `0004` 升级默认关闭、既有上下文版本下限保留、
原子入队回滚、仅完整普通轮次入队、幂等开关和重放、后台写入与来源、重启认领恢复、
超时/取消及三次重试上限。关闭/重开、删除后迟到提交、纠正后迟到提交各重复三次，
最终分别 **3/3、3/3、3/3**；完整库还包含既有治理与备份恢复竞态回归。秘密及受控
敏感样本到达后台提取模型的调用数均为 0。Swift 新增覆盖已确认状态、稳定重试、
丢失回执/未知状态、自动来源、版本变化、迟到轮询与实例切换。

开发失败与定向修复独立保留，不混为一次全量成功：

- 首次聚焦 `54801fd8-93e1-4759-9acc-817fc62de7e5` 为 125 通过、6 失败。三项暴露
  敏感普通输入被误标为自动候选，现已在入口排除，后台及提交仍独立复核；另三项
  旧竞态夹具只手动推进视图版本，未模拟治理推进最低上下文版本，已修正夹具。
- 第二次聚焦 `75b81f0b-e508-4fca-8080-0f0593e136a3` 为 147 通过、1 失败，暴露
  Pipeline 的候选标记未传到助手落账点，已通过内部完成事件及待落账缓存传递。
- 语音修后定向 `00120ba8-e99c-4247-ba85-80fcb9a4fd7d` 为 51/51；此后全仓
  587/587 和 Mac 121/121 是上表独立最终运行，未用定向结果替代全量。

本轮证明任务、提交和设置合同，不证明真实自动提取精确率、召回率或健康环境可见
p95，也没有执行新版 Mac 真人交互或生产 `0004` 迁移。下一步 1D-10 扩展既有评估入口，
补齐 100 条自动提取正负例、每条真实模型三次、关闭后的 20 轮/重开不补提取及延迟分布。
通过质量门槛并取得生产启用授权前继续默认关闭。`check:ci` 的相对 HEAD 生成物无差异
检查要在获准提交后执行；本地已有协议变更，用上表前后 hash 证明再生成一致性。

### 2.30 1D-10 评估准备与本地预检（2026-09-28）

用户要求补齐真实模型评估、验证精确率/召回率/延迟。本轮已完成可执行的评估准备，
**真实模型尚未调用**：Phase 2 已结束的费用额度不沿用，拟申请本轮 20 元及 900 次
HTTP 尝试上限。没有提交、推送、部署或开启生产自动记忆。

同一 JSONL 语料从 180 条扩展到 280 条，原有 Phase 2 模式保持 180 条。新增 100 条
自动提取样本包含 60 条正例、40 条负例、64 个应记项；真实模式计划每条三次，共
300 次独立试验、192 个应记项。包含限定/否定、多项事实、重复补来源、已有记忆冲突、
秘密/受控健康信息、助手/工具/视觉推断和拒绝记忆；每次试验重建隔离 schema。

`eval:memory --automatic` 使用生产提取函数、持久任务和提交路径。真实模式保留 1 秒
调度、30 秒超时及任务/SDK 重试，记录每次实际请求、可见回答、状态、费用与入库结果。
评分需要与原始证据/语料 hash 绑定的逐条复核；最终写入才进入精确率分母，全部应记项
进入召回率分母，重复写入不能多次得分，失败及缺失不会被丢弃。每轮和合并指标分别报告。
Core 可见延迟从助手落账确认到记忆列表读到结果，输出所有样本及尾部统计；不包括
Mac 刷新/网络时间。详细命令与评分规则见 [评估说明](./testing/memory-evaluation.md#phase-3-自动提取评估)。

本地检查结果：

| 检查 | 结果 | test-run |
|---|---|---|
| 全仓 TS/脚本及真实本地 PostgreSQL | 51 文件、598 项通过，无跳过 | `c4590b66-f094-4975-beb6-6fd31e10869a` |
| 自动提取固定提议及治理故事 | 100/100；关闭 20 轮零写入、重开零补提取、20 次删除后迟到任务均通过；关闭时明确写入/纠正/查询/删除通过 | `fb4020de-3b9d-44b1-b52a-100e6681fabe` |
| Mac 隐私专项及 Swift 编译 | 15 tests 通过，凭据格式参数化样本为 7 个 | `ae980b6a-ab06-4afe-b279-10d7dc54cbac` |
| Core 与依赖构建 | 通过；审阅文件纳入 24 小时清理规则后最终 Core 编译也通过 | `fb4020de-3b9d-44b1-b52a-100e6681fabe`、`8269aaf0-9609-49a9-bcde-98221dd59c1b` |
| Biome | 171 文件通过，无修改 | `2a04d8f4-9b3e-4ae7-8065-c98b6f397a84` |
| 无付费调用计划 | 300 试验中 276 次适用供应商；本地 key 存在，不代表供应商认证已经验证 | `9ffe9e3f-ccb3-4bd3-96fc-37df0c247ea9` |
| 证据与文档复核 | 语料/原始输出 hash、旧 180 条 CLI 入口、4 份文档及 26 个本地链接通过 | `a8d46773-7b66-4605-8f54-835a111e5fd6` |

预检同时发现并修复中文“API token 是……”未识别为秘密、服药陈述未识别为受控敏感
信息的缺口；Mac 的英文字段中文赋值识别同步补齐。后台集成回归证明这两类样本均在
提取前拦截。该规则仍是已覆盖格式的确定性边界，不声称识别任意表达的所有敏感信息。

失败尝试保留：

- `735825c3-7ab7-4b6e-9747-8f47efc35ff6`：10 通过、1 失败，暴露秘密分类遗漏。
  构建类型问题 `c70febb7-04ab-4675-a253-d5ef813d7685` 和格式检查
  `05d5a15c-d231-4e49-b44a-52082422a0c7`、`13e121d4-4883-4f1f-8c5a-958179c9c0e9`
  修复后由最终构建/检查通过记录取代。
- `aff7d3a5-907f-4e0d-b0f7-a422b24683ba`、`f909d37c-74b5-420f-a0a9-5d99ec589d29`：
  入口动态导入与顶层 await 互等，退出码 13；调整 CLI 启动时机后真实入口通过。
- `2731b239-94cb-47f4-9e7b-ea6bacb64335`：100 条固定提议通过；删除故事未先保存
  对应记忆来源，被生产删除合同拒绝。补齐夹具后完整本地入口通过。
- `a621d647-88eb-4297-a1d6-35347134a0c4`：SwiftPM 子沙箱阻止编译宏；
  使用仓库既有 `VIOLET_SWIFTPM_DISABLE_SANDBOX=1` 构建选项后专项通过。

按 09-28 官方峰值价格及输入字节保守估计，无重试且输出打满为 **9.776064 元**；
全部重试打满为 2,484 次、87.984576 元。拟授权上限 **20 元、900 次 HTTP 尝试**
包含失败/重试及定向复验，任一到限即停；不同 run 共享持久预算，不通过重跑重置。
本轮已发生费用及真实供应商次数均为 **0**。

自动精确率 ≥95%、召回率 ≥80%、健康环境 Core 可见 p95 ≤60 秒及真实负例零违规
仍待矩阵和逐条语义复核。本地固定提议的 100/100 不用于填充上述指标。Phase 2 已通过
且未受影响的历史/真人/恢复矩阵不重复付费，598 项本地回归与历史证据分开记录。

### 2.31 1D-10 前两次真实矩阵及失败分析（2026-09-30）

用户已授权“100×3 矩阵及必要复验，费用上限 20 元”，沿用本轮提出的 900 次 HTTP
尝试上限。所有运行共享 `.local-acceptance/phase3-eval-budget.ndjson`，不重置失败预留。
09-30 复核官方峰值单价仍为未命中输入 2 元/百万、输出 8 元/百万。
本节为本地真实供应商证据；没有提交、推送、部署或开启生产自动记忆。

首次启动 `6ec7fcf6-721e-4dd5-b8d9-79858ab63cc4` 连续 8 次 HTTP 400 后主动停止：
两条试验已失败，第三条未取得最终快照，其余 297 条未开始。原运行没有记录供应商
错误正文，保留此缺口。诊断 `36cbede8-709b-4390-8405-597364cee8e3` 的第 9 次请求
确认错误为 `Prompt must contain the word 'json'`。自动提示漏写 JSON 字样，已补齐，
并让评估记录器保存异常正文。9 次拒绝全部保留费用上界 **0.318426 元**，不推测退款。
诊断记录核对原始发送与预算逐条一致后只移除孤儿锁；中断产生的单个隔离 schema 经
请求 ID 定位后清理，见 `53ab2dc4-a31f-4b93-892b-b767fd2c3ecc`。

接口修复后的首次完整矩阵为 `2dd4429d-91b5-4e73-b1ea-279819306022`：
100×3 全部完成，276 次供应商请求、无重试，24 条敏感试验在调用前跳过。
语料 hash 保持 `3adaba235493e16a04da16bd16d318cb765ff108a6dbb311619491cc8763595d`。
逐条原文、模型正文、最终写入、类型、范围与引用复核存于该 run 的
`capture-automatic-review.json`，三个分轮判定也单独保存并绑定行 hash。
评分记录 `d974c097-852b-4e70-8d35-76a916c7fd65` 退出 1，表示质量未通过：

| 首次完整测量 | 正确/全部写入 | Precision | 正确/全部应记项 | Recall |
|---|---|---|---|---|
| 第 1 轮 | 56/68 | 82.35% | 56/64 | 87.50% |
| 第 2 轮 | 52/72 | 72.22% | 52/64 | 81.25% |
| 第 3 轮 | 52/69 | 75.36% | 52/64 | 81.25% |
| 合并 | 160/209 | **76.56%** | 160/192 | **83.33%** |

Core 可见延迟共 184 个值（含 4 次负例误写），p50 **1.934 s**、p95 **2.387 s**、
p99 **2.594 s**、最大 **3.031 s**；三轮 p95 分别 2.282、2.436、2.298 s。
300 次任务结束耗时 p50 1.844 s、p95 2.284 s、p99 2.457 s、最大 3.032 s。
没有丢弃慢样本；缺失/任务失败/正例完全无可见记忆均为 0。不包含 Mac/UI/网络刷新，
快速入库也不代表写入内容正确。

失败包括：持续活动误作目标、亲友/宠物误作事实，限定/对照/进度拆分后单条失去完整
范围，改写丢失 `only`、用户本人关系或 `best`。40 条负例三次共 120 次中有 4 次误写：
`auto-072` 第 2/3 轮把待校对文字当职业，`auto-100` 第 2 轮把当前轮次语言要求当长期
偏好，`auto-091` 第 3 轮另建与当前最爱颜色矛盾的记忆。最后一项触发受保护负例门禁；
种子本身未改写或删除。敏感发送与写入均为 0，助手/工具/视觉/拒绝记忆负例零写入。
42 项开关、重开不回填、删除后迟到任务及关闭时 Phase 2 治理控制全部通过。

已针对证据修复自动提示：复用明确记忆已有的类型定义，保留完整用户原句及关联限定，
区分任务中的示例文字与本人陈述，排除当前回答要求，并在新建前比较同一属性的冲突。
原有明确记忆提示正文保持相同，语料及评分门槛未修改。修后聚焦 52 项通过
（`19e43a96-44dc-4045-b260-abe8823a5b7a`），Core 及依赖构建通过；这些不替代真实复验。

截至首次完整矩阵及诊断，累计 **285/900 次**、费用上界 **0.582184/20 元**；
其中完整矩阵按 usage 的保守价格计算为 0.263758 元，9 次失败预留仍保留。
随后完成第二次完整 100×3，run `49869645-7101-453b-9c8f-c9bd824d81be`。
全部原文、模型正文、最终入库和零写入试验再次逐条复核，判定存于该 run 的三个
`capture-judgments-trial*.json` 及合并后的 `capture-automatic-review.json`。
评分 `832a1c4d-283e-4002-95ca-5b9e649dc6ef` 退出 1，仍未通过：

| 第一次修复后的完整复验 | 正确/全部写入 | Precision | 正确/全部应记项 | Recall |
|---|---|---|---|---|
| 第 1 轮 | 58/67 | 86.57% | 58/64 | 90.63% |
| 第 2 轮 | 54/67 | 80.60% | 54/64 | 84.38% |
| 第 3 轮 | 59/66 | 89.39% | 59/64 | 92.19% |
| 合并 | 171/200 | **85.50%** | 171/192 | **89.06%** |

Core 可见延迟 187 个值（含 7 次负例误写），p50 **1.886 s**、p95 **2.423 s**、
p99 **7.863 s**、最大 **7.962 s**；三轮 p95 为 2.458、2.376、2.631 s。
300 次任务结束耗时 p50 1.793 s、p95 2.407 s、p99 7.832 s、最大 15.592 s。
没有缺失或正例完全无可见记忆；`auto-095` 第 3 轮连续三次非法 `supersede/update`
被校验拒绝，最终任务失败，零写入，失败和全部耗时保留。收集器退出 0 只证明收集结束。

本轮 284 次 HTTP 均取得用量，其中 8 次为任务重试增加的尝试，没有 SDK HTTP 重试：
第 1 轮 051/053、第 3 轮 052/053/055 首次补来源擅自改变原文标点，被拒后成功；
095 第 2 轮一次非法动作后成功跳过，第 3 轮三次均失败。
24 次敏感试验仍在调用前拦截，42 项治理控制通过，种子未改写或删除。

精确率改善，但类型、拆分、重复匹配和边界仍有错误。两个音乐属性被合并的 042
第 2/3 轮按规格的原子主张合同判错；没有给一次写入重复计分。052 第 1/2 轮及
054 第 2/3 轮新建了已有记忆，未冒充成功补来源。7 次受保护负例误写为：
092 第 1/2/3 轮、094 第 1/2 轮、093 第 3 轮的冲突，以及 081 第 3 轮的明确拒绝。
校对及当前轮次语言负例本次零写入。实际发送记录确认冲突候选已正确传入模型，
并非候选丢失；下一步修复提取判断和拒绝记忆边界，再做真实复验。

至此累计 **569/900 次**、费用上界 **1.009688/20 元**，本次完整复验按 usage
计 **0.427504 元**，最初 9 次失败的 0.318426 元预留仍在。锁已正常关闭。
修后 Biome 171 文件通过（`769d3525-b455-4f66-90e6-3160b09035fb`），
无调用计划 `368ee02b-ccc1-44a5-a730-c293533b9d3a` 得到当前提示最大输入 3,044
tokens、无重试满输出上界 10.605168 元；后续提示若再变更，须重新计算。

### 2.32 1D-10 第二次修复与完整复验（2026-09-30）

针对 2.31 的实际失败，自动提取复用已有中英文拒绝保存规则，在调用前结束明确拒绝的
任务；新建正文保存经原文引用校验的完整用户子句，避免模型改写引入性别或丢失限定。
无目标、正文和类型与唯一候选逐字一致时复用该候选补来源；不做模糊匹配。
已有目标的内容/版本校验、明确记忆合同和禁止自动治理的校验保持生效。
自动提示按排除、比较候选、判定类型和保存原句的顺序整理，自动后台开启网关已有的
thinking 模式，明确记忆仍关闭 thinking。输出上限仍为 4,096 tokens，30 秒超时不变；
记录器只保留可见 JSON 和用量，不保留模型内部推理。

兼容性诊断 `ac210d95-8f88-46ae-9211-7e34d8c345ef` 仅运行 031/042/044/052/092/095
各一次，共 6 次 HTTP，均正常返回 JSON，无重试。逐条检查宠物类型、独立属性、技能
限定、重复补来源和两个冲突的提议均符合预期，耗时 1.019—5.289 秒。该诊断没有通过
任务实际入库，不混入后续 100×3 的质量或延迟分母。费用上界 0.023370 元，至此累计
575/900 次、1.033058/20 元。

修后本地验证：

| 检查 | 结果 | test-run |
|---|---|---|
| 提议、评估预算/评分、真实数据库持久任务 | 80 项通过 | `f0dea518-2745-474d-a622-1f4843cf4979` |
| 全仓 TS/脚本及真实本地 PostgreSQL | 51 文件、600 项通过，无跳过；文件串行，用例内并发保持 | `fb1fd955-546c-4953-acda-5ff4913f3495` |
| Biome | 171 文件通过 | `2bb040c5-1f5c-4666-a7cc-a87b838fe0df` |
| Core 构建及无调用计划 | 通过；最大输入 3,601、输出 4,096，267 次供应商适用试验；无重试满输出上界 10.556964 元 | `c86891f5-93de-4dd6-a526-d4a23bcb0db8` |

失败记录全部保留：`a8378806-720d-46e3-9933-8c1dd14aaec0` 为 79 通过、1 失败，
拒绝保存改为调用前拦截后，计划测试仍期待旧的 276 次；已更新为 267 次。格式检查
`1d028bff-ee6e-4e01-890b-98ec1a4810c1` 的换行问题已修复。
全仓并行 `bcc2340d-6a70-423c-a05c-45afb61b50e9` 为 566 通过、34 跳过，失败来自
测试 schema 并发执行 `CREATE EXTENSION IF NOT EXISTS vector` 的数据库级竞争
（`pg_extension_name_index`），发生在套件初始化。串行完整运行已通过；没有把并行
初始化失败描述为已修复的产品缺陷，也没有取消用例内的事务竞态测试。

完整复验 `19cd6950-bc3f-43a8-875f-d2e767211c76` 的 300 个任务已全部结束，语料
hash 仍为 `3adaba235493e16a04da16bd16d318cb765ff108a6dbb311619491cc8763595d`。
全部原话、模型可见 JSON、最终写入和零写入试验已逐条复核，三个
`capture-judgments-trial*.json` 绑定行 hash；合并后的 `capture-automatic-review.json`
绑定语料及完整 stdout hash。模板留证 `720c6012-7fe6-4e1a-9857-a309eb8d829d`，
正式评分 `220bde5a-e374-4997-83f4-e1883dd3081e` 退出 0，质量及治理检查通过：

| 第二次修复后的完整复验 | 正确/全部写入 | Precision | 正确/全部应记项 | Recall |
|---|---|---|---|---|
| 第 1 轮 | 63/65 | 96.92% | 63/64 | 98.44% |
| 第 2 轮 | 63/65 | 96.92% | 63/64 | 98.44% |
| 第 3 轮 | 63/65 | 96.92% | 63/64 | 98.44% |
| 合并 | 189/195 | **96.92%** | 189/192 | **98.44%** |

| Core 延迟（秒） | 数量 | p50 | p95 | p99 | 最大 |
|---|---|---|---|---|---|
| 第 1 轮记忆可见 | 60 | 2.556 | 3.839 | 5.883 | 5.883 |
| 第 2 轮记忆可见 | 60 | 2.625 | 4.800 | 11.461 | 11.461 |
| 第 3 轮记忆可见 | 60 | 2.660 | 5.600 | 12.829 | 12.829 |
| 合并记忆可见 | 180 | **2.618** | **5.079** | **11.461** | **12.829** |
| 全部任务结束 | 300 | 2.462 | 3.918 | 6.704 | 12.830 |

没有缺失、最终任务失败、种子改写/删除或正例完全无可见记忆。120 次负例全部零写入，
其中 24 次敏感、9 次明确拒绝保存在调用前结束；不能把这些确定性拦截冒充模型理解。
42 项关闭、重开不补提取、删除后迟到任务和关闭时 Phase 2 治理控制全部通过。
共 268 次 HTTP（267 个适用任务 + 1 次任务重试），没有 SDK HTTP 重试；第 3 轮
042 首次引用多加了原文没有的“我”，整体提议在提交前被拒绝，重试后两个属性正确入库。
首次错误 JSON、重试和慢样本均保留，延迟不含 Mac/UI/网络刷新。

残余误差为 004 的沟通偏好：三轮均把“不喜欢电话沟通，工作上更愿意用文字”拆成
两条，每条没有保留完整范围，合计 6 个错误写入、3 个未命中的应记项，全部计入分母。
类型、重复目标、技能限定、冲突和拒绝保存的既有失败在本次矩阵未复现。第 2 轮
043/044 的模型正文仍有改写，最终入库采用校验后的原话；实际输出证实该修复生效。
达到门槛不表示零错误，也不代表固定合成语料之外所有表达已验证；没有修改 golden、
评分规则或挑选最佳轮次。

本次完整复验费用按 usage 和未命中峰值价格计 **0.824392 元**；含前两次完整矩阵、
6 次兼容性诊断及最初 9 次失败预留，累计 **843/900 次、1.857450/20 元上界**。
其中 834 次取得完整用量，最初 9 次 HTTP 400 的 **0.318426 元**预留不冲回。
预算账本正常关闭，不再发起付费调用。

收尾核验 `11f496b3-07a9-4ff2-9687-d9e6e879c87d` 通过：843 次发送逐条对应预算
预留，实际请求的原话、候选、thinking/JSON 设置一致；语料、原始输出和审阅 hash
匹配，4 份文档的 27 个本地链接有效。`git diff --check` 通过
（`f9eb4d3e-24ea-4698-ad58-7dea74bac3f4`）。

本地自动提取质量门槛已通过。Phase 2 既有历史 Top-5、真人语音与恢复证据仍独立引用，
本轮没有重跑这些未受影响的付费矩阵。新版 Mac 自动开关/异步可见故事、生产 `0004`
迁移与回滚验收、默认开启及 Git/部署交付尚未执行；生产自动记忆保持关闭。

### 2.33 并行初始化与沟通偏好修复（2026-09-30）

用户要求先修复 2.32 的两个 P2 问题。本次只修改本地代码与测试、执行已有授权内的
必要模型复验；没有提交、部署或启用生产自动记忆。

数据库根因：`vector` 属于数据库级扩展，但四组集成测试及评估器直接在随机 schema
中执行 `0001`。`IF NOT EXISTS` 不能使并发首次创建成为原子操作，而且临时 schema 的
`DROP ... CASCADE` 会连带删除放在其中的扩展。新增共用的 `initializeTestExtensions`，
用同一连接、事务级 advisory lock 初始化 `public.vector`，之后各自迁移与用例仍并行。
已有扩展若位于其他 schema 则明确报错，不擅自移动或删除；没有修改已发布的 `0001`。

冷库回归每轮新建一个本机隔离数据库，确认初始无 vector，八路独立连接同时初始化、
执行原迁移并清理各自 schema，最后确认唯一扩展仍在 public 且向量类型可用。
三个独立试验通过，只清理本次创建的数据库。默认并行全仓再运行三轮，完整结果如下；
未使用 `--no-file-parallelism`，原有事务与备份竞态用例继续执行。

| 检查 | 结果 | test-run |
|---|---|---|
| 三个冷库、每库八路并发专项 | 3/3 通过 | `4c222d56-a561-4377-9445-8423096851cd` |
| 默认并行全仓第 1 轮 | 52 文件，603/603，无跳过，7.33 秒 | `77e10ac1-03e8-4eb8-9f87-5ceb74990f9a` |
| 默认并行全仓第 2 轮 | 52 文件，603/603，无跳过，7.15 秒 | `9f29cc24-c06c-4c3c-a38e-b2a5c8d73bbb` |
| 默认并行全仓第 3 轮 | 52 文件，603/603，无跳过，6.51 秒 | `0cca897d-ee8e-4908-a528-7b8066ad464e` |
| 最终提示后的提议、评分/预算、数据库持久任务 | 80/80 通过 | `1db50560-14bd-4d56-ad0e-1ec937f7ce85` |
| 最终 Core 构建 | 通过 | `c16cfa50-dc05-4b44-9099-202b0901a51f` |
| 最终 Biome | 173 文件通过 | `b42b0c62-3d78-4c34-b9ab-ad84c7ad6e12` |

三轮默认全仓均包含上述三个冷库用例；因此专项之外又验证了九个全新数据库。总耗时
范围 6.51—7.33 秒，中位数 7.15 秒。首次修复版 Core 构建
`524fe95f-1b34-4826-a7a7-b4c8bc7a8fc1`、八个改动文件格式检查
`894fd230-b979-43ab-98ca-31f7fe62c144` 也通过。2.32 原始并行失败仍保留。

沟通偏好根因：原提示对“一项习惯的相反选择”和“不同属性分别保存”描述有歧义。
只调整自动提取的第 4 条：先区分各自回答不同问题的独立属性，再保留同一属性的所有
选择及限定。沟通渠道的避免/偏好与工作范围共同保存；音乐种类偏好与工作时是否播放
音乐分别保存。没有增加关键词合并代码，没有改变明确记忆合同、原话校验、golden
或评分规则。

先用 15 条原样本和预先固定的 4 条新中英文样本，各运行三次真实持久任务：
`004/042/044/046/047/048/051/056/058/059/080/081/092/094/095`，加英文沟通渠道、
中文通勤选择、英文音乐与工作安静、中文阅读种类与时间。19×3 的计划为
`4128d910-04aa-4a0a-9590-5e77052e9a65`；原 100 条语料 hash 仍为
`3adaba235493e16a04da16bd16d318cb765ff108a6dbb311619491cc8763595d`，
专项语料 hash 为 `95638e17d3e7d1ec6abca7fac64b314d860d20e07611d775eb941d8c1d42299f`。
本地专项脚本复用 `collectAutomatic`、预算与评分函数，不增加生产 CLI 模式。

收集 `6ce23a9b-b87a-4cad-9576-6f380c3394b6` 完整结束，逐条审阅全部 57 次的实际
JSON/零调用、最终入库与原话来源；模板 `25ad66fb-06c6-4fef-83fc-f104395ef168`、
判定落盘 `12f01762-59dd-4f71-aae9-fe5595a9e069`、评分
`36912ed7-b32b-4c58-b36b-7c269805daa6`，审阅绑定原始 stdout 与专项语料 hash。
原沟通偏好和四条新增样本全部通过，但 042 第 1、2 轮把两个独立属性合并，两个实际
写入全部计错，四个应记项未命中。评分合并值通过不代表这两轮各自通过，也没有据此
忽略新回归。

| 中间 19×3 专项 | 正确/全部写入 | Precision | 正确/全部应记项 | Recall |
|---|---|---|---|---|
| 第 1 轮 | 18/19 | 94.74% | 18/20 | 90.00% |
| 第 2 轮 | 18/19 | 94.74% | 18/20 | 90.00% |
| 第 3 轮 | 20/20 | 100% | 20/20 | 100% |
| 合并 | 56/58 | 96.55% | 56/60 | 93.33% |

中间复验 Core 可见延迟 42 个值，p50/p95/p99/max 分别为
2.744/4.500/6.466/6.466 秒；三轮 p95 分别为 4.048/6.466/6.097 秒。
全部 57 个任务结束延迟 p50/p95/p99/max 为 2.412/4.501/6.468/6.468 秒。
15 次负例零写入，其中 6 次拒绝保存为确定性调用前拦截；没有任务失败、种子改写或
缺失。51 次 HTTP，无重试，费用 0.191828 元。42 项治理控制全部通过。

针对观察到的 042 回归，再明确“先判断独立属性”的顺序与音乐属性边界。最终只复验
004/042 各三次，计划 `002fb75d-82f3-4080-995c-23ae4236b16e`，收集
`bdc36b58-9f15-4abd-9377-47432ab877ee`，专项语料 hash
`a3f8384f84c558e559d9f14cadf70c22b89affd464083f07c0bb341e54320de6`。
六份真实 JSON 及九个最终写入/原句均逐条核实：004 每次一条，完整保留电话否定和
工作文字偏好；042 每次两条，分别保留音乐种类和工作时播放的否定。无重试或失败，
三轮各 3/3 正确写入及应记项命中；合并 **9/9，precision/recall 均 100%**。
模板 `4df82fe7-9f82-4767-b6b8-e146650a658e`、判定落盘
`c196bdf8-8b4b-4c51-a9c7-2c24cf260659`、评分
`445853af-34e8-41cf-9e8f-0ecb5156878b`，42 项治理控制再次通过。
Core 可见延迟六个值 p50 为 3.113 秒，p95/p99/max 为 4.736 秒；
三轮 p95 为 4.497/4.736/4.116 秒。任务结束 p50 3.114 秒、p95/p99/max 4.738 秒。

最终六次费用 0.032120 元，本次修复合计 57 次、0.223948 元；Phase 3 授权累计
**900/900 次、2.081398/20 元上界**。891 次取得 usage，最初九次 HTTP 400 的
0.318426 元预留仍未冲回；预算锁正常关闭。次数额度已用完，停止付费调用。
最终提示无调用计划 `93bd496f-b16a-48c3-bca3-05c0084d8062`：
完整语料最大输入 4,008 tokens、输出 4,096；267 个适用任务无重试满输出上界
10.774302 元。这只是计划，不是新的调用授权。

最终证据核对 `fd93a3fb-0cde-498f-800e-aa886b090870` 通过：900 次实际发送均对应
预算预留，最新实际请求提示与构建代码一致，原话/种子/JSON 设置、审阅/评分 hash
和 28 个文档链接匹配。首次核对 `58973a7e-7c71-4107-a9ab-552de4d7a9f6` 因只读
stdout、漏看构建命令写在 stderr 而误报；改为合并核对两个记录后通过，未重跑构建
或模型。`git diff --check` 通过，run `3b37b4db-e732-4dd9-8fed-6d690d27cf49`。

两项原问题已修复并在上述范围内验证。2.32 的 100×3、这里的中间 19×3 和最终 2×3
对应不同提示，不能拼接分母或把最终 9/9 外推成完整 100×3 全对。最新提示没有再次
跑完整矩阵，固定合成样本外的泛化也没有由此证明。Mac 自动开关/异步可见故事、生产
迁移/回滚和发布仍是下一阶段；当前自动记忆默认关闭，代码未提交、未部署。

### 2.34 新版 Mac 与生产发布预检（2026-09-30）

用户明确要求进行新版 Mac 验收和生产发布。发布授权已具备，但以下实际环境门禁未
通过，因此没有提交 Phase 3、更新生产或启用自动学习。本节不改变 2.33 的测试结论。

| 检查 | 结果 | test-run |
|---|---|---|
| 全工作区构建及类型检查 | 9 个工作区 build/typecheck 均通过 | `b5dcfc00-92bf-42fb-889d-5106984cf586` |
| Mac 全量入口 | 编译器启动失败，exit 134；未执行测试断言 | `4fe9f450-4ac5-416e-8164-2a9987b0ed19` |
| Kerberos 有效性 | `klist -s` 返回 0 | `ca27935b-90a4-4343-8590-2f8bcd774e2f` |
| Devbox 控制面 | 目标实例 active，官方 SSH 地址仍为 `10.37.247.128` | `cc5683d9-3b9f-42c5-ab92-249cbe01a634`、`256f3c32-5a21-4008-8b8b-193d80c05767` |
| 生产 IPv4 SSH | 握手前连接超时，exit 255 | `9cba5c46-1eb1-4273-beb8-a2b1c183a88f` |
| 同机 IPv6 SSH | 保留已知主机验证，握手前超时，exit 255 | `aeabb01b-cc7a-45b6-8dc6-ebc82f71f343` |
| 普通终端预检脚本语法 | 通过，尚未代替普通终端实际执行 | `d78fd81f-966d-46c8-9fea-4abec36fc7cc` |
| 隔离 Core 零费用预检 | 迁移、开关持久化、重启和 Core recorder 通过 | `20c5a59f-b526-4f1f-be32-bec962974655` |

Mac 的 dyld 错误为沙箱映射的 `lib_CompilerSwiftDiagnostics.dylib` 无法加载
`@rpath/XcodeDefaultTools-6.4.0.34.1/../lib_CompilerSwiftSyntax.dylib`。
该尝试已经使用 `VIOLET_SWIFTPM_DISABLE_SANDBOX=1`；未通过改写动态库或机器配置
绕过 Agent 沙箱。已准备普通终端的一次性脚本，依次留证 Mac 全量测试、App 构建/
严格验签与生产 SSH 只读检查。执行前备份原 App，不自动启动或改生产。

零费用预检使用正式 `dist/storage/migrate.js` 对临时数据库应用全部迁移至 `0004`；
确认初始自动学习关闭、记忆为空，设置开启后关闭，重启 Core 后 revision 2 与关闭
状态保留，实例不变。两个实际 Core PID 的 recorder ready 均有记录。无授权模型代理
返回 403，供应商调用为 0。完成后临时数据库和凭据均已清理；没有启动 Mac，
不能据此宣称 Mac recorder 已就绪或真人故事通过。

入口与五步用例见 [Phase 3 Mac 短验收](./testing/phase3-real-acceptance.md)。
本地辅助脚本为 `.local-acceptance/phase3-mac-preflight.sh` 和
`.local-acceptance/phase3-mac-story.mjs`，不属于生产运行时。后者复用现有
`EvaluationBudget`，文字请求发送前预留、含重试计数、缺少 usage 不退款，未授权
默认阻断。拟申请独立上限 1 元 / 40 次；尚未运行带授权参数的故事，未创建或重置
新的付费账本，原 900 次预算不沿用。故事限定每次最多 4,096 输出 tokens。

下一步先完成普通终端构建和连通检查，再进行有独立预算的 Mac 开关/异步来源故事；
通过后从已提交版本打包、迁移生产、验证能力回滚与备份调度、启用自动学习并记录
真实部署版本。生产现状只沿用上次已验证版本，不把本次无法连接表述为生产健康。

### 2.35 普通终端构建核实与实机环境门禁（2026-10-01）

用户提供普通终端输出并授权实机最高 1 元、40 次调用（含重试），继续实机及发布。
直接核对已有记录，确认用户两次运行均完成 Mac 测试与构建，失败只在后续 SSH。
输出里的 `Test: evidence:: unexpected operator` 出现在整条脚本命令被反引号包围后：
shell 执行脚本并捕获 stdout，再尝试把首段 `Test evidence: ...` 作为命令执行。
不是 Mac 断言失败，不需要因此重新跑测试。

| 已有普通终端运行 | 结果 | test-run |
|---|---|---|
| 第一次 Mac 全量 | 121 tests / 11 suites，7.098 秒通过 | `e822e4ed-f853-4642-a2eb-ec44f443bb5c` |
| 第二次 Mac 全量 | 121 tests / 11 suites，5.890 秒通过 | `53c144b3-8840-4b3f-a824-af7907122db1` |
| 两次 App 构建与严格验签 | 均 exit 0 | `5a51b648-450f-4470-b341-35ceb72e9249`、`bdde264e-87da-4dd9-816f-c15da1f21398` |
| 两次后续 SSH | 均超时，exit 255 | `fad12a2a-5828-416e-8de3-c6ed3f36d76d`、`25141797-5410-4ba7-ac9d-13c79d97f02a` |

这六次绑定相同工作树指纹
`4ee63615fdfd880434497d77c0d03608691ecbf0f3db8ab18beb21defd43ed28`。
实际签名 App 主二进制 SHA-256 为
`a9e8096a02a5536aa6d1f140723f040f23be220677b4ec0cddf7c5986e87ab1b`。

本次 SSH 诊断 `e7ea1604-6ff6-4722-bc66-85058979930a` 成功：既有 ECDSA 主机指纹
匹配，Kerberos `gssapi-with-mic` 认证通过，主机名 `n37-247-128`。官方地址核对为
`e4047101-ed33-4c14-a6ac-d6c3fccf455c`。没有修改 SSH、网络、票据或机器配置，
不能据此倒推先前超时的具体网络原因。

生产只读预检 `f8fe7ece-173d-4be6-9e6e-ed55ea351898`：
`b3fa62c-release-1d-phase2`、healthy、restart 0，Core 镜像
`82409333e0bd71c4cdb88029a058f3a3edc63c80ad946a67966dc96e5e91d098`；
备份镜像 `534b98904a1b6438f46fd987b2aaaae836e2eaa98f06cd4d13640e1f0cca91c0`。
迁移至 `0003`；实例 `2938b3dd-6781-49cd-8b93-ab9e74f22ac2` 的 memory revision /
restore epoch 都为 0，记忆 0，事件 1,113。每日备份及每分钟清理 cron 均存在。

**实机启动与实际阻塞。** 首次本地隔离启动
`8a0a6150-211d-497a-a4f9-3db22b4fe09d` 因 Docker daemon 不可用停止，调用 0。
启动已有 Docker Desktop 的 `2af8115f-86a6-4dc4-90c8-628c5d58f7ab` 返回 1，
日志目录写入被拒。没有更改目录权限或换路径绕过该拒绝。

随后使用 Devbox 已有 PostgreSQL 镜像创建独立临时容器，禁止拉取、限制资源、只绑定
loopback，以 SSH 隧道连接本地 Core；未连接生产数据库。run
`05a2757b-b68f-47b0-918a-1f4baf7bfed8` 已完成正式迁移，Core PID 11217、Mac PID
11249 的两端 recorder ready 早于 UI 操作。Computer Use 观察到记忆窗口提示
“恢复保护正被另一操作使用或暂时不可用，请稍后重试。”，开关禁用。
实例 `7f21ddba-7d1a-40bc-9d4f-92df04d4d87b` 对应的恢复锁文件未创建；
源码在 `Darwin.open` 或 `flock` 失败时返回该错误，实际 errno 没有记录，不能把
通用提示当成已经证实的并发争锁。这里尚未进行模型输入，设置仍为 false / revision 0。
普通终端启动真实 App 的恢复锁及 Keychain 路径仍需现场验证。

助手发送的 PTY 中断终止了进程组，未跑完脚本 finally；这不是用户取消。
缺少原生收尾的事实明确保留。专项核对与清理
`45c1a9c3-07ee-4f83-8e88-d62a1ebf48a6` 确认相关进程已退出、账本只有授权行且
无预留，通过本次 run label 核实后删除临时容器及卷，清理本次凭据，释放遗留预算锁。
从仍存在的原始 Core 文件收集 36 条 Mac/Core 事件，无解析缺口；未补造不存在的问答。
原 run 标记失败，并注明中断及独立清理证据。

为避免进程组中断，辅助脚本增加 `abort` 命令。计划内收尾试验
`b01bb98b-28b7-4efa-8b31-5d4c63aa02e0` 在两端 ready 后输入 abort，按预期返回失败，
原生 finally 成功清理临时数据库/容器、隧道及凭据，释放预算锁；合成实例 Keychain
查询为 not found（44）。这是收尾路径验证，不是五步产品故事通过。

新实机账本累计 **0/40 次、0/1 元**，授权不需要重复确认。没有修改生产应用、
迁移或开关，Phase 3 没有提交/发布。本轮只调整本地验收辅助脚本与交接文档。
下一步由普通终端使用
[远端隔离库的五步入口](./testing/phase3-real-acceptance.md#费用与启动) 启动实机，
不重跑已通过的构建；实际开关/异步来源故事通过后继续提交、部署及默认启用。

### 2.36 真人故事失败复核与明确写入修复（2026-10-01）

用户反馈“已全部测试完成”。真人 run `196ea4de-d4ca-4783-8220-2b3530e4dec9`
正常完成采集和清理，但产品故事**未通过**。原 `result.json` 的 verdict 明确要求
继续核对 UI 与原始输出；保留原结果，并在同目录 `REVIEW.md` 单独记录判定。

三次 Mac/Core 启动均已确认 recorder ready，两次重启保持实例
`8303bbb4-03bb-47e5-966c-54283b0e946f`。用户输入紫色书签、橙色笔记本、蓝色
文件夹三句普通偏好，模型均提议 `write`，Core 同步回复“已记住”，来源全部为
`explicit`，后台任务始终为空。后两句在自动学习关闭时仍写入。第二次重启后没有
重新开启请求，不能将其标作重开验证通过。来源 UI 尚未看到真实 `automatic` 项。

根因是明确意图入口误判，且共用来源校验只验证事实原文，没有拦截缺少记忆操作表达
的明确写入。之前的自动质量矩阵直接验证后台提取，未覆盖该入口。修复将“是否要求
记忆操作”置于提示的持久性判断之前；明确写入增加记忆操作词的必要条件，并复用
拒绝保存检查。词匹配不独自授权，引用、问句、虚构与事实来源仍须通过原有语义判断
和校验；没有把自动开关用来禁用明确写入或治理。

聚焦回归 `6998c038-6107-497a-b52c-36828f7f1246` **77/77**，其中真实 PostgreSQL
集成故意让模型在同步入口错误提议 write，验证关闭时零写入、开启时仅完成轮次后
生成 automatic 项，重放仍返回普通回答；关闭时明确记住仍成功。
远端隔离库创建、迁移、Core recorder 与清理记录为
`aec1333f-0d6c-40c1-bdea-6378259a247f`。Core 构建
`68709334-ef24-4a20-9a24-98642456af26` 通过。

**真实完整路径复验。** `3c0beeff-9191-4e4c-a1f3-b4ceecf59f43` 中，三条原输入
各 3 次均由模型直接返回 none；另外翻译、角色台词和拒绝保存 3 条也为 none。
9 次原输入提议耗时范围 0.320—1.216 秒，保留全部结果，不作为新的 100×3 质量矩阵。
实际 Core 聊天完成后，开启时紫色书签和重开后的蓝色文件夹均产生 automatic 来源；
关闭时橙色笔记本零写入、零任务、重开不补提取。两次重启分别保持开启和关闭。
关闭状态下明确写入、纠正 v2、仅生成删除预览也通过。

该 run 同时发现第二个缺陷：紫色在后台完成前、橙色在关闭且未写入时，聊天模型均
声称“我记下了”；蓝色还被误当成历史问题。脚本原结构断言通过不覆盖这些语义，
独立 `REVIEW.md` 将该 run 判为“路由通过，表述失败”。共享文字/Pipeline 回复入口
补充“本轮 Core 未确认记忆操作”的系统事实，普通自述直接回应，不能承诺保存或
要求重复。关闭记忆注入时仍保留这项约束。

最终回答定向 run `7c0d5137-b7fb-4e0f-94f2-3f3044be213f` 三条均已逐字复核：
只评价书签/笔记本/文件夹的颜色，没有虚假保存或重复提问；关闭状态下三次快照的
记忆和任务均为空。该 run 的 `REVIEW.md` 保留全部三条原文和判定。

**回归与环境差异。** 全工作区构建和类型检查
`d1efcc77-e562-401c-8756-abfb98eb4a8e` 通过；Biome
`848b9d28-016c-4652-a3f2-d3c9483a7297` 173 文件通过。
默认并行全仓 run `9ea05b11-ab9f-45cc-917e-df3a988bf528` 为 609 通过、1 超时、
1 未运行：远端临时库下连续 20 轮用例超过测试 30 秒预算；备份快照要求 Docker
容器入口，首次未注入远端容器 transport。没有修改产品超时或断言。

定向补验 `cf01f5b7-4ec0-4929-94d2-638c5bbbb298` 的两项均通过：
20 轮用例 24.056 秒（该次测试预算 120 秒），备份快照/旧恢复拒绝/干净新恢复
13.169 秒。备份测试通过仅限本 run 容器的 SSH Docker transport 执行原始测试，
未换用 mock。两次合计覆盖 **611 项**；不表述为单次全仓 611/611。
最后将“未确认保存”约束保留到关闭注入的回滚路径后，共享召回回归
`a2f73d4b-6e12-4f6f-b64e-d623f48bf524` 4/4、最终 Core 构建
`efb04c50-d37e-4a0b-abf0-c104f8d95c4e` 通过。没有修改 Mac 源码或重建已验签 App。

本次独立账本累计 **33/40 次、0.076956/1 元**，全部结算，剩 7 次；
包含真人 3 次、路由复验 24 次、回复复验 6 次，不沿用已耗尽的 900 次评估授权。
临时数据库、容器、隧道和凭据均按 run 收尾。
当前仍未提交或部署。用户只需执行
[一条输入的 Mac 补验](./testing/phase3-real-acceptance.md#2026-10-01-修复后的最短补验)，
核对异步提示和自动来源；原整套开关/重启故事不重复。

### 2.37 Mac 自动来源短补验通过（2026-10-01）

用户完成限定的一条输入补验并反馈“执行完成”。run
`ae20bd35-722b-4820-a943-ee3964071456` 的 Mac/Core recorder 在输入前均已就绪，
窗口设置更新成功。原话“我平常喜欢用紫色书签”的明确提议返回 none，实际回答没有
宣称保存。Core 聊天完成后约 2.24 秒，后台任务一次完成，生成 current v1、
preference、normal、**automatic** 来源的记忆，UTF-8 引用 0—30 与原话一致。

请求为 `14324e59-e4ee-4bd4-bbdb-0ac8620f1dcd`，记忆为
`09e86b43-2019-46a9-b73d-29148b4ecdc7`。Mac 已成功读取更新后的列表及该条详情，
没有请求错误。异步提示与显示的完成依据为用户执行反馈和真实列表/详情操作；
未保存提示截图或逐项文字观察，不将其描述为精确 UI 渲染延迟或新的 p95。
完整原始事件及独立判定位于该 run 的 `server/story.ndjson`、Mac/Core 记录和
`REVIEW.md`。原采集器 Collected 不被改写为自动语义判定。

Mac 二进制仍与 2.35 验签产物一致。隔离数据库、容器、卷、凭据及该实例 Keychain
全部清理成功。本轮新增 3 次 / 0.007226 元，独立授权累计
**36/40 次、0.084182/1 元**，全部结算。其余开关/重启/不补提取合同沿用 2.36
真实 Core 复验，不重做原五步故事。实机门禁已补齐，接下来进行已授权的提交、
合并、生产迁移、能力回滚、备份验证及默认启用；本节完成时生产尚未更新。

### 2.38 Phase 3 双主线合并与生产部署（2026-10-01）

用户的新版 Mac 验收与生产发布授权持续有效。本轮实现提交为
`6263451d7df9e20045e7966b798d5f29480d65d9`，没有重跑已通过的模型矩阵或真人故事。

- GitHub [#20](https://github.com/Defector-12/violet/pull/20) 合入
  `50028ef301cd7bf143aa47c57e71443cf08a592a`。
- Codebase [!37](https://code.byted.org/user/violet/merge_requests/37) 合入
  `60a8cfe87099c09c64c430d2743d6b32cc9e2576`。
- 实现提交与双主线 tree 均为 `1e872f56b3cdc06d5ce0cf203aa1a43671755ef3`，
  独立核对 run `0b494be4-98f3-4eb0-b90f-034e3f4a088d`。
- Codebase 自动检查通过；未配置 Pipeline，Aime 仍为 neutral，GitHub 没有状态检查。
  默认 review 按既有个人仓库流程记录 `no_need_for_review`，未修改保护规则。
  合并状态、例外和合并记录分别为 `b45a1822-5e9f-4d9d-805a-e65c327b4bfc`、
  `13838f66-85ff-4a7a-84a1-e981eecf289b`、`fd650bbe-f31a-4040-8bf8-5d9dd8a900cf`。
- 确定提交的 workspace 构建通过：`fc09bc8b-54f6-4880-a4f0-f0294034249d`。
  重新生成协议通过且相对 HEAD 无差异：`1f8845cf-0ddc-43e8-8984-42322ede708f`。
  Mac hash 与 2.35—2.37 相同。本轮沿用相同源码的 611 项回归及 121 项 Mac 证据。

运行版本为 **`6263451-release-1d-phase3`**，部署目录为
`/data00/home/baojunhan/violet-release-6263451-release-1d-phase3`。
发布包来自已提交源码，包含 496 个运行时/Schema/迁移产物指纹，未打包本地秘密或验收记录。
依赖未变化，复用既有基础镜像；同时替换全部运行时 workspace 产物，并按部署 UID
验证备份模块加载。构建 run `5749535b-8553-40dd-97c9-232bd6e2a82e`。

| 产物 | SHA-256 |
| --- | --- |
| 发布归档 | `9fc7e281431ab7f0cdfb18cf34dd32e14f29b1c8812b08e82fc3f160a4b3083b` |
| Core 镜像 | `a5ba9adf5ed53227419456895adbc124cf4c142475e339bf71ae3076471fc786` |
| backup / backup-upload 镜像 | `6129eb936b0c19c40dbf7d012a8110f4642c0e0ffa3515df0a2a06c96a04c7d5` |
| Mac 主二进制 | `a9e8096a02a5536aa6d1f140723f040f23be220677b4ec0cddf7c5986e87ab1b` |

生产预检 `5153bdb9-b486-44d7-a2c1-0fd6b376209a` 确认旧版健康、零重启。
维护窗口暂停 Core 和备份调度，保留并上传升级前 schema 2 加密备份
`20261001T043040Z-a8985cfc-6663-416f-8c32-cbbfcac70653.vltbk`，
密文 hash `6bf3d30dd78b7ac8fb64ae4598adc4b16f036c8d0602f9034e8eb27563efb5a8`。
首次通过 stdin 传入远端脚本时，backup-upload 继承并消耗剩余脚本文本，进程退出 0
但没有完成部署；独立 REVIEW 标记 run `d8db9977-b8f7-4df4-9e75-eb34e95777f5` 为
未完成，原输出和退出码保留。随后上传脚本文件并关闭 SSH stdin，从已保存备份处继续，
没有覆盖备份记录或重新生成假成功结果。

续行 run `a0a2b4d6-1272-46f0-9507-48a082ad09fe` 完成 `0004_memory_jobs.sql`，
新 Core 健康、零自动重启。迁移前后实例
`2938b3dd-6781-49cd-8b93-ab9e74f22ac2` 的事件均为 **1,113**，memory revision 和
restore epoch 均为 **0**；记忆、任务与带自动学习标记的旧事件均为 **0**。
自动学习初值 false、settings revision 0。鉴权 API、设置幂等重放和九组运行产物
树哈希均通过：`5b19be6a-1a56-454c-95c0-7e5f002d11a9`。

迁移后备份为 `20261001T043202Z-10a219b7-ce61-4fe6-a4f1-21d795f94038.vltbk`，
密文 hash `47f5da8c42ffbc49f3c830d2d7ab9fbd2dedb74146d28b895a78fac79b8e4852`，
明文 dump hash `91651424a3f448c90e6876d249c6ec15cacce52c5734554945019d160654f49d`；
加密校验与 TOS 上传均成功。每日 03:17 备份和每分钟清理 cron 已指向新发布目录。
本次无待删除记录；不将空队列检查冒称生产删除清理实测。

实际关闭记忆注入并重建同版本 Core 的 run 为
`c7df7b04-02a7-4385-a917-66eda46f5223`；关闭状态下健康、鉴权列表、版本化设置和
幂等重放均通过（`33b3cefc-45b8-46f9-a3ff-d18b078edb87`），旧历史零回填，
全部纪元不变。自动学习始终关闭，开启/关闭的真实任务行为沿用 2.36 的隔离 Core
实测。能力回滚保留 0004 和治理能力，不回退数据库或恢复删除前备份。
随后恢复 `VIOLET_MEMORY_INJECTION_ENABLED=true`：
`d42de715-437d-4771-b181-17434283418f`。恢复后的鉴权 API、开关幂等和数据库核对
通过（`85c4232c-7865-4f51-a406-b4dd4c15b34b`）；最后生产只读检查
`8111667c-c472-4c7c-9ca0-5d4227508f3c` 再次确认新镜像、0004、健康、零自动重启及
新备份调度。这里的零重启为 Docker RestartCount，另有本节明确记录的配置切换重建。

**当时待完成的本机收尾（已于 2.39 补齐）。** Agent 读取真实恢复保护 Keychain 被沙箱拒绝，错误
`RestoreEpochError.keychain(100013)`，run `f54f040c-9cfa-41af-a415-4c9ef971d9a4`。
这不是生产恢复数据失败；本轮尚未进行生产备份的官方隔离恢复或启动正式 Mac。
普通终端入口见 [Phase 3 生产激活](./testing/phase3-real-acceptance.md#生产激活收尾)。
脚本使用真实 Keychain 和官方恢复入口，只向无网络、无持久卷的独立临时 PostgreSQL
容器恢复；通过并清理后才调用版本化 API 启用自动学习并启动已验签 Mac。
不得以旧 Phase 2 的恢复证据替代本轮新备份的实际恢复，也不将命令准备完成当作执行完成。
本轮未调用模型，实机预算仍为 **36/40 次、0.084182/1 元**。

### 2.39 官方恢复、自动学习启用与正式 Mac 激活完成（2026-10-01）

用户在普通终端执行 `.local-acceptance/phase3-finish-mac.mjs`，run
`9c42c72c-7446-4404-9312-a3e20bb69bc1` 完整通过。该 run 基于干净提交
`97ccb08cac957759932e5f9eca6d69131768c479`；其源码与已部署实现 6263451 一致，
仅增加交付文档。App 严格验签、helper hash、真实 Keychain 最低纪元写入及回读、
Mac 设备凭据与生产部署凭据匹配检查均通过；凭据值未进入记录。

`scripts/restore-backup.sh` 成功解密 2.38 的迁移后 schema 2 备份，密文与明文 hash
均匹配。仅向无网络、无持久卷的独立临时 PostgreSQL 容器恢复，未覆盖生产数据库。
恢复库包含 `0004`、1,113 条事件，记忆/任务/旧事件自动学习标记均为 0，恢复纪元为 0。
临时容器删除退出 0，明文 dump 已移除；清理完成后才进入自动学习启用步骤。

启用的独立 run 为 `9a0db7ab-1222-4f00-97c4-11b560769a64`。鉴权
`POST /v1/memory-settings` 请求 `4e460b0a-7059-4530-9b29-eb3a43c68744` 以
expectedRevision 0 将 enabled 从 false 改为 **true**、revision 改为 **1**；
相同请求重放与 GET 回读均返回相同设置。memory revision 与 restore epoch 仍为 0，
启用后旧历史标记和任务仍为 0，没有补提取上线前事件。

已验签的正式 Mac 启动成功，进程 49072 对应 2.38 的 App 路径，经生产连接读到
enabled true、revision 1。启动等待记录保留在 `startup.ndjson`；本节证明正式进程、
凭据和生产连接激活，UI 交互验收仍引用 2.35—2.37，不冒称新增 UI 或语音测试。

独立复核 `84e37087-0148-469a-8695-31df2b9628d6` 校验原始命令/API、清理先于启用、
临时容器和明文已不存在，并只读确认生产版本 `6263451-release-1d-phase3` 健康、
自动学习开启、settings revision 1、恢复纪元 0。原始结果未改写，复核另存文件指纹。
没有新增模型调用，实机预算仍为 **36/40 次、0.084182/1 元**。

本机收尾门禁已关闭，Release 1D 三阶段完成交付。原失败、矩阵分布、后续定向修复与
最新提示未重跑完整矩阵的范围限制继续保留；不要求用户再次运行激活入口或真人故事。

## 3. P0：事实与来源

第 3—11 节同时包含 Phase 2 与 Phase 3 的验收合同。自动提取、自动记忆开关和
`0004` 明确属于 Phase 3；它们不作为 Phase 2 独立交付的前置。勾选只表示所引用
环境与样本的证据通过，不表示已迁移或部署生产，也不把历史失败从分布中排除。

- [x] PostgreSQL `conversation_events` 仍是唯一原始事实源（2.10、2.25）。
- [x] 文件系统不存在可反向覆盖 PostgreSQL 的记忆事实（2.10、2.25）。
- [x] 上线前历史没有被自动回填为长期记忆（2.10、2.14）。
- [x] 每条记忆至少有一个仍存在的最终用户事件来源（2.10、2.25）。
- [x] 每个来源 quote 与用户原文逐字匹配（2.18—2.19、2.25）。
- [x] 负例中助手、工具、视觉、临时语音和取消语音单独成为用户事实的数量为 0（2.19、2.25）。
- [x] 重试不会为同一来源创建重复版本（2.10、2.25）。
- [x] 多来源记忆删除一个来源后可保留，最后一个来源删除后消失（2.10、2.25）。

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
- [x] Core 重启后会终止化遗留的 user-only 轮次，运行时失败标记写入失败会持续重试。
- [x] Core 关闭会先有界排空 Realtime 会话和持久化队列，再关闭数据库。
- [x] 同一数据库只允许一个生产 Core 持有 advisory lease。
- [x] 同一 turn 的重试由 attempt ID 隔离，旧 attempt 的迟到输出不会污染当前轮次。
- [x] Qwen 文字重试不会重复创建 provider item 或已成功请求的 response。
- [x] 关闭 checkpoint 后不读取或写入此前持久化的 checkpoint。
- [x] Release 1C 的视觉新鲜度、取消和隐私行为无回归。

## 5. P0：写入和隐私

### 5.1 明确记忆

40 条样本覆盖文字、最终语音、中英文、纠正和受控敏感授权：

- [x] 明确写入 120/120，纠正 30/30（2.18—2.19；语音另见 2.20—2.24）。
- [x] 已验收样本的内容、类型、来源和原文引用正确（2.18—2.19）。
- [x] 本轮完成前可以在记忆入口看到变化（2.12、2.21—2.24）。
- [x] 最终转写来源可见且可在同一路径删除（2.21—2.22；验证治理路径，未人为诱发 ASR 误识别）。
- [x] 写入失败时声称“已经记住”的次数为 0（2.18 真实 Qwen 存储失败及 2.25 回归）。
- [x] 已测纠正后旧版本作为当前事实使用的次数为 0（2.19—2.25）。
- [x] 删除纠正来源后旧版本复活次数为 0（2.10、2.25）。

### 5.2 自动记忆（Phase 3，质量与 Mac 实机通过，生产已部署并启用）

持久任务、提交与开关合同的本地证据见 2.29，评估准备见 2.30，完整真实复验见 2.32；
100 条标注普通轮次，每条真实模型运行 3 次：

- [x] `precision = 正确写入数 / 全部写入数 >= 95%`（189/195，96.92%）。
- [x] `recall = 正确写入的应记项 / 全部应记项 >= 80%`（189/192，98.44%）。
- [x] 健康环境从轮次完成到记忆可见 p95 不超过 60 秒（Core 5.079 秒；不含 Mac 刷新/网络）。
- [x] 自动提取取代旧版本的次数为 0（2.32；冲突负例也零新建）。
- [x] 关闭后的 20 个完成轮次新增记忆数为 0（2.30，本地持久任务故事）。
- [x] 重开后对这 20 个轮次的补提取数为 0（2.30，含重放及任务恢复）。

### 5.3 敏感负例

- [x] 敏感负例中密码、验证码、Token、私钥写入记忆或派生内容的数量为 0（2.14、2.19）。
- [x] 绝对秘密发送给记忆提取模型的数量为 0（2.19）。
- [x] 普通受控敏感内容自动写入和发送后台提取的数量均为 0（2.11、2.25；Phase 3 本地真实矩阵见 2.32）。
- [x] 明确受控敏感内容按用户原话加密保存，不调用提取模型（2.10、2.25）。
- [x] 受控敏感正文默认遮挡（2.12、2.25）。
- [x] 已测负例中助手推断冒充用户事实的数量为 0（2.19、2.25）。
- [x] 记忆没有扩大工具、外部发送、现实行动或数据访问权限（2.11、2.25）。

## 6. P1：检索

- [x] `recall_memory` 每次最多返回 5 条（2.11、2.25）。
- [x] 当前记忆召回率不低于 80%：本地给定关键词的非敏感记忆 36/36（2.14；不冒称模型选词准确率）。
- [x] 50 条明确历史用例三次 Top-5 来源命中 146/150，三轮均高于 90%（2.19，含最多三轮检索）。
- [x] 本地搜索四组 p95 均低于 300 ms，完整分布见 2.14；不外推生产网络。
- [x] 时间范围边界正确（2.14）。
- [x] 旧历史可明确召回，但不会被自动转为长期记忆（2.14、2.19）。
- [x] 20 条无关历史各三次，60 次零目标编造、零无关披露（2.19）。
- [x] 无结果时返回 `not_found` 并诚实说明；最后表述修复定向 21/21、真人删除后问答通过（2.19、2.24）。
- [x] 已测样本中无来源私人事实被补造为记忆的数量为 0（2.19）。
- [x] summary 版本不匹配时使用次数为 0（2.11、2.25）。

## 7. P0：纠正与删除

- [x] 纠正创建新版本，旧版本在同一事务失效（2.10、2.25）。
- [x] 自然语言“忘掉”只生成删除预览，不直接删除（2.19、2.25）。
- [x] 模型只能提议删除目标，不能执行删除（2.11、2.25）。
- [x] Core 只接受当前实例中的真实 ID（2.10、2.25）。
- [x] 确认页展示完整来源轮次和全部受影响版本，敏感正文仍遮挡（2.12、2.22、2.25）。
- [x] 状态变化后旧预览不能继续确认，409 可被 Mac 正确识别并允许重新预览（2.25）。
- [x] “关闭自动记忆”不会删除内容（2.30，本地 20 轮开关故事保留已有记忆）。
- [x] “清空已学习记忆”始终单独确认（2.12、2.25）。
- [x] 删除后目标 user/assistant 轮次、来源关系和无来源记忆均消失（2.16、2.21、2.25）。
- [x] 删除后 summary、checkpoint、搜索和迟到任务继续使用目标的次数为 0（2.16、2.24—2.25）。
- [x] 并发失败时事务完整回滚，不出现半删除（2.10、2.25）。
- [x] 删除审计不包含正文或可恢复语义（2.10、2.25）。

## 8. P0：备份恢复

- [x] 删除确认前，Mac 已把下一 `minimum_restore_epoch` 写入 Keychain（2.16、2.21）。
- [x] Keychain 写入失败时删除确认请求数量为 0（2.12、2.25 故障注入）。
- [x] 备份认证内容包含自身 `restore_epoch`，篡改后校验失败（2.13、2.25）。
- [x] 官方恢复在写出 dump 前拒绝低于 Keychain 最低纪元的备份（2.16）。
- [x] 删除后生成并验证新的干净备份（2.16）。
- [x] 本次隔离的 Violet 管理目录中旧本地备份数量为 0（2.16；生产部署另验）。
- [x] 本次隔离 TOS 前缀中旧 object version、delete marker 和未完成分片数量为 0（2.16）。
- [x] 清理失败不回滚在线删除，官方恢复仍拒绝旧备份（2.13、2.16、2.25）。
- [x] 使用删除后备份经官方入口隔离恢复，event、memory、summary、checkpoint 和搜索复活数量均为 0（2.16）。

## 9. P1：Mac 记忆窗口

- [x] 窗口独立于聊天 popover（2.12、2.21）。
- [x] 入口变化标记可见，不弹 toast 或新增聊天气泡（2.12、2.25）。
- [x] 当前记忆、近期变化、搜索、筛选和来源详情可用（2.12、2.21—2.22）。
- [x] 用户可纠正、删除和单独确认清空（2.12、2.21、2.25）。
- [x] 自动记忆开关关闭只停止新增（2.36 真实 Core 合同复验，2.37 Mac 自动来源短补验）。
- [x] 受控敏感正文默认遮挡（2.12、2.25）。
- [x] 删除成功后清除当前聊天展示缓存，并阻止迟到输出填回（2.25）。
- [x] 真人所用尺寸下来源显示体感正常（2.22、2.24；未做多尺寸截图矩阵）。
- [x] 用户确认 VoiceOver、键盘及取消删除正常（2.22）。

## 10. 自动化回归

每条命令必须生成独立 test-run，退出码为 0：

```sh
fnm exec --using=.node-version -- pnpm test:record pnpm check:ci
fnm exec --using=.node-version -- pnpm test:record pnpm eval:phase1-checkpoints
fnm exec --using=.node-version -- pnpm eval:memory
fnm exec --using=.node-version -- pnpm macos:test
fnm exec --using=.node-version -- pnpm test:record pnpm macos:app
fnm exec --using=.node-version -- pnpm test:record docker compose -f infra/compose/compose.yaml config --quiet
```

另有独立记录证明：

- [x] Phase 2 空 schema、隔离恢复库及已有事件数据升级到 `0003` 通过
  （`0001 → 0002 → 0002b → 0002c → 0003`；2.10、2.13、2.14）。
- [x] Phase 3 本机空 schema 及既有数据升级到 `0004` 通过（2.29；未迁移生产）。
- [x] PostgreSQL 本地并发、回滚、重启服务后读取和隔离恢复/删除竞态通过（2.10—2.14）。
- [x] OpenAPI 再生成前后内容 hash 一致（2.14、2.25）；生成物已提交，提交后相对 HEAD
  无差异检查通过（2.26）。
- [x] backup 旧/新格式、TOS 清理和官方恢复脚本通过（2.13、2.16、2.25）。
- [x] 真实模型矩阵保留每条 3 次结果；Qwen 的全部故事尝试和失败另行列明（2.19—2.21）。

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

- [x] 十步覆盖有发送、接收、关联 ID、状态与结果证据，分布于 2.16、2.21—2.24；不冒称同一 run 一次全部成功。
- [x] Phase 2 剩余三项实机缺口已补齐，记录与用户体感一致（2.24；前序恢复、治理及窗口证据见 2.16、2.21—2.22）。
- [x] 用户无需搬运上下文或选择会话（2.24 重启及文字/语音切换）。
- [x] 无结果时诚实表达（2.24 删除后问答）。
- [x] 用户确认来源显示、键盘/VoiceOver、取消删除正常，最终短验收体感通过（2.22、2.24）。

## 12. Release 1D 全阶段发布门禁

这里保留当时三个阶段全部完成后的总门禁；Phase 2 独立交付合同现见
[规格](./release-1d-spec.md)。提交、合并及生产迁移/部署另需明确授权。

- [x] 三个 Phase 的合并门全部通过，Phase 3 已合入双主线（2.38）。
- [x] 所有 P0 和 P1 项有可检查证据且无未决失败；历史失败及复验分别保留（2.10—2.39）。
- [x] 真实供应商评估达到门槛，真实 Mac 完成最终故事（2.32—2.37；范围与后续定向复验分别记录）。
- [x] 旧备份恢复被拒绝，新备份恢复不复活（2.16、2.36）；本次生产备份官方隔离恢复通过（2.39）。
- [x] 实际 commit、构建、部署、失败和 run ID 已写回本文（2.38—2.39）。
- [x] Phase 1 两轮审查加固已提交、合入主线并重新部署，运行版本为
  `d311e1a-release-1d-phase1-final`。
- [x] Phase 1 第三轮审查修复已提交、复审、合入双主线并重新部署，运行版本为
  `a6389f6-release-1d-phase1-review3`。
- [x] Phase 1 第四轮审查修复已提交、复审、合入双主线并重新部署，运行版本为
  `1ee90fe-release-1d-phase1-review4`。
- [x] Phase 1 第五轮最终门禁修复已提交、复审、合入双主线并重新部署，运行版本为
  `66ead81-release-1d-phase1-final-gate`。
- [x] Phase 1 复盘后的请求清理修复与精简已合入双主线并重新部署，运行版本为
  `414fd54-release-1d-phase1-runtime-fix`。
- [x] Phase 2 已合入双主线并部署，`0003`、备份调度、Mac 激活与生产备份官方隔离
  恢复完成，运行版本为 `b3fa62c-release-1d-phase2`（2.26—2.27）。
- [x] Phase 3 已合入双主线并部署，`0004`、备份调度与注入能力回滚通过，
  运行版本为 `6263451-release-1d-phase3`（2.38）。
- [x] Phase 3 生产备份官方隔离恢复与正式 Mac 激活完成（2.39）。
- [x] 用户明确批准后，生产自动记忆已通过版本化 API 开启，settings revision 1（2.39）。

关闭自动提取、记忆注入或 checkpoint 可以回滚能力；任何回滚都不得降低
`restore_epoch`、恢复旧版本或重新关联已删除来源。
