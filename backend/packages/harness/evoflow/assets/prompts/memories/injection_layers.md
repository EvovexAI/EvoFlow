# Asset injection layers (SoT · 实现/运维)

对话侧「写什么、落哪、何时更新」**唯一口径**：同目录 [`read_path.md`](read_path.md)（注入系统提示 `## Entity assets`）。  
本文件只描述运行时分层，**不要**再抄落点表。

| Layer | What | When | Owns |
|-------|------|------|------|
| **L0 job** | system_prompt / soul | every turn | Duty skeleton only |
| **L1b affect** | `profile/affect.md` → `<affect>` | memory on | Main→user vault；employee/小微→own |
| **L2 standing** | `standing.md` 正文 | **on demand** | 用户长期记忆（像人脑回忆） |
| **L3 body** | craft / episodic / journal 正文 + 文件名 | **on demand** | `assets` read / search / list |

**standing 与 catalog 不再每轮注入**——按需用 `assets list/search/read` 取，保持上下文干净。

`memory_enabled` 关 → `<affect>`、assets 工具全关。

kind → 路径映射：admin `skills/public/evoflow-admin/references/assets-contract.md` 布局表；行为规则仍以 `read_path.md` 为准。
