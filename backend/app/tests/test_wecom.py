"""WeCom channel unit tests (offline — no network)."""

from __future__ import annotations

from app.channels.message_bus import MessageBus
from app.channels.wecom import (
    WecomChannel,
    _apply_file_size_limits,
    _entry_matches,
    _extract_text,
    _response_error,
    _split_text,
)

# -- allowlist matching -----------------------------------------------------


def test_entry_matches_basic():
    assert _entry_matches(["abc"], "abc") is True
    assert _entry_matches(["abc"], "ABC") is True  # case-insensitive
    assert _entry_matches(["abc"], "abd") is False
    assert _entry_matches(["*"], "anything") is True
    assert _entry_matches(["wecom:user:foo"], "foo") is True
    assert _entry_matches(["user:foo"], "foo") is True
    assert _entry_matches(["group:g1"], "g1") is True


# -- DM / group policy ------------------------------------------------------


def test_dm_policy_intake():
    ch = WecomChannel(bus=MessageBus(), config={})
    ch._dm_policy = "open"
    assert ch._is_dm_intake_allowed("u1") is True
    ch._dm_policy = "disabled"
    assert ch._is_dm_intake_allowed("u1") is False
    ch._dm_policy = "allowlist"
    ch._allow_from = ["u1"]
    assert ch._is_dm_intake_allowed("u1") is True
    assert ch._is_dm_intake_allowed("u2") is False
    ch._dm_policy = "pairing"
    assert ch._is_dm_intake_allowed("u1") is True


def test_group_policy():
    ch = WecomChannel(bus=MessageBus(), config={})
    ch._group_policy = "disabled"
    assert ch._is_group_allowed("g1", "u1") is False
    ch._group_policy = "open"
    assert ch._is_group_allowed("g1", "u1") is True
    ch._group_policy = "allowlist"
    ch._group_allow_from = ["g1"]
    assert ch._is_group_allowed("g1", "u1") is True
    assert ch._is_group_allowed("g2", "u1") is False


# -- text splitting ---------------------------------------------------------


def test_split_text_short():
    assert _split_text(WecomChannel(bus=MessageBus(), config={}), "hello") == ["hello"]


def test_split_text_long():
    text = "x" * 4001
    chunks = _split_text(WecomChannel(bus=MessageBus(), config={}), text)
    assert len(chunks) == 2
    assert all(len(c) <= 4000 for c in chunks)
    assert "".join(chunks) == text


def test_split_text_lines():
    lines = ["a" * 3000, "b" * 3000]
    text = "\n".join(lines)
    chunks = _split_text(WecomChannel(bus=MessageBus(), config={}), text)
    assert len(chunks) == 2
    assert "".join(chunks) == text


# -- media size limits ------------------------------------------------------


def test_apply_file_size_limits_image_too_big():
    r = _apply_file_size_limits(11 * 1024 * 1024, "image", "image/png")
    assert r["rejected"] is False
    assert r["downgraded"] is True
    assert r["final_type"] == "file"


def test_apply_file_size_limits_over_absolute():
    r = _apply_file_size_limits(21 * 1024 * 1024, "file", "application/pdf")
    assert r["rejected"] is True
    assert r["reject_reason"]


def test_apply_file_size_limits_voice_unsupported_mime():
    r = _apply_file_size_limits(1024, "voice", "audio/mp3")
    assert r["downgraded"] is True
    assert r["final_type"] == "file"


def test_apply_file_size_limits_ok():
    r = _apply_file_size_limits(1024, "image", "image/png")
    assert r["rejected"] is False
    assert r["downgraded"] is False
    assert r["final_type"] == "image"


# -- response error ---------------------------------------------------------


def test_response_error():
    assert _response_error({"errcode": 0}) is None
    assert _response_error({}) is None
    assert _response_error({"errcode": 40013, "errmsg": "invalid"}) == "WeCom errcode 40013: invalid"


# -- inbound text extraction ------------------------------------------------


def test_extract_text_plain():
    body = {"msgtype": "text", "text": {"content": "你好"}}
    text, _reply = _extract_text(body)
    assert text == "你好"


def test_extract_text_mixed():
    body = {
        "msgtype": "mixed",
        "mixed": {"msg_item": [{"msgtype": "text", "text": {"content": "a"}}, {"msgtype": "text", "text": {"content": "b"}}]},
    }
    text, _reply = _extract_text(body)
    assert text == "a\nb"


def test_extract_text_quote():
    body = {
        "msgtype": "text",
        "text": {"content": "回答"},
        "quote": {"msgtype": "text", "text": {"content": "问题"}},
    }
    _text, reply = _extract_text(body)
    assert reply == "问题"


# -- channel construction (no network) --------------------------------------


def test_wecom_channel_construction():
    ch = WecomChannel(bus=MessageBus(), config={"bot_id": "b1", "secret": "s1"})
    assert ch.name == "wecom"
    assert ch._bot_id == "b1"
    assert ch._secret == "s1"
