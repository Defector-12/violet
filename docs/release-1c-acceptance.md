# Release 1C Violet Sight 验收

> 状态：实现候选，代码已集成到主线。真实视觉 API canary、后台 Vision 真实复测、三种 Context
> 入口人工冒烟和视觉矩阵 20/50 已完成。用户当前未遇到其他 Bug，2026-08-27
> 主动暂停剩余验收；后续主功能开发完成后统一恢复，也可由用户随时发起专项测试。
> 暂停不等于通过，Release 1C 仍不标记为正式交付。2026-08-28 增加的 1C.1
> Natural Pointing 候选已部署，仍待真实环境验收。

## 自动门禁

```bash
pnpm check
pnpm macos:test
VIOLET_SWIFTPM_DISABLE_SANDBOX=1 pnpm macos:app
```

当前基线：

- TypeScript/JavaScript：79 项通过。
- Swift：39 项通过。
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

1280px 上传和输出 token 上限实验没有稳定降低供应商长尾，且 token 上限会让 thinking 模型耗尽内部推理预算后返回空响应，因此均未保留。用户决定不继续投入 DeepSeek 供应商延迟优化。Selected Text 和 Window/Display 选择期间浮窗保持显示；Region 框选期间浮窗隐藏，框选完成后自动恢复，并在 `Reading` 期间保持显示。

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

## 当前集成状态

