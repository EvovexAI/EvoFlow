"""DingTalk channel unit tests (offline — no network)."""

from __future__ import annotations

from types import SimpleNamespace

from app.channels.dingtalk import (
    DingtalkChannel,
    _coerce_set,
    _normalize_markdown,
    _truthy,
)
from app.channels.message_bus import MessageBus


def _make_channel(config: dict) -> DingtalkChannel:
    return DingtalkChannel(bus=MessageBus(), config=config)


# -- value coercion ---------------------------------------------------------


def test_coerce_set():
    assert _coerce_set(None) == set()
    assert _coerce_set("") == set()
    assert _coerce_set("a,b,c") == {"a", "b", "c"}
    assert _coerce_set("  a , b ") == {"a", "b"}
    assert _coerce_set(["a", "b"]) == {"a", "b"}
    assert _coerce_set(123) == {"123"}


def test_truthy():
    assert _truthy(True) is True
    assert _truthy("true") is True
    assert _truthy("1") is True
    assert _truthy("yes") is True
    assert _truthy("on") is True
    assert _truthy(False) is False
    assert _truthy("false") is False
    assert _truthy("0") is False
    assert _truthy("") is False


# -- user allowlist ---------------------------------------------------------


def test_user_allowed_empty_means_allow_all():
    ch = _make_channel({})
    assert ch._is_user_allowed("s1", "staff1") is True


def test_user_allowed_wildcard():
    ch = _make_channel({"allowed_users": "*"})
    assert ch._is_user_allowed("s1", "staff1") is True


def test_user_allowed_match():
    ch = _make_channel({"allowed_users": "staff1"})
    assert ch._is_user_allowed("other", "staff1") is True
    assert ch._is_user_allowed("other", "staff2") is False


# -- group trigger ----------------------------------------------------------


def test_group_process_when_no_mention_required():
    ch = _make_channel({})
    assert ch._should_process_group(None, "cid1") is True


def test_group_process_require_mention_not_mentioned():
    ch = _make_channel({"require_mention": True})
    msg = SimpleNamespace(is_in_at_list=False)
    assert ch._should_process_group(msg, "cid1") is False


def test_group_process_require_mention_mentioned():
    ch = _make_channel({"require_mention": True})
    msg = SimpleNamespace(is_in_at_list=True)
    assert ch._should_process_group(msg, "cid1") is True


def test_group_process_free_response_chats():
    ch = _make_channel({"require_mention": True, "free_response_chats": "cid1"})
    msg = SimpleNamespace(is_in_at_list=False)
    assert ch._should_process_group(msg, "cid1") is True
    assert ch._should_process_group(msg, "cid2") is False


def test_group_process_hard_allowlist():
    ch = _make_channel({"allowed_chats": "cid1"})
    assert ch._should_process_group(None, "cid1") is True
    assert ch._should_process_group(None, "cid2") is False


# -- markdown normalization -------------------------------------------------


def test_normalize_markdown_numbered_list():
    text = "line\n1. first\n2. second"
    out = _normalize_markdown(text)
    assert "\n\n1. first" in out


def test_normalize_markdown_code_block_dedent():
    text = "    ```py\n    x = 1\n    ```"
    out = _normalize_markdown(text)
    assert out.startswith("```py")


# -- channel construction ---------------------------------------------------


def test_dingtalk_channel_construction():
    ch = _make_channel({"client_id": "cid", "client_secret": "secret"})
    assert ch.name == "dingtalk"
    assert ch._client_id == "cid"
    assert ch._client_secret == "secret"
    assert ch._require_mention is False


def test_dingtalk_channel_require_mention():
    ch = _make_channel({"require_mention": True})
    assert ch._require_mention is True
