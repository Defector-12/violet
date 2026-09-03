# Release 1C Violet Sight 验收

> 状态：实现候选，代码已集成到主线。真实视觉 API canary、后台 Vision 真实复测、三种
> Context 入口人工冒烟和视觉矩阵 20/50 已完成。2026-08-30 恢复 1C.1 验收后确认：
> 唤醒级静态 Context 可处理精确 AX 选区和宽泛窗口问题，但无法稳定处理同一会话内变化
> 的鼠标位置、颜色和小控件。按需视觉替换方案已部署，普通非视觉问答、真实 Qwen 工具
> 路由和连续 AX 快速通道已通过冒烟；Trae 终端精确选区失败，截图精细定位、隐私和
> 生命周期矩阵仍待执行。完成真实验收前不得合并 MR !20 或将 Release 1C/1C.1 标记为
> 正式交付。

## 自动门禁

```bash
pnpm check
pnpm macos:test
VIOLET_SWIFTPM_DISABLE_SANDBOX=1 pnpm macos:app
```

当前基线：

- TypeScript/JavaScript：95 项通过。
- Swift：48 项通过。
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
- 1C.1 初始功能提交 `3ea3afc` 已推送至 Codebase/GitHub 的
  `feat/1c1-natural-pointing`；UUID/时钟修复 `d3fbd55` 与图片 WebSocket 修复
  `2753351` 已同步两个远端，Draft MR !20 需要以最新提交的检查为准。
- Devbox Core 与本地 Mac App 已部署无诊断代码的 `2753351`；Core 健康、Mac 单进程
  在线，加密事件账本保持 `805 / 1..805` 连续。

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
- 有线耳机与内置扬声器都可能被 Core Audio 标记为 `builtIn` transport；现改为同时读取
  标准 `hdpn` 输出数据源。有线耳机模式保留语音打断，用户已完成真实复测。
- 内置扬声器模式暂不支持语音打断，仍可点击打断。
- 语音唤醒不再自动弹出浮窗；菜单栏打开后继续已有会话。
- 明确控制短句和 `Control + Option + Space` 可立即退出；180 秒无活动自动退出。
- “拜拜”“今天就到这里吧”等自然告别由 Core 独立文字模型分类。Qwen 先完整回复，
  Core 在对应 `response.completed` 后发出 `session.end_requested`，Mac 等本地播放队列
  清空后停止监听。用户已确认真实行为正确。

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

### 2026-08-30 真实验收结论

已通过：

- 普通编辑器中可读取的文字选区能够通过 Accessibility 精确传入 Realtime。
- Trae 集成终端退化为截图后，部分代码问题和宽泛窗口内容问题可以回答。
- 唤醒不会自动打开浮窗；用户打开浮窗后继续当前语音会话。
- 自然告别会在完整回复播放结束后退出，明确控制短句、快捷键和 180 秒空闲退出正常。
- 内置扬声器继续阻止回声自打断；有线耳机通过 `hdpn` 数据源识别并恢复语音打断。

未通过：

- Trae 集成终端不暴露 `AXSelectedText`，截图 fallback 无法稳定判断视觉选区。
- 跨行终端命令曾只返回路径后半段，也曾把右侧输入框提示误认为左侧选中代码。
- “鼠标位置的 33”被解释成行号；实际 `33` 是 Source Control 变更数量徽标。
- “右下角绿色按钮”被解释成白色的“全部确认”；实际目标是绿色发送按钮。
- 日志确认 OCR 已识别完整命令，但唤醒时保存的焦点坐标会与后续问题目标不同。
- 同一 Realtime 会话只复用唤醒时的一张截图和一个通用 Vision 摘要，后续鼠标移动、
  界面变化和新空间指代没有新证据。
- Qwen 并非每个视觉问题都调用 `inspect_current_context`。

因此停止继续调节 OCR 距离阈值和提示词。以下替换方案已形成实现候选：

1. Qwen Audio 先理解用户话语并决定是否需要视觉；普通问题直接回答。
2. 需要视觉时由 Qwen 调用工具，Core 再向 Mac 请求当前轮截图，不在唤醒时预上传。
3. AX 能读取选中文字时保留为快速通道；失败时才截图。
4. Mac 不持久缓存图片；Apple Vision OCR 只用于出境前的秘密阻断和敏感遮挡，不再负责
   目标选择。
5. DeepSeek Vision 接收当前截图和用户原问题，直接生成最终答案，同时返回目标边界、
   类型、颜色和置信度供 Core 校验。
6. Core 将通过校验的答案作为工具结果交还 Qwen；Qwen 只负责自然语音播报。
7. Core 必须兜底拦截 Qwen 漏调视觉工具的视觉问题，且不得用旧 Context 代替新截图。
8. 当前不切换到 Qwen Omni。现用 `qwen-audio-3.0-realtime-plus` 保持语音与工具路由，
   DeepSeek `deepseek-v4-flash-vision-exp` 继续负责视觉。

2026-08-31 新候选的本地自动测试已覆盖：

- `Look` 偏好默认关闭并可持久化。
- 唤醒本身不采集 Context；只有 Core 发出当前轮请求后才读取 AX 或截图。
- Natural Pointing 能读取当前 AX 选中文字，浮窗已打开时可沿用打开前保存的外部目标。
- AppKit 鼠标坐标转换与窗口内归一化焦点坐标。
- 截图先经过本地 OCR、秘密阻断和敏感遮挡；OCR 原文不作为按需视觉模型证据发送。
- `requestId`、`turnId`、过期时间、成功/失败回执、错轮拒绝及打断后迟到结果丢弃。
- Qwen 工具路由、Core 对明确视觉指代的漏调兜底、未经验证回答的播报前取消。
- DeepSeek 问题级结构化答案、边界框/颜色/置信度校验和小目标裁剪复核。
- AX 精确文本不调用 Vision；低置信度、位置或颜色冲突时返回不可可靠定位。
- Mac App 完成打包和深度签名校验；Core 生产部署包中的 `sharp` 裁剪依赖可加载。

