"""Tests for invocation_kind resolution labels."""

from __future__ import annotations

from evoflow.observability.invocation_kinds import (
    infer_invocation_kind_from_prompt,
    label_zh,
    resolve_invocation_kind,
)


def test_infer_title_from_prompt():
    text = "Generate a concise title (max 6 words) for this conversation.\nUser: hi\nAssistant: hello"
    assert infer_invocation_kind_from_prompt(text) == "title"


def test_infer_mission_state_from_prompt():
    text = '{"primary_objective": "x", "intent_hint": "chat", "active_subproblems": []}'
    assert infer_invocation_kind_from_prompt(text) == "mission_state"


def test_resolve_prefers_explicit_kind():
    assert (
        resolve_invocation_kind(
            vendor_row={"invocation_kind": "memory"},
            payload_row={"invocation_kind": "main"},
        )
        == "memory"
    )


def test_resolve_title_label():
    assert label_zh("title") == "会话标题"
    assert label_zh("mission_state") == "意图 / 任务态分析"
