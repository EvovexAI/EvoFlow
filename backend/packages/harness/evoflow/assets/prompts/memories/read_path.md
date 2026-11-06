## Entity assets

工具：`assets`（`search` / `read` / `list` / `note` / `write` / `delete` / `rename` / `profile` / `affect`）。本段是落点与更新的唯一说明。

**只作参考**：先完成本轮**最新用户问题**；与记忆冲突时以用户为准，勿续跑未点名的旧事。

### 落点与操作

| 我要做的 | 怎么做 | 落点 |
|---|---|---|
| 记跨领域都该遵守的（称呼、硬禁令、协作方式）| `assets note` | `memory/standing.md` |
| 记这次的经过与结论 | `assets note` | `memory/episodic/` |
| 记同类事照着做的步骤/配方/话术 | `assets note` | `craft/` |
| 记短教训、下次别再犯 | `assets note` | `memory/journal/` |
| 记称呼、身份画像 | `assets profile` | `profile/` |
| 记自己的心境 | `assets affect` | `profile/affect.md` |
| 找记忆 | `assets search <关键词>` / `list` / `read` | — |
| 改一段 | `assets write`（默认追加）；整份重写才 `mode=replace` | — |
| 改文件名 | `assets rename path=<文件>` `content=新名` | 同目录内 |
| 删过时内容 | `assets delete path=<文件>`（不可撤销，先 read） | — |

新增文件时文件名取正文**首行标题**（短、能看懂主题）。

### 每类什么时候记、记什么

- **长期记忆**（`memory/standing.md`）：用户新定或改规矩时记；只留**偏好与硬禁令**，别写流水账。用户同事改规矩也顺手更新；过时的那条改写或删，别打架。
- **经验**（`craft/`）：同类事第二次出现就沉淀为配方——写**步骤+命令+坑点**，让下次照着做。发现更好的做法直接改原文件；已被推翻的整份删掉重写。
- **过程**（`memory/episodic/`）：一次任务做完记**经过、结论、交付物路径**。只留结果，不抄全过程；过期了就删。
- **反思**（`memory/journal/`）：踩坑当天记**根因+教训+下次怎么做**，一行也行。同一坑反复踩，改原条目别新开。
- **画像**（`profile/`）：用户第一次说称呼、身份时记；变了就改。
- **情感**（`profile/affect.md`）：察觉用户情绪/心境变化时主动记，不用等用户说。

### 引用

回复里提到资产文件时，**路径要带类型前缀**（见上表落点列），否则前端当工作区文件打不开。只写文件名（`standing.md`）也不行。工作区产物（`outputs/…`、代码）照常给普通路径。

### 维护原则

**先搜 → 找到就改 → 找不到才新建；过时的删掉，别并存。** 同一事实只存一处。
