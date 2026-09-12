# 安全政策

## 支持的版本

EvoFlow 处于活跃开发中，请使用最新版本以获取安全更新。

| 版本 | 支持状态 |
|------|----------|
| 最新版 | ✅ 活跃支持 |
| < 0.2.x | ❌ 不再支持 |

## 报告安全漏洞

我们非常重视安全漏洞。如果你发现了安全问题，请**不要**在公开的 Issue 中提交。

### 报告方式

1. **邮件**：发送详情至 [cloud@evovexai.com](mailto:cloud@evovexai.com)
2. **GitHub Security Advisory**：使用 [GitHub Private Vulnerability Reporting](https://github.com/EvovexAI/EvoFlow/security/advisories/new)

### 报告内容应包含

- 漏洞的详细描述
- 复现步骤
- 受影响的版本
- 可能的影响范围
- 如果有的话，建议的修复方案

### 响应时间

| 阶段 | 目标时间 |
|------|----------|
| 确认收到 | 48 小时内 |
| 初步评估 | 7 个工作日内 |
| 修复发布 | 根据严重程度，通常在 30 天内 |

## 本地安装安全实践

EvoFlow 作为本地桌面应用运行，用户应注意以下安全事项：

- **API 密钥**：模型服务商的 API Key 存储在本地 SQLite 数据库中，请确保设备物理安全。
- **网络绑定**：桌面端 Gateway 默认绑定 `127.0.0.1`（仅本机），不暴露到网络。
- **安全护栏**：桌面端默认启用 Guardrails，防止 Agent 执行危险操作。
- **沙箱**：默认使用 `LocalSandboxProvider`，主机 bash 执行默认关闭。
- **CORS**：默认限制为 Tauri 桌面端和本地开发端口。
- **Docker 部署**：使用 Docker 时，端口映射到 `127.0.0.1`。除非有反向代理和认证层，不要暴露到 `0.0.0.0`。

## 依赖扫描

建议定期运行依赖扫描：

```bash
# Python 依赖
pip install pip-audit && pip-audit

# Node.js 依赖
cd evopanel && npm audit
```
