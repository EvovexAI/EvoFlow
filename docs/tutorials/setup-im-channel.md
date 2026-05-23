# 接入飞书 / Telegram

## 你将学到什么

- 配置飞书或 Telegram 消息渠道
- 无需公网 IP 的接入方式

## 前置条件

- EvoFlow 正在运行

## 预计用时

15 分钟

## 步骤

### 飞书（Lark）

#### 1. 创建飞书应用

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 启用**机器人**能力

#### 2. 配置权限

添加权限：`im:message`、`im:message.p2p_msg:readonly`、`im:resource`

#### 3. 订阅事件

在**事件**中订阅 `im.message.receive_v1`，选择**长连接**模式。

#### 4. 获取凭证

复制 App ID 和 App Secret。

#### 5. 配置 config.yaml

```yaml
channels:
  langgraph_url: http://localhost:2024
  gateway_url: http://localhost:8001
  feishu:
    enabled: true
    app_id: $FEISHU_APP_ID
    app_secret: $FEISHU_APP_SECRET
```

#### 6. 设置环境变量

在 `.env` 中：

```bash
FEISHU_APP_ID=cli_xxxx
FEISHU_APP_SECRET=your_app_secret
```

### Telegram

#### 1. 创建 Bot

与 [@BotFather](https://t.me/BotFather) 对话，发送 `/newbot`，获取 HTTP API token。

#### 2. 配置

```yaml
channels:
  langgraph_url: http://localhost:2024
  gateway_url: http://localhost:8001
  telegram:
    enabled: true
    bot_token: $TELEGRAM_BOT_TOKEN
```

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

## 验证是否生效

重启 EvoFlow 后，在对应 IM 中给你的 Bot 发消息，它会创建线程并回应。

## 可用命令

| 命令 | 说明 |
|------|------|
| `/new` | 开始新对话 |
| `/status` | 查看当前线程信息 |
| `/models` | 列出可用模型 |
| `/memory` | 查看记忆 |
| `/help` | 显示帮助 |

## 下一步

- [IM 消息渠道配置指南](../guides/im-channels.md) — 钉钉 / Slack / Discord
- [自动化任务调度](../guides/automation-scheduler.md)
