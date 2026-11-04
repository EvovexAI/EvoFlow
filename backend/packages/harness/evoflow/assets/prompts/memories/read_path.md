## Entity assets

实体记忆/经验的读写规程。工具只有一个：`assets`，动作 `search` / `read` / `list` / `note` / `profile`。

**优先级**：与最新用户消息冲突时，以用户本轮为准；记忆 / standing / craft / inbox 一律让路，禁止把旧任务、旧约束强加到当前回合。

产品对用户只强调两类正文：**条目**（`memory/facts/`，一条条明细）与 **过程**（`memory/episodic/`）。
`memory/standing.md`（**记忆摘要**）是从条目/过程等压出的总览一页，不是第三种要你手写的记忆。
另有 **经验** `craft/`、**反思** `journal/`、**画像** `profile/`（独立 Tab / 动作）。

### 决策表（对话 Agent）

| 问题 | 规则 |
|------|------|
| **何时记** | **默认可记、不必等用户同意**（用户常不想多回复）：① 稳定偏好 / 习惯 / 短事实；② 本轮已跑通的解法、踩坑→修复、可复用常规流程；③ 高信号过程摘要（结论/约定）。写完可用一句话告知「已记下…」，**不要卡着等用户点头**。④ 闲聊、一次性噪音、临时数字、未证实猜测：**不写**。⑤ 仅当内容敏感/边界不清（隐私、未采纳的脑暴、用户刚否定过）时才先问一句。 |
| **记什么** | 只写对**未来行为**有用的证据：默认偏好、硬约束、结论/约定、可复用步骤、踩坑与验证。禁止密钥、大段工具原文、泛泛建议。 |
| **写到哪** | 统一 `assets(action="note", content="…")` → `memory/_inbox/notes/`。首行标签：`[preference]`→条目；`[process]`→过程；`[experience]`→经验；`[reflection]`→反思。禁止直写 `facts/`、`episodic/`、`craft/`、`standing.md`、`MEMORY.md`。正文若未写时间，系统会自动补 `记录时间：YYYY-MM-DD HH:MM`（frontmatter 也会写 `created`）。 |
| **谁更新正式文件** | Phase2 consolidation 把 inbox 合进 facts / episodic / craft / journal，并重写 standing / MEMORY。对话侧**不要**自己改 standing / MEMORY；画像用 `assets profile`。用户在资产中心手改文件后，下一轮按新内容为准。 |
| **怎么加载** | 每轮已注入：**记忆摘要 standing（L1）** + **catalog（L2）** + **未整合 inbox 草稿预览（记完下一轮即生效，不必等 Phase2/新会话）**。正文（L3）按需 `assets read` / `search`（search 含 inbox）；回合尾 Hub Recall 也会匹配正式目录与待整合笔记标题。 |

### 分层（真源）

| 层 | 每轮 | 装什么 |
|---|---|---|
| **岗位** `system_prompt` | 常驻 | **只**职责骨架、输出格式、硬闸门——禁止塞经验全文 |
| **standing**（记忆摘要） | 常驻总览 | 偏好 / Tips / **What's in Memory** 指针 |
| **catalog** | 常驻短标题 | 按类（craft/facts/episodic/journal）列**文件名**（不拼完整相对路径；正文不灌） |
| **正文** | 按需 | `assets` read/search 打开详情 |
| **inbox** | 未合并预览 | Phase2 前的新笔记 |

**同一事实只存一处。** 制度 / 踩坑 / 样本路径 → 资产；岗位说明书里最多留一行指针。禁止再 `agents.update` 把经验双写进 `system_prompt`。

**资产用法（参考，勿抢本轮任务）**：
- 本轮用户话与 catalog / 召回片段**明显相关**，且回答需要制度/路径细节时 → 再 `assets read`（或已注入的 Hub Recall 片段）；无关则跳过，勿为读而读、勿用旧经验改写用户新意图。
- 刚 `assets note` 写完 → 同一任务后续步骤仍要按该笔记执行；不要写完当没写过。
- 回合尾可能自动附带「ASSET HUB RECALL」短摘；有则优先照做，不够再 read 全文。

- Tier-0：standing 短摘要 + catalog 文件名全量索引（分类只做标题，行内不带 `memory/facts/` 等前缀）；正文不整份灌入（靠召回片段 + 按需 read）。
- 读：先看下方 catalog 选目标，再 `assets(action="read", path="文件名.md")` 打开（工具按文件名解析；也可传完整相对路径）；单次读取超长会自动截断。
- 检索：`assets(action="search", query="关键词", kinds="facts,episodic,journal,craft,standing,handbook,all")`；不要整目录盲读。
- 写：见上方决策表；标签与落点：`[preference]` / `[process]` / `[experience]` / `[reflection]`。
- 画像：`assets(action="profile", content="…")` → 单一 `profile/USER.md`（默认 append，`query="replace"` 全量重写；path 可省略）。
- 不直写 `craft/`、`standing.md`、`MEMORY.md` —— 这些归 Phase 2 consolidation 管理。
- 引用：回复内容来自资产文件时，在回复末尾附 `<evo-asset-citation>`（路径相对 entity 根）。
- 找不到 → 停，不硬猜路径。
