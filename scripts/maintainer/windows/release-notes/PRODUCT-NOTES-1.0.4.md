**EvoFlow v1.0.4 — 企业微信 / 钉钉渠道接入**

### 用户可见

- 消息渠道新增**企业微信（WeCom）**与**钉钉（DingTalk）**接入（Stream 模式，出站长连接，无需公网 IP）
- 企微：AI Bot WebSocket 网关，支持扫码自动创建机器人并回填凭证
- 钉钉：官方 dingtalk-stream SDK，支持「📱 钉钉扫码」自动授权，或手动配置 Client ID / Secret
- 渠道配置模板同步补充到 `config.example.yaml`

### 版本与安装

- 桌面端 / 面板 / 后端 / harness 统一 **1.0.4**
- 安装包名：`EvoFlow_1.0.4_x64-setup.exe`（macOS 对应 DMG）

### 升级建议

- 建议从 1.0.3 覆盖安装至 1.0.4
- 如需启用企微/钉钉渠道，升级后在「IM Channels → 企业微信 / 钉钉」扫码或手动配置即可
