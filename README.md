# Violet

单用户私人智能体项目。当前可用入口为原生 macOS 菜单栏 App 和文字开发 CLI；
云端 Core 负责对话、模型调用、加密事件与短时视觉上下文。

Release 1A/1B 已交付；1C Sight 与 1C.1 Natural Pointing 仍是候选，终端精确选区
尚未通过验收。长期记忆、持久任务、Worker 和浏览器扩展属于后续目标，不是现有能力。

## 开发

需要 Node.js 22.16+ 或 24、pnpm 11.21.0，以及支持 Swift 6.1 的 macOS 开发工具链。
依赖版本与安装脚本策略以 lockfile、`pnpm-workspace.yaml` 为准。

```bash
pnpm install --frozen-lockfile
pnpm check:ci
pnpm macos:test
pnpm macos:app
```

Mac 配置、权限、启动与一次性失败样本录制见 [Mac README](./apps/macos/README.md)。
实际模型调用需要既有秘密源；不要将 API Key 放进源码、命令参数、日志或回放样本。

## 项目结构

| 路径 | 当前职责 |
|---|---|
| `apps/macos` | 原生交互、音频、AX/截图、本地隐私过滤 |
| `apps/dev-cli` | 经 SDK 访问 Core 的文字调试入口 |
| `services/core` | HTTP/Realtime、模型 Adapter、Context 和对话持久化 |
| `services/backup` | 加密备份上传 |
| `packages/domain`、`policy` | 领域类型与确定性策略 |
| `packages/protocol`、`sdk` | Schema/OpenAPI、生成物与客户端 |
| `packages/crypto`、`backup` | 加密和备份格式 |
| `infra`、`scripts` | Compose、迁移、观测、部署和验收工具 |

## 文档入口

- [当前部署与验收状态](./docs/release-1c-acceptance.md)：唯一维护动态版本与测试结果的位置。
- [Natural Pointing 交接](./docs/natural-pointing-handoff.md)：实现约束与下一步。
- [终端误识别诊断](./docs/diagnostics/terminal-selection-ungrounded.md)：失败证据和回放边界。
- [历史记录](./docs/历史记录.md)：阶段变化，不代替当前健康状态。
- [架构方向](./docs/architecture-direction.md)、[工程路线](./docs/engineering-roadmap.md)：
  已实现边界与未来方向。
- [产品宪法](./docs/product-philosophy-and-constitution.md)：产品与授权原则，不是实现清单。
- [开发规则待审](./docs/development-rules-review.md)：供用户决定删改，不是新增强制流程。

诊断图片、秘密、本地日志和构建产物不进入 Git 或 Docker 构建上下文。
不强推共享历史，不损坏其他人的工作区；MR !20 在完整验收通过前保持 Draft。
