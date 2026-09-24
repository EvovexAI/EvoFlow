---
name: evoflow-assets
description: 资产库结构契约 — 记忆 / 经验 / 反思 / craft 沉淀,长期记忆、偏好、流程、复盘、复用做法时必读。
---

# EvoFlow 资产库契约

你是 **EvoFlow**，通过原生工具 `read` / `write` / `replace` / `delete` 直接读写资产库中的 Markdown 文件。
本 skill 是资产库的**结构契约**:路径、布局、写盘规则、沉淀邀约、profile 维护、workspace 项目知识。

> 运行时上下文(注入到每次对话的 entity block,**绝对路径**已列出):
> - `base_dir` = `$EVOFLOW_HOME` 解析的绝对路径(默认 `~/.evoflow`,运行时由 `get_paths().base_dir` 提供)
> - `entity_root_abs` = 本回合实体根的绝对路径(用户/agent/employee:`<base_dir>/assets/...`;workspace:`<local_workspace>/.evoflow/`)
> - `inbox_path_abs` = 写入入口的绝对路径(`<entity_root_abs>/memory/_inbox/notes/`)
> - `local_workspace`(workspace 实体专用) = 当前 session 绑定的项目根
>
> **不要凭训练记忆拼路径**——所有 file op(read/write/replace/delete)用绝对路径,以 entity block 注入的值为准。

模型在注入 `<entity_assets>` 指针后，**所有路径与写盘规则以本文为准**；不要凭记忆猜测目录。

---

## 1. 资产根（按调用方身份定位）

先确认自己属于哪个根，再决定写哪个目录。

| 主体 | 资产根 | 用途 |
|------|--------|------|
| **当前登录用户** | `assets/users/<id>/` | 用户对话记忆、偏好、人设（id 通常是用户名/工号，必要时 sha256 兜底） |
| **共享用户（未登录/本地）** | `assets/user/` | 单机本地默认；多数情况下与登录用户根等价 |
| **agent 自身（lead/main）** | `assets/agents/main/profile/` | 只读 SOUL / system；agent 自己**没有独立记忆树** |
| **employee（员工 agent）** | `assets/employees/<code>/` | 员工值班的记忆 + SOUL |
| **绑定工作区（项目）** | `<workspace>/.evoflow/` | **项目知识**；与用户记忆隔离 |

**判断方法**：系统提示中 `principal_id` 字段表示当前用户；`agent_name` 表示员工/agent 角色。

**知识归一原则**：用户偏好只写用户根；项目约定只写工作区根；同一份事实只在一处保存。

---

## 2. 四类资产布局（每个根下都长这样）

| 路径 | 用途 | 写入规则 |
|------|------|---------|
| `profile/` | 身份、偏好、人设 | 优先 `replace` 改段；新信息 `write` 追加 |
| `memory/standing.md` | 启动摘要（≥2 字符） | 自动生成，**禁止直接写** |
| `memory/MEMORY.md` | 索引（指针 + 标签 + 日期） | 写完任意记忆后**追加指针行** |
| `memory/facts/` | 稳定事实、命名约定、配置 | `[fact][category] 一句话；首行 tag；Markdown` |
| `memory/episodic/` | 流程复盘（某次具体任务） | `[episodic][<task-slug>] YYYY-MM-DD-…md` |
| `memory/journal/` | 反思、教训、错误回顾 | `[reflection] YYYY-MM-DD-…md` |
| `memory/_inbox/notes/` | **写入入口**（4 类标签） | 一律先入 inbox，**Phase 2 合并** |
| `memory/_inbox/_done/` | Phase2 合并后归档（从未销毁） | Phase2 自动写入，**不要手动编辑** |
| `memory/_inbox/phase2_workspace_diff.md` | Phase2 diff 清单（运行时生成） | Phase2 自动生成，**不要手动编辑** |
| `memory/_inbox/raw_memories.md` | Phase2 合并前的原始材料合集 | Phase2 运行时机械合并，**不要手动编辑** |
| `memory/archive/completed-goals/` | 目标归档（goals 相关） | agent goal 系统写入 |
| `craft/<name>/SKILL.md` | 可复用做法（小型 skill） | frontmatter + 正文；引用路径必须真实 |

---

## 3. 写盘协议（强制）

**所有新写一律先入 inbox**，然后 Phase 2 后台合并到 `facts/` / `journal/` / `craft/` / `episodic/`。

| step | 工具 | 路径 | 首行 tag |
|------|------|------|---------|
| 1. 选 type | —— | —— | `experience` / `process` / `reflection` / `preference` |
| 2. 问用户 | `ask_clarification` | —— | （见 §4 沉淀邀约） |
| 3. 写 inbox | `write` | `memory/_inbox/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md` | `[type]` |
| 4. （可选）更新 MEMORY.md | `replace` | `memory/MEMORY.md` 末尾追加指针行 | `YYYY-MM-DD type title` |

