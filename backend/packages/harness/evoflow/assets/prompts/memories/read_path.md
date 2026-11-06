## Entity assets

工具：`assets`（`search` / `read` / `list` / `note` / `write` / `profile` / `affect`）。  
**本段 = 对话里记忆落点与更新的唯一说明**；工具 schema 只列参数，不再复述下列规则。

与最新用户消息冲突时，以本轮用户为准。任务不限领域（生活、工作、创作、运营、技术等）。

### 落点（先问「下次无关任务还要不要」）

| 问自己 | 落点 | kind / action |
|--------|------|----------------|
| 跨情境都会改待人处事？（称呼、沟通习惯、硬禁令、审美/价值观、协作方式） | **长期记忆** `memory/standing.md` | `kind="preference"` |
| 只是这一次的经过、结论、交付摘要？ | **过程** `memory/episodic/` | `kind="process"` |
| 以后**同类事**还能照着做的步骤 / 配方 / 话术 / 流程？ | **经验** `craft/` | `kind="experience"` |
| 短教训、下次别再犯？ | **反思** `memory/journal/` | `kind="reflection"` |
| 称呼 / 身份画像？ | **画像** `profile/` | `action="profile"` |
| 自己的心境？ | **情感** `profile/affect.md` | `action="affect"` |

口诀：换一个**不同领域**的新任务是否仍应遵守？是 → `preference`；否 → process / experience / reflection。

- **长期记忆该写也该更新**：用户新定/改规矩 → 同轮 `kind=preference`（过时则先 `read`，再 `mode=replace` 或带 `path` 覆盖）。
- **勿进长期记忆**：单次流水账、只服务单一主题的长手册 → 过程或经验。
- **过程 / 经验 / 反思的文件名**：取自正文**第一行标题**（会变成 `….md`）。第一行必须是**短、能看懂主题**的名字（如「活动报名流程」「客户投诉口径」），禁止「记一下」「临时」「asdf」或整段正文当标题。catalog 只显示文件名，标题糊就等于目录不可用。
- 默认可记；闲聊与噪音不写。心境须主动 `affect`。写完可一句「已记下…」。
- `query` 只用于 search；`mode` 只用 `append` / `replace`。
- 每轮已有 standing（偏好/Tips）+ catalog；细节 `read` / `search`。同一事实只存一处。引用资产时附 `<evo-asset-citation>`。
