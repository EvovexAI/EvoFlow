"""SSE to Feishu Card Bridge — 流式响应桥接器

将 AI 的 SSE 流式输出转换为飞书消息卡片的实时更新。
支持 Markdown 渲染、代码块高亮、节流控制和智能分段。

典型使用场景:
    1. 用户发送消息后，创建 "Processing..." 初始卡片
    2. SSE 流式响应通过此桥接器实时更新卡片内容
    3. 流结束时，卡片显示完整回复

使用示例:
    ```python
    bridge = SSEFeishuBridge(feishu_client, message_id)

    # 开始流式更新
    await bridge.start()

    # 处理 SSE 事件流
    async for sse_event in stream:
        await bridge.on_sse_event(sse_event)

    # 完成流式更新
    await bridge.finish()
    ```

依赖说明:
    - 与 streaming_handler.py 解耦，可独立使用
    - 如需使用高级节流控制，可配合 StreamingHandler 使用
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal, Protocol

logger = logging.getLogger(__name__)


class SSEEventType(Enum):
    """SSE 事件类型"""

    MESSAGE = "message"  # AI 消息增量
    TOOL_CALL = "tool_call"  # 工具调用开始
    TOOL_RESULT = "tool_result"  # 工具调用结果
    ERROR = "error"  # 错误事件
    END = "end"  # 流结束
    UNKNOWN = "unknown"  # 未知类型


@dataclass
class SSEEvent:
    """SSE 事件数据"""

    event_type: SSEEventType
    data: dict[str, Any] = field(default_factory=dict)
    raw_event: str = ""

    @classmethod
    def parse(cls, raw_event: str) -> SSEEvent:
        """解析原始 SSE 事件字符串

        支持格式:
            data: {"event": "message", "data": {"content": "hello"}}

            event: message
            data: {"content": "hello"}
        """
        event_type = SSEEventType.UNKNOWN
        data: dict[str, Any] = {}

        lines = raw_event.strip().split("\n")
        event_name = None

        for line in lines:
            if line.startswith("event:"):
                event_name = line[6:].strip()
            elif line.startswith("data:"):
                data_str = line[5:].strip()
                try:
                    parsed = json.loads(data_str)
                    if isinstance(parsed, dict):
                        if "event" in parsed:
                            event_name = parsed["event"]
                            data = parsed.get("data", {})
                        else:
                            data = parsed
                except json.JSONDecodeError:
                    # 非 JSON 数据，作为原始文本
                    data = {"content": data_str}

        # 确定事件类型
        if event_name:
            event_type = SSEEventType(event_name) if event_name in [e.value for e in SSEEventType] else SSEEventType.UNKNOWN

        return cls(event_type=event_type, data=data, raw_event=raw_event)


@dataclass
class CardTemplate:
    """飞书消息卡片模板配置"""

    enable_markdown: bool = True
    enable_code_highlight: bool = True
    wide_screen_mode: bool = True
    update_multi: bool = True  # 支持多次更新同一卡片
    max_content_length: int = 10000  # 单条消息最大长度
    truncate_indicator: str = "\n\n... (内容已截断)"

    # 样式配置
    header_color: str = "blue"  # blue, wathet, turquoise, green, yellow, orange, red, purple, carmine
    processing_text: str = "🤔 思考中..."
    done_text: str = "✅ 完成"


class FeishuCardAPI(Protocol):
    """飞书卡片 API 协议（用于依赖注入）"""

    async def reply_card(self, message_id: str, content: str) -> str | None:
        """回复卡片消息，返回卡片 message_id"""
        ...

    async def update_card(self, message_id: str, content: str) -> None:
        """更新卡片内容"""
        ...


class MarkdownProcessor:
    """Markdown 处理器 - 优化飞书卡片显示"""

    # 代码块缓存，用于保持未闭合代码块
    _open_code_block: str | None = None

    @classmethod
    def process(cls, text: str, is_streaming: bool = True) -> str:
        """处理 Markdown 文本以适应飞书卡片

        Args:
            text: 原始 Markdown 文本
            is_streaming: 是否流式输出中（影响代码块处理）

        Returns:
            处理后的 Markdown 文本
        """
        if not text:
            return text

        # 保护代码块内容
        text = cls._protect_code_blocks(text)

        # 处理行内元素
        text = cls._process_inline_elements(text)

        # 恢复代码块
        text = cls._restore_code_blocks(text)

        # 流式状态下的代码块处理
        if is_streaming:
            text = cls._handle_unclosed_code_block(text)

        return text.strip()

    @classmethod
    def _protect_code_blocks(cls, text: str) -> str:
        """保护代码块，防止内部内容被处理"""
        cls._code_blocks = []

        def replace_block(match: re.Match) -> str:
            cls._code_blocks.append(match.group(0))
            return f"<<<CODE_BLOCK_{len(cls._code_blocks) - 1}>>>"

        # 匹配 ```language\ncode\n``` 格式
        pattern = r"```[\w]*\n[\s\S]*?(?:```|$)"
        return re.sub(pattern, replace_block, text)

    @classmethod
    def _process_inline_elements(cls, text: str) -> str:
        """处理行内 Markdown 元素"""
        # 转义飞书特殊字符
        text = text.replace("&", "&amp;")

        # 保留其他 Markdown 语法，飞书卡片原生支持
        return text

    @classmethod
    def _restore_code_blocks(cls, text: str) -> str:
        """恢复保护的代码块"""
        if not hasattr(cls, "_code_blocks"):
            return text

        for i, block in enumerate(cls._code_blocks):
            text = text.replace(f"<<<CODE_BLOCK_{i}>>>", block)

        return text

    @classmethod
    def _handle_unclosed_code_block(cls, text: str) -> str:
        """处理未闭合的代码块（流式输出中）"""
        # 检查是否有未闭合的 ```
        code_fence_count = text.count("```")

        if code_fence_count % 2 == 1:
            # 奇数个代码围栏，说明有一个未闭合
            # 暂时闭合它以保持渲染正确
            text += "\n```"

        return text

    @staticmethod
    def truncate_for_card(text: str, max_length: int = 10000, indicator: str = "\n\n...") -> str:
        """截断文本以适应卡片长度限制"""
        if len(text) <= max_length:
            return text

        # 在合理位置截断（优先在段落边界）
        truncate_point = max_length - len(indicator)

        # 尝试在最后一个完整段落处截断
        last_para = text.rfind("\n\n", 0, truncate_point)
        if last_para > truncate_point * 0.8:
            truncate_point = last_para

        return text[:truncate_point] + indicator


@dataclass
class StreamBuffer:
    """流式内容缓冲区"""

    content: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    tool_results: list[dict] = field(default_factory=list)
    is_complete: bool = False
    error: str | None = None

    def append_content(self, text: str) -> None:
        """追加内容"""
        self.content += text

    def add_tool_call(self, tool_call: dict) -> None:
        """添加工具调用"""
        self.tool_calls.append(tool_call)

    def add_tool_result(self, result: dict) -> None:
        """添加工具结果"""
        self.tool_results.append(result)

    def mark_complete(self) -> None:
        """标记流完成"""
        self.is_complete = True

    def mark_error(self, error_msg: str) -> None:
        """标记错误"""
        self.error = error_msg


class FeishuCardBuilder:
    """飞书消息卡片构建器"""

    def __init__(self, template: CardTemplate | None = None):
        self.template = template or CardTemplate()
        self._md = MarkdownProcessor()

    def build_card_data(
        self,
        content: str,
        status: Literal["processing", "streaming", "complete", "error"] = "streaming",
        tool_info: list[dict] | None = None,
    ) -> dict[str, Any]:
        """构建飞书卡片 JSON 数据

        Args:
            content: 卡片正文内容
            status: 当前状态
            tool_info: 工具调用信息

        Returns:
            飞书卡片 JSON 对象
        """
        elements: list[dict] = []

        # 状态头部
        if status == "processing":
            elements.append({"tag": "markdown", "content": f"**{self.template.processing_text}**"})
        elif status == "error":
            elements.append({"tag": "markdown", "content": "**❌ 出错了**"})

        # 工具调用信息（如果有）
        if tool_info and self.template.enable_markdown:
            tool_content = self._format_tool_info(tool_info)
            elements.append({"tag": "markdown", "content": tool_content})

        # 主内容
        if content:
            processed_content = self._md.process(content, is_streaming=(status != "complete"))

            # 截断处理
            if len(processed_content) > self.template.max_content_length:
                processed_content = self._md.truncate_for_card(processed_content, self.template.max_content_length, self.template.truncate_indicator)

            # 如果启用 Markdown，使用 markdown 元素
            if self.template.enable_markdown:
                elements.append({"tag": "markdown", "content": processed_content})
            else:
                # 纯文本模式
                elements.append({"tag": "div", "text": {"tag": "plain_text", "content": processed_content}})

        # 完成状态标识
        if status == "complete":
            elements.append({"tag": "markdown", "content": f"\n---\n*{self.template.done_text}*"})

        card = {
            "config": {
                "wide_screen_mode": self.template.wide_screen_mode,
                "update_multi": self.template.update_multi,
            },
            "elements": elements,
        }

        # 添加标题头（仅在初始时）
        if status == "processing":
            card["header"] = {"template": self.template.header_color, "title": {"tag": "plain_text", "content": "AI Assistant"}}

        return card

    def _format_tool_info(self, tool_info: list[dict]) -> str:
        """格式化工具调用信息"""
        lines = ["**正在进行工具调用...**"]
        for tool in tool_info:
            name = tool.get("name", "unknown")
            status = tool.get("status", "running")
            icon = "⏳" if status == "running" else "✅" if status == "complete" else "❌"
            lines.append(f"{icon} **{name}**")
        return "\n".join(lines)

    def build_card_json(self, **kwargs) -> str:
        """构建卡片 JSON 字符串"""
        return json.dumps(self.build_card_data(**kwargs))


class SSEFeishuBridge:
    """SSE 到飞书卡片的桥接器

    核心职责:
        1. 接收 SSE 流式事件
        2. 缓冲和聚合内容
        3. 转换为飞书卡片格式
        4. 控制更新频率（节流）
        5. 管理卡片生命周期（创建→更新→完成）
    """

    def __init__(
        self,
        api: FeishuCardAPI | Any,
        source_message_id: str,
        *,
        template: CardTemplate | None = None,
        update_interval: float = 1.0,  # 最小更新间隔（秒）
        min_content_delta: int = 10,  # 最小内容变化才更新
        enable_throttle: bool = True,
    ):
        """初始化桥接器

        Args:
            api: 飞书 API 客户端（需实现 reply_card 和 update_card）
            source_message_id: 源消息 ID（用于回复）
            template: 卡片模板配置
            update_interval: 最小更新间隔（秒）
            min_content_delta: 最小内容变化字符数
            enable_throttle: 是否启用节流控制
        """
        self.api = api
        self.source_message_id = source_message_id
        self.template = template or CardTemplate()
        self.update_interval = update_interval
        self.min_content_delta = min_content_delta
        self.enable_throttle = enable_throttle

        # 状态
        self._card_message_id: str | None = None
        self._buffer = StreamBuffer()
        self._builder = FeishuCardBuilder(self.template)
        self._is_running = False
        self._last_update_time: float = 0
        self._last_update_content: str = ""
        self._pending_update: str | None = None
        self._update_task: asyncio.Task | None = None

    async def start(self, initial_text: str = "") -> str | None:
        """启动桥接器，创建初始卡片

        Args:
            initial_text: 初始显示的文本（可选）

        Returns:
            创建的卡片 message_id
        """
        if self._is_running:
            logger.warning("[SSEFeishuBridge] already started")
            return self._card_message_id

        self._is_running = True

        # 创建初始卡片
        card_json = self._builder.build_card_json(content=initial_text, status="processing")

        try:
            self._card_message_id = await self.api.reply_card(self.source_message_id, card_json)
            logger.info("[SSEFeishuBridge] card created: source=%s card=%s", self.source_message_id, self._card_message_id)
        except Exception:
            logger.exception("[SSEFeishuBridge] failed to create card")
            self._is_running = False
            raise

        self._last_update_time = asyncio.get_event_loop().time()
        return self._card_message_id

    async def on_sse_event(self, event: str | dict | SSEEvent) -> None:
        """处理 SSE 事件

        Args:
            event: SSE 事件（字符串 JSON 或已解析的事件对象）
        """
        if not self._is_running:
            logger.warning("[SSEFeishuBridge] not started, ignoring event")
            return

        # 解析事件
        if isinstance(event, str):
            sse_event = SSEEvent.parse(event)
        elif isinstance(event, dict):
            event_type = SSEEventType(event.get("event", "unknown"))
            sse_event = SSEEvent(event_type=event_type, data=event.get("data", {}), raw_event=json.dumps(event))
        else:
            sse_event = event

        # 处理不同类型的事件
        if sse_event.event_type == SSEEventType.MESSAGE:
            await self._handle_message_event(sse_event.data)
        elif sse_event.event_type == SSEEventType.TOOL_CALL:
            await self._handle_tool_call_event(sse_event.data)
        elif sse_event.event_type == SSEEventType.TOOL_RESULT:
            await self._handle_tool_result_event(sse_event.data)
        elif sse_event.event_type == SSEEventType.ERROR:
            await self._handle_error_event(sse_event.data)
        elif sse_event.event_type == SSEEventType.END:
            await self._handle_end_event()
        else:
            logger.debug("[SSEFeishuBridge] unknown event type: %s", sse_event.event_type)

    async def _handle_message_event(self, data: dict) -> None:
        """处理消息事件"""
        content = data.get("content", "")
        if not content:
            return

        self._buffer.append_content(content)

        # 检查是否需要更新卡片
        if await self._should_update():
            await self._schedule_update()

    async def _handle_tool_call_event(self, data: dict) -> None:
        """处理工具调用事件"""
        self._buffer.add_tool_call(data)

        # 工具调用时立即更新显示
        await self._schedule_update(force=True)

    async def _handle_tool_result_event(self, data: dict) -> None:
        """处理工具结果事件"""
        self._buffer.add_tool_result(data)

        # 找到对应的工具调用并更新状态
        tool_id = data.get("tool_call_id")
        for tc in self._buffer.tool_calls:
            if tc.get("id") == tool_id:
                tc["status"] = "complete" if not data.get("error") else "error"
                break

        await self._schedule_update(force=True)

    async def _handle_error_event(self, data: dict) -> None:
        """处理错误事件"""
        error_msg = data.get("message", "Unknown error")
        self._buffer.mark_error(error_msg)
        logger.error("[SSEFeishuBridge] stream error: %s", error_msg)

        await self._update_card_now(status="error")

    async def _handle_end_event(self) -> None:
        """处理流结束事件"""
        self._buffer.mark_complete()
        await self.finish()

    async def _should_update(self) -> bool:
        """检查是否应该更新卡片"""
        if not self.enable_throttle:
            return True

        now = asyncio.get_event_loop().time()
        time_since_last = now - self._last_update_time

        # 时间间隔检查
        if time_since_last < self.update_interval:
            # 内容变化足够大也可以触发
            content_delta = len(self._buffer.content) - len(self._last_update_content)
            if content_delta < self.min_content_delta:
                return False

        return True

    async def _schedule_update(self, force: bool = False) -> None:
        """调度卡片更新"""
        if not self._card_message_id:
            return

        current_content = self._buffer.content
        self._pending_update = current_content

        if force:
            # 强制立即更新
            if self._update_task and not self._update_task.done():
                self._update_task.cancel()
            await self._update_card_now()
        elif not self._update_task or self._update_task.done():
            # 创建延迟更新任务
            self._update_task = asyncio.create_task(self._delayed_update())

    async def _delayed_update(self) -> None:
        """延迟执行更新（用于节流）"""
        await asyncio.sleep(self.update_interval)
        await self._update_card_now()

    async def _update_card_now(self, status: str = "streaming") -> None:
        """立即更新卡片"""
        if not self._card_message_id or self._pending_update is None:
            return

        # 准备工具信息
        tool_info = None
        if self._buffer.tool_calls:
            tool_info = [{"name": tc.get("name", "unknown"), "status": tc.get("status", "running")} for tc in self._buffer.tool_calls]

        # 构建卡片
        card_json = self._builder.build_card_json(
            content=self._pending_update,
            status=status,  # type: ignore[arg-type]
            tool_info=tool_info,
        )

        try:
            await self.api.update_card(self._card_message_id, card_json)
            self._last_update_time = asyncio.get_event_loop().time()
            self._last_update_content = self._pending_update
            logger.debug("[SSEFeishuBridge] card updated: %s", self._card_message_id)
        except Exception:
            logger.exception("[SSEFeishuBridge] failed to update card")

    async def finish(self) -> None:
        """完成流式输出，发送最终状态"""
        if not self._is_running:
            return

        self._is_running = False

        # 取消待处理的更新任务
        if self._update_task and not self._update_task.done():
            self._update_task.cancel()
            try:
                await self._update_task
            except asyncio.CancelledError:
                pass

        # 发送最终更新
        if self._card_message_id:
            await self._update_card_now(status="complete" if not self._buffer.error else "error")
            logger.info("[SSEFeishuBridge] stream finished: card=%s content_len=%d", self._card_message_id, len(self._buffer.content))

    async def abort(self, reason: str = "已取消") -> None:
        """中止流式输出"""
        if not self._is_running:
            return

        self._is_running = False
        self._buffer.mark_error(reason)

        if self._card_message_id:
            await self._update_card_now(status="error")

    @property
    def is_running(self) -> bool:
        """是否正在运行"""
        return self._is_running

    @property
    def card_message_id(self) -> str | None:
        """当前卡片消息 ID"""
        return self._card_message_id

    @property
    def current_content(self) -> str:
        """当前累计内容"""
        return self._buffer.content


# 高级用法：与 FeishuChannel 集成的辅助函数


async def stream_to_feishu_card(
    feishu_channel: Any,  # FeishuChannel
    source_message_id: str,
    sse_stream: AsyncIterator[str | dict],
    *,
    update_interval: float = 1.0,
    template: CardTemplate | None = None,
) -> str | None:
    """将 SSE 流式输出桥接到飞书卡片

    便捷函数，封装完整的流式处理流程。

    Args:
        feishu_channel: FeishuChannel 实例
        source_message_id: 源消息 ID
        sse_stream: SSE 事件异步迭代器
        update_interval: 更新间隔（秒）
        template: 卡片模板配置

    Returns:
        创建的卡片 message_id

    示例:
        ```python
        async def sse_generator():
            yield {"event": "message", "data": {"content": "Hello"}}
            yield {"event": "message", "data": {"content": " World"}}
            yield {"event": "end", "data": {}}

        card_id = await stream_to_feishu_card(
            feishu_channel, message_id, sse_generator()
        )
        ```
    """

    # 创建 API 适配器
    class FeishuChannelAdapter:
        def __init__(self, channel: Any):
            self.channel = channel

        async def reply_card(self, message_id: str, content: str) -> str | None:
            # 使用 FeishuChannel._reply_card 方法
            return await self.channel._reply_card(message_id, content)

        async def update_card(self, message_id: str, content: str) -> None:
            await self.channel._update_card(message_id, content)

    adapter = FeishuChannelAdapter(feishu_channel)
    bridge = SSEFeishuBridge(adapter, source_message_id, update_interval=update_interval, template=template)

    # 启动并处理流
    await bridge.start()

    try:
        async for event in sse_stream:
            await bridge.on_sse_event(event)
    except Exception as e:
        logger.exception("[stream_to_feishu_card] error processing stream")
        await bridge.abort(str(e))
        raise

    await bridge.finish()
    return bridge.card_message_id


# 兼容性：Streaming Handler 集成


class StreamHandlerAdapter:
    """Streaming Handler 适配器

    如需与 streaming_handler.py 一起使用，通过此适配器连接两者。
    """

    def __init__(
        self,
        bridge: SSEFeishuBridge,
        text_callback: Callable[[str], None] | None = None,
    ):
        self.bridge = bridge
        self.text_callback = text_callback

    async def on_text_delta(self, delta: str, full_text: str) -> None:
        """StreamingHandler 文本增量回调"""
        event = SSEEvent(event_type=SSEEventType.MESSAGE, data={"content": delta})
        await self.bridge.on_sse_event(event)

        if self.text_callback:
            self.text_callback(full_text)

    async def on_complete(self, full_text: str) -> None:
        """StreamingHandler 完成回调"""
        await self.bridge.finish()

    async def on_error(self, error: Exception) -> None:
        """StreamingHandler 错误回调"""
        event = SSEEvent(event_type=SSEEventType.ERROR, data={"message": str(error)})
        await self.bridge.on_sse_event(event)  # type: ignore[arg-type]
        await self.bridge.abort(str(error))
