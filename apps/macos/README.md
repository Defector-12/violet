# Violet macOS

原生 Mac 身体已完成 Release 1B/1C/1D 验收。它负责菜单栏、快捷键、
Keychain、连接状态、设备音频、本地唤醒、受控视觉感知和记忆管理；身份与记忆的事实源
仍在 Core。Qwen 是默认实时运行时，Pipeline 可由 Core 显式配置启用，Mac 状态机不随
运行时改变。当前交付证据见 [Release 1D 验收](../../docs/release-1d-acceptance.md)。

## 验证

```bash
fnm exec --using=.node-version -- pnpm macos:test
fnm exec --using=.node-version -- pnpm macos:wake-assets
fnm exec --using=.node-version -- pnpm test:record pnpm macos:app
```

生成的本地应用位于：

```text
apps/macos/.build/app/Violet.app
```

应用使用 ad-hoc 签名，仅用于当前 Mac 开发和验收。正式分发前再配置 Apple Developer 签名与公证。

## 本地配置

客户端默认访问 `http://127.0.0.1:14310`。可选 SSH 隧道配置保存在 Mac 本地，不进入 Git：

```bash
fnm exec --using=.node-version -- pnpm macos:configure -- <ssh-host>
```

配置文件为 `~/.config/violet/client.json`，格式参考 `client.example.json`。App 通过系统 `/usr/bin/ssh` 使用现有 SSH 配置和 `known_hosts`，启用 `BatchMode` 与 `ExitOnForwardFailure`，不会保存 SSH 私钥或口令。

`excludedContextBundleIds` 可增加本机保密应用的 Bundle ID。该列表仅保存在 Mac 本地配置，不进入 Context、Core 或日志。

设备令牌从 `.env` 一次性迁移到 Keychain：

```bash
fnm exec --using=.node-version -- pnpm macos:migrate-token
```

迁移工具通过 stdin 传递令牌，不将令牌写入命令参数或日志。Keychain service 为 `com.violet.device-token`，account 为 `violet`。

## 测试隔离

`VIOLET_TEST_MODE=1` 时使用静音音频、空唤醒、空全局快捷键和空 SSH 转发器。单元测试不会占用真实麦克风、播放声音、注册系统快捷键、读取屏幕、锁屏或控制其他应用。

确定性 Realtime Adapter 仅用于协议和状态机验证。Qwen 与 Pipeline 已通过工程路线中的 Release 1B 决策门；更换默认运行时仍需重新执行对应比较和验收。

真实设备验收使用 `bash scripts/start-test-run.sh <case-name>` 创建独立 run，
先退出普通 App，确认 Mac/Core recorder ready 后开始。最长 30 分钟，原始证据保留
24 小时，范围见 [Test Evidence](../../docs/testing/README.md)。性能元数据另存为
run 内的 `acceptance.ndjson`，不包含音频、转写或回复；它不能替代完整测试记录。
30/30/50 样本矩阵见 [Release 1B 实时语音验收](../../docs/release-1b-acceptance.md)。

## 记忆管理

浮层的记忆入口打开独立窗口，可查看当前记忆与近期变化、搜索和筛选、核对版本与来源，
并纠正、预览删除或单独确认清空。受控敏感正文默认遮挡，只在详情中主动显示。
删除前按实例把最低恢复纪元写入 Keychain；失败时不发送删除确认。在线删除与备份清理
分别显示状态，清理失败不会撤销在线删除。自动学习开关控制普通完成轮次的后台提取；
关闭不删除已有记忆，重开不补提取关闭期间的内容。异步变化会提示刷新，详情区分明确
与自动来源；开关始终显示服务端确认的状态。

## 音频会话

用户可通过浮层中的麦克风按钮，或显式开启后的语音唤醒启动会话。App 先连接
`RealtimeSession` 并检查服务端能力；只有服务端声明支持音频输入后，才请求
macOS 麦克风权限并启动 `AudioIOPort`。会话启动后由 `smart_turn` 自动断句并持续多轮监听；播放回复时再次点击会取消当前回复，其余监听状态下再次点击会结束会话。

