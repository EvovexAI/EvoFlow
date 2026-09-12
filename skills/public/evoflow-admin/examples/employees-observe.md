# 智能体员工 — 安排岗位与观察台

主对话里用 `terminal` 跑下列命令；**不要**把员工拉进群聊互相对话。
对用户只用自然语言总结，勿整段贴 JSON。

**顺序：智能体 → 岗位。** `hire` 不会创建 Agent，只把已有 `agent_code` 雇成值班岗位。

## 0. 安排智能体 + 雇佣岗位

```bash
# 1) 智能体（若还没有）
evoflow agents check code-reviewer
evoflow agents create --file outputs/agent.json

# 2) 雇为岗位（参考 employees-hire.json）
evoflow employees hire --file outputs/hire.json
# 或：Get-Content outputs/hire.json | evoflow employees hire --stdin

# 3) 改岗位信息（职责 / KPI / 心跳 / 上下班…）
evoflow employees update code-reviewer --file outputs/patch.json

# 4) 停巡检 / 重新上岗 / 归档（不删智能体）
evoflow employees pause code-reviewer
evoflow employees resume code-reviewer
evoflow employees archive code-reviewer
```

示例 JSON：[`employees-hire.json`](employees-hire.json)、[`employees-update.json`](employees-update.json)。

## 1. 今天谁在岗？有没有待批 / 忙碌？

```bash
evoflow employees list
evoflow employees list --compact
evoflow employees list --status active
evoflow employees get code-agent
```

关注字段：

| 字段 | 含义 |
|------|------|
| `roles[].agent_code` | 员工编码（后续命令都用它） |
| `roles[].role_name` | 显示名 |
| `roles[].busy` | 是否正在巡检/派发（需 Gateway） |
| `roles[].pending_approvals` | 该人待你拍板的事项数 |
| `pending_approvals` | 全局待批总数 |
| `gateway_reachable` | Gateway 是否可达（`busy` 才可信） |

示例输出形状见 [`employees-list.sample.json`](employees-list.sample.json)。

## 2. 某人今天干了啥？

```bash
# 默认今天（本机日期）
evoflow employees worklog code-agent

# 指定日期
evoflow employees worklog code-agent --day 2026-07-18
evoflow employees worklog project-debugger --day 2026-07-18 --limit 100
```

关注字段：

| 字段 | 含义 |
|------|------|
| `rounds[]` | **值班巡检轮次**（initiatives 聚合）。仅当员工跑过 proactive 轮次才有；`round_count=0` 不等于没干活 |
| `tasks[]` / `task_count` | **当日台账 Task**（含 `items.dispatch` 派发）。派发工作看这里 |
| `activity_count` | `round_count + task_count`，快速判断「这天有没有活动」 |
| `hint` / `semantics` | 字段语义说明；助手判空时请读 `hint`，勿只看 `round_count` |
| `rounds[].round_id` | 值班轮次 id → 可交给 `trail` |
| `rounds[].goal` / `outcome` | 本轮目标与交班结论 |
| `rounds[].verdict` | `done` / `incomplete` / `in_progress` |
| `rounds[].pending_approval` | 本轮待批事项数 |
| `rounds[].items[]` | 事项摘要（含 `is_journal` 交班卡） |

示例输出形状见 [`employees-worklog.sample.json`](employees-worklog.sample.json)。

## 3. 某一轮具体调了哪些工具？

```bash
# 省略 --round-id 时取该员工最近一轮
evoflow employees trail code-agent

evoflow employees trail code-agent --round-id round_abc123
evoflow employees trail code-agent --round-id round_abc123 --max-steps 60
```

关注：`tool_counts`、`steps[]`、`scorecard`（goal/outcome/verdict）。

示例输出形状见 [`employees-trail.sample.json`](employees-trail.sample.json)。

## 4. 派发任务（等价聊天里 @员工）

**必须 Gateway 在跑。** 员工忙碌时会 Conflict，先 `list` / `trail` 看进度，勿重复派发。

```bash
evoflow employees dispatch code-agent --goal "核对 ESLint 是否仍为 0 error"
evoflow employees dispatch project-debugger -g "复现昨晚 CI 失败并给出最小复现步骤" --priority high
```

成功后提示用户可去员工页「工作轨迹」查看；`watch_path` 仅供内部跳转，勿对用户念路径原文。

## 推荐问答套路

| 用户说法 | 建议命令 |
|----------|----------|
| 安排个岗位 / 雇个员工 | `agents create`（如需）→ `employees hire --file …` |
| 改一下他的职责/KPI | `employees update <code> --file …` |
| 先别让他巡检 | `employees pause <code>` |
| 今天员工都干了啥 | `list` → 对活跃员工各跑一次 `worklog --day 今天` |
| XX 这班值得好不好 | `worklog <code>` 看 `verdict` / `outcome` |
| 他到底有没有真干活 | `trail <code> --round-id …` 看 `tool_counts` |
| 让前端去查一下首页卡顿 | `dispatch <code> --goal "…"` |
