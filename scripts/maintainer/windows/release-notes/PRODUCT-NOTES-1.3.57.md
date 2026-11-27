**EvoFlow v1.3.57 — 修复正式包前端构建失败**

本版相对 **1.3.56**：补回被 `.gitignore` 误忽略的「待发送队列按会话隔离」模块，GitHub Actions Windows / macOS 正式包前端构建可过。覆盖安装即可。

---

### 修复

- **正式包前端构建**：补齐 `pending-send-queue-session`，vite 不再因缺失模块失败（1.3.53–1.3.56 CI 根因）
- **gitignore**：仓库根 `/hooks/` 不再误伤 `evopanel/src/react/hooks/`

### 覆盖安装即可

无数据迁移。从 **1.3.56**（或更早 1.3.x）覆盖安装至 **1.3.57**。
