# Release 1C Violet Sight 验收

> 状态：实现候选、真实视觉 API canary、后台 Vision 真实复测和三种 Context
> 入口人工冒烟已完成；完整视觉矩阵、Context 生命周期矩阵和办公环境唤醒验收待执行。

## 自动门禁

```bash
pnpm check
pnpm macos:test
VIOLET_SWIFTPM_DISABLE_SANDBOX=1 pnpm macos:app
```

当前基线：

- TypeScript/JavaScript：75 项通过。
- Swift：32 项通过。
- Context 协议覆盖未知字段、过期、超长 TTL、越权、乱序、哈希篡改和删除。
- DeepSeek Vision 请求使用 OpenAI 兼容图片内容块，测试不访问真实 API。
- TOS 测试确认对象正文不含截图明文，并删除全部版本与 delete marker。
- Mac 本地测试覆盖绝对秘密、受控敏感信息、保密应用和截图区域遮挡。
- Mac App 已完成资源打包、ad-hoc 签名和深度签名校验。

## DeepSeek Vision Canary

2026-08-24 使用本地生成、无真实用户数据的两张方向图执行真实
`deepseek-v4-flash-vision-exp` canary：

- 左侧 `SOURCE` 指向右侧 `TARGET 42`：文字、颜色、位置和从左向右方向全部正确，耗时 3.83 秒。
- 右侧 `ORIGIN` 指向左侧 `RESULT 7`：文字、颜色、位置和从右向左方向全部正确，耗时 3.42 秒。

第一次请求正确识别文字和颜色，但把箭头方向描述反了。Adapter 随后增加“先定位箭头头部，再核对来源和目标位置”的约束；同图复测和反向图交叉测试均通过。该结果证明 API、模型权限和当前 Adapter 可用，但不能替代 50 个真实场景的准确率门禁。

## Context 人工冒烟

2026-08-25 用户在真实 macOS 权限环境中确认以下入口均可用：

- `Selected Text` 可以读取 Trae/Electron 编辑器选区，并在首次操作时成功建立 Context。
- `Window or Display` 可以选择完整窗口或显示器，并返回基于画面的回答。
- `Region` 可以框选局部区域，并返回限定于该区域的回答。
- 点击浮窗外部会关闭浮窗并清理短期 Context。

冒烟期间修复了 Electron Accessibility 树延迟启用、浮窗外部点击不关闭、Swift UUID 大小写导致 Context 查询 404，以及 DeepSeek thinking 忽略后置 system Context 的问题。Context 现在作为 JSON 编码的非可信数据紧邻当前用户问题，同时由首条 system 消息约束不得执行其中的指令。

窗口与区域入口仍有可感知的 `Reading` 等待。当前链路依次执行截图、Vision OCR、本地隐私遮挡、上传、DeepSeek Vision 推理和 Context 提交；优化前先分别记录各阶段耗时，再优先处理截图尺寸、OCR 和上传，不能通过跳过本地隐私门禁缩短延迟。

2026-08-25 的延迟优化候选完成：

- 截图统一限制为最长边 2048px，OCR 与 JPEG 编码并行执行。
- 无敏感区域时复用已编码 JPEG，不再执行 PNG 编码、解码和 JPEG 二次编码。
- 本地门禁完成后，DeepSeek Vision 与加密 TOS 写入并行执行；Vision 失败时主动删除已写对象。
- Core 新增 `violet.context.stage.duration` 指标，仅记录 understanding、artifact store 和 total 耗时，不记录内容。
- 同一张 640×360 合成图片的完整 Core 提交基线为 `2984 / 2435 / 1914ms`，优化后为 `2059 / 2404 / 1987ms`；中位数由 2435ms 降至 2059ms，约降低 15%。

真实窗口与区域复测确认：

- Window：截图约 82ms，OCR 与编码约 1.40s，本地捕获合计约 2.40s，本地隐私过滤约 4ms，DeepSeek/Core 请求约 20.07s。
- Region：截图约 40ms，OCR 与编码约 564ms，本地捕获合计约 3.58s（包含系统框选器返回），本地隐私过滤约 1ms，DeepSeek/Core 请求约 9.37s。
- TOS 写入约 0.1s；长尾几乎全部来自 DeepSeek Vision understanding。

1280px 上传和输出 token 上限实验没有稳定降低供应商长尾，且 token 上限会让 thinking 模型耗尽内部推理预算后返回空响应，因此均未保留。用户决定不继续投入 DeepSeek 供应商延迟优化。浮窗在选择和 `Reading` 期间保持显示，完成后才恢复 transient 行为。

随后按用户确认的交互边界将 DeepSeek Vision 移出 `Reading`：

- `Reading` 只等待截图、OCR、本地隐私过滤和加密 TOS 写入，完成后立即返回 `Context ready`。
- DeepSeek Vision 与上述步骤并发启动并在 Core 后台继续，不重复请求。
- 首个文字或语音请求若早于 Vision 完成，会等待同一个后台任务；若已经完成则直接使用结果。
- Context 删除、关闭或失效会取消对应后台任务，旧任务不能回写已删除或更新后的 session。
- DeepSeek 失败时保留经过本地隐私处理的 OCR 证据作为降级结果，不再让已接受的 Context 变成 500。

