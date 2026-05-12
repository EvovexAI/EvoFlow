# 流式 E2E 运行登记（输入 / 输出 / 判定）

> **说明：**本页为**轻量汇总**，便于快速索引一次跑批。正式验收请使用 [验收报告模板](templates/scenario-acceptance-report.template.md)，**每个场景或每个案例单独一份**完整文档（含每轮工具耗时、模型全文输出、**文末**测试意见）。

本页由自动化/代理在本地执行 `e2e_scenarios_api_test.py` 后**手工整理**，登记每场景的**用户侧输入**、**可观测输出摘要**、**脚本判定**与**原始 JSON** 路径，便于与 [流式对话验收方法说明](manual-acceptance-test-playbook.md) 对照。

---

## 登记 #1 — 2026-05-12（Gateway 8070）

| 字段 | 值 |
|------|-----|
| **执行时间** | 2026-05-12（本地一次连续跑批） |
| **Gateway** | `http://127.0.0.1:8070` |
| **LangGraph**（本机） | `2070`（由 Gateway 配置代理，非脚本直连） |
| **session_key** | `agent:main:e2e-scenarios-20260512-142607` |
| **命令** | `uv run python scripts/e2e_scenarios_api_test.py --gateway http://127.0.0.1:8070 --timeout 420 --only chat,web,manage,create_agent,create_skill,evolve,trae --output-json scripts/_e2e_output/run-20260512-142606.json` |
| **原始 JSON** | `backend/scripts/_e2e_output/run-20260512-142606.json` |
| **套件结论** | **不通过**（`ok: false`）：轮次 2 失败，其余轮次通过 |
| **suite_wall_ms** | 258857.818 ms（≈ 4.3 min） |
| **说明** | 表中命令为**当时**跑批原样；现行写法（脚本函数名 + §1.3 用户消息、不展开 CLI 枚举）见 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §1。下列各轮 **context** 行保留为历史原始摘录。 |

### 轮次 1 — chat

| 项 | 内容 |
|----|------|
| **thread_id** | `f5dd7a6c-7a66-4069-ab03-ff5e4931f3dd` |
| **context** | `activated_scenarios=["chat"]`，`collab_phase=idle`，`is_plan_mode=false`，`recursion_limit=120` |
| **输入（用户消息原文）** | `用中文解释：什么是 HTTP 长连接（keep-alive）？只解释概念，不要调用任何工具，不要联网搜索，不要读写文件。` |
| **观测输出摘要** | HTTP 200；`ai_text_seen=true`；无工具调用；无 `error_events`。 |
| **timing** | `request_total_ms=14120.54`，`first_ai_visible_ms=13087.981`，`tool_runs=[]` |
| **脚本判定** | **通过** |

### 轮次 2 — web

| 项 | 内容 |
|----|------|
| **thread_id** | `ea968895-e5ea-46bb-aeb7-6f012ffcae85` |
| **context** | `activated_scenarios=["web"]`，`collab_phase=idle`，`recursion_limit=300` |
| **输入（用户消息原文）** | `当前是 web 场景。你必须调用 web_search 或 web_fetch 至少一次，查询「Python 3.12 正式发布日期」并给出一句结论（附来源域名即可）。不要编造。` |
| **观测输出摘要** | HTTP 200；流内多次 `web_search` / `web_fetch`；**未**形成最终可见 AI 正文（`ai_text_seen=false`）；SSE 出现 `GraphRecursionError`（`recursion_limit` 300 耗尽）；`unclosed_tool_call_ids` 含 `functions.web_fetch:6`。 |
| **timing** | `request_total_ms=122401.303`，`first_ai_visible_ms=null`；`web_fetch` 单次工具耗时最高约 **63903.697 ms** |
| **脚本判定** | **不通过**（`web: no AI text observed…` + recursion 错误） |
| **排查建议** | 提高 `run_scenario_web` 的 `recursion_limit` 或收紧提示词限制 fetch 次数；关注慢速 `web_fetch` 域名。 |

### 轮次 3 — manage

| 项 | 内容 |
|----|------|
| **thread_id** | `6f4c7bbf-949f-45c7-ab9a-a89df3b9d755` |
| **context** | `activated_scenarios=["manage"]`，`collab_phase=idle`，`recursion_limit=120` |
| **输入（用户消息原文）** | `当前是 manage 场景。你必须调用 list_agents 或 skill_manager 至少一次：列出当前已配置的 agents 或技能状态摘要。禁止执行 execute_command、禁止 write_to_file/delete_file。` |
| **观测输出摘要** | HTTP 200；工具序列含 `scenario`、`list_agents`；`ai_text_seen=true`；无 `error_events`。 |
| **timing** | `request_total_ms=18504.846`，`list_agents` **duration_ms=161.453** |
| **脚本判定** | **通过** |

