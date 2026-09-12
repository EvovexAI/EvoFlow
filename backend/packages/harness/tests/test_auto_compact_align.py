"""runtime-aligned compaction threshold + gate token accounting."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.context_compaction_core import (
    estimate_tokens_after_last_model_message,
    resolve_compaction_gate_tokens,
)
from evoflow.utils.model_context_length import (
    AUTO_COMPACT_RATIO,
    auto_compact_token_limit,
    compression_threshold_tokens,
)


def test_auto_compact_token_limit_integer_math():
    # Runtime: (context_window * 9) / 10 — integer division.
    assert auto_compact_token_limit(400_000) == 360_000
    assert auto_compact_token_limit(128_000) == 115_200
    assert compression_threshold_tokens(400_000) == 360_000
    assert compression_threshold_tokens(400_000, threshold_ratio=AUTO_COMPACT_RATIO) == 360_000


def test_custom_ratio_still_fractional():
    assert compression_threshold_tokens(100_000, threshold_ratio=0.50) == 50_000


def test_aggressive_full_window_auto_compact():
    assert compression_threshold_tokens(128_000, aggressive=True, aggressive_ratio=1.0) == 128_000
    assert compression_threshold_tokens(128_000, aggressive=True, aggressive_ratio=0.999) == 128_000


def test_growth_after_last_ai_message():
    msgs = [
        HumanMessage(content="hi"),
        AIMessage(content="hello"),
        HumanMessage(content="next turn " * 50),
    ]
    growth = estimate_tokens_after_last_model_message(msgs)
    assert growth > 0
    assert estimate_tokens_after_last_model_message(msgs[:2]) == 0


def test_resolve_gate_is_last_api_plus_growth_only(monkeypatch):
    msgs = [
        HumanMessage(content="a"),
        AIMessage(content="b"),
        HumanMessage(content="c " * 80),
    ]
    growth = estimate_tokens_after_last_model_message(msgs)
    assert growth > 0

    monkeypatch.setattr(
        "evoflow.persistence.session_context_usage.load_last_observed_active_tokens",
        lambda _sk: 350_000,
    )
    # No session → bootstrap local estimate only.
    assert resolve_compaction_gate_tokens(msgs, session_key="") < 50_000
    # With session → exactly Runtime: last_total + growth (no max with full estimate).
    gate = resolve_compaction_gate_tokens(msgs, session_key="sess-test")
    assert gate == 350_000 + growth
