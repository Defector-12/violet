# Natural Pointing 交接

## 结论

功能可实现。当前失败不是 DeepSeek 看不到图片，而是截图几何、模型目标定义和 Realtime
时序实现不完整。

推荐目标：AX 优先；AX 不可用时，截取鼠标所在的单个显示器，以鼠标为注意力锚点，
由 DeepSeek 根据用户问题定位并回答。保持失败关闭，不降低置信度。

## 用户意图

- 用户说“这个、这里、我选中的内容”时，无需复制粘贴。
- 模型先理解问题意图，再从鼠标附近寻找相关证据。
- 颜色、高亮和边框只是候选信号，不能单独决定目标。
- “选中内容”要求完整识别连续选区。
- “这个词在这一段是什么意思”要求先定位词，再读取所属段落或代码块。
- 按钮、图标问题要求定位鼠标下的真实控件。
- 人工绘制的定位环永远不是目标。

## 已确认事实

### AX

- 普通编辑器暴露 `AXSelectedText`，现有 AX 路径可以精确读取。
- Trae 集成终端不暴露选区属性，同一 AX 代码只能返回 unavailable。
- 禁止通过模拟 Command-C 读取剪贴板。

### 截图与坐标

- Mac 已发送截图、用户原问题和归一化鼠标坐标。
- 原始 Trae 窗口约 `2940 x 1846` 像素。
- 当前代码分别把宽、高限制到 `2048`，得到 `2048 x 1846`，破坏宽高比。
- 图片下方出现大片白区；鼠标点 `(0.039, 0.907)` 被画到白区，而非终端选区。
- 正确等比结果约为 `2048 x 1286`。

### 模型实测

- DeepSeek 第一轮看到了整张图和鼠标坐标。
- 它误把编辑器绿色 diff 当成选区，并把定位环作为 target。
- 第一轮置信度 `0.9`，说明模型自报置信度不能单独作为可信依据。
- 旧二次验证按错误 target 裁图，只得到 `173 x 167` 的圆环图片。
- 二次模型正确指出裁剪图没有代码，将置信度降为 `0.2`；Core 随后拒绝回答。

### 已实现，勿回退

- `2753351`：已鉴权 Realtime WebSocket 上限为 `12 MiB`，单图上限为 `8 MiB`。
- `680f5c9`：在 `input.speech.stopped` 时冻结应用、AX 目标和鼠标，绑定 turnId；
  证据 30 秒过期且一次性消费，错轮、重复和迟到请求均拒绝。
- OCR 只做本机秘密检测和遮挡，不参与目标识别，也不限制图片证据置信度。
- Core 要求图片带 `focusPoint`、`confidence >= 0.7`，且 `target.bounds` 包含鼠标点。
- `f7590ba`：将“发送取消后收到 no active response”转换为正常取消，不再终止会话。
- `01a1151`：最终转写完成前缓存回复事件，视觉问题不再先播一两个字再截断。

## 图片大小实测

限制：

- Mac/Core 图片上限：`8 MiB`
- Realtime WebSocket 上限：`12 MiB`
- `8 MiB` 图片经 Base64 后约 `10.67 MiB`

当前 `2940 x 1912` 显示器：

| 样本 | 次数 | 最大 JPEG | 超过 8 MiB |
|---|---:|---:|---:|
| 实际 Violet UI | 1 | 0.49 MiB | 否 |
| 随机噪声，质量 90 | 20 | 4.43 MiB | 0/20 |
| 照片类画面，质量 90 | 20 | 2.14 MiB | 0/20 |
| 4K 随机噪声，质量 90 | 10 | 6.52 MiB | 0/10 |
| 6K 随机噪声，质量 90 | 3 | 16.01 MiB | 3/3 |

结论：当前单屏无需默认缩放。只有超限时才缩放，且必须使用统一比例。

## 待实现

### 1. 截图

- 捕获冻结鼠标所在的单个显示器，不拼接多显示器。
- 以原始像素尺寸完成隐私遮挡和定位标记。
- JPEG 质量 0.9；不超过 `8 MiB` 时原图发送。
- 超限时先降到质量 0.8；仍超限再统一等比缩小并重新编码。
- 禁止分别限制宽高；禁止裁剪或填充后继续使用旧坐标。
- 坐标以同一显示器边界归一化，Y 轴只转换一次。

### 2. DeepSeek 任务定义

模型必须按以下顺序执行：

1. 根据用户问题识别任务类型：选区、单词、段落、代码块、按钮、图标或一般对象。
2. 鼠标坐标仅作为注意力中心；定位环是人工标记，禁止作为 target。
3. 从鼠标附近开始，按“包含鼠标点、距离、问题语义、布局连续性”排序候选。
4. 颜色和高亮仅为辅助信号。
5. 选区问题返回完整连续文字；词义问题读取词所在段落或代码块。
6. target 必须表示回答依据，并包含 `kind`、`bounds`；文本任务还必须包含 `text`。
7. 无法可靠定位时返回低于 `0.7` 的置信度，不猜测。

建议沿用现有 JSON：

```json
{
  "answer": "直接回答",
  "confidence": 0.9,
  "target": {
    "kind": "text-selection",
    "bounds": { "x": 0.1, "y": 0.7, "width": 0.4, "height": 0.08 },
    "text": "完整选区"
  }
}
```

### 3. Core 校验

- 删除二次裁剪和第二次模型调用。
- 指针/定位环/annotation/marker 不允许作为语义 target。
- 选区问题只接受 `text-selection`、`text` 或 `code-block`，并要求 `target.text`。
- `target.bounds` 必须包含鼠标点。
- 保留置信度 `>= 0.7`、位置、颜色、新鲜度和 turnId 校验。

## 主要文件

- `apps/macos/Sources/VioletMacCore/ContextCapture.swift`
- `apps/macos/Sources/VioletMacCore/LocalContextPrivacy.swift`
- `apps/macos/Tests/VioletMacCoreTests/ContextCaptureTests.swift`
- `services/core/src/context/deepseek-vision-understanding.ts`
- `services/core/src/context/deepseek-vision-understanding.test.ts`
- `services/core/src/realtime/visual-grounding.ts`
- `services/core/src/realtime/visual-grounding.test.ts`

## 验收标准

1. 截图无拉伸、裁切或白色填充区。
2. 定位环与真实鼠标位置误差不超过 1 输出像素。
3. 终端选区问题中，target 是选区或代码块，不是定位环。
4. 模型只调用一次；无 verification crop。
5. 普通非视觉问题不截图且回复无额外明显延迟。
6. 视觉问题不播放被取消回复的音频前缀。
7. 无法识别时明确拒绝，不降低 `0.7` 门禁。
8. `pnpm check:ci`、`pnpm macos:test`、`pnpm macos:app` 和深度签名全部通过。
9. 用真实 Trae 终端、徽标和按钮样本复测。

## 当前状态

- 功能分支：`feat/1c1-natural-pointing`
- 本轮临时取证代码、日志、图片和测试目录已清理；部署以本交接提交为准。
- “待实现”部分尚未开发，下一位开发者应从截图几何开始。
- MR !20 保持 Draft，完整视觉矩阵通过前不得合并。
- 无数据库、协议或依赖变更。
- 回滚基线：`680f5c9`。