关闭浮层、退出 App、锁屏或睡眠会立即停止采集和播放并关闭 Realtime
会话。运行时不支持音频时会明确显示不可用，不会请求麦克风权限或上传音频。

## Context 与本地唤醒

浮层中的 Context 菜单支持 Accessibility 选中文本、系统窗口/显示器选择和区域框选。原始图片先在 Mac 使用 Apple Vision OCR 和本地规则遮挡，再装入五分钟有效的 Context Envelope。关闭浮层、锁屏、睡眠、撤权或主动清除会删除当前 Context。

Wake 开关默认关闭。开启后，`sherpa-onnx` 只在本地监听关键词 `Violet`；唤醒前 PCM 不写盘、不上传、不记录。检测成功后 KWS 先停止，保持浮层隐藏，播放本地打包的 Qwen `longanqian`“我在”，播放完成后启动 Realtime 会话；稍后打开浮层会续接该会话。模型和动态库下载到被 Git 忽略的 `.local-wake/`，打包时复制进 App Resources。

`Look` 独立且默认关闭。开启后，在语音结束时冻结本轮鼠标与 AX 目标；只有 Core 请求
当前视觉证据时，才截取冻结鼠标所在的完整单屏。AX 只参与本地安全检查，不替代截图；
手动 `Selected Text` 仍使用独立的 AX 选中文字路径。该流程不持续采帧。

真实权限和视觉验收见 [Release 1C Violet Sight 验收](../../docs/release-1c-acceptance.md)。

## 失败样本回放

开发者先用保存的输入自行回放，候选通过后再交用户最终验收。普通启动不留图片。
用户授权的验收窗口可显式保留下一次按需图片，避免错误放行时丢失输入：

```bash
VIOLET_RUN="$(fnm exec --using=.node-version -- node scripts/test-run.mjs create human natural-pointing)"
open -n -g \
  --env "VIOLET_TEST_RUN_DIR=$VIOLET_RUN" \
  --env "VIOLET_ACCEPTANCE_LOG=$VIOLET_RUN/acceptance.ndjson" \
  --env "VIOLET_POINTING_REPLAY_DIR=$VIOLET_RUN/pointing" \
  apps/macos/.build/app/Violet.app
```

先退出普通 App，再执行上述命令；确认 Mac/Core recorder ready 后测试。

单图录制授权 15 分钟内有效，最多一张；输出为 `$VIOLET_RUN/pointing/case.json`，包含过滤后的图、
最终问题、鼠标、轮次和 hash，不含 OCR、音频、凭证。文件私有且拒绝覆盖；录制不产生
额外截图。新样本 24 小时后拒绝回放，App 存活时自动删除。App 已退出时，由开发者清理：

```bash
swift run --package-path apps/macos violet-context-replay-capture \
  --purge-expired "$VIOLET_RUN/pointing"
```

需要重建受控画面时才调用一次显式采集工具；它会读取当前已授权的屏幕，不是后台任务：

```bash
fnm exec --using=.node-version -- pnpm test:record \
  swift run --package-path apps/macos violet-context-replay-capture \
  --record .local-acceptance/pointing-case "我选中的代码是什么意思？"
```

开发者为样本标注 `expected.json`，格式为
`{"includes":["EMBER"]}`。回放只验证高置信视觉答案包含预期内容，不要求回答文字框
包含指针。用真实 Core Adapter 与门禁回放：

```bash
fnm exec --using=.node-version -- pnpm test:record pnpm --filter @violet/core build
VIOLET_MODEL_API_KEY_FILE=/run/violet-secrets/deepseek_api_key \
  fnm exec --using=.node-version -- pnpm test:record \
  node scripts/replay-natural-pointing.mjs case.json expected.json results.json 5
```

最后一条在已有供应商凭证的受控 Core 环境运行；不要把凭证复制到样本或命令参数。
回放需本次模型费用授权，不占用麦克风、不写对话账本，记录全部尝试。
它不替代 Qwen 最终输出和真实设备生命周期验证。问题关闭后删除样本与远端诊断副本。
