# 智能体员工 — 安排岗位与观察（外部 Agent 版）

用 shell 跑 `evoflow`；**不要**把员工拉进群聊互相对话。对用户用自然语言总结，勿整段贴 JSON。

**顺序：智能体 → 岗位。** `hire` 不创建 Agent，只把已有 `agent_code` 雇成值班岗位。

## 0. 建智能体 + 雇佣

```bash
evoflow agents check code-reviewer
evoflow agents create --file examples/agent-create.json
evoflow employees hire --file examples/employees-hire.json
evoflow employees update code-reviewer --file examples/employees-update.json
evoflow employees pause|resume|archive code-reviewer
```

### 岗位模型配置字段

`employees hire/update` JSON 中可传：

| 字段 | 说明 |
|------|------|
| `thinking_enabled` | `true` 启用 / `false` 禁用 / `null` 跟随默认（模型思考/推理过程） |
| `model_name` | 覆盖执行模型（空=用智能体默认） |
| `inject_user_profile` | 是否注入用户画像 |
| `inject_memory` | 是否注入对话记忆上下文 |
| `inject_assets` | 是否注入资产/经验库 |
| `inject_skills` | 是否注入技能描述 |
| `inject_kb` | 是否注入知识库检索 |
| `inject_soul` | 是否注入 SOUL.md 人设 |

## 1. 今天谁在岗？

```bash
evoflow employees list
evoflow employees list --status active
evoflow employees get code-reviewer
```

关注：`agent_code`、`role_name`、`busy`（需 Gateway）、`pending_approvals`、`gateway_reachable`。

## 2. 某人今天干了啥？

```bash
evoflow employees worklog code-reviewer
evoflow employees worklog code-reviewer --day 2026-09-05
```

| 字段 | 含义 |
|------|------|
| `rounds[]` / `round_count` | 值班巡检轮次；**为 0 ≠ 没干活** |
| `tasks[]` / `task_count` | 当日台账 Task（含 `items.dispatch`） |
| `hint` | 判空时优先读 hint |
| `rounds[].verdict` | `done` / `incomplete` / `in_progress` |

## 3. 某一轮调了哪些工具？

```bash
evoflow employees trail code-reviewer --round-id <id>
```

## 4. 派活 / 唤醒

```bash
evoflow employees dispatch code-reviewer --goal "核对 ESLint 是否仍为 0 error"
evoflow employees wake code-reviewer --goal "协助验收" --from main
```

需要 Gateway。从个人事项派工：`items dispatch`（见 `05-playbooks.md`）。
