"""Unit tests for compaction_trigger policy cache."""

from __future__ import annotations

import time
from unittest.mock import patch

from langchain_core.messages import AIMessage

from evoflow.agents.compaction_trigger import (
    CompactionTriggerSnapshot,
    get_compaction_trigger_cache,
    reset_compaction_trigger_cache_for_tests,
)


def setup_function() -> None:
    reset_compaction_trigger_cache_for_tests()


def _big_msgs(n: int = 14) -> list:
    big = "token " * 5000
    return [AIMessage(content=f"{big}{i}") for i in range(n)]


def test_same_turn_blocks_second_compress_during_cooldown() -> None:
    cache = get_compaction_trigger_cache()
    msgs = _big_msgs()
    turn_id = "turn-abc"
    tokens = 80_000

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-hop-1"),
    ):
        cache.record_compress(
            "t-same-run",
            run_id=turn_id,
            before_gate_tokens=tokens,
            after_gate_tokens=tokens,
            message_count=len(msgs),
        )
        decision = cache.evaluate(
            thread_id="t-same-run",
            tokens=tokens,
            message_count=len(msgs),
            min_messages=8,
            context_length=128_000,
            threshold_ratio=0.50,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
            log_phase="test",
        )

    assert decision.same_run is True
    assert decision.allow is False
    assert decision.reason == "same_turn_already_compressed"


def test_new_turn_allows_compress_during_cooldown() -> None:
    cache = get_compaction_trigger_cache()
    msgs = _big_msgs()
    tokens = 80_000

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        side_effect=[("turn-old", "lg-1"), ("turn-new", "lg-2")],
    ):
        cache.record_compress(
            "t-new-run",
            run_id="turn-old",
            before_gate_tokens=tokens,
            after_gate_tokens=tokens,
            message_count=len(msgs),
        )
        decision = cache.evaluate(
            thread_id="t-new-run",
            tokens=tokens,
            message_count=len(msgs),
            min_messages=8,
            context_length=128_000,
            threshold_ratio=0.50,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
            log_phase="test",
        )

    assert decision.same_run is False
    assert decision.allow is True
    assert decision.reason == "over_threshold_new_turn"


def test_same_turn_allows_recompress_over_aggressive_threshold() -> None:
    cache = get_compaction_trigger_cache()
    turn_id = "turn-stable"
    after = 28_000
    # Must clear SAME_TURN_REFILL_RATIO (1.5), not just POST_COMPRESS_REFILL_RATIO (1.22).
    tokens = 42_500
    aggressive = 29_440

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-hop-2"),
    ):
        cache.record_compress(
            "t-aggressive-rearm",
            run_id=turn_id,
            before_gate_tokens=after,
            after_gate_tokens=after,
            message_count=15,
        )
        decision = cache.evaluate(
            thread_id="t-aggressive-rearm",
            tokens=tokens,
            message_count=20,
            min_messages=8,
            context_length=32_000,
            threshold_ratio=0.78,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=0.0,
            log_phase="test",
        )

    assert tokens >= aggressive
    assert tokens >= int(after * 1.5)
    assert decision.same_run is True
    assert decision.allow is True
    assert decision.reason == "same_turn_over_aggressive_threshold"


def test_same_turn_blocks_modest_tool_refill_under_1_5x() -> None:
    """~22% growth after tools must not re-arm compress mid-turn (was thrashing)."""
    cache = get_compaction_trigger_cache()
    turn_id = "turn-stable"
    after = 28_000
    tokens = 34_266  # past 1.22x but under 1.5x
    aggressive = 29_440

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-hop-2"),
    ):
        cache.record_compress(
            "t-modest-refill",
            run_id=turn_id,
            before_gate_tokens=after,
            after_gate_tokens=after,
            message_count=15,
        )
        decision = cache.evaluate(
            thread_id="t-modest-refill",
            tokens=tokens,
            message_count=20,
            min_messages=8,
            context_length=32_000,
            threshold_ratio=0.78,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=0.0,
            log_phase="test",
        )

    assert tokens >= aggressive
    assert tokens >= int(after * 1.22)
    assert tokens < int(after * 1.5)
    assert decision.same_run is True
    assert decision.allow is False
    assert decision.reason == "same_turn_still_hot_no_refill"


def test_same_turn_blocks_recompress_until_refill_past_aggressive() -> None:
    """After compress, staying over 92% is not enough — need refill past after_gate * 1.22."""
    cache = get_compaction_trigger_cache()
    turn_id = "turn-stable"
    after = 25_166
    tokens = 26_306
    refill_floor = int(after * 1.22)

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-hop-2"),
    ):
        cache.record_compress(
            "t-no-double",
            run_id=turn_id,
            before_gate_tokens=27_743,
            after_gate_tokens=after,
            message_count=10,
        )
        decision = cache.evaluate(
            thread_id="t-no-double",
            tokens=tokens,
            message_count=12,
            min_messages=8,
            context_length=26_000,
            threshold_ratio=0.78,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=0.0,
            log_phase="test",
        )

    assert tokens >= int(26_000 * 0.92)
    assert tokens < refill_floor
    assert decision.same_run is True
    assert decision.allow is False
    assert decision.reason == "same_turn_still_hot_no_refill"


