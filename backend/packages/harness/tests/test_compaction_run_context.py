"""Compaction metadata attached to observability usage_json."""

from __future__ import annotations

from evoflow.observability.compaction_run_context import (
    merge_compaction_into_usage,
    set_compaction_snapshot_for_main_call,
    set_compress_pass_label,
    take_compaction_snapshot,
)


def test_main_call_usage_gets_compaction_snapshot():
    set_compaction_snapshot_for_main_call(
        before_gate_tokens=120_000,
        after_gate_tokens=95_000,
        before_message_count=40,
        after_message_count=18,
        passes=["pass1"],
        note="conversation_fold",
        compacted=True,
    )
    merged = merge_compaction_into_usage({"prompt_tokens": 95000}, invocation_kind="main")
    assert merged is not None
    comp = merged["compaction"]
    assert comp["compaction_before_gate_tokens"] == 120_000
    assert comp["compaction_after_gate_tokens"] == 95_000
    assert comp["compaction_saved_gate_tokens"] == 25_000
    assert comp["compaction_applied"] is True
    assert take_compaction_snapshot() is None


def test_compress_call_gets_pass_label():
    set_compress_pass_label("pass2-aggressive")
    merged = merge_compaction_into_usage({"prompt_tokens": 1344}, invocation_kind="compress")
    assert merged["compaction_pass"] == "pass2-aggressive"


def test_non_main_kind_clears_pending_snapshot():
    set_compaction_snapshot_for_main_call(
        before_gate_tokens=10,
        after_gate_tokens=8,
        before_message_count=2,
        after_message_count=2,
        compacted=True,
    )
    merged = merge_compaction_into_usage({"prompt_tokens": 1}, invocation_kind="memory")
    assert "compaction" not in (merged or {})
    assert take_compaction_snapshot() is None
