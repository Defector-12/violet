# Violet macOS

Release 1B 已交付、Release 1C 正在验收的原生 Mac 身体。它负责菜单栏、全局快捷键、Keychain、连接状态、设备音频、本地唤醒和受控视觉感知，不承载 Violet 的身份、记忆或固定模型供应商。Qwen 是当前默认实时运行时，Pipeline 可由 Core 显式配置启用，Mac 状态机不随运行时改变。

## 验证

```bash
pnpm macos:test
pnpm macos:wake-assets
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

`excludedContextBundleIds` 可增加本机保密应用的 Bundle ID。该列表仅保存在 Mac 本地配置，不进入 Context、Core 或日志。

设备令牌从 `.env` 一次性迁移到 Keychain：

```bash
pnpm macos:migrate-token
```

迁移工具通过 stdin 传递令牌，不将令牌写入命令参数或日志。Keychain service 为 `com.violet.device-token`，account 为 `violet`。

## 测试隔离

`VIOLET_TEST_MODE=1` 时使用静音音频、空唤醒、空全局快捷键和空 SSH 转发器。单元测试不会占用真实麦克风、播放声音、注册系统快捷键、读取屏幕、锁屏或控制其他应用。

确定性 Realtime Adapter 仅用于协议和状态机验证。Qwen 与 Pipeline 已通过工程路线中的 Release 1B 决策门；更换默认运行时仍需重新执行对应比较和验收。

真实设备批量验收使用本地、默认关闭的元数据记录器。启动方式、30/30/50 样本矩阵和报告命令见 [Release 1B 实时语音验收](../../docs/release-1b-acceptance.md)。记录不包含音频、转写或回复内容。

## 音频会话

用户只能通过浮层中的麦克风按钮主动启动音频会话。App 先连接
`RealtimeSession` 并检查服务端能力；只有服务端声明支持音频输入后，才请求
macOS 麦克风权限并启动 `AudioIOPort`。会话启动后由 `smart_turn` 自动断句并持续多轮监听；播放回复时再次点击会取消当前回复，其余监听状态下再次点击会结束会话。

关闭浮层、退出 App、锁屏或睡眠会立即停止采集和播放并关闭 Realtime
会话。运行时不支持音频时会明确显示不可用，不会请求麦克风权限或上传音频。

## Context 与本地唤醒

浮层中的 Context 菜单支持 Accessibility 选中文本、系统窗口/显示器选择和区域框选。原始图片先在 Mac 使用 Apple Vision OCR 和本地规则遮挡，再装入五分钟有效的 Context Envelope。关闭浮层、锁屏、睡眠、撤权或主动清除会删除当前 Context。

Wake 开关默认关闭。开启后，`sherpa-onnx` 只在本地监听关键词 `Violet`；唤醒前 PCM 不写盘、不上传、不记录。检测成功后 KWS 先停止，再显示浮层、播放“我在”并启动现有 Realtime 会话。模型和动态库下载到被 Git 忽略的 `.local-wake/`，打包时复制进 App Resources。

真实权限和视觉验收见 [Release 1C Violet Sight 验收](../../docs/release-1c-acceptance.md)。
