# 最佳实践案例 — 流式对话验收方法说明

本文档只描述**怎么测**：通过**与 EvoPanel 相同的实时对话流式接口**模拟真实用户发消息，消费 SSE/流式事件，对照各案例文档中的预期做判断；并在**对应案例文档**里沉淀**每一轮交互的输入与输出**，便于版本回溯与缺陷复现。

具体「测什么、示例提示词」仍以各案例正文为准（见 [案例索引](index.md)），本文不重复案例一至八的业务步骤表。  
**能力向验收项（创建/管理智能体与技能、定时任务、Plan、联网出稿等）** 的编号、命令与 REST 说明见 **[流式验收案例目录（能力向）](stream-acceptance-catalog.md)**，与索引中的故事线文档交叉对照。

---

## 1. 目标与边界

| 项目 | 说明 |
|------|------|
| **目标** | 验证「用户发一句 → 运行时流式返回 → 工具/阶段/最终文案」是否与该案例文档描述一致；异常时可凭文档中的 I/O 记录快速对齐网关版本与配置。 |
| **推荐主路径** | 调用 Gateway 代理的 LangGraph 流式接口（与桌面 EvoPanel 对话同源），而非仅肉眼点 UI（UI 可作为辅助录制 session_key / thread_id）。 |
| **不在此接口内的操作** | 纯表单类：新建角色、新建技能、定时任务 TOML、渠道配置等，走 REST/UI；若案例包含这类步骤，文档中区分「非流式步骤」与「流式对话步骤」，**流式步骤**必须按第 4 节记入交互记录。 |

---

## 2. 与真实用户等价：流式接口

与 IM、渠道、任务执行等共用思路一致：对用户消息发起一次 **run stream**，按事件增量观测。

- **HTTP**：`POST {GATEWAY_BASE}/api/langgraph/threads/{thread_id}/runs/stream`
- **`thread_id`**：同一案例的多轮追问须复用同一线程，才能验证上下文；新案例或要隔离状态时可换新 `thread_id`。
- **请求体要点**（与 EvoPanel 对齐；字段以当前网关实现为准）：
  - `assistant_id`：如主智能体为 `lead_agent`
  - `input.messages`：用户消息（结构与前端一致，常见为 `role` + `content` 块）
  - `stream_mode`：建议至少包含 `messages-tuple`（token/消息增量）与 `values`（状态快照）；需要自定义进度事件时可加 `custom`
  - `context`：与 EvoPanel 勾选一致；**字段名与合法取值以 OpenAPI / 脚本为准**，能力向验收清单不在此罗列（见 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §0、§1）。

**参考实现（可直接当脚本模板）**：

- `backend/scripts/stream_timing_trace.py` — **流式耗时 trace**（单次 `runs/stream` 的墙钟、TTFT、工具耗时等），被下列脚本复用  
- `backend/scripts/e2e_scenarios_api_test.py` — 多场景流式聚合、工具名采集、**每轮 `stream.timing` + 场景 `thread_scenario_wall_ms` + 套件 `suite_wall_ms`**  
- `backend/scripts/e2e_plan_mode_api_test.py` — Plan 阶段与 `collab_phase` 组合，**每轮流式带 `timing` + `thread_scenario_wall_ms`**  

**`session_key`**：须与一次登录/会话策略一致；手工可用浏览器开发者工具从 EvoPanel 对话请求里复制，或采用与脚本类似的测试用前缀（如 `agent:main:e2e-...`），**同一组多轮测试保持不变**。

**网关与 LangGraph 端口（以你本机实际为准）**

| 服务 | 你当前启动结果（示例） | 说明 |
|------|------------------------|------|
| **LangGraph** | `2070` | LangGraph API / Studio 直连端口；Gateway 通过 `EVOFLOW_LANGGRAPH_URL`（或 `config`/compose 中的等价项）访问该地址。 |
| **Gateway** | `8070` | EvoPanel / 流式脚本应对准 **`http://127.0.0.1:8070`**（或你的主机名），请求路径仍为 `/api/langgraph/...`。 |

流式验收脚本示例（与下节脚本一致；**子集与筛选参数见各脚本 `--help`**，不在此抄枚举）：

```bash
cd backend && uv run python scripts/e2e_scenarios_api_test.py --gateway http://127.0.0.1:8070 --output-json scripts/_e2e_output/run.json
```

若经 Nginx 统一入口，可能是 `8012` 等，以 `make dev` / `serve.sh` 或部署说明为准，见 [API 参考 - 架构说明](../reference/api-reference.md)。

