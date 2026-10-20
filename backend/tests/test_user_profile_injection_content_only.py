"""User profile injection: real facts only; no scaffold / usage essays."""

from __future__ import annotations

from evoflow.assets.user_profile_dims import (
    _strip_placeholder_body,
    build_user_profile_injection_block,
)


def test_strip_drops_pending_fill_scaffold_and_frontmatter() -> None:
    raw = """---
last_used_at: 2026-10-20T09:20:29Z
use_count: 3
---

## Agent 补充

- （本对话中用户尚未提供身份信息，待补：称呼、常用语言/时区/城市、职业角色）
"""
    assert _strip_placeholder_body(raw, filename="basic-info.md") == ""


def test_strip_keeps_real_name() -> None:
    raw = """# 基本信息

## 称呼
银泰

## 语言与时区
中文；UTC+8 / 上海
"""
    filled = _strip_placeholder_body(raw, filename="basic-info.md")
    assert "银泰" in filled
    assert "UTC+8" in filled


def test_injection_empty_when_only_scaffold(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.assets.user_profile_dims.read_user_profile_dimensions",
        lambda **_: {
            "basic-info.md": "",
            "preferences.md": "",
            "persona.md": "",
        },
    )
    monkeypatch.setattr(
        "evoflow.assets.user_profile_dims.ensure_user_profile_files",
        lambda *a, **k: None,
    )
    assert build_user_profile_injection_block(scope="identity") == ""
    assert build_user_profile_injection_block(scope="full") == ""


def test_injection_content_only_no_meta(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.assets.user_profile_dims.read_user_profile_dimensions",
        lambda **_: {
            "basic-info.md": "## 称呼\n银泰",
            "preferences.md": "",
            "persona.md": "",
        },
    )
    monkeypatch.setattr(
        "evoflow.assets.user_profile_dims.ensure_user_profile_files",
        lambda *a, **k: None,
    )
    text = build_user_profile_injection_block(scope="full")
    assert "<user_profile>" in text
    assert "银泰" in text
    assert "<preferences>" not in text  # empty dim omitted
    assert "员工上下文" not in text
    assert "profile_upkeep" not in text
    assert "agent_behavior" not in text
    assert "assets" not in text
    assert "EMPTY" not in text
    assert "待补" not in text


def test_resolve_scope_is_global_full() -> None:
    from evoflow.assets.user_profile_dims import resolve_profile_injection_scope

    assert resolve_profile_injection_scope(agent_name="douyin-analyst") == "full"
    assert resolve_profile_injection_scope(agent_name="main") == "full"
