# 飞书 (Feishu/Lark) 集成依赖说明

> ⚠️ **合规声明**
>
> 本飞书集成通过 **飞书开放平台官方 API**（`lark-oapi` SDK）实现，符合飞书开发者协议。
> 使用前请确保：
> - 已在飞书开放平台创建应用并获取合法凭证
> - 遵守飞书开放平台 **[开发者协议](https://open.feishu.cn/document/home/developer-agreement)**
> - 机器人消息推送符合《即时通信工具公众信息服务发展管理暂行规定》
>
> **禁止用于**：未经用户同意的批量消息推送、爬取用户隐私数据、或违反飞书平台规则的行为。
> 开发者（EvovexAI）不对因使用本集成产生的任何法律后果承担责任。

## 核心依赖

| 包名 | 版本要求 | 用途 |
|------|---------|------|
| lark-oapi | >=1.4.0 | 飞书开放平台官方 SDK，提供 WebSocket 长连接和 API 调用 |

## 安装命令

```bash
# 使用 uv 安装（推荐）
uv add lark-oapi>=1.4.0

# 或使用 pip
pip install lark-oapi>=1.4.0
```

## 可选依赖

```bash
# Markdown 转飞书格式（用于消息格式化）
uv add markdown-to-mrkdwn>=0.3.1

# 异步 HTTP 客户端（用于 SSE 流式请求）
uv add httpx>=0.28.0
```

## 配置文件说明

在 `config.yaml` 中配置飞书应用信息：

```yaml
channels:
  feishu:
    # 飞书应用凭证（必填）
    # 从飞书开放平台获取：https://open.feishu.cn/app/
    app_id: "cli_xxxxxxxxxxxxxxxx"
    app_secret: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

    # 可选：事件验证 Token（用于 Webhook 验证，WebSocket 模式下可选）
    verification_token: "xxxxxxxxxxxxxxxx"

    # 可选：加密密钥（启用事件加密时使用）
    # encrypt_key: "xxxxxxxxxxxxxxxx"
```

## 飞书应用配置步骤

1. **创建应用**
   - 访问 [飞书开放平台](https://open.feishu.cn/app/)
   - 点击「创建企业自建应用」
   - 填写应用名称和描述

2. **获取凭证**
   - 进入应用详情 →「凭证与基础信息」
   - 复制 `App ID` 和 `App Secret` 到 `config.yaml`

3. **配置权限**
   - 进入「权限管理」，添加以下权限：
     - `im:message:send` - 发送消息
     - `im:message:receive` - 接收消息
     - `im:chat:readonly` - 读取群组信息
     - `im:message.group_msg` - 接收群消息

4. **订阅事件**
   - 进入「事件订阅」，开启以下事件：
     - `im.message.receive_v1` - 接收消息事件
   - WebSocket 模式无需配置请求地址

5. **发布应用**
   - 进入「版本管理与发布」
   - 点击「创建版本」，填写版本信息
   - 申请发布，等待管理员审核

## 模块接口说明

### 主要类

| 类名 | 路径 | 功能描述 |
|------|------|----------|
| `FeishuChannel` | `app.channels.feishu` | 飞书频道主类，处理 WebSocket 连接和消息收发 |
| `SSEFeishuBridge` | `app.channels.sse_feishu_bridge` | SSE 流式响应桥接器，将 AI 流式输出实时更新到飞书卡片 |
| `CardTemplate` | `app.channels.sse_feishu_bridge` | 飞书卡片模板配置 |
| `SSEEvent` | `app.channels.sse_feishu_bridge` | SSE 事件数据类 |

### 便捷函数

```python
from app.channels import stream_to_feishu_card

# 方式1：便捷函数（推荐）
card_id = await stream_to_feishu_card(
    feishu_channel,
    source_message_id,
    sse_stream_iterator,
    update_interval=1.0
)

# 方式2：精细控制
from app.channels import SSEFeishuBridge, CardTemplate

bridge = SSEFeishuBridge(feishu_client, message_id, template=CardTemplate())
await bridge.start()
async for event in sse_stream:
    await bridge.on_sse_event(event)
await bridge.finish()
```

## 消息生命周期

```
用户发送消息
    ↓
FeishuChannel._on_message() 接收消息
    ↓
添加 "OK" 表情回应
    ↓
发送 "Processing..." 卡片（楼中楼）
    ↓
MessageBus 分发到 ChannelManager
    ↓
调用 LangGraph Server 处理
    ↓
SSE 流式响应
    ↓
SSEFeishuBridge 实时更新卡片
    ↓
添加 "DONE" 表情回应
```

## 注意事项

1. **WebSocket 模式**：本集成使用 WebSocket 长连接，无需公网 IP 或配置回调 URL
2. **卡片更新频率**：默认每秒更新一次，可通过 `update_interval` 调整
3. **消息长度限制**：单条消息最大 10000 字符，超出会自动截断
4. **文件上传限制**：图片 10MB，其他文件 30MB
