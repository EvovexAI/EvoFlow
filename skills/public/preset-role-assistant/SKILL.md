---
name: preset-role-assistant
description: EvoFlow「快速创建预设角色」专用流程。当用户要在对话里新建预设角色、子智能体、智能体人设、agent_code、系统提示词、SOUL、勾选工具或技能、或说「按文档快速创建角色」「帮我设计一个角色配置」时使用。与侧栏「角色管理」写入同一套 agents 数据。落盘走 platform / evoflow agents（create_agent 等分散工具已退役）。不要 undertrigger——用户明确要新建角色而你不按本 Skill 先盘点工具/技能再落盘，容易写出非法工具名或未启用技能。
---

# 预设角色助手（EvoFlow）

在 EvoFlow 对话里创建角色时，**不要**调用已退役的 `create_agent` / `update_agent` / `list_agents` / `list_skills_catalog` / `list_assignable_tools`。统一走：

1. 日常：内置工具 **`platform`**（`agents.*` / `skills.*`）
2. 脚本或批处理：技能 **`evoflow-admin`** + **`terminal`** 跑 `evoflow agents …`

## 概念对齐（写进答复里，避免和用户对不上）

| 字段 | 说明 |
|------|------|
| **agent_code** | 仅 `^[a-z0-9-]+$`，作唯一标识；给用户看的「代号」。 |
| **agent_name** | 界面展示名（可用中文）。 |
| **description** | 一句话职责摘要。 |
| **system_prompt** | **子智能体（subagent）** 的硬指令：步骤、输入输出、工具使用边界、何时拒绝。`agent_type=subagent` 时必填。 |
| **SOUL / soul** | 气质、价值观、长期人设与安全护栏；与 `system_prompt` 分工：**SOUL 偏「是谁」，`system_prompt` 偏「怎么做」**。 |
| **tools / mcp_servers / skills** | 能力白名单；**名称必须与运行时目录一致**，禁止臆造。 |

## 强制顺序（缺一不可）

1. **澄清需求（先问再写）**  
   至少确认：角色定位、主要服务谁、典型任务 2～3 个、输出形态、绝对不做的事（合规/隐私）、是否需要联网/终端/文件写入。  
   **agent_code** 由你提议（小写+连字符），用户确认后再用。

2. **确认代号可用**  
   - `platform action=agents.list`（可带 `tag` / `agent_name`），或  
   - `evoflow agents check <agent_code>` / `evoflow agents list`  
   确认不与已有智能体冲突。

3. **盘点技能**  
   - `platform action=skills.list`（需要未启用时再看全量列表），或  
   - `evoflow skills list` / `evoflow skills list --enabled-only`  
   只从返回的 `name` 里勾选技能。

4. **盘点可分配工具**  
   - 若 Gateway 可达：`GET /api/tools/metadata`（中文 label 仅供展示）  
   - 或读运行时工具目录 / 现有角色的 `tools` 字段作对照  
   **写配置仍以真实 `name` 为准**；**最小权限**：能只读就不给写盘，能不用终端就不给。

5. **起草并让用户确认**  
   用表格或结构化 Markdown 展示拟定的：`agent_code`、`agent_name`、`description`、`system_prompt` 摘要、`soul` 摘要、`tools[]`、`mcp_servers[]`、`skills[]`、`agent_type`。  
   **未经用户明确同意不得落盘。**

6. **落盘（用户确认后）**  
   预设业务子角色默认 `agent_type="subagent"`，并传入完整 **`system_prompt`** 与 **`soul`**。

   ```bash
   # 先 write_to_file → outputs/agent.json，再：
   evoflow agents create --file outputs/agent.json
   evoflow agents get <agent_code>
   ```

   或等价：

   ```text
   platform action=agents.create confirm=true
     args_json={...同一套字段...}
   ```

   字段名必须与目录一致。若返回 `unknown_tools` / `unknown_skills`，回到步骤 3–4 修正，禁止猜名字重试超过两轮不问用户。

7. **后续微调**  
   - `evoflow agents update <name> --file patch.json`  
   - 或 `platform action=agents.update confirm=true`

## JSON 示例

见 [`evoflow-admin/examples/agent-create.json`](../evoflow-admin/examples/agent-create.json)。可扩展字段：`system_prompt`、`tools`、`mcp_servers`、`agent_type`、`tags`。

## 写作提示

- **system_prompt** 建议含：角色任务定义、输入假设、输出模板、引用与事实策略、失败时如何回复、与总控/用户的协作方式。  
- **soul** 建议含：语气、价值排序、对用户与数据的尊重、不编造、不越权；可按「身份 / 用户偏好 / 禁区」分段，保持单文件 Markdown 即可。

## 与产品文档的关系

站点「快速创建角色」页描述的是**自然语言入口**；本 Skill 规定的是**落盘前必须执行的治理步骤**。二者同时成立：先按本 Skill 盘点再 `evoflow agents create` / `platform agents.create`，与用户在「角色管理」里手填等价。

需要雇成值班岗位时，继续走 **`evoflow-admin`** 的 `employees hire`（先有 Agent，再有岗位）。
