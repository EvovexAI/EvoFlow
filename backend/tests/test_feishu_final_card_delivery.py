"""Feishu final delivery: plain text reply; card body strips md images."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from app.channels.feishu import FeishuChannel
from app.channels.message_bus import OutboundMessage


def test_card_body_text_strips_markdown_images() -> None:
    raw = (
        "开场\n\n"
        "![frame](http://127.0.0.1:8768/media/x.jpg)\n\n"
        "这是正文描述。\n"
        "![local](file:///D:/tmp/a.png)\n"
        "结尾"
    )
    body = FeishuChannel._card_body_text(raw)
    assert "127.0.0.1" not in body
    assert "file://" not in body
    assert "这是正文描述" in body
    assert "开场" in body
    assert "结尾" in body


@dataclass
class _FakeFinalHost:
    _running_card_ids: dict[str, str] = field(default_factory=dict)
    _running_card_tasks: dict[str, Any] = field(default_factory=dict)
    _running_card_account_ids: dict[str, str] = field(default_factory=dict)
    _stream_stop_ctx: dict[str, Any] = field(default_factory=dict)
    _last_stream_patch_text: dict[str, str] = field(default_factory=dict)
    _stream_state_ts: dict[str, float] = field(default_factory=dict)
    _recent_final_fingerprint: dict[str, tuple[str, float]] = field(default_factory=dict)
    _claude_code_chat_mode: dict[str, bool] = field(default_factory=dict)
    store: Any = None
    plain_texts: list[str] = field(default_factory=list)
    patch_texts: list[str] = field(default_factory=list)
    deleted_ids: list[str] = field(default_factory=list)

    def _touch_stream_state(self, source_message_id: str) -> None:
        pass

    def _prune_final_fingerprints(self, now: float | None = None) -> None:
        pass

    def _clear_stream_state(self, source_message_id: str) -> None:
        self._running_card_ids.pop(source_message_id, None)

    def _stop_ctx_from_outbound(self, msg: OutboundMessage) -> dict[str, Any] | None:
        return None

    def _resolve_outbound_account_id(self, msg: OutboundMessage) -> str:
        return str(msg.account_id or "")

    def _remember_reply_route(self, *args: Any, **kwargs: Any) -> None:
        pass

    def _prefer_account_id(self, *parts: Any) -> str:
        for p in parts:
            if p is not None and str(p).strip():
                return str(p).strip()
        return ""

    def _is_not_message_sender_error(self, err: Any) -> bool:
        return False

    def _bind_card_sender(self, **kwargs: Any) -> None:
        pass

    async def _add_reaction(self, message_id: str, emoji_type: str = "THUMBSUP") -> None:
        return None

    async def _update_card(self, message_id: str, text: str, **kwargs: Any) -> None:
        self.patch_texts.append(text)

    async def _delete_message(self, message_id: str, *, account_id: str = "") -> bool:
        self.deleted_ids.append(message_id)
        return True

    async def _reply_plain_text(self, message_id: str, text: str, **kwargs: Any) -> str | None:
        self.plain_texts.append(text)
        return "om_final_text"

    async def _reply_card(self, message_id: str, text: str, **kwargs: Any) -> str | None:
        raise AssertionError("plain text path should succeed; card fallback unused")

    async def _ensure_running_card(self, *args: Any, **kwargs: Any) -> str | None:
        return None


@pytest.mark.asyncio
async def test_final_uses_plain_text_and_deletes_placeholder() -> None:
    """Final must not depend on message.patch for the body (placeholder stick bug)."""
    host = _FakeFinalHost()
    host._running_card_ids["om_user"] = "om_running"
    host._running_card_account_ids["om_user"] = "bot-a"
    host._running_card_account_ids["om_running"] = "bot-a"

    msg = OutboundMessage(
        channel_name="feishu",
        chat_id="oc_x",
        thread_id="thread-1",
        text="完整正文应该出现在普通文本消息里",
        is_final=True,
        thread_ts="om_user",
        account_id="bot-a",
    )
    bound = FeishuChannel._send_card_message_locked.__get__(host, _FakeFinalHost)
    await bound(msg, "om_user")

    assert host.plain_texts == ["完整正文应该出现在普通文本消息里"]
    assert host.deleted_ids == ["om_running"]
    assert host.patch_texts == []
    assert len(host._recent_final_fingerprint) == 1
