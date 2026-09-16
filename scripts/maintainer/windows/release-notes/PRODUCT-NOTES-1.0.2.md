**EvoFlow v1.0.2 — 项目记忆落盘与面板稳定性**

在 1.0.1 之上，把项目空间记忆迁到仓库内 `.evoflow/`，并修 Gateway UTF-8、会话列表与资源市场等相关体验。

### 本版亮点

- **项目空间记忆**：权威存储迁到绑定项目下的 `.evoflow/memory/` 与 `.evoflow/craft/`（不再写 `~/.evoflow/assets/workspaces/`）
- **Gateway UTF-8**：响应 `Content-Type` 补齐 charset，减少中文 Windows 下乱码
- **会话 / 首页**：线程历史与首页数据钩子稳定性改进
- **资源市场 / 组织包**：文案与拉取路径小修

### 版本说明

- 桌面端 / 面板 / 后端 / harness 统一 **1.0.2**
- 安装包名：`EvoFlow_1.0.2_x64-setup.exe`（macOS 对应 DMG）

### 升级说明

- 建议从 1.0.1 覆盖安装至 1.0.2
- 已绑定项目会在下次会话绑定时自动创建 `.evoflow/` 骨架；旧 `assets/workspaces/` 数据不自动迁移
- 模型与 API Key 仍在「设置 → 模型」配置
- 商用授权与定制：cloud@evovexai.com
- 文档：https://www.evovexai.com/docs/chat/evopanel
