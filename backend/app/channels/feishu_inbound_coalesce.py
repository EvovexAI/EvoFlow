"""Short-window coalesce for Feishu inbound chat + media events.

Feishu delivers image/file and follow-up text as **separate**
``im.message.receive_v1`` events. Without a debounce window the agent would
see the image alone, then a second turn for the caption — losing multimodal
context (same failure mode WeCom already solved with text batching).

Commands bypass the window: any pending buffer is flushed first, then the
command is published immediately.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from app.channels.message_bus import InboundMessage, InboundMessageType

logger = logging.getLogger(__name__)

# Matches FeishuChannel._prepare_inbound(msg_id, inbound).
PublishFn = Callable[[str, InboundMessage], Awaitable[None]]


class FeishuInboundCoalescer:
    """Merge near-simultaneous inbound chunks for the same chat/user/account."""

    def __init__(
        self,
        *,
        delay_seconds: float = 0.6,
        publish: PublishFn | None = None,
    ) -> None:
        self._delay_seconds = max(0.05, float(delay_seconds or 0.6))
        self._publish = publish
        self._pending: dict[str, InboundMessage] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._primary_msg_ids: dict[str, str] = {}

    def set_publish(self, publish: PublishFn) -> None:
        self._publish = publish

    @staticmethod
    def batch_key(msg: InboundMessage) -> str:
        aid = str(msg.account_id or "").strip() or "primary"
        return f"{aid}:{msg.channel_name}:{msg.chat_id}:{msg.user_id}"

    async def accept(self, msg: InboundMessage, *, source_message_id: str) -> None:
        """Buffer a CHAT message, or flush+publish a COMMAND immediately."""
        if msg.msg_type == InboundMessageType.COMMAND:
            await self._flush_key(self.batch_key(msg), force=True)
            await self._do_publish(msg, source_message_id)
            return

        if self._delay_seconds <= 0:
            await self._do_publish(msg, source_message_id)
            return

        key = self.batch_key(msg)
        existing = self._pending.get(key)
        if existing is None:
            self._pending[key] = msg
            self._primary_msg_ids[key] = str(source_message_id or "")
        else:
            self._merge_into(existing, msg)
            # Keep the first chunk's message_id as reply anchor (media-first UX).
            if str(source_message_id or "").strip():
                self._primary_msg_ids.setdefault(key, str(source_message_id))

        prior = self._tasks.get(key)
        if prior and not prior.done():
            prior.cancel()
        self._tasks[key] = asyncio.create_task(self._delayed_flush(key))

    def _merge_into(self, existing: InboundMessage, incoming: InboundMessage) -> None:
        if incoming.text:
            existing.text = (
                f"{existing.text}\n{incoming.text}" if existing.text else incoming.text
            )
        if incoming.files:
            existing.files = list(existing.files or []) + list(incoming.files or [])
        existing_meta = existing.metadata if isinstance(existing.metadata, dict) else {}
        incoming_meta = incoming.metadata if isinstance(incoming.metadata, dict) else {}

        owned = list(existing_meta.get("_owned_temp_paths") or [])
        for path in incoming_meta.get("_owned_temp_paths") or []:
            if path and path not in owned:
                owned.append(path)

        message_ids = list(existing_meta.get("message_ids") or [])
        for mid in incoming_meta.get("message_ids") or []:
            if mid and mid not in message_ids:
                message_ids.append(mid)
        single = str(incoming_meta.get("message_id") or "").strip()
        if single and single not in message_ids:
            message_ids.append(single)

        # Keep the earliest reply anchor / thread_ts (first chunk).
        thread_ts = existing.thread_ts or incoming.thread_ts
        if thread_ts:
            existing.thread_ts = thread_ts

        existing.metadata = {
            **existing_meta,
            **{k: v for k, v in incoming_meta.items() if k not in {"_owned_temp_paths", "message_ids"}},
            "_owned_temp_paths": owned,
            "message_ids": message_ids,
            "message_id": str(existing_meta.get("message_id") or single or ""),
        }
        if incoming.topic_id and not existing.topic_id:
            existing.topic_id = incoming.topic_id

    async def _delayed_flush(self, key: str) -> None:
        me = asyncio.current_task()
        try:
            await asyncio.sleep(self._delay_seconds)
            if self._tasks.get(key) is not me:
                return
            await self._flush_key(key, force=False)
        except asyncio.CancelledError:
            return
        finally:
            if self._tasks.get(key) is me:
                self._tasks.pop(key, None)

    async def _flush_key(self, key: str, *, force: bool) -> None:
        task = self._tasks.get(key)
        if task and not task.done() and force and task is not asyncio.current_task():
            task.cancel()
            self._tasks.pop(key, None)

        msg = self._pending.pop(key, None)
        msg_id = self._primary_msg_ids.pop(key, "")
        if not msg:
            return
        if not msg_id:
            meta = msg.metadata if isinstance(msg.metadata, dict) else {}
            msg_id = str(meta.get("message_id") or msg.thread_ts or "")
        logger.info(
            "[FeishuCoalesce] flush key=%s text_len=%d files=%d force=%s",
            key,
            len(msg.text or ""),
            len(msg.files or []),
            force,
        )
        await self._do_publish(msg, msg_id)

    async def _do_publish(self, msg: InboundMessage, source_message_id: str) -> None:
        if self._publish is None:
            logger.warning("[FeishuCoalesce] no publish callback; dropping inbound")
            return
        await self._publish(msg, str(source_message_id or ""))

    async def flush_all(self) -> None:
        """Flush every pending batch (channel stop / tests)."""
        for key in list(self._pending.keys()):
            await self._flush_key(key, force=True)