- 功能基线：`752b4ad fix: hide popover during region selection`。
- Region 修复提交：`8363333 fix: correct region capture coordinates`。
- Region 框选浮窗修复提交：`752b4ad fix: hide popover during region selection`。
- Codebase MR [!19](https://code.byted.org/user/violet/merge_requests/19) 的 4/4 检查通过，
  并在 2026-08-27 的仓库收口中集成到主线。
- Codebase 与 GitHub 主线保持相同内容；平台生成的 merge commit 可以不同。
- Devbox 使用同一主线代码，Core、PostgreSQL、LGTM 和 Collector 健康。
- 代码集成不改变验收结论：Release 1C 仍是实现候选。
- 1C.1 功能提交 `3ea3afc` 已推送至 Codebase/GitHub 的
  `feat/1c1-natural-pointing`；Draft MR !20 的 4/4 检查通过。
- Devbox Core 已部署 `3ea3afc` 并保持健康，数据库仍为连续的 567 条事件；本地新版
  Mac App 已启动。

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

2026-08-26 完成第一轮真实人工门禁：

- 用户在正常工作位、正常音量和距离下主动唤醒 20 次，成功 15 次、漏唤醒 5 次，
  成功率 75%，未报告测试窗口内的误触发。
- 结果低于 19/20 门槛，因此不执行后续 100 次正样本、1000 条负样本和 8 小时
  办公环境验收，也不继续降低 threshold。
- 隐私安全的本地验收日志记录了 9 次 `session.start.requested`；当前 schema 没有独立
  `wake.detected` 事件，且部分成功唤醒未进入 Realtime，因此日志不能替代用户的
  15/20 人工计数。后续定制 KWS 验收前需补充独立唤醒检测事件。
- 测试结束后 Wake 已恢复关闭，Violet 已恢复普通 LaunchServices 启动。
- 下一候选方向是针对用户真实发音的定制 KWS 模型，而不是继续放宽当前
  GigaSpeech 开放词汇模型阈值。

2026-08-29 完成本机音频路由专项验证：

- 内置扬声器回复会被内置麦克风重新采集，并连续两帧越过本地打断门；当前在内置
  扬声器播放期间及结束后 250ms 暂停上传麦克风帧，用户确认不再发生自我打断。
- Apple Voice Processing 在本机 7 声道聚合路由上启动失败，因此不作为当前方案。
- 插入或摘下耳机会停止 Wake 的 `AVAudioEngine`，旧代码仍把 detector 标记为运行；
  现在由 detector 上报配置失效，Coordinator 等待 500ms 后自动重建监听。
- 用户完成不戴耳机、戴上耳机和摘下耳机三段真实验证，均可重新唤醒 Violet。
- 内置扬声器模式暂不支持语音打断，仍可点击打断；耳机路径继续支持语音打断。

## Natural Pointing 候选

2026-08-28 增加 1C.1 Natural Pointing：

- Mac 浮窗增加默认关闭的 `Look` 开关；只有用户主动开启后，语音唤醒才自动建立
  Context。
- 唤醒时在浮窗夺取焦点前保存前台应用、Accessibility 焦点元素和鼠标位置。
- 有可读选区时优先提交 `focus.text`；否则自动捕获前台应用窗口，并在
  `screen.snapshot` 中携带左上原点的归一化 `focusPoint`。
- 截图继续先执行 Apple Vision OCR、绝对秘密阻断、受控敏感信息遮挡和保密应用隔离。
- Context 提交后 Realtime 使用本地 OCR 证据启动，不等待后台 DeepSeek Vision。
- Qwen 仅在存在活动 Context 时注册只读 `inspect_current_context`；模型判断问题依赖当前
  画面时，由 Core 等待并返回同一后台 Vision 结果，不重复请求。
- 用户开始新一轮语音时会取消旧回复并丢弃迟到的 Context 工具结果。
- 自动 Context 沿用 5 分钟 TTL；关闭浮窗、锁屏、睡眠、撤权或退出 App 时继续执行既有
  清理逻辑。
- 唤醒时若前台仍是 Violet 且没有保存的外部目标，自动 Natural Pointing 静默退化为
  纯语音，不显示 `No readable context is available`；手动 Context 的同类失败仍明确提示。

本地自动测试已覆盖：

- `Look` 偏好默认关闭并可持久化。
- Natural Pointing 优先使用浮窗出现前保存的选中文字。
- AppKit 鼠标坐标转换与窗口内归一化焦点坐标。
- 焦点坐标通过协议、本地隐私过滤和 DeepSeek Vision 提示完整传递。
- Realtime Context 工具注册、结果回传、Core 内部消费和打断后迟到结果丢弃。

真实验收仍需完成：

1. `Look` 关闭时 20 次唤醒不得产生任何自动 Context。
2. `Look` 开启后，选中文字、鼠标附近文字、文章、图片和图表各 10 次；正确率至少
   90%，错误窗口或旧 Context 命中为 0。
3. 唤醒后 Realtime 不等待 DeepSeek Vision；本地 Context 超过 4 秒时仍能进入语音，
   并明确显示 Context 未就绪。
4. 普通聊天不调用 Context 工具；视觉问题只产生一次后台 Vision 请求。
5. 保密应用和绝对秘密内容出境为 0，生命周期结束后自动 Context 接受数量为 0。

## 视觉真实验收

在用户明确开始系统权限验收后执行：

1. 桌面文件或图标 10 次。
2. 图片预览局部 10 次。
3. PDF 当前页或选区 10 次。
4. IDE 选中代码或窗口 10 次。
5. 无浏览器适配器的页面 10 次。

2026-08-27 完成无浏览器适配器页面组：

- 使用本地合成页面和 `Region` 完成 10 次测试，覆盖精确文字、颜色、形状、数量、
  相对位置和状态识别。
- 用户逐项核对标准答案，10/10 正确，当前组识别准确率 100%。
- 10 次框选内容均与回答一致，当前组 Region 坐标准确率 100%。
- 失败样本 0；本组只使用合成内容，不包含私人或工作数据。

2026-08-27 完成桌面文件或图标组：

- 使用本地验收目录中的 5 个空白测试文件和 1 个空文件夹完成 10 次 `Region`
  测试，覆盖文件名、文件类型、对象数量、选中状态和相对位置。
- 用户逐项核对标准答案，10/10 正确，当前组识别准确率和 Region 坐标准确率均为
  100%，失败样本 0。
- 视觉真实矩阵累计完成 20/50，剩余图片预览、PDF 和 IDE 共 30 次。

## 验收暂停与待测清单

2026-08-27 用户确认当前实际使用未遇到其他 Bug，决定暂停剩余测试，先继续后续主功能
开发。以下事项保留为明确的验收债务；后续主功能完成后统一恢复，也可由用户随时发起
其中任一专项测试。

视觉准确率：

- 图片预览局部 10 次。
- PDF 当前页或选区 10 次。
- IDE 选中代码或窗口 10 次。
- 当前累计 20/50，已完成的浏览器和桌面组均为 10/10，剩余 30 次未执行。

Context 隐私：

- 保密应用、密码字段和绝对秘密合成测试，要求内容出境数量为 0。
- 受控敏感信息默认遮挡测试，要求召回率至少 95%。
- 验证原始截图、敏感 OCR 原文和临时明文不进入日志、长期记忆或持久账本。

Context 生命周期：

- 覆盖浮窗关闭、主动清除、新 Context 替换、5 分钟超时、锁屏、睡眠、权限撤销和
  App 退出。
- 上述场景累计执行 50 次，要求过期或已删除 Context 被云端接受的数量为 0。
- 验证删除会取消后台 Vision，旧任务不能在删除或替换后回写。

语音唤醒：

- 当前候选真实短门禁为 15/20，低于 19/20，不继续降低 threshold。
- 后续先增加不含音频和转写的独立 `wake.detected` 事件，并评估针对用户真实发音的
  定制 KWS。
- 新候选先重新执行 20 次短门禁；通过后再执行 100 次主动唤醒、1000 条负样本、
  8 小时办公环境，以及锁屏、睡眠、切换用户和 Realtime 会话期间停采验证。
- 唤醒前 PCM 写盘、上传和日志记录数量必须为 0。

暂停期间保持的结论：

- 当前没有由用户实际使用发现但尚未修复的 1C Bug。
- 上述功能已有实现和自动测试；未完成项是扩大样本后的真实交付证据。
- 代码可以进入主线供后续阶段复用；只有恢复并通过原定门槛后，才能标记 Release 1C
  正式交付。

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
