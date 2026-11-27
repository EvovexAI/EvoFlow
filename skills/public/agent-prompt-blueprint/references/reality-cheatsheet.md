# 平台真实约束速查（落盘前必读）

这份表是**实测结果**，不是设计文档。提示词里写错工具名，模型不会报错，它会假装做了——这是最难查的一类缺陷。

## 一、可绑定的工具白名单（15 个，`evoflow agents bindings` 实测）

```
bash  fetch_url  grep  knowledge  platform  read  replace
search_code_index  subagent  taskoutput  tasks  taskstop  todo_write  web_search  write
```

`max_allowlist_tools = 12`：单个角色的工具白名单建议不超过 12 个，超了说明岗位没拆干净。

## 二、退役 / 已改名工具对照（写提示词时最容易踩）

| 提示词里常写成 | 实际状态 | 应该写成 |
|---|---|---|
| `view_image` | **已并入 `read`**（图片引用在 read 内部分发） | 用 `read` 直接传本地图片绝对路径 |
| `process` | 已退役 → bash 后台 + TaskOutput/TaskStop | "用 bash 后台执行，再用 TaskOutput 取输出" |
| `browser` | 已注销 → 改用 `agent-browser` 技能（CLI/MCP） | "用 agent-browser 技能" |
| `find` | 已退役 → Bash 内嵌搜索 | "用 bash 里的 grep / rg" |
| `todo` | 已退役 → `todo_write` 恒挂载 | `todo_write` |
| `read_lints` | 已退役 → 诊断走 Bash（pyright/ruff） | "用 bash 跑 ruff / pyright" |
| `worker` | 临时未注册 | 用 `subagent` |
| `create_agent` / `update_agent` / `list_agents` | 已退役 | `platform` 的 `agents.*`，或 `evoflow agents …` |
| `list_skills_catalog` / `list_assignable_tools` | 已退役 | `platform` 的 `skills.list` / `agents.bindings` |

**机检**：`python backend/scripts/prompt_drift_guard.py` 能查退役工具名与死路径，但它只扫仓库自身的提示词栈，**不扫数据库里的 agent 配置**——所以自己保存的 Agent 必须人工过一遍这张表。

## 三、能力包（优先于逐个勾工具）

| id | 标签 | 含工具 |
|---|---|---|
| `none` | 无业务工具 | 空（仅运行时系统工具） |
| `research` | 调研检索 | web_search, fetch_url, read, knowledge |
| `writer` | 文案文档 | read, write, replace, knowledge |
| `duty` | 值班运维 | tasks, todo_write, read, knowledge |
| `coding` | 编码终端 | bash, taskoutput, taskstop, read, write, replace, search_code_index, grep, todo_write, subagent |
| `custom` | 自定义 | 手填短白名单（需 `confirm_inherit_all=true` 才继承全表，员工创建默认禁止） |

最小权限原则：能只读就不给写盘，能不用终端就不给 `coding`。

## 四、写死任何外部事实前，必须实测的三类东西

| 类型 | 验证命令 | 失败后果 |
|---|---|---|
| 模型 id / 参数 | `evoflow media catalog` | 模型不存在，每次生成都报错，或静默换模型导致风格漂移 |
| 外部路径 / 端口 / 服务 | `ls <dir>`、`curl -s -o /dev/null -w "%{http_code}" <url>` | "先起服务再干活"变成永远起不来 |
| MCP 工具名 | `evoflow mcp <server> test`，或读该 MCP 的 `mcp/tools.json` | 调不存在的方法；或把"初筛"当"裁决" |

**实测能过 ≠ 语义正确**。工具存在，不代表它能力如你所想。看工具的自述 description，以及该服务仓库里有没有记录它的已知局限（`data/reports/` 这类目录经常有）。

## 五、其它易错点

- `agent_code` 只允许 `^[a-z0-9-]+$`；`agent_name` 可用中文
- `system_prompt` 是 `agent_type=subagent` 时的必填项
- 创建后必须 `evoflow agents get <code>` 回读确认，不要假设写进去了
- 返回 `unknown_tools` / `unknown_skills` 时，回到 bindings 核对，**禁止猜名字重试超过两轮**
