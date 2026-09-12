"""Feishu Stream Bridge — 子任务流式输出桥接器

将子任务（subagent/task_tool）的 stream_writer 输出桥接到飞书MessageBus，
实现子任务执行过程的实时流式推送到飞书。

使用场景:
    1. Lead Agent 委派子任务后，子任务的执行进度实时推送到飞书
    2. 工具调用过程实时显示在飞书卡片中
    3. 子任务完成结果自动推送

使用示例:
    ```python
    # 在 task_tool.py 或 execution.py 中
    from app.channels.feishu_stream_bridge import get_feishu_stream_bridge

    bridge = get_feishu_stream_bridge()
    if bridge:
        await bridge.on_subtask_event({
            "type": "task_started",
            "task_id": "subtask-001",
            "description": "编写代码",
        })
    ```
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class SubtaskStreamState:
    """子任务流式状态"""

    task_id: str
    card_message_id: str | None = None  # 飞书卡片消息ID
    accumulated_text: str = ""  # 累积的文本内容
    tool_calls: list[dict] = field(default_factory=list)  # 工具调用列表
    is_final: bool = False  # 是否已完成
    last_update_time: float = 0.0  # 上次更新时间
    event_count: int = 0  # 接收到的子任务事件计数
    push_count: int = 0  # 推送到飞书次数
    last_text_len: int = 0  # 上次推送文本长度


class FeishuStreamBridge:
    """飞书流式桥接器

    核心职责:
        1. 接收子任务的 stream_writer 事件
        2. 转换为飞书卡片更新
        3. 通过 MessageBus 推送到飞书
        4. 控制更新频率（节流）
    """

    def __init__(
        self,
        message_bus: Any,  # MessageBus 实例
        *,
        update_interval: float = 0.0,  # 更新间隔（秒），0表示不节流
        min_content_delta: int = 0,  # 最小内容变化字符数，0表示有变化就更新
        enable_throttle: bool = False,  # 关闭节流
    ):
        self.bus = message_bus
        self.update_interval = update_interval
        self.min_content_delta = min_content_delta
        self.enable_throttle = enable_throttle

        # 状态管理
        self._subtask_states: dict[str, SubtaskStreamState] = {}
        self._chat_id: str | None = None  # 当前聊天ID（从上下文获取）
        self._thread_ts: str | None = None  # 当前线程时间戳

    def set_context(self, chat_id: str, thread_ts: str | None = None) -> None:
        """设置飞书上下文（聊天ID和线程时间戳）"""
        self._chat_id = chat_id
        self._thread_ts = thread_ts
        logger.info(
            "[FeishuStreamBridge] context set: chat_id=%s, thread_ts=%s",
            chat_id,
            thread_ts,
        )

    async def on_subtask_event(self, event: dict[str, Any]) -> None:
        """处理子任务事件

        Args:
            event: 子任务事件字典，包含 type 字段标识事件类型
        """
        event_type = event.get("type", "unknown")
        task_id = event.get("task_id", "")

        if not task_id:
            logger.warning("[FeishuStreamBridge] event missing task_id, ignoring")
            return

        # 获取或创建子任务状态
        state = self._subtask_states.get(task_id)
        if not state:
            state = SubtaskStreamState(task_id=task_id)
            self._subtask_states[task_id] = state
        state.event_count += 1
        logger.info(
            "[SubtaskStream] event_in: task_id=%s, event_type=%s, event_count=%d",
            task_id,
            event_type,
            state.event_count,
        )

        # 处理不同类型的事件
        if event_type == "task_started":
            await self._handle_task_started(state, event)
        elif event_type == "task_running":
            await self._handle_task_running(state, event)
        elif event_type == "task_completed":
            await self._handle_task_completed(state, event)
        elif event_type == "task_failed":
            await self._handle_task_failed(state, event)
        else:
            logger.debug("[FeishuStreamBridge] unknown event type: %s", event_type)

    async def _handle_task_started(self, state: SubtaskStreamState, event: dict) -> None:
        """处理子任务开始事件"""
        description = event.get("description", "子任务")
        subagent_type = event.get("subagent_type", "unknown")

        state.accumulated_text = f"🚀 **子任务启动**: {description}\n🤖 **执行器**: {subagent_type}\n⏳ **状态**: 执行中...\n\n"

        logger.info(
            "[SubtaskStream] task_started: task_id=%s, description=%s",
            state.task_id,
            description,
        )

        await self._push_to_feishu(state, is_final=False)

    async def _handle_task_running(self, state: SubtaskStreamState, event: dict) -> None:
        """处理子任务运行事件（流式更新）"""
        # 提取消息内容
        messages = event.get("messages", [])
        appended_chars = 0
        for msg in messages:
            msg_type = msg.get("type", "")
            content = msg.get("content", "")

            if msg_type == "ai":
                # AI消息：追加文本
                if isinstance(content, str):
                    state.accumulated_text += content
                    appended_chars += len(content)
                elif isinstance(content, list):
                    # 内容块列表
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            txt = block.get("text", "")
                            state.accumulated_text += txt
                            appended_chars += len(txt) if isinstance(txt, str) else 0

            elif msg_type == "tool":
                # 工具消息：记录工具调用
                tool_name = msg.get("name", "unknown")
                tool_status = "✅" if not msg.get("error") else "❌"
                state.tool_calls.append(
                    {
                        "name": tool_name,
                        "status": tool_status,
                        "content": content[:200] if isinstance(content, str) else "",
                    }
                )
        logger.info(
            "[SubtaskStream] task_running: task_id=%s, messages=%d, appended_chars=%d, total_text_len=%d, tool_calls=%d",
            state.task_id,
            len(messages) if isinstance(messages, list) else 0,
            appended_chars,
            len(state.accumulated_text),
            len(state.tool_calls),
        )

        # 节流检查
        if not await self._should_update(state):
            return

        await self._push_to_feishu(state, is_final=False)

    async def _handle_task_completed(self, state: SubtaskStreamState, event: dict) -> None:
        """处理子任务完成事件"""
        result = event.get("result", "")

        state.accumulated_text += f"\n\n✅ **子任务完成**\n📝 **结果**: {result[:500] if result else '无'}\n"
        state.is_final = True

        logger.info(
            "[SubtaskStream] task_completed: task_id=%s, final_text_len=%d, push_count=%d",
            state.task_id,
            len(state.accumulated_text),
            state.push_count,
        )

        await self._push_to_feishu(state, is_final=True)

        # 清理状态
        self._subtask_states.pop(state.task_id, None)

    async def _handle_task_failed(self, state: SubtaskStreamState, event: dict) -> None:
        """处理子任务失败事件"""
        error = event.get("error", "未知错误")

        state.accumulated_text += f"\n\n❌ **子任务失败**\n🔥 **错误**: {error[:500]}\n"
        state.is_final = True

        logger.warning(
            "[SubtaskStream] task_failed: task_id=%s, error=%s, text_len=%d, push_count=%d",
            state.task_id,
            error,
            len(state.accumulated_text),
            state.push_count,
        )

        await self._push_to_feishu(state, is_final=True)

        # 清理状态
        self._subtask_states.pop(state.task_id, None)

    async def _should_update(self, state: SubtaskStreamState) -> bool:
        """检查是否应该更新（节流控制）"""
        if not self.enable_throttle:
            return True

        import time

        now = time.monotonic()
        time_since_last = now - state.last_update_time

        if time_since_last < self.update_interval:
            return False

        return True

    async def _push_to_feishu(self, state: SubtaskStreamState, is_final: bool = False) -> None:
        """推送到飞书"""
        if not self._chat_id:
            logger.warning("[FeishuStreamBridge] no chat_id set, skipping push")
            return

        try:
            from app.channels.message_bus import OutboundMessage

            # 构建工具调用信息
            tool_info = ""
            if state.tool_calls:
                tool_lines = [
                    "\n\n🔧 **工具调用**:",
                ]
                for tc in state.tool_calls[-5:]:  # 只显示最近5个
                    tool_lines.append(f"{tc['status']} {tc['name']}")
                tool_info = "\n".join(tool_lines)

            # 完整消息文本
            text = state.accumulated_text + tool_info
            prev_len = state.last_text_len

            # 发布到MessageBus
            outbound = OutboundMessage(
                channel_name="feishu",
                chat_id=self._chat_id,
                thread_id="",  # 子任务不需要LangGraph thread_id
                text=text,
                is_final=is_final,
                thread_ts=self._thread_ts,
                topic_id=None,
                metadata={
                    "task_id": state.task_id,
                    "is_subtask": True,
                },
            )

            await self.bus.publish_outbound(outbound)

            import time

            state.last_update_time = time.monotonic()
            state.push_count += 1
            state.last_text_len = len(text)

            logger.info(
                "[SubtaskStream] push_out: task_id=%s, push_count=%d, prev_text_len=%d, text_len=%d, delta=%d, is_final=%s, thread_ts=%s",
                state.task_id,
                state.push_count,
                prev_len,
                len(text),
                max(0, len(text) - prev_len),
                is_final,
                self._thread_ts,
            )

        except Exception:
            logger.exception(
                "[FeishuStreamBridge] failed to push to feishu: task_id=%s",
                state.task_id,
            )

    def clear_all_states(self) -> None:
        """清理所有子任务状态"""
        self._subtask_states.clear()
        logger.info("[FeishuStreamBridge] all states cleared")


# 全局单例
_feishu_stream_bridge: FeishuStreamBridge | None = None


def get_feishu_stream_bridge() -> FeishuStreamBridge | None:
    """获取飞书流式桥接器单例"""
    return _feishu_stream_bridge


def init_feishu_stream_bridge(message_bus: Any) -> FeishuStreamBridge:
    """初始化飞书流式桥接器

    Args:
        message_bus: MessageBus 实例

    Returns:
        FeishuStreamBridge 实例
    """
    global _feishu_stream_bridge
    _feishu_stream_bridge = FeishuStreamBridge(
        message_bus=message_bus,
        update_interval=0.2,
        min_content_delta=0,
        enable_throttle=True,
    )
    logger.info("[FeishuStreamBridge] initialized")
    return _feishu_stream_bridge
