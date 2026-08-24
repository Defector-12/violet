# Release 1C Violet Sight 验收

> 状态：实现候选和真实视觉 API canary 已完成；系统权限、完整视觉矩阵和办公环境验收待执行。

## 自动门禁

```bash
pnpm check
pnpm macos:test
VIOLET_SWIFTPM_DISABLE_SANDBOX=1 pnpm macos:app
```

当前基线：

- TypeScript/JavaScript：71 项通过。
- Swift：29 项通过。
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

## 唤醒候选

- 引擎：`sherpa-onnx v1.13.6`。
- 模型：GigaSpeech English KWS 3.3M，模型卡标记 Apache-2.0。
- 关键词：`Violet`，boost `1.5`，threshold `0.35`。
- 资产由 `scripts/fetch-wake-word-assets.sh` 下载并校验 SHA-256，不进入 Git。
- 合成样本：100/100 触发，100 次静音误触发 0，CPU 处理 p95 22.2ms。

合成样本不能替代真实验收。仍需：

1. 用户正常、轻声、远场和办公噪声下共 100 次主动唤醒，成功率至少 95%。
2. 1000 条普通讲话、媒体和环境音负样本，误触发不超过 1 次。
3. 办公环境连续 8 小时，误触发为 0。
4. 锁屏、睡眠、切换用户和 Realtime 会话期间，KWS 采集为 0。
5. 唤醒前 PCM 写盘、上传和日志记录为 0。

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
