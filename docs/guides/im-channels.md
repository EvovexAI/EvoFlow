# IM 消息渠道配置

## 适用场景
将 EvoFlow 接入即时通讯平台（飞书、钉钉、Telegram、Slack、Discord、QQ），让用户通过 IM 与 Agent 对话。

## 前置条件
- EvoFlow 已运行
- 已创建目标 IM 平台的应用/机器人，获取必要的凭证
- 如 IM 渠道运行在 Docker 容器内，需使用容器 DNS 名称而非 localhost

## 支持的渠道

| 渠道 | 连接方式 | 配置项 |
|------|----------|--------|
| 飞书 (Feishu) | WebSocket | `app_id`, `app_secret` |
| 钉钉 (DingTalk) | WebSocket/轮询 | 相应凭证 |
| Telegram | Bot API 轮询 | `bot_token` |
| Slack | Socket Mode | `bot_token`, `app_token` |
| Discord | Gateway | 相应凭证 |
| QQ | WebSocket | 相应凭证 |

所有渠道使用出站连接（WebSocket 或轮询），无需公网 IP。

## 全局配置

```yaml
channels:
  # LangGraph Server URL（默认: http://localhost:2024）
  # Docker 部署时使用容器 DNS:
  #   langgraph_url: http://langgraph:2024
  #   gateway_url: http://gateway:8001
  langgraph_url: http://localhost:2024
  gateway_url: http://localhost:8001

  # 可选：所有 IM 渠道的默认会话配置
  session:
    assistant_id: lead_agent
    config:
      recursion_limit: 100
    context:
      thinking_enabled: true
      is_plan_mode: false
      subagent_enabled: false
```

## 飞书配置

```yaml
channels:
  feishu:
    enabled: false
    app_id: $FEISHU_APP_ID
    app_secret: $FEISHU_APP_SECRET
    # 主动推送（可选）：POST /api/channels/feishu/push
    # push_secret: $EVOFLOW_FEISHU_PUSH_SECRET
```

**主动推送**：配置 `push_secret` 后，可通过以下方式向飞书主动推送消息：
```bash
curl -X POST http://localhost:8001/api/channels/feishu/push \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EVOFLOW_FEISHU_PUSH_SECRET" \
  -d '{"chat_id": "oc_xxx", "content": "**标题**\n\n正文内容"}'
```

## Slack 配置

```yaml
channels:
  slack:
    enabled: false
    bot_token: $SLACK_BOT_TOKEN     # xoxb-...
    app_token: $SLACK_APP_TOKEN     # xapp-... (Socket Mode)
    allowed_users: []               # 空 = 允许所有用户
```

## Telegram 配置

```yaml
channels:
  telegram:
    enabled: false
    bot_token: $TELEGRAM_BOT_TOKEN
    allowed_users: []               # 空 = 允许所有用户
```

**渠道级会话覆盖**：
```yaml
    session:
      assistant_id: mobile-agent
      context:
        thinking_enabled: false

    # 按用户覆盖
    session:
      users:
        "123456789":
          assistant_id: vip-agent
          context:
            thinking_enabled: true
            subagent_enabled: true
```

## 渠道命令

用户在 IM 中可以使用以下命令：

| 命令 | 功能 |
|------|------|
| `/new` | 开始新对话（创建新线程） |
| `/status` | 显示当前线程信息 |
| `/models` | 列出可用模型 |
| `/memory` | 显示记忆状态 |
| `/help` | 显示帮助信息 |

## 会话管理

- 每个 `channel:chat_id`（根对话）或 `channel:chat_id:topic_id`（话题）映射到一个 LangGraph `thread_id`
- 会话映射存储在 JSON 文件中（`channels/` 目录）
- `/new` 命令创建新的 thread_id 映射，不删除旧线程
- 不同渠道的用户会话相互隔离

## Docker Compose 中的 URL 注意事项

当渠道运行在 gateway 容器内时，`localhost` 指向容器本身而非宿主机。需使用容器 DNS：

```yaml
channels:
  langgraph_url: http://langgraph:2024
  gateway_url: http://gateway:8001
```

或通过环境变量覆盖：
```bash
export DEER_FLOW_CHANNELS_LANGGRAPH_URL=http://langgraph:2024
export DEER_FLOW_CHANNELS_GATEWAY_URL=http://gateway:8001
```

## 验证是否生效

```bash
# 查看渠道状态
curl http://localhost:8001/api/channels

# 重启指定渠道
curl -X POST http://localhost:8001/api/channels/feishu/restart

# 查看/修改渠道配置
curl http://localhost:8001/api/channels/feishu/config
curl -X PUT http://localhost:8001/api/channels/feishu/config \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

## 常见问题

**Q: 飞书机器人收不到消息？**
确认飞书应用的回调 URL 已正确配置，事件订阅已开启。检查 `app_id` 和 `app_secret` 是否正确。

**Q: Slack Socket Mode 不工作？**
确认 `app_token`（xapp-开头）和 `bot_token`（xoxb-开头）都已正确设置。

**Q: Telegram 机器人无响应？**
确认 `bot_token` 正确。检查是否有网络代理阻止访问 Telegram API。

**Q: 多个 IM 渠道的会话会互相干扰吗？**
不会。每个 `channel:chat_id` 有独立的 thread_id 映射。

**Q: 如何限制只有特定用户能使用？**
在渠道配置中设置 `allowed_users: ["user_id1", "user_id2"]`，空数组表示允许所有人。

## 相关文档
- [EvoPanel 桌面端使用指南](./evopanel-guide.md)
- [Docker 开发部署](./docker-deployment.md)

---

**最后验证**：2026-05-10；适用范围：默认分支。