**渐进测试建议**：同一 Gateway 下可先落盘全量 `--output-json`，再按 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) **§1 脚本函数名**在结果里分段对照；**用户消息原文**以该文档 **§1.3** 与源码为准，避免文档与脚本漂移。

---

## 3. 观测什么算「输出」（含功能与耗时）

对流式响应不要只截最后一句，建议按事件类型做最小结构化记录（便于 diff 与自动化后移）。  
**用户向验收正文**不必复述底层实现名称（终端用户通常不感知）；实现层细节放在 JSON 附件或单独「研发对照」小节即可（与 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §0 一致）。

### 3.1 功能与错误类（与原先一致）

| 观测项 | 含义 |
|--------|------|
| **聚合后的助手可见正文** | 从 `messages-tuple`（或等价事件）拼出的用户可见回复终稿 |
| **工具调用序列** | 出现的 `tool_calls` 名称及顺序（是否出现搜索、写文件、`write_todos`、`task` 等） |
| **协作 / Plan 相关** | `collab_phase` 变化、是否出现规划门禁下的拦截（无写工具等） |
| **错误与结束** | HTTP 非 2xx、SSE 中的 error、`end` 事件中的 usage 等 |

### 3.2 耗时类（验收标准的一部分）

以下指标与 **`stream_timing_trace.py` 输出的 `timing` 字典**一一对应（单位均为 **毫秒 ms**，墙钟 `time.perf_counter()`，与 EvoPanel 内「首 token」埋点可对照但数值定义以本模块为准）。

| 字段 | 定义 | 典型用途 |
|------|------|----------|
| **`request_total_ms`** | 自发起 `POST .../runs/stream` 起，至读完响应流（`iter_lines` 结束） | **单次流式请求整体耗时**；与模型快慢、工具多少、网络相关 |
| **`first_sse_payload_ms`** | 自 POST 起至首条有效 `data:`（非空、非 `[DONE]`） | 服务端排队 + 首包；排查网关/LangGraph 排队 |
| **`first_ai_visible_ms`** | 自 POST 起至**首次**解析到助手非空可见正文（TTFT 近似） | **单次模型首字延迟**；受模型、thinking、上下文长度影响大 |
| **`assistant_visible_stream_ms`** | 首末次观测到助手非空正文的时间差（流式多帧会反复刷新「末次」） | **同一次流内助手可见输出跨度**（含工具前后续写）；不是严格的「纯模型内部耗时」 |
| **`tool_runs`** | 数组；每项含 `name`、`tool_call_id`、**`duration_ms`**（自首次出现该 id 的 `tool_calls` 到首次出现对应 tool 结果消息） | **单次工具请求耗时**（含沙箱/MCP/网络）；未在流结束前闭合的项带 `duration_ms: null` 与 `pending_stream_end_ms` |
| **`unclosed_tool_call_ids`** | 流结束仍未收到结果的 `tool_call_id` 列表 | 流被截断、超时或配对失败时排查 |

**场景 / 套件级（脚本 JSON 顶层或 `results[]` 每项）**：

| 字段 | 定义 |
|------|------|
| **`thread_scenario_wall_ms`** | 自该场景内创建 `thread_id` 起，至该场景最后一轮流式与轮询逻辑结束（以 `e2e_scenarios_api_test` 各 `run_scenario_*` 为准） | **该场景在同一线程上的整体墙钟**（含多轮 `runs/stream` 与 `collab` 等待） |
| **`suite_wall_ms`** | `e2e_scenarios_api_test.py` 一次完整跑完所选场景的总墙钟 | **回归套件整体耗时** |

**如何把耗时当「标准」用**：

1. **基线对比**：在稳定环境、固定模型与 `--timeout` 下跑 `--output-json`，将 `timing` 与 `thread_scenario_wall_ms` 存为基线；后续发布对比 `first_ai_visible_ms`、`request_total_ms`、各 `tool_runs[].duration_ms` 是否异常抬升。  
2. **阈值（团队自拟）**：文档不规定全局 SLA；由你们在 `CHANGELOG` 或内部基线表中约定（例如 chat 场景 `first_ai_visible_ms` 不超过某 P95）。超阈值记为「性能不通过」，与功能断言并列。  
3. **文档回填**：第 4 节表格中增加耗时列或附 `--output-json` 路径，保证回溯时能看到当次数字。

**是否符合预期**：功能仍以**对应案例文档**成功条件为准；**耗时**以团队基线/阈值为准，二者并列记录。

---

## 4. 在「对应案例文档」里写每一轮交互（回溯规范）

每个案例 Markdown（如 `use-main-agent.md`、`create-agent.md`）在维护验收记录时，增加固定章节（名称可统一如下）：