def test_db_summary_blocks_recompress_until_refill_even_on_new_turn() -> None:
    cache = get_compaction_trigger_cache()
    turn_a = "turn-a"
    turn_b = "turn-b"
    after = 25_166

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        side_effect=[(turn_a, "lg-a"), (turn_b, "lg-b")],
    ), patch(
        "evoflow.agents.compaction_trigger._session_has_compaction_summary",
        return_value=True,
    ):
        cache.record_compress(
            "t-db-refill",
            run_id=turn_a,
            before_gate_tokens=27_743,
            after_gate_tokens=after,
            message_count=10,
            session_key="agent:main:test",
        )
        decision = cache.evaluate(
            thread_id="t-db-refill",
            tokens=26_306,
            message_count=12,
            min_messages=8,
            context_length=26_000,
            threshold_ratio=0.78,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=0.0,
            session_key="agent:main:test",
            log_phase="test",
        )

    assert decision.allow is False
    assert decision.reason == "summary_present_awaiting_refill"


def test_same_turn_blocks_refill_after_tool_hops() -> None:
    cache = get_compaction_trigger_cache()
    after = 50_000
    turn_id = "turn-stable"

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-hop-2"),
    ):
        cache.record_compress(
            "t-refill",
            run_id=turn_id,
            before_gate_tokens=after,
            after_gate_tokens=after,
            message_count=14,
        )
        refilled = 65_000
        assert refilled >= int(after * 1.22)
        assert refilled >= int(128_000 * 0.50)
        decision = cache.evaluate(
            thread_id="t-refill",
            tokens=refilled,
            message_count=18,
            min_messages=8,
            context_length=128_000,
            threshold_ratio=0.50,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
            log_phase="test",
        )

    assert decision.allow is False
    assert decision.reason == "same_turn_already_compressed"


def test_refill_only_across_turns() -> None:
    cache = get_compaction_trigger_cache()
    after = 50_000
    refilled = int(after * 1.22) + 1000

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        side_effect=[("turn-a", "lg-a"), ("turn-b", "lg-b")],
    ):
        cache.record_compress(
            "t-refill",
            run_id="turn-a",
            before_gate_tokens=after,
            after_gate_tokens=after,
            message_count=14,
        )
        decision = cache.evaluate(
            thread_id="t-refill",
            tokens=refilled,
            message_count=18,
            min_messages=8,
            context_length=128_000,
            threshold_ratio=0.50,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
            log_phase="test",
        )

    assert decision.allow is True
    assert decision.reason == "post_compress_refill"


def test_cooldown_expires_still_blocks_same_turn() -> None:
    """Same user turn stays blocked even after cooldown timer expires."""
    cache = get_compaction_trigger_cache()
    cache._snapshots["t-expired"] = CompactionTriggerSnapshot(
        run_id="turn-old",
        before_gate_tokens=90_000,
        after_gate_tokens=90_000,
        message_count=12,
        monotonic_at=time.monotonic() - 200,
    )

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=("turn-old", "lg-x"),
    ):
        decision = cache.evaluate(
            thread_id="t-expired",
            tokens=80_000,
            message_count=12,
            min_messages=8,
            context_length=100_000,
            threshold_ratio=0.50,
            aggressive_ratio=0.85,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
            log_phase="test",
        )

    assert decision.in_cooldown is False
    assert decision.allow is False
    assert decision.reason == "same_turn_already_compressed"


def test_compress_in_flight_does_not_block_gate_inside_active_pipeline() -> None:
    """try_acquire at pipeline entry must not cause evaluate() to deny the owner."""
    cache = get_compaction_trigger_cache()
    assert cache.try_acquire_compress("t-inflight") is True
    try:
        with patch(
            "evoflow.agents.compaction_trigger.resolve_turn_run_id",
            return_value=("turn-a", "lg-a"),
        ):
            decision = cache.evaluate(
                thread_id="t-inflight",
                tokens=30_000,
                message_count=10,
                min_messages=8,
                context_length=32_000,
                threshold_ratio=0.78,
                aggressive_ratio=0.92,
                compaction_cooldown_seconds=0.0,
                compaction_hysteresis_enabled=True,
                log_phase="test",
            )
        assert decision.allow is True
        assert decision.reason == "over_threshold"
    finally:
        cache.release_compress("t-inflight")


def test_resolve_turn_run_id_prefers_latest_user_run_id() -> None:
    from evoflow.agents.compaction_trigger import resolve_turn_run_id

    with patch(
        "evoflow.agents.compaction_trigger.run_id_from_context",
        return_value="lg-hop-volatile",
    ), patch(
        "evoflow.persistence.chat_message_repositories.latest_user_run_id",
        return_value="user-turn-stable",
    ), patch(
        "evoflow.persistence.session_run_state.peek_current_run_id",
        return_value="lg-hop-overwritten",
    ):
        turn, lg = resolve_turn_run_id(session_key="agent:main:x", thread_id="tid-1")

    assert turn == "user-turn-stable"
    assert lg == "lg-hop-volatile"


def test_same_turn_stable_across_volatile_lg_hops() -> None:
    """Changing LangGraph hop id must not look like a new user turn."""
    cache = get_compaction_trigger_cache()
    after = 29_000
    tokens = 35_000

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        side_effect=[("user-turn", "lg-hop-1"), ("user-turn", "lg-hop-2")],
    ):
        cache.record_compress(
            "t-hop-stable",
            run_id="user-turn",
            before_gate_tokens=after,
            after_gate_tokens=after,
            message_count=12,
        )
        decision = cache.evaluate(
            thread_id="t-hop-stable",
            tokens=tokens,
            message_count=16,
            min_messages=8,
            context_length=32_000,
            threshold_ratio=0.78,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=0.0,
            log_phase="test",
        )

    assert decision.same_run is True
    assert decision.allow is False
    assert decision.reason == "same_turn_still_hot_no_refill"