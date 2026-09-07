# 开发规则待审清单

> 2026-09-06。按用户要求只盘查，不删除或改写现有 skills。本文是审查结果，不是新增强制流程。

## 范围与结论

仓库及其父目录没有找到 `agent.md`、`AGENTS.md` 或 `CLAUDE.md`。
项目中有 25 个 `.trae/skills/*/SKILL.md`，合计约 7,600 行；全局还存在同职能 skills。
这些正文不是每轮全部加载，但“任何代码修改都触发”的宽泛描述会让多个流程同时命中。
问题不在于缺少更多规则，而在于默认流程过多、重复阻塞和与真实工具不匹配。

## 优先处理

| 位置 | 可核实问题 | 影响与建议 |
|---|---|---|
| 全局 `TRAE-debugger/SKILL.md`；`guides/workflow.md` 第 6、9、10 步 | 强制用户操作复现、每次清空日志、仅用户确认后清理；总则允许文字选项，细则禁止文字选项且强制不存在的 `AskUserQuestion` | 本次反复交还用户和证据被覆盖的直接流程诱因。建议禁用此自动触发流程，保留“假设、证据、修复、回归”的原则；默认由 agent 回放，仅最终验收或权限缺口询问用户。 |
| 同 skill 的 `guides/logging.md` | 禁止原生日志，强制 HTTP 收集器和内联一行代码，禁止公共辅助函数 | 与现有结构化日志重复；临时 IP、无超时 fetch、格式豁免进入业务代码，重启收集器还出现自动换端口。建议删除这组形式要求，用项目已有日志和明确启用的私有回放。 |
| `.trae/skills/git-workflow-and-versioning/SKILL.md:170,189` | 失败就删除 worktree，示例推荐 `git reset --hard HEAD` | 脏工作区下可能毁掉用户未提交工作。删除这两个破坏性恢复示例，保留原子提交和显式回滚。不要为“规整”重写已推送历史。 |
| `.trae/skills/*/SKILL.md` 中 `../../references/*.md` | 19 处引用指向不存在的 `.trae/references/`，涉及 7 种参考文件 | 完成标准、安全、测试等指导实际上无法读取。补齐经审查的必要文件，或删除断链；不要自动安装整个工具包来填补。 |
| `.trae/skills/using-agent-skills/SKILL.md:67-70`、`context-engineering/SKILL.md:223` | 任何不一致或没有先例都要求停下询问 | 将可从源码验证的小问题变成用户决策。改为只有权限、安全、不可逆操作或重大产品歧义才阻塞，其余说明假设后验证。 |
| `.trae/skills/test-driven-development/SKILL.md`、`incremental-implementation/SKILL.md` 的“不变代码不重复测试” | 对确定性单测合理，但没有排除随机模型、并发和性能抽样 | 会妨碍同图多次回放测稳定性。明确区分确定性回归与统计评估；后者必须记录全部尝试，不能挑最好一次。 |
| `.trae/skills/doubt-driven-development/SKILL.md:114-164` | 每次交互式审查都要提出跨模型选择，并确认 CLI 调用；引用的编排规范缺失 | 对常规实现增加多轮确认和上下文成本。保留为用户显式要求的高风险审查，不作为所有非平凡修改的默认流程。 |
| `.trae/skills/source-driven-development/SKILL.md:10,143` | 每个框架模式都要求查官方资料、逐项引用 | 已有代码模式和安装版本 API 可以本地确认时仍增加检索。建议只在新 API、版本变化、行为不确定时触发，安全边界仍需核实。 |
| 全局 `ponytail/SKILL.md` 的 Persistence、Output、test 规则 | 声明跨回复常驻、偏向一行实现、限制测试框架/fixture；与项目 TDD、可读性和用户要求详细分析存在重叠 | 保留 stdlib、最小实现原则；删除常驻、输出长度和一刀切测试限制。本次回放 fixture 是必要证据，不是过度设计。 |

## 重复能力

- `using-agent-skills`、`context-engineering`、`karpathy-guidelines`、`ponytail`、
  `incremental-implementation` 重复要求理解、简化、限定范围、验证。
  建议默认只留一份简短工程约定，其余按需调用。
- `interview-me`、`idea-refine`、`spec-driven-development`、`planning-and-task-breakdown`
  与全局 `think`、`pm-product-discovery` 部分重叠。明确区分产品探索与已授权实现，
  不要在明确修复请求中重新开始完整访谈、规格、审批流程。
- `TRAE-code-review`、`bits-code-guard`、`code-review-and-quality` 的审查入口重叠；
  动态 UI 与浏览器 skills 也有重复入口。建议每种任务选一个主入口，其他按专长显式调用。
  无关数据库、小程序等 skill 不应因安装存在就被调用，但“本次没用到”不是删除依据。

## 项目文档问题

- `engineering-roadmap.md` 的 1C 旧段落允许暂停验收后继续合并，
  但 1C.1 与验收文档禁止合并 MR !20。旧许可必须标为历史、由当前门槛取代。
- 五份文档重复维护部署哈希、测试计数、账本数量；诊断版部署后仍写 `490b26c`。
  用一处验收状态作为当前事实源，其余链接过去，历史证据加日期。
- “缺少 target.text”是一次拒绝原因，不是完整根因；“框包含鼠标”也不是正确识别证明。
  不能把 prompt 字符串断言通过写成模型准确率通过。
- “截图不持久化”应准确表述为产品默认不保留原始截图；用户明确授权的本地诊断样本
  必须限定来源、用途、权限和留存期限，不能默认为全天录屏或永久缓存。
- 产品宪法是 Violet 的目标与权限约束，不代表未来记忆、任务、删除传播等能力已经实现，
  也不应被解释为开发助手可自动安装 skills 或扩权的授权。

## 建议保留

保留隐私过滤、绝对秘密阻断、明确授权、最低置信度、当前轮次绑定、失败关闭、
不损坏用户工作、测试与真实证据、用户最终验收权。应删除的是重复和不适用的流程形式，
不是把质量、安全或证据标准降低。
