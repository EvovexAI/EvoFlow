**EvoFlow v1.0.3 — 代码索引落盘到项目 `.evoflow/`**

### 用户可见

- 工作区代码索引改存到绑定项目的 `.evoflow/code_index/`（与项目记忆同树；该目录仍 gitignore，不进仓库）
- 旧路径 `~/.evoflow/code_index/{hash}.db` 不再写入；无自动迁移，首次搜索/重建会生成新索引

### 版本与安装

- 桌面端 / 面板 / 后端 / harness 统一 **1.0.3**
- 安装包名：`EvoFlow_1.0.3_x64-setup.exe`（macOS 对应 DMG）

### 升级建议

- 建议从 1.0.2 覆盖安装至 1.0.3
- 升级后可在绑定项目下确认存在 `.evoflow/code_index/index.db`，或在面板触发一次索引重建
