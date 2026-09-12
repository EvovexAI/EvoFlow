"""IM Channel integration for EvoFlow.

Provides a pluggable channel system that connects external messaging platforms
(Feishu/Lark, Slack, Telegram) to the EvoFlow agent via the ChannelManager,
which uses ``langgraph-sdk`` to communicate with the underlying LangGraph Server.

飞书/Feishu 集成快速开始:
    1. 安装依赖: uv add lark-oapi>=1.4.0
    2. 配置 config.yaml:
       channels:
         feishu:
           app_id: "your-app-id"
           app_secret: "your-app-secret"
    3. 启动服务，飞书频道将自动连接
"""

from app.channels.base import Channel
from app.channels.feishu import FeishuChannel
from app.channels.message_bus import InboundMessage, MessageBus, OutboundMessage
from app.channels.sse_feishu_bridge import (
    CardTemplate,
    MarkdownProcessor,
    SSEEvent,
    SSEEventType,
    SSEFeishuBridge,
    stream_to_feishu_card,
)

__all__ = [
    # 基础类
    "Channel",
    "InboundMessage",
    "MessageBus",
    "OutboundMessage",
    # 飞书主类
    "FeishuChannel",
    # SSE 流式桥接器
    "SSEFeishuBridge",
    "CardTemplate",
    "SSEEvent",
    "SSEEventType",
    "MarkdownProcessor",
    "stream_to_feishu_card",
]