```markdown
## 验收交互记录（测试回放）

**环境**：Gateway 基址、网关/ LangGraph 版本或 commit、模型名、`session_key` 前缀（脱敏）、测试日期、执行人（可选）

| 轮次 | thread_id | 请求要点（context 摘要） | 用户输入（原文） | 观测输出摘要 | 工具/阶段要点 | timing 摘要（见 §3.2） | 对照文档步骤/预期 | 通过 |
|------|-------------|--------------------------|------------------|--------------|---------------|------------------------|-------------------|------|
| 1 | … | is_plan_mode=false … | （粘贴） | … | … | TTFT xxms；整流 yyms；工具 … | 案例一 §步骤 3 | 是 |
| 2 | 同左 | … | … | … | … | … | 案例一 §步骤 5 | 否 |
```

**填写约定**：

1. **一轮** = 用户发送一次 `input.messages` 并得到该轮流式结束（含工具链）。中间若有多段 AI/Tool 消息，在「观测输出摘要」里用简短分段或附「见 `artifacts/xxx.json`」指向保存的完整 SSE 落盘文件（推荐大输出另存，文档只索引路径）。  
2. **用户输入（原文）**必须与请求 JSON 中一致，避免「文档写了 A、实际跑了 B」。  
3. **timing 摘要**：可直接粘贴 `e2e_scenarios_api_test.py --output-json` 中该轮对应的 `stream.timing` 关键字段，或引用附件路径。  
4. **不通过**时在同一行或下方加「现象 + 初步归类（鉴权/工具白名单/Plan 阶段/网络/耗时超标）」，并链到网关日志或 issue。  
5. **Plan / 确认执行**：若 UI 上存在单独一次「确认」请求，算作新的一轮或子轮，在表里单独一行，**请求要点**里写清 `collab_phase` 与按钮触发的等价调用。

这样每个案例文档自身即为**可回溯的测试夹**：读文档即能复现输入与当时系统反应，而不依赖个人聊天记录。

---

## 5. 推荐执行顺序（方法层面）

1. 读案例文档的「前置准备」与步骤，列出**哪些步骤必须走流式接口**（含多轮）。  
2. 固定 `GATEWAY_BASE`、`thread_id`、`session_key`，按顺序发起每轮 `POST .../runs/stream`，脚本或 `curl` 均可。  
3. 每轮结束后把第 4 节表格填一行；大体积 SSE 保存为仓库外路径或 `docs/cases/_fixtures/<案例名>/turnN.jsonl`（若团队允许纳入 git）。  
4. 对「仅 UI、无对话」的步骤：在案例文档中用一行写「UI 步骤已验证」并附截图或 issue 链即可，不要求伪造流式记录。  
5. 回归下一版本时：复用同一表格追加新日期区块，或对比两次 `--output-json` 中的 `timing` / `suite_wall_ms`。

---

## 6. 不符合预期时的排查（与接口相关优先）

1. **请求是否真与 UI 一致**：对比 EvoPanel 网络面板中同一 `runs/stream` 的 body（尤其 `context`、`activated_scenarios`、`collab_phase`）。  
2. **线程是否串线**：多轮是否误换 `thread_id`。  
3. **模型与鉴权**：HTTP 状态、响应体中的 provider 错误信息。  
4. **工具未出现**：工具分组、沙箱、Plan 门禁阶段是否禁止了副作用工具。  
5. **耗时异常**：`first_sse_payload_ms` 大 → 排队/冷启动；`first_ai_visible_ms` 大 → 模型/thinking/上下文；单项 `duration_ms` 大 → 该工具后端或外网慢；`unclosed_tool_call_ids` 非空 → 流中断或配对失败。  
6. **与脚本对照**：用 `e2e_scenarios_api_test.py --help` 缩小跑批范围，对照 [流式验收案例目录（能力向）](stream-acceptance-catalog.md) §1 中的函数名与 §1.3 提示词，确认是产品回归还是环境配置。

---

## 7. 交付物

- 各案例文档内「验收交互记录」章节（必填于对外发布前 gate 时）  
- CI 或本地跑 `e2e_scenarios_api_test.py` / `e2e_plan_mode_api_test.py` 时加 **`--output-json`**：归档的 JSON 含每轮 **`stream.timing`**、**`thread_scenario_wall_ms`**、套件 **`suite_wall_ms`**，与文档中的轮次 id 交叉引用  

**登记示例（旧式汇总表，将逐步由「单场景正式报告」替代）：**见 [流式 E2E 运行登记](e2e-stream-run-registry.md)。  
**单场景 / 单案例正式报告模板：**见 [验收报告模板](templates/scenario-acceptance-report.template.md)（每场景一份文档；**测试意见**仅允许写在模板最后一节）。
