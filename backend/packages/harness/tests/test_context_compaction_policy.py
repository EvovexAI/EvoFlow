"""Compaction trigger policy: token threshold + cooldown / cached refold."""

from __future__ import annotations

import time
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.compaction_trigger import (
    CompactionTriggerSnapshot,
    get_compaction_trigger_cache,
    reset_compaction_trigger_cache_for_tests,
)
from evoflow.agents.context_compaction_core import (
    ContextCompactionEngine,
    estimate_gate_tokens,
    estimate_messages_tokens,
)


def setup_function() -> None:
    reset_compaction_trigger_cache_for_tests()


def _fill_messages(n: int, text: str = "word " * 8000) -> list:
    out = []
    for i in range(n):
        if i % 2 == 0:
            out.append(HumanMessage(content=f"user {i} {text}"))
        else:
            out.append(AIMessage(content=f"ai {i} {text}"))
    return out


def test_compress_when_tokens_above_threshold():
    engine = ContextCompactionEngine()
    ctx = 100_000
    msgs = _fill_messages(12)
    assert estimate_messages_tokens(msgs) > 50_000

    assert engine.should_compress(
        msgs,
        thread_id="t1",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
    )


def test_no_compress_when_below_threshold():
    engine = ContextCompactionEngine()
    ctx = 100_000
    msgs = _fill_messages(4, text="y " * 200)
    assert estimate_messages_tokens(msgs) < 50_000

    assert not engine.should_compress(
        msgs,
        thread_id="t1",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
    )


def test_cooldown_blocks_repeat_compress_llm():
    engine = ContextCompactionEngine()
    ctx = 100_000
    msgs = _fill_messages(12, text="a" * 18_000)
    gate_tokens = estimate_gate_tokens(msgs)
    threshold_ratio = 0.30
    aggressive_ratio = 0.92
    assert gate_tokens >= int(ctx * threshold_ratio), gate_tokens
    assert gate_tokens < int(ctx * aggressive_ratio), gate_tokens
    engine.mark_compress_completed("t1", before_gate_tokens=gate_tokens)

    assert not engine.should_compress(
        msgs,
        thread_id="t1",
        context_length=ctx,
        threshold_ratio=threshold_ratio,
        aggressive_ratio=aggressive_ratio,
        compaction_cooldown_seconds=120.0,
        compaction_hysteresis_enabled=True,
    )


def test_cooldown_allows_aggressive_pass():
    engine = ContextCompactionEngine()
    ctx = 100_000
    msgs = _fill_messages(12)
    engine.mark_compress_completed("t1", before_gate_tokens=90_000)

    assert engine.should_compress(
        msgs,
        thread_id="t1",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
        aggressive=True,
        compaction_cooldown_seconds=120.0,
    )


def test_message_count_never_triggers_compress():
    """runtime-aligned: message-count round trigger is disabled (token window only)."""
    engine = ContextCompactionEngine()
    ctx = 100_000
    msgs = _fill_messages(4, text="y " * 200)
    assert estimate_messages_tokens(msgs) < 50_000

    assert engine.should_compress(
        msgs,
        thread_id="t-round",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
        compaction_trigger_message_count=200,
    ) is False

    msgs200 = _fill_messages(200, text="y " * 200)
    assert len(msgs200) == 200
    # Even at/above the configured count, do not trigger without token pressure.
    assert estimate_messages_tokens(msgs200) < 50_000
    assert engine.should_compress(
        msgs200,
        thread_id="t-round",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
        compaction_trigger_message_count=200,
    ) is False


def test_message_count_rearm_disabled_after_fold():
    engine = ContextCompactionEngine()
    ctx = 100_000
    # Keep tokens well under the 50% threshold so only a count-based rearm
    # could have allowed compress (and must not).
    short = "y " * 20
    msgs200 = _fill_messages(200, text=short)
    assert estimate_gate_tokens(msgs200) < 20_000
    engine.mark_compress_completed("t-round", before_gate_tokens=10_000, message_count=200)

    assert not engine.should_compress(
        msgs200,
        thread_id="t-round",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
        compaction_trigger_message_count=200,
    )

    msgs230 = _fill_messages(230, text=short)
    assert estimate_gate_tokens(msgs230) < 20_000
    assert not engine.should_compress(
        msgs230,
        thread_id="t-round",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.85,
        compaction_trigger_message_count=200,
    )


def test_cooldown_expires():
    engine = ContextCompactionEngine()
    ctx = 100_000
    msgs = _fill_messages(12)
    cache = get_compaction_trigger_cache()
    cache._snapshots["t1"] = CompactionTriggerSnapshot(
        run_id="turn-1",
        before_gate_tokens=90_000,
        after_gate_tokens=90_000,
        message_count=len(msgs),
        monotonic_at=time.monotonic() - 200,
    )

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=("turn-2", "lg-new"),
    ):
        assert engine.should_compress(
            msgs,
            thread_id="t1",
            context_length=ctx,
            threshold_ratio=0.50,
            aggressive_ratio=0.85,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
        )
