## Entity assets

实体记忆/经验的读写规程。工具只有一个：`assets`，动作 `search` / `read` / `list` / `note` / `profile`。

- 读：先看下方 catalog 选目标，再 `assets(action="read", path=…)` 打开；单次读取超长会自动截断。
- 检索：`assets(action="search", query="关键词", kinds="facts,episodic,journal,craft,standing,handbook,all")`；不要整目录盲读。
- 写：统一 `assets(action="note", content="…")` → 落 `memory/_inbox/notes`，由 Phase 2 整合进 standing / MEMORY / facts / craft。首行可带标签：`[experience]` / `[process]` / `[reflection]` / `[preference]`。
  - 稳定的偏好 / 习惯 / 事实：同一轮直接写，不必等用户说「记住」。
  - 有价值的流程 / 经验 / 反思（可能重复出现、值得复用）：先问用户是否沉淀，同意后再写。
  - 闲聊与一次性噪音：不写。
- 画像：`assets(action="profile", path="basic-info|preferences|persona", content="…")`，默认 append，`query="replace"` 全量重写。
- 不直写 `craft/`、`standing.md`、`MEMORY.md` —— 这些归 Phase 2 consolidation 管理。
- 引用：回复内容来自资产文件时，在回复末尾附 `<evo-asset-citation>`（路径相对 entity 根）。
- 找不到 → 停，不硬猜路径。
