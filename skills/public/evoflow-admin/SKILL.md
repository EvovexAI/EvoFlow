---
name: evoflow-admin
description: EvoFlow 产品自介绍 + 系统治理 + 资产库契约 + 对话创建预设角色。用户问「EvoFlow 是什么 / 你能做什么 / 怎么用」时用白话介绍（细则见 references/product-intro.md）。新建预设角色、子智能体、人设、agent_code、SOUL、勾选工具/技能、或说「按文档快速创建角色」「帮我设计一个角色配置」时，按 references/preset-role.md 强制盘点后再 platform / evoflow agents 落盘（原 preset-role-assistant 已并入）。长期记忆/经验/偏好/craft 走内置 assets 工具（契约见 references/assets-contract.md，布局见 assets-layout.md）。日常行政优先 platform（catalog→confirm→执行）；复杂/脚本化治理再 terminal + evoflow CLI。覆盖模型、联网搜索、技能、Agent应用、插件、资源包、IM渠道、Agent、员工、工作流、事项、协作任务、审批、资产、知识库、MCP、评测、会话、自动化、画像、日志诊断、系统验证。description 够用勿整篇读 SKILL。仅挂主 Agent（main）；外部 Agent 用 evoflow-admin-external。
---

# EvoFlow Admin（自介绍 + 治理 + 资产）

## 何时用哪一段

| 用户意图 | 做法 |
|----------|------|
| 「是什么 / 能做什么 / 怎么用 / 介绍一下自己」 | 按 description + [`references/product-intro.md`](references/product-intro.md) 白话回答；**勿**向用户念 CLI |
| 长期记忆 / 经验 / 偏好 / craft / 资产审计 | 内置 **`assets`**；细则 [`references/assets-contract.md`](references/assets-contract.md)、布局 [`assets-layout.md`](references/assets-layout.md) |
| 日常平台行政（改模型、雇员工、事项…） | 内置 **`platform`**（先 `catalog`，写操作 `confirm=true`） |
| 脚本化 / 批处理 / CLI 独有参数 | **`terminal` + `evoflow`**（下文命令参考） |

已退役：分散工具 `create_agent`、`experience_*`、`memory_remember` / `remember`；旧 CLI `evoflow experience` / `evoflow memory`；旧 platform `memory.*` / `experience.*`；独立技能 **`evoflow-assets`** / **`evoflow-intro`** / **`preset-role-assistant`**（已并入本技能；建角色流程见 [`references/preset-role.md`](references/preset-role.md)）。长期记忆与经验统一走 **`assets` 工具**（面板 `#/assets`）。

**runtime / Work Body / 无 EvoFlow 会话的 Agent**：安装独立发行包 **`evoflow-admin-external`**（GitHub Releases / 官网下载，或本地用 `package_release.py` 打出 zip），不要依赖本技能里的 `platform` / `terminal` 工具叙述，也不要用软链接代替整包拷贝。

## Admin CLI

## Platform ↔ CLI 对照（保持同步）

