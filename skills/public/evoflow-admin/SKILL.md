---
name: evoflow-admin
description: EvoFlow 系统治理 CLI — 复杂/脚本化治理时通过 terminal 跑 `evoflow`。日常对话优先用内置工具 `platform`（catalog→confirm→执行）。CLI 与 platform 域对齐：模型、联网搜索、技能、Agent、员工、工作流、用户事项、协作任务、审批、组织包、资产、知识库、MCP、记忆、经验库、会话、自动化、画像、日志诊断、系统验证。外部 Agent 用 evoflow-admin-external。
---

# EvoFlow Admin CLI

日常平台行政优先用内置工具 **`platform`**（先 `action=catalog`，写操作带 `confirm=true`）。  
需要脚本化、批处理或 CLI 独有参数时，再走 **`terminal` + `evoflow`**（本技能）。已退役的分散工具（`create_agent`、`experience_*`、`remember` 等）不要再用。

**runtime / Work Body / 无 EvoFlow 会话的 Agent**：安装独立发行包 **`evoflow-admin-external`**（GitHub Releases / 官网下载，或本地用 `package_release.py` 打出 zip），不要依赖本技能里的 `platform` / `terminal` 工具叙述，也不要用软链接代替整包拷贝。

## Platform ↔ CLI 对照（保持同步）

| Platform 域 | CLI 组 | 备注 |
|-------------|--------|------|
| `knowledge.*` | `evoflow knowledge …` | vaults / create / enable / list / get / remember / recall / delete；platform 用 `ingest`/`notes`/`search` 等同义名 |
| `workflow.*` | `evoflow workflow …` | CLI：**仅** list / get / run / stop / status。创建/发布/复制/版本/resume/list_runs → **只用 platform** 或 `POST /api/apps` |
| `settings.*`（模型+画像+联网搜索） | `evoflow models …` + `profile …` | 联网搜索暂无 CLI，用 `platform`：`settings.get/patch/test_web_search` |
| `appearance.*` | （暂无 CLI） | 主题/背景/液态玻璃：只用 `platform` |
| `agents.*` | `evoflow agents …` | CLI 另有 `check`；**无** `agents seed` |
| `employees.*` | `evoflow employees …` | CLI 另有 trail / dispatch / wake / stop / migrate；platform 有 stop，无 wake/migrate |
| `tasks.*` | `evoflow tasks …` | 协作任务；CLI 另有 `progress` / `cleanup-noise` / `reclaim-zombies` |
| `items.*` | `evoflow items …` | **个人事项 ≠ tasks** |
| `skills.*` / `mcp.*` / `automation.*` / `approvals.*` / `memory.*` / `sessions.*` / `experience.*` | 同名 CLI | MCP：platform 仅 get/set；CLI 另有 list/add/remove/test/login/logout |
| `diagnostics.*` | `evoflow logs …` | sources / scan / timeline；综合诊断 `diagnostics.run` **仅 platform** |
| `verification.*` | （暂无 CLI，用 `platform` 或 `POST /api/platform`） | 技能 **`evoflow-system-verification`** |
| （无） | `evoflow org …` | 组织/资源包：preflight / install / list / get / uninstall / export / market |
| （无） | `evoflow assets …` | Entity Asset Hub：init / migrate / export / import |
| （无） | `evoflow workspace memory …` | CLI 独有：show / status / clear / bootstrap / prune / seed |
| （API `/api/eval`） | `evoflow eval …` | 评测中心：场景回归 + 观测指标 |

外部 Agent（runtime / 无 `platform` 工具）见技能 **`evoflow-admin-external`**。

## Prerequisites

1. 对话里能搞定的治理：直接调 **`platform`**，不必读本技能全文。
2. 需要 CLI 时：直接 **`terminal`** 跑 `evoflow …`（同一 shell；JSON 输出便于解析）。
2. **`terminal`** 在同一 shell 会话中执行（JSON 输出便于解析）。
3. CLI 必须在 PATH 上，否则终端找不到 `evoflow`。

**桌面安装包**：安装向导有一页「将 evoflow CLI 添加到 PATH」——**默认勾选**。装完后**新开终端**即可用。若取消勾选，则需用安装目录里的 `evoflow.cmd` 全路径（见下）。不要运行安装根目录的 `evoflow.exe`——那是桌面客户端。

