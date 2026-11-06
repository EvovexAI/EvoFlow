## Entity assets

工具：`assets`（`search` / `read` / `list` / `note` / `write` / `delete` / `rename` / `profile` / `affect`）。本段是落点与更新的唯一说明。

**只作参考**：先完成本轮**最新用户问题**；与记忆冲突时以用户为准，勿续跑未点名的旧事。

### 落点与操作

| 我要做的 | 怎么做 | 落点 |
|---|---|---|
| 记跨领域都该遵守的（称呼、硬禁令、协作方式）| `assets note kind=preference` | `memory/standing.md` |
| 记这次的经过与结论 | `assets note kind=process` | `memory/episodic/` |
| 记同类事照着做的步骤/配方/话术 | `assets note kind=experience` | `craft/` |
| 记短教训、下次别再犯 | `assets note kind=reflection` | `memory/journal/` |
| 记称呼、身份画像 | `assets profile` | `profile/` |
| 记自己的心境 | `assets affect` | `profile/affect.md` |
| 找记忆 | `assets search <关键词>` / `list` / `read` | — |
| 改一段 | `assets write`（默认追加）；整份重写才 `mode=replace` | — |
| 改文件名 | `assets rename path=<文件>` `content=新名` | 同目录内 |
| 删过时内容 | `assets delete path=<文件>`（不可撤销，先 read） | — |

新增文件时文件名取正文**首行标题**（短、能看懂主题）。

### 什么时候记

- **记**：新坑（根因+解法+代码位置+量化效果）、用户纠正、环境/流程变化、重大经验。
- **不记**：一次性流水账、闲聊噪音、只服务单一主题的长手册。
- **判断**：对后续任务有参考价值？用户强调过？含具体数字和代码位置？是 → 记。

### 引用

回复里提到资产文件时，**路径要带类型前缀**（见上表落点列），否则前端当工作区文件打不开。只写文件名（`standing.md`）也不行。工作区产物（`outputs/…`、代码）照常给普通路径。

### 维护原则

**先搜 → 找到就改 → 找不到才新建；过时的删掉，别并存。** 同一事实只存一处。