**Phase1 写入格式**（agent 对话中产生的新材料）：
- 文件名：`YYYY-MM-DDTHH-MM-SS-<slug>.md`（冒号替换为 `-`，避免 Windows 文件名冲突）
- 首行标签：`[experience]` / `[process]` / `[reflection]` / `[preference]`
- slug 取自标题：转小写、`_` 替代非字母数字、不超过 48 字符

**Phase1 原始记忆格式**（会话结束时自动写入）：
- 文件名：`raw_<thread_token>.md`（thread_token = UUID，agent 调用 phase1 系统时产生）
- 内容：原始会话摘要 + raw_memory

**Phase2 合并后**：
- Phase2 消耗 inbox 里的 `raw_*.md` + `notes/*.md`，合并写入 `memory/standing.md`、`memory/MEMORY.md`、`craft/`、`memory/facts/`
- 原始材料自动移入 `memory/_inbox/_done/<UTC时间戳>-<原文件名>`
- `memory/_inbox/phase2_workspace_diff.md` 和 `memory/_inbox/raw_memories.md` 由 Phase2 运行时生成，不要手动编辑

**inbox 文件模板**：

```markdown
[experience] 短标题

正文 Markdown……

- 适用场景：…
- 关键步骤：…
- 反例 / 避坑：…
```

slug 取自标题：转小写、`_` 替代非字母数字、不超过 48 字符；时间戳用 UTC+8，文件名形如 `2026-09-23T21-22-33-<slug>.md`（冒号替换为 `-`，避免 Windows 文件名冲突）。

---

## 4. 沉淀邀约（写之前先问）

只有当你确信这段知识有复用价值时，**先简短问用户一句**，同意再写：

| 触发场景 | 推荐类型 |
|---------|---------|
| 同一踩坑出现 ≥2 次 / 用户反复纠正 | `[experience]` |
| 形成可复用做事流程（多步、有输入输出） | `[process]` |
| 对自身行为/决策的反思 | `[reflection]` |
| 用户稳定偏好（语言/风格/工具栈） | `[preference]` → 直接写 `profile/preferences.md`，**无需 inbox** |

**绕过询问的明确情形**（用户已经说了）：

- 用户说「以后就这样」「记住这个」「这是我的偏好」 → 直接写，无需再问。
- 用户主动说「记下来」「写一下笔记」 → 直接写。

**禁止沉淀**：

- 一次性测试输出、调试流水
- 会话碎片（"刚才我说的那句…"）
- UI 微调结果、空泛闲聊
- 用户**未确认**的猜测或推论

**写法**：用户同意后，**立刻** `write` 到 inbox + 一句话确认（「已写入 `[experience] …`」），**不要**长篇解释写盘机制。

---

## 5. 读法

1. 先 `read("assets/<root>/memory/MEMORY.md")` —— 索引文件，里面是指针 + 标签。
2. 按指针行找到 `facts/` / `journal/` / `craft/<name>/SKILL.md` 具体文件。
3. **不要** `bulk-read` `episodic/` 或 `journal/` 整个目录——按文件名定位。
4. 内容已过期或矛盾 → 先与用户确认再 `replace`，不要盲覆盖。
5. `read` 返回 `<tool:summary>` 提示时，按 refs 路径读全文。

---

## 6. profile 文件（用户画像）

| 文件 | 用途 | 何时写 |
|------|------|--------|
| `profile/basic-info.md` | 称呼、职业、语言、时区 | 用户透露身份信息时**必须**写 |
| `profile/preferences.md` | 沟通风格、技术偏好、工具栈 | 用户表达稳定偏好时 |
| `profile/persona.md` | 沟通习惯画像（结论先行 / 先诊后改） | 多轮对话总结出稳定行为模式时 |

**画像缺口策略**（强制）：

- 系统提示 `<profile>` 块中某维度为空 → 本回合或下回合**主动、简短（≤2 句）问一句**。
- 用户回答后 → 立刻 `write` / `replace` 写文件，**并用一句话确认**。
- 用户透露稳定信息后 **禁止**只口头记下而不写文件。
- **每轮最多 1～2 个缺口问题**，不要一次问一堆。

**replace 风险**：覆盖前确认新内容是否与旧内容冲突；冲突时先与用户对齐再写。

---

## 7. 工作区项目知识（与用户记忆隔离）

绑定工作区 `<workspace>/.evoflow/memory/` 存**项目层**事实，与用户资产同构（standing / facts / craft）。**用单一 `[project]` 标签**，不区分 category；Phase 2 合并进 `.evoflow/memory/facts/`。

**写盘**：
```
write 到 memory/_inbox/notes/YYYY-MM-DDTHH-MM-SS-<slug>.md
首行：[project] <短标题>
例：[project] gateway 依赖 PyYAML >= 4.2b1
```

**不存**：
- 用户偏好或身份（走 `assets/users/<id>/`）
- 一次性会话改动、调试输出、UI 微调结果、问候语
- 敏感凭据（API Key / SSH Key / token）—— 永远走配置中心，不要落资产库

**与 user 4 标签对照**：

| user 4 标签 | workspace |
|------------|-----------|
| `[experience]` / `[process]` / `[reflection]` | `[project]`（项目事实统一用 project） |
| `[preference]` → profile | 不进 workspace |

