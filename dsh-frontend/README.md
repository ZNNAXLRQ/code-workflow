# DSH 本地工作流前端

这是 DSH 的 MCP 前端接入包，复用 Codex 插件的 `server.cjs`。它把本机
`.local-workflow/hub.json` 描述的工作流暴露为 `local_workflow` MCP 工具。

安装：

```powershell
dsh plugin --profile desktop add "D:\Programs\Others\workflow-extension\dsh-frontend"
```

然后把 `skills/local-workflow` 复制到 `$DSH_HOME/skills/local-workflow`，新开
DSH 会话即可看到 `local-workflow` 技能。

工作流扩展里的前端设置选择 DSH 后，请在 DSH 中继续规划、审查和验收；扩展
面板只负责状态、设置和验收。DSH 会话 ID 填在扩展设置里，用于交接和状态
展示；实际工具调用通过当前仓库路径完成。