### 轮次 4 — create_agent

| 项 | 内容 |
|----|------|
| **thread_id** | `cce8d6ed-15ed-44e3-b535-001f95c5c510` |
| **context** | `activated_scenarios=["manage"]`，`collab_phase=idle`，`recursion_limit=200` |
| **输入（用户消息原文）** | `当前是 manage 场景。你必须调用一次 create_agent：agent_code 必须严格等于 "e2e-bootstrap-20260512142843"（仅小写字母、数字、连字符），agent_type 为 subagent，agent_name 为 "E2E 自动化占位"，system_prompt 用一句中文说明仅用于自动化回归、无业务含义。不要调用 execute_command、write_to_file、delete_file；不要创建第二个 agent。` |
| **观测输出摘要** | HTTP 200；`create_agent` 已调用；`ai_text_seen=true`；无 `error_events`。 |
| **timing** | `create_agent` **duration_ms=1656.663** |
| **bootstrap_agent_code** | `e2e-bootstrap-20260512142843` |
| **脚本判定** | **通过** |

### 轮次 5 — create_skill

| 项 | 内容 |
|----|------|
| **thread_id** | `74247f2a-e71d-40d8-892d-b158413416f8` |
| **context** | `activated_scenarios=["manage"]`，`collab_phase=idle`，`recursion_limit=240` |
| **输入（用户消息原文）** | `当前是 manage 场景。你必须调用一次 skill_manager：action 为 create，name 必须严格为 "e2e-skill-bootstrap-20260512142858"，content 为下列完整 SKILL.md（原样作为 content 传入，保留换行与 frontmatter）：` +（内嵌 YAML 与正文，与脚本 `run_scenario_create_skill` 一致）+ `不要调用 execute_command；除本次 create 外不要 delete 其他技能。` |
| **观测输出摘要** | HTTP 200；`skill_manager` 已调用；`ai_text_seen=true`；无 `error_events`。 |
| **timing** | `skill_manager` **duration_ms=2497.838** |
| **bootstrap_skill_name** | `e2e-skill-bootstrap-20260512142858` |
| **脚本判定** | **通过** |

### 轮次 6 — evolve

| 项 | 内容 |
|----|------|
| **thread_id** | `0f09e877-aa64-4947-b89a-8027af2186a4` |
| **context** | `activated_scenarios=["evolve"]`，`collab_phase=idle`，`recursion_limit=300` |
| **输入（用户消息原文）** | `当前是 evolve 场景。请给出 2 条可执行的助手能力改进建议，并调用 skill_manager 或 read_file 至少一次：例如用 read_file 读取某个技能目录下的 SKILL.md（若不存在则说明），或用 skill_manager 查询技能状态。不要执行 execute_command。` |
| **观测输出摘要** | HTTP 200；工具含 `skill_manager`、`read_file`（多轮）；`ai_text_seen=true`；无 `error_events`。 |
| **timing** | `request_total_ms=38751.92` |
| **脚本判定** | **通过** |

### 轮次 7 — trae

| 项 | 内容 |
|----|------|
| **thread_id** | `3d581867-6000-4d20-95b2-0e70b9645ada` |
| **context** | `activated_scenarios=["trae"]`，`collab_phase=idle`，`recursion_limit=120` |
| **输入（用户消息原文）** | `当前是 trae 场景。请调用 trae_status 或 trae_start 检查/启动 Trae 运行时（二选一即可）。如果工具不可用，说明缺少的配置或依赖。` |
| **观测输出摘要** | HTTP 200；`mode=tools_ok`；`ai_text_seen=true`；`timing.tool_runs` 含 `trae_status`、`trae_start`（与聚合 `tool_names_unique` 展示可能不一致时以 `timing.tool_runs` 为准）。 |
| **timing** | `trae_start` **duration_ms=11609.42** |
| **脚本判定** | **通过** |

---

## 登记 #2 — 自然用户口吻冒烟（acc-09 / §6，Gateway 8070）

