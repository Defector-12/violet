# Test Evidence

2026-09-14 用户关闭持续 Debug Trace。Mac 与 Core 默认均不再记录；历史文件
`.local-acceptance/debug-trace.ndjson` 保留为既有验收证据，不继续追加。

持续记录器、轮询同步和专用 UI 已移除。专项实时会话验收使用
`bash scripts/start-test-run.sh <case-name>`，显式启动独立 run，最长 30 分钟，
原始记录保留 24 小时。运行前先退出普通 App；普通启动不记录。

- 目录 `.local-acceptance/test-runs/<runId>/` 权限 `0700`，文件 `0600`。
- Mac/Core 分别保存请求、最终转写、回答、工具、模型、采集路径、冻结坐标、错误与关联 ID；
  图片仅复用本轮已经授权且完成隐私过滤的采集，不新增截图。OCR 原文不保存。
- 不记录凭据、模型内部推理、原始音频或无关旧历史；音频与流式碎片只记长度。
- 启动前核验参与链路的记录器就绪，结束后收集 Core 记录。失败或缺口明确标注，
  不要求用户因为遗漏记录重复已执行测试。命令测试不要求运行 Mac/Core。
- `manifest.json`、原始文件、stdout/stderr、退出码与所有失败尝试均可检查；
  manifest 记录提交与完整工作树指纹（含未跟踪源码），命令结束后另存最终指纹。
  报告生成成功不等于产品验收通过。

自动化测试仍由 `pnpm test` / `pnpm macos:test` 保存独立 stdout、stderr 和退出码到
`.local-acceptance/test-runs/`。其他验证用：

```sh
fnm exec --using=.node-version -- pnpm test:record <命令> <参数...>
```

每次运行 `scripts/test-run.mjs` 都会先清理超过 24 小时保留期的原始证据，也可用
`fnm exec --using=.node-version -- node scripts/test-run.mjs purge` 显式触发。未过期
证据和历史持续日志不会被顺带删除。
