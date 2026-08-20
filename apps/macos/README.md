# Violet macOS

Release 1B 的原生 Mac 身体。它负责菜单栏、全局快捷键、Keychain、连接状态和设备音频，不承载 Violet 的身份、记忆或固定模型供应商。

## 验证

```bash
pnpm macos:test
pnpm macos:app
```

生成的本地应用位于：

```text
apps/macos/.build/app/Violet.app
```

应用使用 ad-hoc 签名，仅用于当前 Mac 开发和验收。正式分发前再配置 Apple Developer 签名与公证。

## 本地配置

客户端默认访问 `http://127.0.0.1:14310`。可选 SSH 隧道配置保存在 Mac 本地，不进入 Git：

```bash
pnpm macos:configure -- <ssh-host>
```

配置文件为 `~/.config/violet/client.json`，格式参考 `client.example.json`。App 通过系统 `/usr/bin/ssh` 使用现有 SSH 配置和 `known_hosts`，启用 `BatchMode` 与 `ExitOnForwardFailure`，不会保存 SSH 私钥或口令。

设备令牌从 `.env` 一次性迁移到 Keychain：

```bash
pnpm macos:migrate-token
```

迁移工具通过 stdin 传递令牌，不将令牌写入命令参数或日志。Keychain service 为 `com.violet.device-token`，account 为 `violet`。

## 测试隔离

`VIOLET_TEST_MODE=1` 时使用静音音频、空全局快捷键和空 SSH 转发器。单元测试不会占用真实麦克风、播放声音、注册系统快捷键、锁屏或控制其他应用。

当前确定性 Realtime Adapter 仅用于协议和状态机验证。真实 Pipeline 或端到端语音模型必须通过工程路线中的运行时决策门后再接入。
