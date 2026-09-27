# Violet

单用户私人智能体项目。当前可用入口为原生 macOS 菜单栏 App 和文字开发 CLI；
云端 Core 负责对话、模型调用、加密事件与短时视觉上下文。

Release 1A/1B/1C 已完成产品验收；Release 1D Phase 2 明确长期记忆、来源查询、
纠正删除和备份恢复保护已验收并部署，Mac 激活与生产备份官方隔离恢复已通过。版本与证据见
[当前状态](./docs/release-1d-acceptance.md)。普通对话自动记忆、持久任务、Worker
和浏览器扩展属于后续目标。

## 开发

本地 Node.js 版本以 `.node-version` 为准，pnpm 要求以根 `package.json` 为准；
Mac 需要支持 Swift 6.1 的开发工具链。通过 `fnm exec` 使用仓库版本，避免继承旧的
Shell 环境。依赖版本与安装脚本策略以 lockfile、`pnpm-workspace.yaml` 为准。

```bash
fnm exec --using=.node-version -- pnpm install --frozen-lockfile
fnm exec --using=.node-version -- pnpm test:record pnpm check:ci
fnm exec --using=.node-version -- pnpm macos:test
fnm exec --using=.node-version -- pnpm test:record pnpm macos:app
```

Mac 配置、权限、启动与一次性失败样本录制见 [Mac README](./apps/macos/README.md)。
测试留证与保留期见 [Test Evidence](./docs/testing/README.md)。
实际模型调用需要既有秘密源；不要将 API Key 放进源码、命令参数、日志或回放样本。

## 项目结构

| 路径 | 当前职责 |
|---|---|
| `apps/macos` | 原生交互、音频、AX/截图、本地隐私过滤、记忆治理与恢复保护 |
| `apps/dev-cli` | 经 SDK 访问 Core 的文字调试入口 |
| `services/core` | HTTP/Realtime、模型 Adapter、统一上下文、加密账本与记忆治理 |
| `services/backup` | 加密备份、上传、旧副本清理与官方恢复校验 |
| `packages/domain`、`policy` | 领域类型与确定性策略 |
| `packages/protocol`、`sdk` | Schema/OpenAPI、生成物与客户端 |
| `packages/crypto`、`backup` | 加密和备份格式 |
| `infra`、`scripts` | Compose、迁移、观测、部署和验收工具 |

## 文档入口

- [Release 1D 当前状态](./docs/release-1d-acceptance.md)：当前开发、部署与测试证据。
- [Release 1C 验收](./docs/release-1c-acceptance.md)：视觉与 Natural Pointing 基线。
- [Natural Pointing](./docs/natural-pointing-handoff.md)：当前实现合同与边界。
- [历史记录](./docs/历史记录.md)：阶段变化，不代替当前健康状态。
- [架构方向](./docs/architecture-direction.md)、[工程路线](./docs/engineering-roadmap.md)：
  已实现边界与未来方向。
- [产品宪法](./docs/product-philosophy-and-constitution.md)：产品与授权原则，不是实现清单。

诊断图片、秘密、本地日志和构建产物不进入 Git 或 Docker 构建上下文。
不强推共享历史，不损坏其他人的工作区。
