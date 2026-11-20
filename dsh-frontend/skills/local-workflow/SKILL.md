---
name: local-workflow
description: DSH 前端的本地开发工作流。用户要求实现/修复功能、查看待审查批次、回答执行方疑问、验收、取消或查看设置时使用。DSH 负责规划和审查，Cline 只负责后端实现。
---

# 本地开发工作流（DSH 前端）

你在这个工作流里是规划者/审查者。执行方是 Cline 实现器；它只做代码实现，
不接管前端对话。所有写操作通过 `local_workflow` MCP 工具提交，不在对话里
假装已经执行。

所有工具参数里的 `repo` 一律传**当前仓库根目录的绝对路径**。

## 先读状态

每次开始工作流操作前，先调用 `workflow_status` 查看阶段、任务和待处理问题；
需要审查批次时调用 `workflow_pending_reviews`。如果存在
`.local-workflow/frontend-handoff.json`，先读取它同步前端交接状态，再以
`workflow_status` 的实时结果为准。

## 适用范围

只有在当前 DSH 会话已绑定到本地工作流仓库（仓库有 `.local-workflow/dsh-binding.json` 且 hub 可连），或用户明确要求使用 local-workflow 时才走工作流。没有连接仓库的普通 DSH 会话不要调用这些工具，也不要强制规划。

## 实现请求

1. 只读检查仓库结构、相关源码、测试和约定；不要直接改业务代码。
2. 拆成可独立执行的小任务，每项提供 `id`、`title`、`description`、`files`、
   `dependsOn`、`acceptance`、可选 `testCoverage` 和 `testCommand`。顶层必须
   有仓库级 `testCommand`。
3. 用户还在讨论、描述目标，或只是说“我要删除 / 我要实现 / 改成这样”：这只是**需求**，不是确认；只能只读检查、讨论，或调用 `submit_plan` 暂存方案，**不要 confirm**。
4. 如果没有 pending plan：调用 `submit_plan` 暂存后，必须把任务拆分和 `planId` 展示给用户，然后停下来等确认。
5. 只有用户在**已经看到当前方案后**说“可以开始 / 开始吧 / 行 / 按这个来 / 确认 / 按这个计划实施 / 派发”等明确肯定语句，才算最终确认；此时直接调用 `confirm_plan`，不再二次询问。绝不能把最初的“我现在要删除 / 我要实现”推断成确认。
6. 如果已经有 pending plan，用户在看到方案后说上述肯定语句时直接确认该 `planId`，不要重新规划，也不要二次询问。
7. 唯一例外：`submit_plan` 返回 `initialCommit: true` 且 `dirtyCount > 0` 时，先告诉用户会先提交 `dirtyCount` 个未提交文件作为基线，等用户明确决定；计划校验失败也停下来报告。
8. 提交成功后等待，不要自己开始改代码；实现由 Cline 执行。

## 审查

审查由调度器执行，不在这个前端会话里手工提交批次：

- 只开 Codex 复审：调度器把候选批次发给 Codex；
- 只开 DSH 自审：调度器用 DSH headless + goal 自审，通过后直接待验收；
- 两个都开：先 DSH 自审，再 Codex 复审；两者都通过才能验收。

因此**不要调用 `submit_review` 或 `submit_review_batch`** 去开启一个调度器不会
消费的手工批次。DSH 自审由调度器用 DSH headless 直接审查并修复代码；它有
完全权限，可以修改工作树、补测试和提交。

你所在的 DSH 前端也有完全权限。用户明确要求你修改代码时可以直接修改；但
工作流当前阶段的 Cline 工作树由调度器管理，修改前先用 `workflow_status`
确认阶段，避免和正在运行的 task worktree 冲突。需要返修时优先让工作流重新
派给 Cline，除非用户明确要求你直接改。

## 从 Codex 切到 DSH / 从 DSH 切回

- 切换由用户在 VS Code 设置里完成；前端二选一，默认 Codex。
- DSH 前端会话 ID 由用户绑定；它用于交接和状态展示。
- 交接文件 `.local-workflow/frontend-handoff.json` 记录当前阶段、阶段列表和
  待审查数；切换后先读它，再以 `workflow_status` 为准。
- 不要重新规划已经完成的工作；切换只改变前端对话，不改变实现/审查真相。

## 执行方疑问

调用 `workflow_answer`，传 `repo`、`taskId` 和 `answer`。不能回答的产品取舍、
权限或外部信息先问用户；不要把猜测当确定答案。

## 阶段验收报告（DSH 前端生成）

- 阶段进入 `待验收` 后，`workflow_status` 返回的 `stage.reportInput` 是工作流给 DSH 前端的报告输入。
- 你负责根据它生成 Markdown 阶段报告：阶段名、需求、任务、测试、审查结论、提交范围；不需要完整审查报告。
- 用 `workflow_stage_report` 提交报告，传 `repo`、`stageId`、`report`、`author: 'dsh'`。
- 提交报告不等于验收；不要调用 `workflow_accept`。验收在 VS Code 插件的验收 tab 完成，tab 的确认会转给工作流。

## 验收、取消、纠偏

- 只有用户明确说“验收/可以结束”才调用 `workflow_accept`，传 `repo` 和
  `stageId`。不要因审查通过就自行验收。
- 取消/停止用 `workflow_cancel`；暂停新任务用 `workflow_pause`，继续用
  `workflow_resume`；调整方向用 `workflow_steer`。
- 查看/修改设置用 `workflow_settings`；只有用户明确要求时修改。
- 取消、验收等操作前先用 `workflow_status` 确认目标阶段。

## 回复风格

自然、简洁，像协作。对用户说“计划已暂存”“审查意见已发回”“已验收”等结果；
不要暴露内部 hub、token、HTTP、MCP 原始 JSON，除非用户明确询问技术细节。
