# 流式验收案例目录（能力向）

> **定位**：本页与 [案例索引](index.md) 中的「故事型最佳实践（一至八）」**并列**：索引偏**用户旅程与截图步骤**；本目录偏**产品能力 / 管理面 + 执行面**，与你在 EvoPanel 里常做的「创建 / 管理智能体、技能、定时任务、Plan、联网出稿、主对话里持续改需求」等对齐，便于**逐项跑验收、逐项写正式报告**（模板见 [scenario-acceptance-report.template.md](templates/scenario-acceptance-report.template.md)）。

---

## 0. 验收写法：模拟真实用户，而不是「写死底层实现」

| 原则 | 说明 |
|------|------|
| **用户消息** | 用**目标 + 约束**描述（「我想做…」「帮我看看…」「接上条…」），**不要**在提示词里写「你必须调用 xxx」「当前是 xxx 场景你必须…」这类实现层指令。真实用户通常不知道底层有哪些可调用的实现单元。 |
| **与 EvoPanel 对齐** | 请求里与界面勾选一致的上下文字段，以**网关 / OpenAPI / 脚本源码**为准；**本文档不展开字段名或取值枚举**，避免把「场景标识」当作文档正文。 |
| **如何判断通过** | 以**是否完成用户意图**为主：有无可读答复、错误事件、明显幻觉。若需复盘「助手背后做了什么」，只把**结构化记录**放进报告附件（JSON），**用户向正文不要罗列实现层名称**——读者只需知道「达成了什么 / 出了什么问题」。 |
| **与 CI 脚本的关系** | `e2e_scenarios_api_test.py` 中部分用例为**回归硬断言**（对实现层名称做断言，便于防回归）；**对外验收 / 体验评估**请优先采用 **§6 自然用户冒烟脚本** 及下节「脚本内用户消息」中偏自然语的段落。二者可并行保留。 |

---

**推荐执行顺序**：**acc-09（自然持续对话）** 与 **§6** 可随时穿插；**acc-01 → acc-08** 按依赖逐项执行。**不要一次跑完全表**，每完成一项再登记或成文（见 [流式 E2E 运行登记](e2e-stream-run-registry.md)）。

**环境约定（与现有文档一致）**

| 服务 | 典型本机端口 |
|------|----------------|
| Gateway | `http://127.0.0.1:8070` |
| LangGraph | `2070`（由 Gateway 代理，脚本一般只打 Gateway） |

---

## 1. 主目录（与常见文档表述对齐）

**统一执行方式（不在此写 CLI 枚举名）**：在 `backend` 目录执行  
`uv run python scripts/e2e_scenarios_api_test.py --gateway <GATEWAY> --output-json <路径.json>`  
子集筛选、合法参数列表以 **`python scripts/e2e_scenarios_api_test.py --help`** 为准。Plan 专项：`uv run python scripts/e2e_plan_mode_api_test.py --gateway <GATEWAY> --output-json <路径.json>`（同样 **`--help`**）。

