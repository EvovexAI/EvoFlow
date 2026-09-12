# evoflow CLI 全量速查

全局：`evoflow [--config path] <组> <子命令> …`  
默认 pretty JSON；脚本加 `--compact`。写 JSON：**`--file <路径>` 或 `--stdin`**（禁止把 JSON 字符串塞进 `--file`）。  
**参数以 `evoflow <组> <子命令> -h` 为准。** 选组先读 [`00-concept-routing.md`](00-concept-routing.md)。

顶层组（20）：`models` `skills` `agents` `employees` `org` `approvals` `mcp` `memory` `assets` `experience` `knowledge` `automation` `profile` `sessions` `tasks` `workflow` `items` `workspace` `eval` `logs`

---

## 1. models — 模型

```bash
evoflow models list
evoflow models get <name>
evoflow models primary get
evoflow models primary set <name>
evoflow models create --file examples/model-create.json
evoflow models update <name> --file examples/model-update.json
evoflow models delete <name>
evoflow models test --file examples/model-test.json
evoflow models invoke --file examples/model-invoke.json
evoflow models list-remote --file examples/model-list-remote.json
```

`create` 必填：`name` `model` `base_url`；常用：`api_key` `vendor` `display_name` `supports_vision` `max_tokens` `context_length`。

---

## 2. skills — 技能包

```bash
evoflow skills list [--enabled-only]
evoflow skills get <name>
evoflow skills enable <name>
evoflow skills disable <name>
evoflow skills install <path.zip>          # 推荐 .zip
evoflow skills install-market <slug>       # SkillHub
evoflow skills delete <name>               # 仅 custom
```

---

## 3. agents — 智能体角色（≠ employees）

```bash
evoflow agents list [--tag 标签]
evoflow agents get <code>                  # 主控常用 main
evoflow agents check <code>
evoflow agents create --file examples/agent-create.json
evoflow agents update <code> --file examples/agent-update.json
evoflow agents delete <code> [--keep-employee]
```

**无** `agents seed`。字段：`agent_code` `agent_name` `description` `soul` `system_prompt` `tools` `skills` `mcp_servers` `agent_type` `tags`。

---

## 4. employees — 智能体员工 / 值班岗位

先有 `agents`，再 `hire`。观察：[`employees-observe.md`](employees-observe.md)。

```bash
evoflow employees list [--status active|paused|archived|draft] [--include-archived]
evoflow employees get <agent_code> [--recent N]
evoflow employees hire --file examples/employees-hire.json
evoflow employees update <agent_code> --file examples/employees-update.json
evoflow employees pause|resume|stop|archive <agent_code>
# stop=停在途；pause=停巡检；archive=离岗名册
evoflow employees worklog <agent_code> [--day YYYY-MM-DD] [--limit N]
evoflow employees trail <agent_code> [--round-id id] [--max-steps N]
evoflow employees dispatch <agent_code> --goal "…" [--description …] [--priority normal|high|low] [--task-id …] [--round-id …] [--force-new]
evoflow employees wake <code_or_role_name> [--goal …] [--from <code>] [--task-id …]
evoflow employees migrate [--agent-code …] [--dry-run]
```

`dispatch` / `wake` **需 Gateway**。

---

## 5. items — 个人事项 / 备忘（≠ tasks）

```bash
evoflow items list [-q …] [--status todo|in_progress|waiting|done|parked] [--priority …] [--tag …] [--exclude-done] [--page N]
evoflow items get <item_id>
evoflow items create --file examples/item-create.json
evoflow items update <item_id> --file examples/item-update.json
evoflow items delete <item_id>
evoflow items dispatch <item_id> --agent <agent_code> [--goal …] [--no-wake] [--force] [--interrupt]
```

`create` 必填 `title`。

---

## 6. tasks — 协作任务台账（任务中心）

```bash
evoflow tasks list [--status …] [--assignee code|--role 岗位名] [--source chat|workflow|role] [--main-task-id …] [--subtasks-only] [--limit N] [--offset N]
evoflow tasks get <task_id> [--subtask-id …]
evoflow tasks create --name "…" [--description …] [--assignee code] [--role 岗位名] [--main-task-id …] [--status pending] [--source …] [--raised-by user|code] [--source-ref …] [--risk-level low|medium|high|critical] [--action-type …] [--round-id …]
evoflow tasks progress <task_id> --progress 0..100 [--status …] [--subtask-id …]
evoflow tasks state <task_id> --status completed|failed|cancelled|… [--summary "必填于 completed"] [--outputs '[{…}]'] [--handlers '[{…}]'] [--subtask-id …]
evoflow tasks delete <task_id> --yes
evoflow tasks cleanup-noise [--apply] [--limit N]
evoflow tasks reclaim-zombies [--apply] [--executing-stale-days 3] [--awaiting-stale-days 3] [--limit N]
```

结案：`state --status completed --summary "…"`。轨迹：platform `tasks.execution_trail`。

---

## 7. approvals — 审批

```bash
evoflow approvals list [--status pending|approved|rejected|timeout|all] [--limit N]
evoflow approvals request <task_id> [--note …] [--risk-level …]
evoflow approvals approve <id> [--comment …] [--by cli]
evoflow approvals reject <id> --reason "必须" [--comment …] [--by cli]
```

`approve` 执行需 Gateway。

---

## 8. workflow — Apps 运行

```bash
evoflow workflow list [--status …] [--search …]
evoflow workflow get <App_id>
evoflow workflow run <App_id> [--file examples/workflow-run-params.json]
evoflow workflow status <run_id>
evoflow workflow stop <run_id> [--pause] [--reason …]
```