按优化前真机数据估算，Window 的 `Reading` 从约 22.5s 降至约 2.5s，Region
从约 13.0s 降至约 3.7s；首个问题仍可能等待剩余的 DeepSeek 时间。

2026-08-26 完成部署和真实复测：

- 生产配置合成 canary 的 Context 提交耗时 373ms，提交后立即发起的聊天耗时
  4424ms，提交和聊天均返回 HTTP 200，证明首问复用了同一后台 Vision 任务。
- 用户真实使用 `Region` 后确认 `Reading` 速度可接受。
- 初次内容校验发现 Region 截到了选区垂直镜像位置。运行时证据确认旧 Window
  Context 已返回 HTTP 204 删除，新 Region 的提交 session、回执 session 和聊天
  session 完全一致，排除了上下文混用。
- 根因是 AppKit 使用左下原点，而 `SCScreenshotManager.captureImage(in:)` 使用左上
  原点；Mac 端现已在截图前转换 Y 坐标，并同时覆盖 macOS 15.2 直接截图路径和旧版
  content-filter 路径。
- 用户完成修复后复测，确认 Region 框选内容与回答一致。该结果关闭当前坐标缺陷，
  但不替代下方 50 个真实场景的正式门禁。

## 当前交付状态

- 分支：`feat/1c-sight-wake`。
- Region 修复提交：`8363333 fix: correct region capture coordinates`。
- Codebase Draft MR：
  [!19](https://code.byted.org/user/violet/merge_requests/19)，当前 4/4 检查通过。
- Codebase 与 GitHub 的同名分支均已核对指向
  `83633331fa754bcd9bdbd41a844f415fd76c5557`。
- Devbox Core 继续运行 `87a4306`；最新提交只修改 Mac Region 坐标转换和单元测试，
  不需要重新部署服务端。

## 唤醒候选

- 引擎：`sherpa-onnx v1.13.6`。
- 模型：GigaSpeech English KWS 3.3M，模型卡标记 Apache-2.0。
- 关键词：`Violet`，boost `2.0`，threshold `0.25`。
- 资产由 `scripts/fetch-wake-word-assets.sh` 下载并校验 SHA-256，不进入 Git。
- 合成样本：100/100 触发，100 次静音误触发 0，CPU 处理 p95 22.2ms。
- 用户实测旧参数可用但召回不足；六种系统音色对比中，旧参数触发 3/6，新参数触发 4/6，相近发音负样本均误触发 1/24。该结果说明调参有改善但不能证明达标。
- 唤醒回执由现有 Qwen Realtime `longanqian` 生成，裁剪为 0.73 秒的本地 24kHz 单声道 PCM WAV；运行时不访问 Qwen，并在实际播放完成后启动 Realtime。

合成样本不能替代真实验收。仍需：

1. 用户正常、轻声、远场和办公噪声下共 100 次主动唤醒，成功率至少 95%。
2. 1000 条普通讲话、媒体和环境音负样本，误触发不超过 1 次。
3. 办公环境连续 8 小时，误触发为 0。
4. 锁屏、睡眠、切换用户和 Realtime 会话期间，KWS 采集为 0。
5. 唤醒前 PCM 写盘、上传和日志记录为 0。

调参后的第一轮人工门禁先执行 20 次正常距离唤醒：至少成功 19 次且无误触发才继续扩大样本。若仍不足 19 次，不继续降低 threshold，而是更换针对用户发音的定制 KWS 模型。

## 视觉真实验收

在用户明确开始系统权限验收后执行：

1. 桌面文件或图标 10 次。
2. 图片预览局部 10 次。
3. PDF 当前页或选区 10 次。
4. IDE 选中代码或窗口 10 次。
5. 无浏览器适配器的页面 10 次。

通过标准：

- 当前对象识别准确率至少 90%。
- 用户框选坐标传递正确率 100%。
- 绝对秘密与保密应用内容出境数量为 0。
- 受控敏感信息默认遮挡召回率至少 95%。
- 关闭、锁屏、超时和撤权共 50 次，过期 Context 接受数量为 0。
- 低完整度或低置信度时明确表达不确定，不把推断伪装成证据。

## 数据边界

- 原始截图先在 Mac 完成 OCR 和遮挡。
- Core 只接收经过本地门禁的 Context Envelope。
- Context 默认 5 分钟过期，浮层关闭、锁屏或撤权时立即删除。
- 默认只保存证据摘要；临时图片使用独立 DEK 加密后进入 `violet/tmp/context/`。
- TOS 生命周期 24 小时兜底；会话结束主动删除全部版本和 delete marker。
- Context 不进入长期记忆，也不改写现有对话账本。

## 回滚

- 将 `VIOLET_VISION_PROVIDER` 设为 `deterministic` 可停止真实视觉调用。
- 将 `VIOLET_CONTEXT_STORAGE_PROVIDER` 设为 `memory` 可停止 TOS 临时对象写入。
- 关闭 Mac Wake 开关可停止本地唤醒，不影响快捷键、文字和手动语音入口。
- 删除 Context Session 后，现有 Release 1B 文字和实时语音路径保持不变。
