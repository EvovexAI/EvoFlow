---
name: workspace-code-workflow
description: 工作区代码任务路由与 worker 检索/改写规范。激活 workspace 场景后，涉及找文件、读代码、改代码、数据展示 bug、环境排查时必读。含 T1–T5 分类、search_code_index/rg/find 选型矩阵。
---

# 工作区代码工作流

**前置**：scenario(activate, agent) 后再读本技能全文并按步骤执行。

<worker_tool_guidance>
**前置（强制）**：任何工作区**代码检索/改写/读文件/跑命令**前，若 `workspace` 不在活跃场景中，**必须先** `scenario(action=activate, scenario_key='workspace', reason='…')`，再调用本工具或其它文件/命令工具。绑定工作区目录 ≠ 已激活 workspace 场景。
**`worker`（核心常驻）**：工作区**代码检索**与**文件改写**默认用它，避免在主会话堆长链 `search_code_index` / `write` / `replace`。
- **检索**：默认 `worker(tasks=[{"action":"search","query":"..."}, ...])`（每任务必填 `action`；可并行多查询）；勿在同一 `worker` 调用里混 file 与 search。
- **按名找文件**：`find(pattern="*PageName*", root="<已知子目录>")` 或 `worker(tasks=[{"action":"locate","query":"*foo*","path":"<子目录>"}])`；**禁止**用自然语言 `search_code_index` 搜 `*.html` / 具体文件名。
- **符号检索**：`search_code_index` / worker search 用 `path:<子目录> Symbol|alias`（短关键词 + `|` 同义词），勿用整句自然语言。
- **并行检索去重**：同一 `worker` 调用里每个 search 任务的 query 必须**不同焦点**（不同符号/目录/问题）；禁止重复 query、禁止把 `a|b` 拆成两个 task、禁止仅换顺序的同义词重复（`foo|bar` 与 `bar|foo` 视为重复）。
- **低信号切换**：连续 2 次 `search_code_index` 无相关命中 → 改 `find` / `rg` / `read` / curl API，勿重复同义查询。
- **禁止子搜索**：已有 `<worker_code_reads>` / Read catalog 后，除非路径仍缺失，否则**不要**再开一轮 worker search；每个 search task **只调一次** `search_code_index`。
- **检索 ≠ 完成**：用户要**修 bug / 加功能 / 改代码 / 落地实现**时，search 返回 `<worker_code_reads>` 后**必须**再调一次 `worker` 做改写（或同轮紧接着改）；禁止只汇报检索结果就结束。
- **改写**：默认 `worker(tasks=[{"action":"write|replace|delete|edit","path":"...", ...}, ...])`——**即使只改 1 个文件也优先 worker**；多文件必须 worker 并行；路径用上一轮 catalog / `<worker_code_reads>`，勿重复 search。
- **直连写文件工具（workspace 场景兜底）**：仅当**同一轮、同一文件、上下文已有完整 `old_string`/全文**，且确属一次性精确替换时，才可用 `replace`/`write`；否则一律 `worker`。
- search 默认 `read_limit=0`（只返回 Read catalog + 搜索 snippet，不批量读文件）；搜完后对 top 1-2 路径用 `read`（主线程）或让 search-worker 读后再汇总；确需批量片段时可显式 `read_limit`（上限 4）。
- **任务快照**：`<mission_state>` 含核心目标、`<exploration_summary>` 探索结论、`<files_already_read>` 已读路径；Mission 分析 debounce 合并同轮 read，勿重复 read。
</worker_tool_guidance>

<search_tool_matrix>
| 意图 | 工具 | 正确示例 | 避免 |

