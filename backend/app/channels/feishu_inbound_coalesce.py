"""Short-window coalesce for Feishu inbound chat + media events.

Feishu delivers image/file and follow-up text as **separate**
``im.message.receive_v1`` events. Without a debounce window the agent would
see the image alone, then a second turn for the caption — losing multimodal
context (same failure mode WeCom already solved with text batching).

Commands bypass the window: any pending buffer is flushed first, then the
command is published immediately.

When text flushes alone (media still in flight / delivered late), we keep a
short sticky caption so a subsequent file/image event can re-attach the
question instead of publishing a caption-less media turn.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.channels.message_bus import InboundMessage, InboundMessageType

logger = logging.getLogger(__name__)

# Matches FeishuChannel._prepare_inbound(msg_id, inbound).
PublishFn = Callable[[str, InboundMessage], Awaitable[None]]


@dataclass
class _RecentTextFlush:
    text: str
    primary_msg_id: str
    thread_ts: str = ""
    message_ids: list[str] = field(default_factory=list)
    flushed_at: float = 0.0


class FeishuInboundCoalescer:
    """Merge near-simultaneous inbound chunks for the same chat/user/account."""

    def __init__(
        self,
        *,
        delay_seconds: float = 0.6,
        text_grace_seconds: float | None = None,
        sticky_seconds: float | None = None,
        publish: PublishFn | None = None,
    ) -> None:
        self._delay_seconds = max(0.05, float(delay_seconds or 0.6))
        # Text often arrives before the companion file event finishes downloading.
        # Hold text-only batches longer so media can merge; once files are present
        # we fall back to the short delay.
        grace = text_grace_seconds
        if grace is None:
            grace = max(self._delay_seconds, 4.0)
        self._text_grace_seconds = max(self._delay_seconds, float(grace or 0.0))
        sticky = sticky_seconds
        if sticky is None:
            sticky = max(self._text_grace_seconds, 6.0)
        self._sticky_seconds = max(0.0, float(sticky or 0.0))
        self._publish = publish
        self._pending: dict[str, InboundMessage] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._primary_msg_ids: dict[str, str] = {}
        self._recent_text: dict[str, _RecentTextFlush] = {}

    def set_publish(self, publish: PublishFn) -> None:
        self._publish = publish

    @staticmethod
    def batch_key(msg: InboundMessage) -> str:
        aid = str(msg.account_id or "").strip() or "primary"
        return f"{aid}:{msg.channel_name}:{msg.chat_id}:{msg.user_id}"

    def _flush_delay_for(self, msg: InboundMessage) -> float:
        if msg.files:
            return self._delay_seconds
        return self._text_grace_seconds

    def _remember_text_only(self, key: str, msg: InboundMessage, msg_id: str) -> None:
        if msg.files or not (msg.text or "").strip():
            self._recent_text.pop(key, None)
            return
        if self._sticky_seconds <= 0:
            return
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        ids = [str(x) for x in (meta.get("message_ids") or []) if str(x or "").strip()]
        primary = str(msg_id or meta.get("message_id") or "").strip()
        if primary and primary not in ids:
            ids.insert(0, primary)
        self._recent_text[key] = _RecentTextFlush(
            text=str(msg.text or ""),
            primary_msg_id=primary,
            thread_ts=str(msg.thread_ts or ""),
            message_ids=ids,
            flushed_at=time.monotonic(),
        )

    def _adopt_sticky_text(self, key: str, msg: InboundMessage) -> bool:
        """Re-attach a just-flushed caption onto a late media-only chunk."""
        recent = self._recent_text.get(key)
        if recent is None:
            return False
        if time.monotonic() - float(recent.flushed_at) > self._sticky_seconds:
            self._recent_text.pop(key, None)
            return False
        if not msg.files:
            return False
        current = str(msg.text or "").strip()
        # Don't overwrite a real new caption; only fill empty / tiny placeholders.
        if current and len(current) > 24:
            return False
        sticky = str(recent.text or "").strip()
        if not sticky:
            self._recent_text.pop(key, None)
            return False
        msg.text = sticky if not current else f"{sticky}\n{current}"
        if recent.thread_ts and not msg.thread_ts:
            msg.thread_ts = recent.thread_ts
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        ids = list(meta.get("message_ids") or [])
        for mid in recent.message_ids:
            if mid and mid not in ids:
                ids.insert(0, mid)
        msg.metadata = {
            **meta,
            "message_ids": ids,
            "message_id": str(meta.get("message_id") or recent.primary_msg_id or ""),
            "sticky_text_from": recent.primary_msg_id,
        }
        self._recent_text.pop(key, None)
        return True

    async def accept(self, msg: InboundMessage, *, source_message_id: str) -> None:
        """Buffer a CHAT message, or flush+publish a COMMAND immediately."""
        if msg.msg_type == InboundMessageType.COMMAND:
            await self._flush_key(self.batch_key(msg), force=True)
            await self._do_publish(msg, source_message_id)
            return

        if self._delay_seconds <= 0 and self._text_grace_seconds <= 0:
            await self._do_publish(msg, source_message_id)
            return

        key = self.batch_key(msg)
        sticky_adopted = False
        if self._pending.get(key) is None:
            sticky_adopted = self._adopt_sticky_text(key, msg)
            if sticky_adopted:
                try:
                    from app.channels.feishu_inbound_trace_log import log_feishu_inbound_trace

                    log_feishu_inbound_trace(
                        "粘贴晚到媒体",
                        account_id=str(msg.account_id or ""),
                        chat_id=str(msg.chat_id or ""),
                        msg_id=str(source_message_id or ""),
                        text_preview=(msg.text or "")[:120],
                        files=len(msg.files or []),
                        batch_key=key[:80],
                    )
                except Exception:
                    pass

        existing = self._pending.get(key)
        merged = existing is not None
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
        pending = self._pending[key]
        delay = self._flush_delay_for(pending)
        self._tasks[key] = asyncio.create_task(self._delayed_flush(key, delay))
        try:
            from app.channels.feishu_inbound_trace_log import log_feishu_inbound_trace

            log_feishu_inbound_trace(
                "合入缓冲" if merged else "进入缓冲",
                account_id=str(msg.account_id or ""),
                chat_id=str(msg.chat_id or ""),
                msg_id=str(source_message_id or ""),
                text_len=len(msg.text or ""),
                chunk_files=len(msg.files or []),
                pending_text_len=len(pending.text or ""),
                pending_files=len(pending.files or []),
                flush_delay_s=round(float(delay), 3),
                sticky_adopted=sticky_adopted,
                batch_key=key[:80],
            )
        except Exception:
            pass

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

    async def _delayed_flush(self, key: str, delay: float) -> None:
        me = asyncio.current_task()
        try:
            await asyncio.sleep(max(0.0, float(delay)))
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
        self._remember_text_only(key, msg, msg_id)
        logger.info(
            "[FeishuCoalesce] flush key=%s text_len=%d files=%d force=%s",
            key,
            len(msg.text or ""),
            len(msg.files or []),
            force,
        )
        try:
            from app.channels.feishu_inbound_trace_log import log_feishu_inbound_trace

            meta = msg.metadata if isinstance(msg.metadata, dict) else {}
            file_names = []
            for f in list(msg.files or [])[:6]:
                if isinstance(f, dict):
                    file_names.append(str(f.get("filename") or f.get("path") or "")[:80])
            log_feishu_inbound_trace(
                "冲刷发布",
                account_id=str(msg.account_id or ""),
                chat_id=str(msg.chat_id or ""),
                msg_id=str(msg_id or ""),
                force=bool(force),
                text_preview=(msg.text or "")[:120],
                text_len=len(msg.text or ""),
                files=len(msg.files or []),
                filenames=file_names,
                message_ids=list(meta.get("message_ids") or [])[:8],
                batch_key=key[:80],
            )
        except Exception:
            pass
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