| Platform 域 | CLI 组 | 备注 |
|-------------|--------|------|
| `knowledge.*` | `evoflow knowledge …` | vaults / create / enable / list / get / remember / recall / delete；platform 用 `ingest`/`notes`/`search` 等同义名 |
| `workflow.*` | `evoflow workflow …` | CLI：**仅** list / get / run / stop / status。创建/发布/复制/版本/resume/list_runs → **只用 platform** 或 `POST /api/apps` |
| `settings.*`（模型+联网搜索） | `evoflow models …` | 含 `update_model`；联网搜索暂无 CLI，用 `platform`：`settings.get/patch/test_web_search` |
| `appearance.*` | （暂无 CLI） | 主题/背景/液态玻璃：只用 `platform` |
| `agents.*` | `evoflow agents …` | CLI 另有 `check`；**无** `agents seed` |
| `employees.*` | `evoflow employees …` | 含 wake / migrate；CLI 另有 dispatch |
| `tasks.*` | `evoflow tasks …` | 含 progress / cleanup_noise / reclaim_zombies |
| `items.*` | `evoflow items …` | **个人事项 ≠ tasks** |
| `skills.*` / `mcp.*` / `automation.*` / `approvals.*` / `sessions.*` | 同名 CLI | MCP：platform 已有 list/add/remove/test/login/logout/get/set；旧 `memory.*` / `experience.*` 已退役，记忆与 craft 走 `assets` 工具 |
| `extensions.*` | （暂无 CLI；`/api/ui-extensions`） | **Agent应用**（侧栏网页）：list/get/install/enable/uninstall；远程 `id+url` 或本地 `path` |
| `plugins.*` | （暂无 CLI；`/api/plugins`） | 插件市场：overview/list/describe/install/enable/update/restore/uninstall + marketplace_* |
| `org.*` | `evoflow org …` | 资源包：preflight / install / list / get / uninstall / export / market_* |
| `channels.*` | （暂无 CLI；`/api/channels`） | IM 渠道：list/get/set_config/enable/restart/push_targets + 扫码 registration_* |
| `diagnostics.*` | `evoflow logs …` | sources / scan / timeline；综合诊断 `diagnostics.run` **仅 platform** |
| `verification.*` | （暂无 CLI，用 `platform` 或 `POST /api/platform`） | 技能 **`evoflow-system-verification`** |
| `assets.*` | `evoflow assets …` | 画像 + Asset Hub：init / migrate / export / import |
| `eval.*` | `evoflow eval …` | 评测中心：cases / run / runs / get / progress |
| （无） | `evoflow workspace memory …` | CLI 独有（刻意不对齐 platform）：show / status / clear / bootstrap / prune / seed |

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

对话里「快速创建预设角色」的强制步骤（澄清 → 查代号 → 盘技能/工具 → 用户确认 → 落盘）见 [`references/preset-role.md`](references/preset-role.md)。示例见 [`examples/agent-create.json`](examples/agent-create.json)。

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
### Long-term memory（Asset Hub）

旧 `evoflow memory …` 与 platform `memory.*` **已退役**（曾读写 SQLite facts，与默认注入脱节）。

- 对话读写：内置 **`assets`** 工具；契约见 [`references/assets-contract.md`](references/assets-contract.md)
- 面板：`#/assets`（侧栏「记忆」入口也进资产中心）
- 迁移旧库：`evoflow assets migrate --only memory`
- 项目级知识（仍独立）：`evoflow workspace memory …`

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

### Experience / craft（可复用经验）

旧 CLI `evoflow experience …` **已退役**。沉淀踩坑经验：

- 对话：内置 **`assets`** 工具写 craft / `[experience]` 笔记（见 [`assets-contract.md`](references/assets-contract.md)）
- 迁移旧库：`evoflow assets migrate --only experience`

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
| `responsibilities` / `kpis` | | 职责、KPI |
| `workspace_path` | | 绑定工作区绝对路径 |
| `autonomy_level` | | `approval_for_all`（默认）/ `approval_for_risky` / `full_auto` |
| `heartbeat_schedule` | | 5 段 cron（与自动化同语义），如 `0 9-19/2 * * *`；旧字段 `heartbeat_rrule` 仍可用 |
| `status` | | `active` / `paused` / `draft` |
| `thinking_enabled` | | `true` 启用 / `false` 禁用 / `null` 跟随默认（模型思考/推理过程） |
| `model_name` | | 覆盖执行模型（空=用智能体默认） |
| `inject_user_profile` | | 是否注入用户画像（`true`/`false`/`null`） |
| `inject_memory` | | 是否注入对话记忆上下文（`true`/`false`/`null`） |
| `inject_assets` | | 是否注入资产/经验库（`true`/`false`/`null`） |
| `inject_skills` | | 是否注入技能描述（`true`/`false`/`null`） |
| `inject_kb` | | 是否注入知识库检索（`true`/`false`/`null`） |
| `inject_soul` | | 是否注入 SOUL.md 人设（`true`/`false`/`null`） |

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

### Organization packs（资源包；platform `org.*` / CLI / `/api/organizations`）

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