**本地开发**：dev 脚本会把 venv 的 Scripts 加进 Gateway 进程 PATH；改代码后需重启 Gateway。

按场景：

```powershell
# 已勾选「添加到 PATH」且新开了终端：
evoflow automation list
evoflow agents list
```

```powershell
# 未加入 PATH：用安装目录下的 CLI 入口（把 <安装目录> 换成实际路径）
& "<安装目录>\binaries\evoflow-gateway\tools\evoflow\evoflow.cmd" automation list
```

```powershell
# 源码 / 开发机（venv 已装好 harness）：
evoflow automation list
# 或：
uv run evoflow automation list
```

**Windows 注意**
- PowerShell 5.x **不支持** `&&`；不要写 `cd … && evoflow …`。
- 配置默认读 `%USERPROFILE%\.evoflow\config.yaml`（或 `EVOFLOW_CONFIG_PATH`）；仅 `cd` 到数据目录不会改配置路径。
- 静默安装：`/AddPath` 强制写 PATH，`/NoAddPath` 跳过。

4. 写 JSON payload 时，先 `write_to_file` 到 `outputs/` 或 `/tmp/`，再 `--file` 传入；或 `echo '{...}' | evoflow ... --stdin`。

## Output rules

- 默认输出 **pretty JSON**；脚本解析用 `--compact`。
- 失败时 stderr/stdout 含 `{"error": "..."}`，检查 exit code。
- **勿**向用户复述原始 JSON；用自然语言总结结果。

## Command reference

### Models

```bash
evoflow models list
evoflow models get <name>
evoflow models primary get
evoflow models primary set <name>
evoflow models create --file model.json
evoflow models update <name> --file patch.json
evoflow models delete <name>
# test / invoke / list-remote 的 payload 需先写入文件再用 --file，或通过 --stdin 传入
echo '{"base_url":"...","api_key":"...","model_id":"..."}' | evoflow models test --stdin
echo '{"model":"primary","messages":[{"role":"user","content":"hi"}]}' | evoflow models invoke --stdin
echo '{"base_url":"...","api_key":"..."}' | evoflow models list-remote --stdin
```

### 联网搜索（platform only）

设置页「联网搜索」偏复杂时，**优先用对话 + `platform` 代配**，不要让用户自己在面板里翻卡片。

流程：`settings.get_web_search` → 读返回里的 **`assistant_guide`**（`say_to_user` / `next_steps` / `status`）→ 需要写配置时 `patch` → `test`。

```text
platform action=settings.get_web_search
# 先看 assistant_guide.status / say_to_user，再决定问用户要 Key 还是直接测通

platform action=settings.patch_web_search confirm=true
  args_json={"preferredBackend":"doubao","doubaoApiKey":"<用户提供的联网 Key>"}

platform action=settings.test_web_search confirm=true
  args_json={"engines":["doubao"],"query":"今天 AI 新闻","adopt_recommended":true}
```

**Agent Plan 用户（最常见困惑）**
- 套餐赠送的是豆包搜索额度；须在火山控制台 **配置 Harness → 豆包搜索** 领取 **联网搜索 API Key**。
- 该 Key **不是** 对话用的 `ark-` Key；`assistant_guide` 在 `agent_plan_needs_doubao_key` 时会写明领取链接。
- 绑 Plan 后首选通常已是 `doubao`；缺的就是把 Harness 联网 Key 写入 `doubaoApiKey`。

