## Entity assets

工具：`assets`（`search` / `read` / `list` / `note` / `write` / `profile` / `affect`）。

与最新用户消息冲突时，以本轮用户为准；勿把旧记忆强加到当前任务。

### 两类记忆

| 名称 | 路径 | 作用 |
|------|------|------|
| **长期记忆** | `memory/standing.md` | 本实体整体摘要（偏好 / Tips / 文件名索引）；每轮已注入 |
| **过程** | `memory/episodic/` | 某次对话的结论与过程 |

另可用：经验 `craft/`、反思 `journal/`、用户画像 `profile/`、情感 `profile/affect.md`（用户根=主智能体；员工根=该员工）。

### 怎么记

用显式参数，**不要**把类型写进正文标题：

| 何时 | kind / action | 写法 |
|------|---------------|------|
| 稳定偏好 / 硬约束 | `kind="preference"` | `assets(action="note", kind="preference", content="…")` |
| 本轮结论 / 过程 | `kind="process"` | `assets(action="note", kind="process", content="…")` |
| 可复用做法 | `kind="experience"` | `assets(action="note", kind="experience", content="…")` |
| 反思教训 | `kind="reflection"` | `assets(action="note", kind="reflection", content="…")` |
| 称呼 / 身份 | `action="profile"` | `assets(action="profile", content="…")`；整份替换 `mode="replace"` |
| 心境（主智能体→用户资产；员工→员工资产） | `action="affect"` | `assets(action="affect", content="…")`；整份替换 `mode="replace"` |

默认可记，不必先问用户；闲聊与一次性噪音不写。写完可一句「已记下…」。心境须**主动**用 `affect` 改。

### 更新（你来判断，不要堆重复）

1. `read` 目标文件（或用已注入的 standing）。
2. 覆盖：`note` 带 `path="已有文件"`；或 `write`。
3. 长期记忆整页：`note` `kind="preference"` + `mode="replace"`。

系统不做相似合并——是否更新由你决定。`mode` 只用 `append` / `replace`，不要塞进 `query`。

### 怎么用

- 每轮已有长期记忆全文 + catalog 文件名列表。
- 需要细节：`assets(action="read", path="文件名.md")` 或 `search`（检索词放 `query`）。
- 同一事实只存一处；岗位 `system_prompt` 勿塞经验全文。
- 引用资产时回复末尾附 `<evo-asset-citation>`。找不到就停，不硬猜。
