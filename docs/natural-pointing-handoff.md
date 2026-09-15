# Natural Pointing

## 当前合同

1. `Look` 开启时，Qwen 判断问题是否需要当前画面并调用 `inspect_current_view`。
2. Mac 使用语音结束时冻结的前台应用、`turnId` 和鼠标位置。
3. Mac 截取鼠标所在显示器的完整画面，不做普通指针或章节裁图。
4. 图片在本机完成保密应用、绝对秘密和受控敏感信息过滤。
5. Core 将一张完整截图、冻结坐标和用户原问题发送给 DeepSeek。
6. DeepSeek 只返回 `answer` 与 `confidence`；可靠答案直接交给 Qwen。

## 边界

- Qwen 是唯一视觉意图路由器，Core 不维护视觉关键词 fallback。
- Natural Pointing 不使用 AX 正文直接回答；AX 只检查安全字段。
- 手动 `Selected Text` 是独立功能，仍可返回明确选中的 AX 文字。
- OCR 只用于本机隐私过滤；原文不上传、不进入提示、不验证模型答案。
- 图片在 `8 MiB` 内保持原始像素；超限时先降 JPEG 质量，再等比缩小。
- 坐标以截图左上角为原点，同时用归一化、百分比和像素值表达。
- 截图不包含 live cursor，避免异步移动导致 cursor 与冻结坐标指向不同对象。
- Core 只保留授权、关联、当前轮次、过期、取消、生命周期和 confidence `>= 0.7`
  门禁。
- 严格点框属于未来点击或执行动作，不属于只读问答。

DeepSeek 输出：

```json
{
  "answer": "直接回答",
  "confidence": 0.9
}
```

已删除：`ContextTargetEvidence`、`localText`、`pointerTextVerified`、普通指针局部图、
第二张图、二次模型调用、颜色/位置/OCR 答案校验和 AX 正文捷径。

## 验收

- Core/Node 全量 150/150：`03b12862-5beb-4c36-966f-23cfa984c10a`。
- Swift 全量 92/92：`1340867c-ed31-45fa-b54e-735214e7cb0c`。
- 受控 HTTP/WebSocket trace 116 个事件、0 个证据缺口：
  `81357081-8e37-4e64-b982-2c37e6db604b`。
- 图片预览前三题真人 3/3：
  `7b740c4e-b051-4c6f-92e8-61d0a6cae39f`。
- 后续用户抽测 3/3，覆盖 Tuesday 峰值、Wednesday 数值/日期和完整库存汇总；用户
  明确接受图片预览整项通过：
  `683bb61f-87e3-4a42-850c-8a238bd8c594`。

## 运行与回滚

- Core：`d2cccc9-clean-vision-v2-candidate`
- Core image：`sha256:e22d11e17ab0f63c8443d08570ac825ab56166f7e2bdc4563ef18f0f4e507278`
- Mac App SHA-256：
  `ec26b6ab7de648bb17e2b4ee88c84f0155e975f03e7481f094ace6986cfd9853`
- 回滚 Core：`violet-core:pre-clean-vision-v2-20260914`
- 回滚 Mac：`.local-acceptance/rollback/Violet-freshness-v6-before-clean-vision.app`

持续 Debug Trace 已由用户关闭；历史证据保留。测试记录规范见
[Test Evidence](./testing/README.md)，最终发布状态见
[Release 1C 验收](./release-1c-acceptance.md)。
