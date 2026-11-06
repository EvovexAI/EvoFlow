# Memory prompt fragments

| File | Role |
|------|------|
| **`read_path.md`** | **对话唯一口径**：落点 / 何时写 / 何时更新 / 何时读（注入系统提示） |
| `read_path_entity.md` | Per-entity 落点壳（不含 catalog / standing 正文） |
| `injection_layers.md` | 实现分层说明（不注入对话） |
| `consolidation.md` | 离线 Phase2 整合（ops；非对话） |

`assets` 工具 docstring 只列参数与路径映射，规则指向 `read_path.md`，勿双写。