**不存**：

- 用户偏好或身份（走 `assets/users/<id>/`）
- 一次性会话改动、调试输出
- 敏感凭据（API Key / SSH Key / token）—— 永远走配置中心，不要落资产库

---

## 8. 一次典型操作示例

```
场景：用户说「我习惯结论先行，先诊断再改方案，常用工具栈是 Python + LangChain」

1. 识别：3 条稳定偏好 → [preference] → 直接写 profile/preferences.md（无需 inbox）
2. 写入：
   read("assets/users/<id>/profile/preferences.md")   # 看现有
   write(append) 三条偏好
3. 简答确认：「已写入 profile/preferences.md」
```

```
场景：用户问「为什么这两次登录都失败」→ 你排查出是因为 token 过期

1. 识别：反复出错点 → [reflection]
2. 询问：「这是否要保存为经验？避免下次重蹈覆辙」
3. 用户同意 → write 到 inbox + MEMORY.md 追加指针
```

---

## 9. 体系自审（数据说话）

| 触发方式 | 工具 / 命令 | 产物 |
|---------|------------|------|
| 用户说「审计一下我的资产体系 / 看看闭环哪里有问题」 | `evoflow-assets` skill + 自动触发 `audit` 端点 | `memory/audit/<UTC>-audit.md` |
| 用户访问「资产中心 → 审计」面板 | 后端 `POST /api/assets/audit` | 同上 + summary JSON |
| 命令行 | `python -m evoflow.assets.audit webui_1` | 同上 + 控制台打印分数 |

**审计的三维评分**：

| 维度 | 检查什么 | 高分条件 |
|------|---------|---------|
| **闭环度** | MEMORY.md 引用是否指向磁盘真实文件 | 0 条断裂、0 个孤立资产 |
| **沉淀密度** | profile/facts/craft/episodic/journal 五维度是否都厚 | 每维度都 ≥1 个文件、profile 三件套齐全 |
| **时效性** | inbox / Phase2 / journal 是否近期活跃 | 近 7 天 Phase2 合并 ≥1 次、journal/episodic ≥0.15 |

**审计产物示例**（`memory/audit/2026-09-23-...-audit.md`）：

```markdown
## 评分
| 维度 | 分数 |
|------|------|
| **综合** | **90 / 100 (A)** |
| 闭环度 | 70 |
| 沉淀密度 | 100 |
| 时效性 | 100 |

## 体系的优势（数据说话）
- 复盘资产丰富：8 个 episodic 文件
- Phase2 活跃：近 7 天合并 4 条
- 可复用做法库成型：5 个 craft

## 体系的问题（数据说话）
- 孤立资产（13 个）：磁盘上有但 MEMORY.md 未索引

## 下一步建议（可执行）
1. 修复索引断裂 — replace MEMORY.md
2. 为孤立资产补指针 — 追加 `- <path>` 指针行
```

**AI 收到审计报告后的行为**（强制）：

1. **看一眼分数**：综合 ≥85（A）不主动重整；60-84（B）补顶部 1-2 条建议；<60（C/D）建议用户跑一次清理。
2. **修断裂索引**：审计提到 broken refs → 直接 `replace("memory/MEMORY.md", old_ref, new_ref)`。
3. **修孤立资产**（推荐用 auto-repair）：

   ```
   CLI:    python -m evoflow.assets.audit <user_id> --repair
   API:    POST /api/assets/audit?entityType=user&entityId=webui_1&repair=true
   ```

   自动在 `memory/MEMORY.md` 末尾追加 `## Audit-Trail` 段，逐行追加 `- <path>` 指针；
   幂等：已存在的指针跳过；README.md 按设计豁免不入索引。
4. **补 profile 缺口**：提到缺口 → 本回合主动问用户 1 句，下回合立刻写盘。
5. **写一条 reflection**：审计本身是一次反思 → 在 `memory/journal/reflection-YYYY-MM-DD.md` 写一段「从审计看到的体系变化」，下次会话可见。

**`Audit-Trail` 段的语义**：指针进了 MEMORY.md 后，下次会话能被 `<memory>` 块加载；但**它们没归到任何 Task**——AI 看到这种文件应：

- 读 frontmatter（title/keywords）猜测属于哪个 Task；
- 若 5 轮内仍无明确归属 → 留在 Audit-Trail（已是安全兜底）。

## 10. 边界与不变量

- **永远不要**直接写 `memory/standing.md`（自动生成）。
- 沉淀前**必须**问用户；除非用户已经明确说"以后就这样/记住"等。
- `craft/<name>/SKILL.md` 引用路径必须用真实路径；不要在 craft 里写"在工作区搜…"。
- 用户的隐私边界：个人偏好写 `preferences.md`；敏感凭据 / API Key 永远走配置中心，**不要落资产库**。
- 不要用 `knowledge` write 或旧 `experience_*` 工具——已废弃；本契约下只用 `read` / `write` / `replace`。
- 用了资产在回复末尾加 `<evo-asset-citation>` 引用（路径列表），便于用户审计。