其它约定：
- 密钥读回已脱敏；空字符串不会清空已有 Key。
- 首选渠道：`doubao` / `bocha` / `tavily` / `brave-free` / `searxng` / `firecrawl` / `infoquest` / `ddgs`。
- 独立豆包：[豆包搜索控制台](https://console.volcengine.com/search-infinity/web-search-exp)。
- 博查：[open.bochaai.com](https://open.bochaai.com/)（`bochaApiKey`）。
- 临时搜网页仍用工具 `web_search`；配好引擎后才搜得稳。

### Skills

```bash
evoflow skills list
evoflow skills list --enabled-only
evoflow skills get <name>
evoflow skills enable <name>
evoflow skills disable <name>
evoflow skills install /path/to/pkg.skill
evoflow skills install-market <slug>
evoflow skills delete <name>   # custom only
```

编辑 `SKILL.md` 正文：用 `evoflow skills get` 确认路径后，`read_file` / `write_to_file` / `replace_in_file` 改 `skills/custom/<name>/SKILL.md`（host 工作区可见时）。

### Agents

```bash
evoflow agents list
evoflow agents list --tag <label>    # 按标签筛选，如 --tag 核心
evoflow agents get <name>      # use "main" for lead agent
evoflow agents check <code>
evoflow agents create --file agent.json
evoflow agents update <name> --file patch.json
evoflow agents delete <name>
```

创建/更新 JSON 可用 `tags` 字段（字符串数组，如 `["核心", "代码"]`）；省略时按 `agent_code` 自动推断初始标签。

示例见 [`examples/agent-create.json`](examples/agent-create.json)。

### MCP

```bash
evoflow mcp list
evoflow mcp get <server_name>
evoflow mcp show                         # 全部原始 JSON（≈ platform mcp.get）
evoflow mcp add --file server.json       # 或按 CLI 帮助传 name/transport
evoflow mcp remove <server_name>
evoflow mcp test <server_name>
evoflow mcp login <server_name>          # HTTP MCP OAuth
evoflow mcp logout <server_name>
evoflow mcp set --file mcp.json          # 整体替换（≈ platform mcp.set）
```
### Long-term memory（Middleware 注入，非 remember）

```bash
evoflow memory show
evoflow memory show --agent main
evoflow memory status
evoflow memory reload
evoflow memory clear
evoflow memory agents
evoflow memory facts delete <fact_id>
```

### Knowledge base（平台自有知识库；对齐 platform knowledge.*）

```bash
evoflow knowledge create --name "英语单词库"          # 自有库 kb_…（默认）
evoflow knowledge create --name "旧 Vault" --legacy-vault [--path /已有目录]
evoflow knowledge vaults                              # 遗留 Obsidian 列表
evoflow knowledge enable|disable <vaultId>            # 仅遗留 Vault
evoflow knowledge list [--vault kb_…] [--prefix guides/]
evoflow knowledge get <path|docId> [--vault kb_…]
evoflow knowledge remember --file note.json           # title + knowledge|content
evoflow knowledge recall "keywords" [--vault kb_…] [--mode hybrid|semantic|keyword]
evoflow knowledge delete <path> [--vault kb_…]
```

### Experience library（经验库）

```bash
evoflow experience list --query "docker"
evoflow experience get <exp_id>
# --file 必须是路径；先写入 JSON 文件，或用 --stdin
evoflow experience save --file outputs/exp.json
echo '{"title":"...","problem":"...","solution":"..."}' | evoflow experience save --stdin
evoflow experience update <id> --file patch.json
evoflow experience mark-used <id>
evoflow experience delete <id>
```
任务前 `experience list`；复用后 `mark-used`；复杂任务结束评估是否 `save`。

### Workflows / Apps（对齐 platform workflow.*）

CLI 覆盖运行路径；**创建/发布/版本**走 platform（或 HTTP `/api/apps`）：

```bash
evoflow workflow list [--status …] [--search …]
evoflow workflow get <appId>
evoflow workflow run <appId> --file params.json    # 参数对象；可省略
evoflow workflow status <runId>
evoflow workflow stop <runId> [--pause] [--reason "…"]
```

```text
# 仅 platform（CLI 无对应子命令）
platform action=workflow.schema|create|generate|update|duplicate|publish|unpublish|delete
platform action=workflow.revisions|restore_revision|resume|list_runs
```
### User items（个人事项；对齐 platform items.*）

**事项 ≠ 协作任务。** 「帮我记一下」→ `items create`；要员工立刻干活 → `items dispatch` 或 `employees dispatch`。

```bash
evoflow items list [-q 关键词] [--status todo] [--exclude-done]
evoflow items get <item_id>
evoflow items create --file item.json              # title 必填
evoflow items update <item_id> --file patch.json
evoflow items delete <item_id>
evoflow items dispatch <item_id> --agent <agent_code> [--goal "…"] [--no-wake]
```

### Automations

```bash
evoflow automation list
evoflow automation get <id>
evoflow automation history <id> [--limit N]
evoflow automation create --file task.json
evoflow automation update <id> --file patch.json
evoflow automation pause <id>
evoflow automation resume <id>
evoflow automation delete <id>
```

示例见 [`examples/automation-daily-cron.json`](examples/automation-daily-cron.json) 和 [`examples/automation-once.json`](examples/automation-once.json)。

主要字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 任务名称 |
| `prompt` | ✅ | 执行时的提示词（Agent 收到的指令） |
| `cron_expr` / `schedule` | 二选一 | Cron 表达式（如 `0 9 * * *`）或 rrule |
| `schedule_type` | | `recurring`（默认）或 `once` |
| `scheduled_at` | once 时必填 | 一次性执行时间（ISO 格式） |
| `max_duration_minutes` | | 最大执行时长，默认 30 分钟 |
| `feishu_push_enabled` | | 完成后是否推送飞书 |
| `workspace` | | 指定工作区路径 |
| `valid_from` / `valid_until` | | 任务有效时间范围 |
| `langgraph_thread_mode` | | `fresh`（默认，每次新会话）或 `sticky`（复用会话） |
| `memory_enabled` | | 是否启用长期记忆 |

### User profile（资产中心）

用户画像 SoT：`~/.evoflow/assets/user/profile/{basic-info,preferences,persona}.md`

- 面板：`#/assets` → 画像
- 对话写入：`assets(action=profile, path=basic-info|preferences|persona, content=…)`
- 管理端：`assets.get_profile` / `assets.update_profile`（path + content）

```bash
evoflow assets init
# 导出含画像的实体包
evoflow assets export --type user --id user -o ./user-hub.evoflow-pack
```

### Workspace memory

```bash
evoflow workspace memory show <path>
evoflow workspace memory status <path>
evoflow workspace memory clear <path>
evoflow workspace memory bootstrap <path> [--model MODEL] [--force]
evoflow workspace memory prune <path> [--dry-run]
evoflow workspace memory seed <path> [--force]    # 已知布局写精选知识，不调 LLM
```

`<path>` 为工作区根目录。`bootstrap` 从 README、目录树等自动初始化工作区记忆。
### Past chat sessions（历史会话检索）

用户提到「上次聊过」「以前那个会话」时，先搜历史再回答，避免让用户重复描述。

```bash
evoflow sessions search --query "docker 端口"
evoflow sessions search -q "规划方案" --limit 3
evoflow sessions search -q "项目名" --titles
```

- 默认检索近 **90** 天消息正文；`--max-age-days 0` 表示几乎不限时间。
- `--titles`：消息无命中时再搜会话标题。

### Logs / diagnostics（日志与异常时间线）

系统内置已知日志源（gateway / langgraph / frontend / startup …）。用户报错或要转发排查材料时，**不要手翻路径**，走 platform 或本 CLI：

```bash
# 有哪些日志源、哪些近期有报错
evoflow logs sources
evoflow logs sources --hours 72

# 扫描异常行
evoflow logs scan --hours 24
evoflow logs scan -s gateway -s frontend --limit 100

# 可转发的异常时间线（含 markdown）
evoflow logs timeline --hours 24
evoflow logs timeline -s gateway --format markdown
```

等价 platform：`diagnostics.sources` / `diagnostics.scan` / `diagnostics.timeline`。

### Employees（智能体员工岗位）

**岗位 ≠ 智能体。** 先有 Agent（`evoflow agents`），再雇佣为值班岗位（`employees hire`）。主对话观察/派发也走本命令；**不要**把员工拉进群聊互相对话。

完整流程见 [`examples/employees-observe.md`](examples/employees-observe.md)。

```bash
# 名册 / 详情
evoflow employees list
evoflow employees list --status active
evoflow employees get <agent_code>

# 雇佣 / 改岗（先 agents create，再 hire）
evoflow agents check code-reviewer
evoflow agents create --file outputs/agent.json
evoflow employees hire --file skills/public/evoflow-admin/examples/employees-hire.json
evoflow employees update <agent_code> --file skills/public/evoflow-admin/examples/employees-update.json

# 上下岗
evoflow employees pause <agent_code>
evoflow employees resume <agent_code>
evoflow employees stop <agent_code>          # 只停在途轮次，岗位保持 active
evoflow employees archive <agent_code>

# 观察 / 派发 / 唤醒
evoflow employees worklog <agent_code> --day 2026-07-18
evoflow employees trail <agent_code> --round-id <id>
evoflow employees dispatch <agent_code> --goal "核对 ESLint 是否仍为 0 error"
evoflow employees wake <agent_code_or_role_name> --goal "协助验收" [--from <你的code>]
evoflow employees migrate [--agent-code <code>] [--dry-run]   # initiative → 岗位 Task
```

| 子命令 | 作用 | 依赖 Gateway |
|--------|------|----------------|
| `list` / `get` | 名册、详情、近期事项 | `list` 的 `busy` 需要 |
| `hire` | 把已有智能体雇成岗位 | 否（写 DB） |
| `update` | 改职责 / KPI / 心跳 / 上下班等 | 否 |
| `pause` / `resume` / `archive` | 停巡检 / 上岗 / 归档 | pause/archive 尽量通知 Gateway 取消在途 |
| `stop` | 停在途工作，保持 active | 尽量通知 Gateway |
| `worklog` / `trail` | 当日交班卡 / 工具轨迹 | 否 |
| `dispatch` | 等价 `@员工` 派发 | **是** |
| `wake` | 按 code/岗位名唤醒同事 | **是** |
| `migrate` | 历史 initiative 迁到 Task | 否 |

JSON 示例：

- 雇佣：[`examples/employees-hire.json`](examples/employees-hire.json)
- 改岗：[`examples/employees-update.json`](examples/employees-update.json)
- 输出形状：[`employees-list.sample.json`](examples/employees-list.sample.json) 等

`hire` 主要字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `agent_code` | ✅ | 必须已存在于 `evoflow agents` |
| `role_name` | | 岗位显示名（默认用智能体名） |
| `responsibilities` / `kpis` / `domain_scope` | | 职责、KPI、管辖目录 |
| `workspace_path` | | 绑定工作区绝对路径 |
| `autonomy_level` | | `approval_for_all`（默认）/ `approval_for_risky` / `full_auto` |
| `heartbeat_rrule` | | 如 `FREQ=HOURLY;INTERVAL=2` |
| `status` | | `active` / `paused` / `draft` |

读观察结果时优先看：`busy`、`verdict`、`tool_counts`、`pending_approvals`。对用户自然语言总结，勿整段复述 JSON。

### Collab tasks（协作任务台账；对齐 platform tasks.*）

**tasks ≠ items。** 任务中心台账、员工结案、状态机用本命令；用户随口备忘用 `items`。

```bash
evoflow tasks list [--status …] [--assignee <code>|--role <岗位名>] [--source chat|workflow|role]
evoflow tasks get <task_id> [--subtask-id …]
evoflow tasks create --name "…" [--assignee …] [--role …] [--description …]
evoflow tasks progress <task_id> --progress 50 [--status …]
evoflow tasks state <task_id> --status completed --summary "…"   # 走状态机校验
evoflow tasks delete <task_id> --yes
evoflow tasks cleanup-noise [--apply] [--limit N]               # 默认 dry-run
evoflow tasks reclaim-zombies [--apply]                        # 卡住的 executing@100% 等
```

等价 platform：`tasks.list|get|create|set_state|delete`；轨迹用 `tasks.execution_trail`（仅 platform）。

### Approvals（岗位工作项审批）

```bash
evoflow approvals list [--status pending|approved|rejected|timeout|all]
evoflow approvals request <task_id> [--note "…"] [--risk-level medium]
evoflow approvals approve <task_id_or_approval_id> [--comment "…"]
evoflow approvals reject <id> --reason "需补充验收标准"
```

`approve` 后执行依赖 Gateway。platform：`approvals.list|approve|reject`（无 `request` 时用 CLI）。

### Organization packs（资源包；仅 CLI / `/api/organizations`）

```bash
evoflow org preflight ./packs/foo [--workspace …]
evoflow org install ./packs/foo.zip --workspace ~/work/foo [--conflict fail|skip|replace]
evoflow org list [--status active|uninstalled|all]
evoflow org get <org_instance_id>
evoflow org uninstall <org_instance_id> [--keep-primitives] [--delete-workspace]
evoflow org export --employees a,b --apps App_xxx -o ./my-pack [--zip]
evoflow org market catalog
evoflow org market install packs/foo [--repo owner/repo@branch]
```

### Entity Asset Hub（仅 CLI / `/api/assets`）

```bash
evoflow assets init
evoflow assets migrate [--dry-run] [--only …]
evoflow assets export -o ./pack.evoflow-pack
evoflow assets import ./pack.evoflow-pack
```

## Typical workflows

### Create a custom agent

1. `evoflow agents check my-role`
2. `evoflow skills list --enabled-only`
3. 写入 JSON（可选 `tags`，如 `["项目", "代码"]`）→ `evoflow agents create --file outputs/agent.json`
4. `evoflow agents get my-role` 验证

### Hire agent as duty employee（安排岗位）

1. 确认智能体存在：`evoflow agents get <code>`（没有则先 `agents create`）
2. 参考 [`examples/employees-hire.json`](examples/employees-hire.json) 写职责/KPI/工作区
3. `evoflow employees hire --file outputs/hire.json`
4. `evoflow employees get <code>` 验证；需要改岗用 `employees update`

### Enable a skill

1. `evoflow skills list` → `evoflow skills enable <name>`

### Save experience after hard bugfix

1. `evoflow experience list --query "<keywords>"`
2. 若无匹配：`evoflow experience save --file outputs/exp.json`

### Review today's AI employees

1. 读 [`examples/employees-observe.md`](examples/employees-observe.md)
2. `evoflow employees list` → 记下 `agent_code` / 忙碌 / 待批
3. 对关心的员工：`evoflow employees worklog <code> --day <今天>`
4. 若 `verdict=incomplete` 或用户质疑「有没有干活」：`evoflow employees trail <code> --round-id <id>`
5. 需要派人做事：`evoflow employees dispatch <code> --goal "…"`（Gateway 须在跑）

## What stays as built-in tools (NOT this skill)

| 仍用内置工具 | 原因 |
|-------------|------|
| `scenario`, `ask_clarification`, `subagent`, `worker`, `terminal` | 运行时 / 核心 |
| `plan`, `supervisor`, `todo` | 编排 |
| `read_file`, `write_to_file`, … | 工作区文件 |
| `propose_goal`, `send_message`, `claude-code` | 交互/外部运行时 |

历史会话检索走 **`evoflow sessions search`**（本技能 + `terminal`），不再使用内置 `session_search`。
智能体员工观察 / 派发走 **`evoflow employees …`**（本技能 + `terminal`），不要另造内置工具。

### Eval Center（发版回归）

面板：`#/eval`。CLI：

```bash
evoflow eval run --mode smoke          # L1 场景（含七大模块主路径）+ 安全 smoke
evoflow eval run --mode scenario       # 全部场景含 L2 细节包
evoflow eval run --mode full           # 场景 + 全量 observational
# 模块 L0/L1/L2：见 evoflow.eval.case_spec.CASE_CATALOG（优先级/流类型/前置步骤预期）
# 跨模块：sc_cross_module_saga（P0）+ reject / no_hire（P1）
# L3 轨迹规划：catalog 可见，本轮不跑 LLM

evoflow eval cases --category scenario
evoflow eval runs
evoflow eval show <run_id>
```

- `smoke` / `scenario`：隔离临时库执行真实 admin API（Items 派发、员工、审批、Workflow rollup、Plan 门、知识库检索等），**不调 LLM**。
- `observational`：只读生产库算任务/工具/安全/性能分。
- HTTP：`POST /api/eval/run`（`mode` + `async_mode`），进度 `GET /api/eval/run/{id}/progress`。

## Product wording

- 用户说「角色 / 新建助手」→ 用本技能 + CLI 创建 Agent，不是单轮扮演；也可触发 **`preset-role-assistant`**（同样落盘走 `agents create` / `platform`）。
- 用户说「安排岗位 / 雇员工 / 改职责 KPI」→ `agents`（如需）+ `employees hire|update`。
- 用户说「今天员工干了啥 / 谁在值班 / 让 XX 去查」→ `employees list|worklog|trail|dispatch|wake`。
- 用户说「记待办 / 个人事项」→ `items`（或 platform `items.*`），不要建成协作 `tasks`。
- 用户说「任务中心 / 结案 / 改进度」→ `tasks`（或 platform `tasks.*`）。
- 用户说「审批 / 批一下」→ `approvals list|approve|reject`。
- 用户说「装资源包 / 导出组织」→ `org …`（无 platform 域）。
- 用户说「跑工作流 / App」→ 运行用 `workflow`；创建/发布用 platform `workflow.*` 或 `/api/apps`。
- 用户说「评测 / 回归 / 发版前验证」→ `evoflow eval run --mode smoke` 或打开面板评测中心。
- 对用户描述时用「系统设置 / 角色管理 / 专项能力包 / 智能体员工」，少提 CLI 与 JSON。