| 字段 | 值 |
|------|-----|
| **执行时间** | 2026-05-12（本地） |
| **Gateway** | `http://127.0.0.1:8070` |
| **session_key** | `agent:main:natural-smoke-20260512-070842` |
| **命令** | `cd backend && uv run python scripts/stream_natural_acceptance_smoke.py --gateway http://127.0.0.1:8070 --timeout 420` |
| **原始 JSON** | `docs/cases/reports/raw/natural-smoke-20260512-070842.json` |
| **对照文档** | [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §0、§6；acc-09 |

### natural_chat

**用户消息（脚本原文）**

```text
我在学 Python asyncio：asyncio.gather 和「先 create_task 再 await 多个 task」在实际项目里一般怎么选？用一两个生活化类比就行，不用写代码。
```

| 项 | 内容 |
|----|------|
| **观测** | `ai_text_seen=true`；侧载条目数 0；无 `error_events`；`request_total_ms≈17557` |

### natural_execute_continue（同 thread 两轮，acc-09）

**第一轮用户消息**

```text
我在维护一个叫 EvoFlow 的项目，后端是 Python。如果只想给运维同事加一个「看一眼就知道服务活着」的说明，你会建议从哪几个文件或目录入手？先给简短建议，不用真的改仓库。
```

| 项 | 内容 |
|----|------|
| **观测** | `ai_text_seen=true`；侧载条目数 0；无 `error_events`；`request_total_ms≈18160` |

**第二轮用户消息**

```text
接上条：如果只动一处、工作量最小，你更推荐先改 README 里加一段 health 说明，还是加一个真正的 HTTP health 路由？用两三句话帮我定个优先级就行。
```

| 项 | 内容 |
|----|------|
| **观测** | `ai_text_seen=true`；侧载条目数 0；无 `error_events`；`request_total_ms≈13763` |

### natural_web

**用户消息（脚本原文）**

```text
帮我用非技术同事能看懂的语气，写两段话说明：2024 年前后 Python 做 Web 后端常见会听到哪些框架名字、各自大概适合什么场合。如果你参考了公开资料，在文末用一句话说明信息大致来自哪类来源（例如官方发布说明、技术媒体）即可。
```

| 项 | 内容 |
|----|------|
| **观测** | `ai_text_seen=true`；侧载条目数 0（模型直接成稿）；无 `error_events`；`request_total_ms≈19241` |
| **备注** | 自然验收以「是否达成用户意图」为准。若需验证「外联信息检索」链路，请跑 `e2e_scenarios_api_test.py` 中 **`run_scenario_web`** 对应用户消息（见 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §1.3），或在自然话里加强「请基于可查的公开资料」等**业务表述**。 |

---

## 登记 #3 — 2026-05-12 复测（自然冒烟 + 回归套件，Gateway 8070）

### A）自然用户口吻冒烟

| 字段 | 值 |
|------|-----|
| **命令** | `cd backend && uv run python scripts/stream_natural_acceptance_smoke.py --gateway http://127.0.0.1:8070 --timeout 420` |
| **原始 JSON** | `docs/cases/reports/raw/natural-smoke-20260512-072051.json` |
| **对照** | [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §6；用户消息原文见同页 §1.3 末尾 |
| **结论** | 四段均 `ai_text_seen=true`、无 `error_events`、侧载条目数 0；整批墙钟约 **54 s**（以本机 `request_total_ms` 之和为参考） |

### B）`e2e_scenarios_api_test.py` 多段回归（含外联成稿 CI 段）

| 字段 | 值 |
|------|-----|
| **命令** | `cd backend && uv run python scripts/e2e_scenarios_api_test.py --gateway http://127.0.0.1:8070 --timeout 420 --output-json scripts/_e2e_output/run-20260512-152147.json`（子集过滤为当时命令行原样，见 JSON 内 `results`） |
| **session_key** | `agent:main:e2e-scenarios-20260512-152148` |
| **原始 JSON** | `backend/scripts/_e2e_output/run-20260512-152147.json` |
| **套件结论** | **`ok: true`**（七段均通过） |
| **suite_wall_ms** | 约 **490414** ms（≈ 8.2 min） |
| **用户消息** | 与 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) **§1.3** 及源码一致；逐段明细以 JSON 为准 |

---

## 后续登记方式

每次跑批后：

1. 保留 `--output-json` 文件于 `backend/scripts/_e2e_output/`。  
2. 在本文件追加「登记 #N」小节，表结构同上。  
3. 若需与案例文档对齐，将对应小节链接到各 `docs/cases/*.md` 内的「验收交互记录」表（见验收方法说明）。