**无** create/publish/resume CLI → [`04-http-platform.md`](04-http-platform.md) `workflow.*` 或 `/api/apps`。

---

## 9. automation — 定时

```bash
evoflow automation list
evoflow automation get <id>
evoflow automation history <id> [--limit N]
evoflow automation create --file examples/automation-daily-cron.json
evoflow automation create --file examples/automation-once.json
evoflow automation update <id> --file examples/automation-update.json
evoflow automation pause|resume|delete <id>
```

必填：`name` + `prompt`；周期用 `cron_expr`/`schedule`；once 要 `schedule_type=once` + `scheduled_at`。

---

## 10. org — 组织 / 资源包

```bash
evoflow org preflight <path> [--zip] [--workspace …] [--id-prefix …]
evoflow org install <path> [--zip] [--workspace …] [--id-prefix …] [--conflict fail|skip|replace]
evoflow org list [--status active|uninstalled|all]
evoflow org get <org_instance_id>
evoflow org uninstall <id> [--keep-primitives] [--delete-workspace]
evoflow org export --employees a,b --apps App_x -o ./out [--zip] [--id …] [--name …] [--version …]
evoflow org market catalog
evoflow org market install packs/foo [--repo owner/repo@branch]
```

---

## 11. assets — Entity Asset Hub

```bash
evoflow assets init
evoflow assets migrate [--dry-run] [--only …]
evoflow assets export [-o path.evoflow-pack]
evoflow assets import <pack.evoflow-pack>
```

---

## 12. mcp — MCP 服务器

```bash
evoflow mcp list
evoflow mcp get <name>
evoflow mcp show
evoflow mcp add <name> --url https://…/mcp
evoflow mcp add <name> -- npx -y @modelcontextprotocol/server-filesystem /path
evoflow mcp remove <name>
evoflow mcp test [name]
evoflow mcp login|logout <name>
evoflow mcp set --file examples/mcp-set.json
```

---

## 13. memory — Agent 长期记忆

```bash
evoflow memory show [--agent main]
evoflow memory status
evoflow memory reload
evoflow memory clear [--agent …]
evoflow memory agents
evoflow memory facts delete <fact_id> [--agent …]
```

---

## 14. knowledge — 平台自有知识库（Obsidian Vault 遗留）

```bash
evoflow knowledge create --name "库名" [--description …] [--embedding-model-ref …]
evoflow knowledge create --name "库名" --legacy-vault [--path …] [--access-mode read_write|read_only] [--disabled]
evoflow knowledge vaults
evoflow knowledge enable|disable <vaultId>   # 仅遗留 Vault
evoflow knowledge list [--vault kb_…] [--prefix guides/] [--limit N]
evoflow knowledge get <path|docId> [--vault kb_…]
evoflow knowledge remember --file examples/knowledge-remember.json [--vault kb_…]
evoflow knowledge recall "关键词" [--vault kb_…] [--mode hybrid|semantic|keyword|title] [--limit N]
evoflow knowledge delete <path> [--vault kb_…]
```

---

## 15. experience — 经验库

```bash
evoflow experience list [--query …] [--category …] [--limit N]
evoflow experience get <id>
evoflow experience save --file examples/experience-save.json
evoflow experience update <id> --file examples/experience-update.json
evoflow experience mark-used <id>
evoflow experience delete <id>
```

---

## 16. 用户画像 — 资产中心

SoT：`~/.evoflow/assets/user/profile/basic-info.md` · `preferences.md` · `persona.md`

- 面板：`#/assets` → 画像
- 对话：`assets(action=profile, path=preferences, content=喜欢简洁回复)`
- 管理 API：`assets.get_profile` / `assets.update_profile`

```bash
evoflow assets init
evoflow assets export --type user --id user -o ./user-hub.evoflow-pack
```

---

## 17. sessions — 历史会话检索

```bash
evoflow sessions search --query "…" [-q …] [--titles] [--limit 5] [--max-age-days 90]
```

`--max-age-days 0` ≈ 不限时间。

---

## 18. workspace memory — 工作区记忆

```bash
evoflow workspace memory show <workspace_root>
evoflow workspace memory status <path>
evoflow workspace memory clear <path>
evoflow workspace memory bootstrap <path> [--model NAME] [--force]
evoflow workspace memory prune <path> [--dry-run]
evoflow workspace memory seed <path> [--force]
```

---

## 19. eval — 评测中心

```bash
evoflow eval run --mode smoke|scenario|full [--name …] [--days 7] [--async]
evoflow eval cases [--category scenario|business|security|performance]
evoflow eval runs
evoflow eval show <run_id>
```

HTTP：`POST /api/eval/run`。

---

## 20. logs — 诊断日志

```bash
evoflow logs sources [--hours 72]
evoflow logs scan [--hours 24] [-s gateway] [-s frontend] [--limit N]
evoflow logs timeline [--hours 24] [-s gateway] [--format markdown|json]
```

等价 platform：`diagnostics.sources|scan|timeline`；综合诊断仅 platform：`diagnostics.run`。

---

## Gateway 依赖

| 需要 Gateway | 通常不需要 |
|--------------|------------|
| `employees dispatch/wake`、`approvals approve` 执行、`workflow run`、多数 automation 触发 | agents/items/skills/org CRUD、hire/update、list/get、experience、knowledge 本地读写 |

示例文件索引：[`../examples/README.md`](../examples/README.md)。
