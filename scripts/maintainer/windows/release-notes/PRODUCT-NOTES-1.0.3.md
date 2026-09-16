**EvoFlow v1.0.3 — 代码索引落盘 + 工作流创建修复**

### 用户可见

- 工作区代码索引改存到绑定项目的 `.evoflow/code_index/`（与项目记忆同树；该目录仍 gitignore，不进仓库）
- 旧路径 `~/.evoflow/code_index/{hash}.db` 不再写入；无自动迁移，首次搜索/重建会生成新索引
- **修复新建空白工作流后打不开**（报 `Application not found`）：创建时写入归属，非管理员也可立刻打开（#19）
- Windows 安装/卸载进程清理改为轻量策略（一轮 taskkill + 短等 + 写锁 Retry），减少升级卡住
- 员工页：部门/组织管理、加人一次完成；工作流指派选员工；「工作项」Tab 移到最后

### 版本与安装

- 桌面端 / 面板 / 后端 / harness 统一 **1.0.3**
- 安装包名：`EvoFlow_1.0.3_x64-setup.exe`（macOS 对应 DMG）

### 升级建议

- 建议从 1.0.2 覆盖安装至 1.0.3
- 升级后可在绑定项目下确认存在 `.evoflow/code_index/index.db`，或在面板触发一次索引重建