| ID | 验收能力 | 脚本定位（文件名 → 函数名） | 通过准则（摘要） |
|----|-----------|---------------------------|------------------|
| **acc-01** | **创建智能体** | `e2e_scenarios_api_test.py` → `run_scenario_create_agent` | 脚本断言通过；无流内 `error_events` |
| **acc-02** | **管理智能体**（列表 / 摘要） | 同上 → `run_scenario_manage` | 同上 |
| **acc-03** | **创建技能** | 同上 → `run_scenario_create_skill` | 同上 |
| **acc-04** | **管理技能**（只了解现状，不要求新建） | **自然用户**：§1.1 提示词，自行发起流式；**弱替代**：同上 → `run_scenario_evolve` | 回答覆盖「现有技能与用途」；附件 JSON 可查侧载；无安全违规 |
| **acc-05** | **创建定时任务** | REST：`POST /api/automation/tasks`（无 LangGraph 流） | 见 [§1.2](#12-acc-05-示例-rest-创建一次性定时任务)；HTTP 200；可 GET 到任务 |
| **acc-06** | **管理定时任务** | REST：`/api/automation/...` | 列表 / 快照 / 暂停 / 恢复 / 删除结果符合预期 |
| **acc-07** | **创建 Plan**（澄清 → 确认执行） | `e2e_plan_mode_api_test.py` → `run_e2e` | `summary.ok`；用户消息原文见 [§1.3](#13-脚本内用户消息与发送文本一致以源码为准) |
| **acc-08** | **外联信息并成稿**（短文 / 报告感） | `e2e_scenarios_api_test.py` → `run_scenario_web`（CI）；日常更推荐 §6 | 无 `error_events`；`ai_text_seen`；意图达成即可 |
| **acc-09** | **主对话持续追问**（同 thread 多轮） | `stream_natural_acceptance_smoke.py` → `natural_execute_continue` | 第二轮承接上文；无未处理 `error_events` |

### 1.1 acc-04 自然用户提示词示例（不指定底层实现）

```text
我想了解一下这个项目里已经配置了哪些技能、各自大概是做什么用的，能帮我用条目简单列一下吗？如果某个技能有说明文档，可以挑一个用一句话概括内容，不用创建新技能。
```

验收在报告**附件**中保留流式 JSON；**正文**用业务语言概括：是否只做了「了解现状」、是否出现与意图不符的写操作。

### 1.2 acc-05 示例：REST 创建一次性定时任务

将 `GATEWAY` 换成你的基址（如 `http://127.0.0.1:8070`）：

```bash
curl -sS -X POST "%GATEWAY%/api/automation/tasks" ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"验收-一次性\",\"prompt\":\"用中文回复：定时任务冒烟成功。\",\"schedule_type\":\"once\",\"scheduled_at\":\"2099-12-31T09:00:00\"}"
```

（Linux/macOS 请将 `^` 换为 `\`。）

**说明**

- **acc-05～06** 不在 LangGraph 流里，正式报告中标明 **REST**。  
- **acc-07** 与界面「规划 → 确认执行」强相关；除用户可见字串外，还有机器可读澄清载荷，以 `e2e_plan_mode_api_test.py` 为准。  
- **acc-08 / acc-09** 日常优先 **§6**；§1.3 中 CI 用 `run_scenario_web` 的提示词偏硬，仅作回归对照。

### 1.3 脚本内用户消息（与发送文本一致，以源码为准）

以下为用户消息原文（或不可分割的拼接），**随版本以仓库为准**；此处便于复制对照，**不**再单独列出请求里的场景类配置。

#### `e2e_scenarios_api_test.py` → `run_scenario_manage`

```text
当前是 manage 场景。你必须调用 list_agents 或 skill_manager 至少一次：列出当前已配置的 agents 或技能状态摘要。禁止执行 execute_command、禁止 write_to_file/delete_file。
```

#### `e2e_scenarios_api_test.py` → `run_scenario_create_agent`

```text
当前是 manage 场景。你必须调用一次 create_agent：agent_code 必须严格等于 "e2e-bootstrap-<脚本运行时生成的时间戳串>"（仅小写字母、数字、连字符），agent_type 为 subagent，agent_name 为 "E2E 自动化占位"，system_prompt 用一句中文说明仅用于自动化回归、无业务含义。不要调用 execute_command、write_to_file、delete_file；不要创建第二个 agent。
```

（`agent_code` 中尖括号部分为说明占位，**实际字符串以源码 `agent_code = …` 为准**。）

#### `e2e_scenarios_api_test.py` → `run_scenario_create_skill`

内嵌整段 SKILL.md 的 `prompt` 过长，**全文见源码** `run_scenario_create_skill` 中 `prompt = (` … `)`。

#### `e2e_scenarios_api_test.py` → `run_scenario_chat`

```text
用中文解释：什么是 HTTP 长连接（keep-alive）？只解释概念，不要调用任何工具，不要联网搜索，不要读写文件。
```

#### `e2e_scenarios_api_test.py` → `run_scenario_web`（CI 回归）

```text
当前是 web 场景。你必须调用 web_search 或 web_fetch 至少一次，查询「Python 3.12 正式发布日期」并给出一句结论（附来源域名即可）。不要编造。
```

#### `e2e_scenarios_api_test.py` → `run_scenario_evolve`

```text
当前是 evolve 场景。请给出 2 条可执行的助手能力改进建议，并调用 skill_manager 或 read_file 至少一次：例如用 read_file 读取某个技能目录下的 SKILL.md（若不存在则说明），或用 skill_manager 查询技能状态。不要执行 execute_command。
```

#### `e2e_scenarios_api_test.py` → `run_scenario_execute`

多轮流式（规划句、澄清载荷、执行阶段等），**用户可见与机器可读段落均以源码 `run_scenario_execute` 为准**，此处不展开。

#### `e2e_scenarios_api_test.py` → `run_scenario_trae`

```text
当前是 trae 场景。请调用 trae_status 或 trae_start 检查/启动 Trae 运行时（二选一即可）。如果工具不可用，说明缺少的配置或依赖。
```

#### `e2e_plan_mode_api_test.py` → `run_e2e`（首轮规划用户字串）

```text
使用执行场景。先问我一个澄清问题，再给计划，不要执行。任务1写task1.txt，任务2/3并行写task2.txt/task3.txt。
```

第二轮起为澄清协议前缀 + JSON + 续句，**完整拼接见源码** `clarify_reply = f"__EVF_CLARIFY_ANS_V1__: …"` 一段。

#### `stream_natural_acceptance_smoke.py`（§6，推荐日常）

**natural_chat**

```text
我在学 Python asyncio：asyncio.gather 和「先 create_task 再 await 多个 task」在实际项目里一般怎么选？用一两个生活化类比就行，不用写代码。
```

**natural_execute_continue 第一轮**

```text
我在维护一个叫 EvoFlow 的项目，后端是 Python。如果只想给运维同事加一个「看一眼就知道服务活着」的说明，你会建议从哪几个文件或目录入手？先给简短建议，不用真的改仓库。
```

**natural_execute_continue 第二轮**

```text
接上条：如果只动一处、工作量最小，你更推荐先改 README 里加一段 health 说明，还是加一个真正的 HTTP health 路由？用两三句话帮我定个优先级就行。
```

**natural_web**

```text
帮我用非技术同事能看懂的语气，写两段话说明：2024 年前后 Python 做 Web 后端常见会听到哪些框架名字、各自大概适合什么场合。如果你参考了公开资料，在文末用一句话说明信息大致来自哪类来源（例如官方发布说明、技术媒体）即可。
```

---

## 2. 与「故事型」案例索引的交叉对照

| 能力项 ID | 可参考的故事型文档（非一一等同） |
|-----------|----------------------------------|
| acc-01 / acc-02 | [create-agent.md](create-agent.md) |
| acc-03 / acc-04 | [create-skill.md](create-skill.md)、[install-skill.md](install-skill.md) |
| acc-05 / acc-06 | [scheduled-tasks.md](scheduled-tasks.md) |
| acc-07 | [supervisor-mode.md](supervisor-mode.md)、[manual-acceptance-test-playbook.md](manual-acceptance-test-playbook.md) |
| acc-08 | [search-html-report.md](search-html-report.md) |
| **acc-09** | [claude-code-continuous.md](claude-code-continuous.md)、[use-main-agent.md](use-main-agent.md) |

---

## 3. 附录：可选回归项（按需）

| ID | 说明 | 脚本定位 |
|----|------|----------|
| **acc-A1** | 纯概念解释（脚本内建偏硬提示） | `run_scenario_chat` |
| **acc-A2** | 多轮执行流水线（脚本内建） | `run_scenario_execute` |
| **acc-A3** | Trae 运行时探测 | `run_scenario_trae` |

---

## 4. 与旧脚本 `generate_case_acceptance_reports.py` 的对应关系（待迁移）

此前 `case-01-use-main-agent` … `case-08-supervisor-mode` 按**故事线**命名，且部分提示词偏「指定底层实现」。后续建议以本页 **acc-xx** + **§0 / §6** 为准生成报告文件名与话术。

---

## 5. 正式报告与登记

- **模板**：[scenario-acceptance-report.template.md](templates/scenario-acceptance-report.template.md)  
- **轻量登记**：[e2e-stream-run-registry.md](e2e-stream-run-registry.md)  
- **方法说明**：[manual-acceptance-test-playbook.md](manual-acceptance-test-playbook.md)

---

## 6. 自然用户口吻冒烟脚本（推荐日常验收）

仓库脚本：`backend/scripts/stream_natural_acceptance_smoke.py`  
逻辑块名（仅用于本脚本自带的子集过滤参数，**非**产品里的场景名）：`natural_chat`、`natural_execute_continue`、`natural_web`。用户消息全文见 **§1.3** 末尾。

```bash
cd backend
uv run python scripts/stream_natural_acceptance_smoke.py --gateway http://127.0.0.1:8070
# 子集：python scripts/stream_natural_acceptance_smoke.py --help
```

输出：`docs/cases/reports/raw/natural-smoke-<时间戳>.json`（含每轮 `timing`、侧载聚合字段、`assistant_visible_text` 等；**验收正文勿逐条翻译**机器字段名）。

**通过建议（自然项）**：每轮 `error_events` 为空；`ai_text_seen` 为真（或说明为何仅有侧载、没有可见答复正文）；持续对话第二轮语义上承接第一轮。
