"""User profile injection: whole USER.md document, no scaffold strip on inject."""

from __future__ import annotations

from evoflow.assets.user_profile_dims import (
    USER_PROFILE_FILENAME,
    _strip_placeholder_body,
    build_user_profile_injection_block,
    default_user_profile_md,
)


def test_strip_drops_pending_fill_scaffold_and_frontmatter() -> None:
    """Strip helper still used for UI \"is filled?\" — not for injection."""
    raw = """---
last_used_at: 2026-10-20T09:20:29Z
use_count: 3
---

## Agent 补充

- （本对话中用户尚未提供身份信息，待补：称呼、常用语言/时区/城市、职业角色）
"""
    assert _strip_placeholder_body(raw, filename=USER_PROFILE_FILENAME) == ""


def test_strip_keeps_real_name() -> None:
    raw = """# 用户画像

## 基本信息
银泰

## 语言与时区
中文；UTC+8 / 上海
"""
    filled = _strip_placeholder_body(raw, filename=USER_PROFILE_FILENAME)
    assert "银泰" in filled
    assert "UTC+8" in filled


def test_injection_loads_full_document_including_scaffold(monkeypatch) -> None:
    body = default_user_profile_md().rstrip() + "\n\n## Agent 补充\n- 银泰\n- 禁用 mini\n"
    monkeypatch.setattr(
        "evoflow.assets.user_profile_dims.read_user_profile_raw",
        lambda **_: body,
    )
    text = build_user_profile_injection_block(scope="full")
    assert "<user_profile>" in text
    assert "填写后会注入" in text  # scaffold kept
    assert "银泰" in text
    assert "禁用 mini" in text
    assert text.count("<user_profile>") == 1


def test_injection_emits_default_when_raw_empty(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.assets.user_profile_dims.read_user_profile_raw",
        lambda **_: "",
    )
    text = build_user_profile_injection_block(scope="full")
    assert "<user_profile>" in text
    assert "用户画像" in text


def test_resolve_scope_is_global_full() -> None:
    from evoflow.assets.user_profile_dims import resolve_profile_injection_scope

    assert resolve_profile_injection_scope(agent_name="douyin-analyst") == "full"
    assert resolve_profile_injection_scope(agent_name="main") == "full"
