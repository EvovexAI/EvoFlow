"""IM / channel outbound must use content only — never reasoning field or thinking blocks."""

from __future__ import annotations

from app.channels.manager import _extract_response_text, _extract_text_content, _latest_im_stream_buffer
from evoflow.persistence.chat_message_content import (
    pack_payload,
    plain_text,
    split_thinking_from_content,
    visible_body_text,
)


def test_visible_body_ignores_reasoning_field():
    payload = {
        "content": "飞书可见正文",
        "reasoning": "Let me think about the seventh link internally…",
    }
    assert visible_body_text(payload) == "飞书可见正文"
    assert "Let me" not in visible_body_text(payload)
    # plain_text may fall back to reasoning only when content empty
    assert plain_text({"content": "", "reasoning": "only think"}) == "only think"
    assert plain_text(payload) == "飞书可见正文"


def test_visible_body_skips_thinking_blocks():
    payload = {
        "content": [
            {"type": "thinking", "thinking": "internal monologue"},
            {"type": "text", "text": "给用户的回复"},
        ]
    }
    assert visible_body_text(payload) == "给用户的回复"


def test_split_thinking_from_content_moves_blocks():
    body, reason = split_thinking_from_content(
        [
            {"type": "thinking", "thinking": "plan A"},
            {"type": "text", "text": "hello"},
        ]
    )
    assert body == "hello"
    assert reason == "plan A"


def test_pack_payload_stores_thinking_in_reasoning():
    packed = pack_payload(
        role="assistant",
        content=[
            {"type": "thinking", "thinking": "scratch"},
            {"type": "text", "text": "对外回复"},
        ],
        raw={"additional_kwargs": {}},
    )
    assert packed.get("content") == "对外回复"
    assert packed.get("reasoning") == "scratch"


def test_extract_text_content_skips_thinking_blocks():
    text = _extract_text_content(
        [
            {"type": "thinking", "thinking": "hidden"},
            {"type": "text", "text": "visible"},
        ]
    )
    assert text == "visible"
    assert "hidden" not in text


def test_extract_response_text_prefers_visible_ai_content():
    result = {
        "messages": [
            {"type": "human", "content": "hi"},
            {
                "type": "ai",
                "content": [
                    {"type": "thinking", "thinking": "Let me poll again"},
                    {"type": "text", "text": "正在处理你的链接"},
                ],
            },
        ]
    }
    assert _extract_response_text(result) == "正在处理你的链接"


def test_latest_im_buffer_not_joined_mid_turn():
    buffers = {
        "m1": "用户新链接，第七条… Let me check job status",
        "m2": "我收到了，正在处理第七个任务",
    }
    assert _latest_im_stream_buffer(buffers) == "我收到了，正在处理第七个任务"