2026-09-02 完成第一轮按需视觉真实冒烟：

- Devbox/Linux 生产构建中的 `sharp` 与 `libvips` 可加载；无用户数据的绿色合成图
  DeepSeek canary 正确返回颜色，置信度为 1。
- 真实 Qwen Realtime 会调用 `inspect_current_view`，Core 随后才按当前 `turnId`
  请求 Mac 采集；Mac 成功读取 Trae Markdown 编辑器中的 `AXSelectedText`，未进入
  截图和 DeepSeek Vision 分支，用户确认 Violet 正确播报选中文字。
- 首轮失败的根因是 Swift 编码 UUID 使用大写，而 Core 以小写 UUID 保存待处理请求；
  Core 现对 `requestId`、`turnId` 和 Context `sessionId` 做大小写无关匹配。
- 第二轮失败的根因是 Mac 时钟比 Devbox 慢约 49ms，严格比较两台设备的
  `capturedAt >= requestedAt` 会把新证据误判为旧证据；新鲜度校验现允许最多 30 秒
  的跨设备时钟偏差，同时仍以请求过期时间和当前轮关联阻止旧证据。
- 修复后的运行证据连续三次显示 request、turn 和 Context session 匹配，Core 均返回
  ready evidence；诊断日志不记录选区正文、截图或语音，并在确认根因后删除。

2026-09-03 继续最小真实冒烟：

- `Look` 开启后询问普通非视觉问题，Violet 正常回答；Context 阶段指标在测试前后均为
  0，证明该轮没有进入 AX、截图或 Vision 处理。
- 在同一 Realtime 会话连续选择三个不同的 AX 文本并提问，三次回答全部正确；
  `understanding` 和 `total` 指标各精确增加 3 次，未命中旧轮证据。
- Trae 集成终端截图 Context 的编码事件约 450–540 KB，超过原 150 KB WebSocket
  `maxPayload`，Core 以 close code 1009 断开，Mac 将底层错误显示为 `Core offline`。
  提交 `2753351` 将已鉴权 Realtime 上限提高到 12 MiB，与 Context 图片协议一致；
  新增集成测试确认协议有效的大图片事件之后同一连接仍可继续回答。
- 传输修复后不再 offline，图片成功完成临时存储和 DeepSeek 调用，但终端跨行选区仍
  未通过。Trae 终端不暴露 `AXSelectedText`；整窗截图携带的鼠标焦点不在终端目标附近，
  模型一次返回置信度 `0.65` 且无边界框，另一次视觉理解失败后使用 `0.25` 无答案降级，
  Core 均按现有门禁明确返回不可可靠定位。
- 当前代码已经实现“AX 失败后发送整窗截图、截图时鼠标坐标和用户原问题”。讨论中的
  每轮提前固定鼠标坐标、拖拽监听、剪贴板读取和 Trae 专用适配器均未实现。用户决定
  暂停进一步开发，由后续 Agent 先重新确认 AX 不可用时的产品语义。

仍未验证：

- `Look` 开关和普通非视觉问题各 20 次的正式计数，以及 Core 漏调兜底的真实时序。
- AX 不可读时的鼠标指向、小目标裁剪复核和稳定精确定位；终端跨行选区当前已知失败。
- 下列真实验收矩阵。

重构后的真实验收必须重新执行：

1. `Look` 关闭时 20 次唤醒不得产生任何自动 Context。
2. `Look` 开启但问题不依赖视觉时不截图、不上传，Qwen 直接回答。
3. AX 可读选区直接回答且不截图；AX 不可读时才进入按需截图链路。
4. 连续三轮分别移动鼠标或改变窗口内容，每轮只能使用与当前 `turnId` 匹配的新证据。
5. DeepSeek 收到原图和用户原问题；Qwen 收到已校验的最终答案，不再根据通用摘要猜测。
6. 终端跨行命令、Source Control 数量徽标和右下角发送按钮必须分别正确识别。
7. 小目标返回边界框、颜色和置信度；属性或空间校验失败时明确表达不确定。
8. 选中文字、鼠标附近文字、文章、图片和图表各 10 次，正确率至少 90%，错误窗口、
   旧 Context 或跨轮 Context 命中为 0。
9. 保密应用和绝对秘密内容出境为 0；受控敏感信息继续本地遮挡。
10. 关闭、锁屏、睡眠、撤权、超时或会话结束后，临时截图与 Context 不可继续使用。

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

2026-08-27 曾暂停剩余测试；2026-08-30 因 Natural Pointing 真实使用发现定位缺陷而恢复。
当前先完成按需视觉重构，再继续扩大矩阵。

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

当前结论：

- Natural Pointing 的按需请求关联、UUID 格式差异和跨设备时钟偏差已修复，真实 AX
  快速通道及三轮新鲜度冒烟已通过；图片 WebSocket 容量缺陷已修复。Trae 终端精确
  选区和截图精细定位仍未通过。
- 已验证的底层 Context、隐私和手动 Region 能力继续保留；唤醒级静态 Context 不能作为
  最终方案合并。
- 原定按需视觉门槛全部通过前，不得将 Release 1C 或 1C.1 标记为正式交付。

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
- 按需截图超时、Qwen 未路由或 Vision 失败时，不使用旧 Context 代替；明确失败并允许
  用户改用 `Region`。