| 按文件名定位 | find / worker locate | find(pattern="*agent-trace-model-response*", root="evopanel/src/pages") | 用 search_code_index 搜 *.js 文件名 |
| 符号 / 类 / API | search_code_index / worker search | query="path:evopanel/src/pages renderModelResponseTypeCell|summarizeModelResponse" | rg 里用 pipe 同义词（| 是正则 OR，易超时） |
| 子目录内符号 | search_code_index | query="path:backend/packages/harness/evoflow/observability list_model_invocations" | 无 path: 的自然语言整句或全库 rg |
| 字面量 / 日志 / 报错 | rg | pattern="Error: rg timed out", path="backend", glob="*.log" | 用 search_code_index 搜完整日志行 |
| 已知文件内正则 | rg | pattern="def fetch_tools_summary", path="backend/.../summaries.py" | pipe 关键词列表如 foo|bar|kind |
| 界面文案 / 中英同义词 | search_code_index | query="path:evopanel/src/pages 回复类型|response_summary|kind_label" | rg pattern="回复类型|kind"（kind 几乎处处匹配） |
| index 无命中后 | rg 再 read | rg(pattern="response_summary", path="evopanel/src/pages", glob="*.js") | 重复同一 index 查询或在 . 上大范围 rg |
**Pipe `|` 语义（关键）**
- `search_code_index`：`foo|bar` = **同义词 OR**（FTS + 符号表）
- `rg`：`foo|bar` = **正则 OR** — 泛词（`kind`、`type`）几乎处处匹配 → 45s 超时；pipe 关键词会自动重定向 index 或 `rg -F`

**路径限定**
- Index：`path:evopanel/src/pages Symbol|alias` — 先限定目录再搜
- rg：`path="evopanel/src/pages"`，可加 `glob="*.js"`

**推荐流程**
1. 文件名？→ `find`
2. 符号/API？→ `search_code_index` + `path:` + `|`
3. 要行上下文/字面量？→ 窄范围 `rg` + `read`
4. 禁止：在 `evopanel/src/pages` 上对 `foo|bar|kind` 跑 rg
<search_tool_matrix>

<task_router>
收到用户消息后，**若涉及代码/仓库/项目文件操作，先确认 Agent 模式已激活**（未激活则 `scenario(activate, agent)`），再分类选工具（不要默认 search_code_index）：

| 类型 | 识别 | 第一步 | 禁止 |
| T1 定位文件 | 具体文件名、`.html/.tsx`、`在哪` | `find` 或 `worker locate` | 自然语言 FTS |
| T2 理解代码 | 某函数/模块干什么 | `path:dir Symbol` + `read`；字面量用 `rg` | 通读整文件 |
| T3 数据/展示 bug | 表格/页面/显示/数据不对 | 复现信息 + **curl API** 对比 UI | 先读 2000 行 |
| T4 改代码 | 修/加/删/实现 | 已知路径 `read` + `worker` 改写 | 无范围搜索 |
| T5 运行环境 | 卡住/超时/日志/Gateway | 日志 + 健康检查 + 进程 | 代码索引 |

**阶段机（所有类型）**：`explore`（取证）→ `act`（该类型的交付动作）→ `verify`（lint/test/curl/复现）→ 简短回复。
- **调研完成 ≠ 任务完成**；任务完成 = 该类型可验证的交付（diff / 根因+证据 / 路径答案 / 文字解释）。
- `<files_already_read>` 或工具结果已覆盖目标时，**禁止**再堆 read/rg/search +「现状总结」。
- **act 因类型而异**：T4→`worker` 改写；T3→先 curl/日志 **验证数据源** 再单层修复；T2→文字解释；T5→日志/进程；T1→给出路径。
- `<action_bias>`（运行时注入）在取证足够时会提示当前阶段该做的 **act**，按 `<task_type>` 执行，勿一律改文件。

**T3 数据/展示问题（通用）标准流程：**
1. **收窄范围**：弄清哪个界面/组件/接口、期望 vs 实际；缺关键 ID（会话、实体、筛选条件）时用 `ask_clarification`（带选项，勿泛泛而问）。
2. **验证数据源**：用 `terminal` curl/请求对应 **API 或日志**（从路由、OpenAPI、README、Gateway 路由表定位 endpoint），拿到原始 JSON/行数。
3. **定位代码**：`find` 按页面/模块名找入口 → 只读相关 **渲染/聚合函数**（通常几百行内），勿通读整个页面主文件。
4. **对比分叉**：API/DB 与 UI 是否一致？一致 → 前端映射/过滤/分页；不一致 → 后端聚合/写入/查询。
5. **一个假设 + 一步验证** 后再改代码；改动尽量单层（数据层或展示层其一）。
6. **收尾**：给出根因或已验证分叉点，禁止以「项目有哪些文件/表」导览结束。

**探索预算**：同任务 `search_code_index` ≤2 次；无边界 `Get-ChildItem -Recurse` / `find .` 禁止；无进展必须换工具类。
**收尾（所有类型）**：调查类任务必须给出假设、证据或验证步骤，禁止用代码库导览代替结论。
</task_router>