### Entity Asset Hub（platform `assets.*` / CLI / `/api/assets`）

```bash
evoflow assets init
evoflow assets migrate [--dry-run] [--only …]
evoflow assets export -o ./pack.evoflow-pack
evoflow assets import ./pack.evoflow-pack
```

## Typical workflows

### Create a custom agent

完整治理清单（含 SOUL / 最小权限 / 用户确认）见 [`references/preset-role.md`](references/preset-role.md)。精简版：

1. `platform agents.bindings`（或 `evoflow agents …`）→ **先选 `packs`**，勿灌全表 tools
2. `evoflow agents check my-role`
3. `evoflow skills list --enabled-only`
4. 写入 JSON：`capability_pack`（如 `writer`/`duty`/`coding`）+ 可选 `tools_extra` / `tags` → `evoflow agents create --file outputs/agent.json`
5. `evoflow agents get my-role` 验证

### Hire agent as duty employee（安排岗位）

1. 一次创建：`platform employees.create` + `capability_pack=duty`（或 research/writer/coding/none）
2. 或分步：确认智能体存在 → [`examples/employees-hire.json`](examples/employees-hire.json) → `evoflow employees hire --file outputs/hire.json`
3. **创建/雇佣成功后**：结果里有 `assistant_guide.say_to_user` —— **原话告诉用户**怎么用（对话 / 渠道 / 派发 / 自动上班），并问要不要绑飞书/企微
4. 用户要绑渠道：`platform employees.bind_channel_begin`（`agent_code` + `channel=feishu|wecom`，`confirm=true`）。右侧平台面板出二维码，扫完自动绑定本岗机器人。**不要**用 `channels.registration_*`（那是全局主机器人）
5. `evoflow employees get <code>` 验证；需要改岗用 `employees update`

知识库 `knowledge.create` 同理：复述 `assistant_guide.say_to_user`，再按用户意图 `ingest` / 绑到员工。

### Enable a skill

1. `evoflow skills list` → `evoflow skills enable <name>`

### Save experience after hard bugfix

1. 用 **`assets`**（细则见 [`assets-contract.md`](references/assets-contract.md)）写入 `[experience]` / craft 笔记
2. 勿再调用 `evoflow experience …`

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

- 用户说「你是谁 / EvoFlow 是什么 / 能做什么」→ 白话自介绍（[`references/product-intro.md`](references/product-intro.md)）；勿甩 CLI/JSON。
- 用户说「记住 / 记偏好 / 沉淀经验 / 审计资产」→ **`assets`** + [`assets-contract.md`](references/assets-contract.md)；勿再提已退役的 `evoflow-assets` 技能名。
- 用户说「角色 / 新建助手 / 设计角色配置」→ 按 [`references/preset-role.md`](references/preset-role.md) 盘点后再 `agents create` / `platform` 落盘；勿再提已退役的 `preset-role-assistant` 技能名；不是单轮扮演。
- 用户说「安排岗位 / 雇员工 / 改职责 KPI」→ `agents`（如需）+ `employees hire|update`。
- 用户说「今天员工干了啥 / 谁在值班 / 让 XX 去查」→ `employees list|worklog|trail|dispatch|wake`。
- 用户说「记待办 / 个人事项」→ `items`（或 platform `items.*`），不要建成协作 `tasks`。
- 用户说「任务中心 / 结案 / 改进度」→ `tasks`（或 platform `tasks.*`）。
- 用户说「审批 / 批一下」→ `approvals list|approve|reject`。
- 用户说「装资源包 / 导出组织」→ `platform` `org.*`（或 `evoflow org …`）。
- 用户说「跑工作流 / App」→ 运行用 `workflow`；创建/发布用 platform `workflow.*` 或 `/api/apps`。
- 用户说「评测 / 回归 / 发版前验证」→ `evoflow eval run --mode smoke` 或打开面板评测中心。
- 对用户描述时用「系统设置 / 角色管理 / 专项能力包 / 智能体员工」，少提 CLI 与 JSON。
