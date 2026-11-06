# Asset injection layers (SoT · 实现/运维)

对话侧「写什么、落哪、何时更新」**唯一口径**：同目录 [`read_path.md`](read_path.md)（注入系统提示 `## Entity assets`）。  
本文件只描述运行时分层，**不要**再抄落点表。

| Layer | What | When | Owns |
|-------|------|------|------|
| **L0 job** | system_prompt / soul | every turn | Duty skeleton only |
| **L1 standing** | `standing.md` → prefs/Tips（软顶；不含 What's in Memory） | memory on | Hard constraints only |
| **L1b affect** | `profile/affect.md` → `<affect>` | memory on | Main→user vault；employee/小微→own |
| **L2 catalog** | craft / episodic / journal 文件名 | memory on | Discoverability |
| **L3 body** | 正文 | on demand | `assets` read / search |

`memory_enabled` 关 → standing、catalog、`<affect>`、assets 工具全关。

kind → 路径映射：admin `skills/public/evoflow-admin/references/assets-contract.md` 布局表；行为规则仍以 `read_path.md` 为准。
