"""Regression tests for context compaction wiring fixes."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.compaction_trigger import reset_compaction_trigger_cache_for_tests
from evoflow.agents.context_compaction_core import ContextCompactionEngine
from evoflow.agents.middlewares.context_compaction_middleware import (
    _apply_tool_history_merge,
    _needs_aggressive_second_pass,
    _prepare_compaction,
    emergency_compress_messages,
)
from evoflow.config.summarization_config import SummarizationConfig, set_summarization_config


def setup_function() -> None:
    reset_compaction_trigger_cache_for_tests()


def _runtime(**ctx) -> SimpleNamespace:
    return SimpleNamespace(context=ctx)


def test_prepare_compaction_returns_none_when_disabled():
    set_summarization_config(SummarizationConfig(enabled=False))
    try:
        msgs = [HumanMessage(content="hi"), AIMessage(content="ok")]
        assert _prepare_compaction(msgs, _runtime(thread_id="t1")) is None
    finally:
        set_summarization_config(SummarizationConfig(enabled=True))


def test_apply_tool_history_merge_enqueues_bg_jobs(monkeypatch):
    msgs = [HumanMessage(content="u"), AIMessage(content="a")]
    enqueued: list = []

    class _Queue:
        def enqueue(self, jobs):
            enqueued.extend(jobs)

    monkeypatch.setattr(
        "evoflow.agents.middlewares.context_compaction_middleware.apply_tool_history_fast",
        lambda *_a, **_k: (msgs, [MagicMock()]),
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.context_compaction_middleware.get_tool_history_summary_queue",
        lambda: _Queue(),
    )
    out, changed = _apply_tool_history_merge(msgs, thread_id="t-jobs")
    assert changed is True
    assert len(enqueued) == 1


def test_generate_summary_cooldown_uses_normalized_thread_id():
    engine = ContextCompactionEngine()
    engine._cooldown_until["normalized"] = float("inf")
    import asyncio

    async def _run():
        return await engine._generate_summary(
            [HumanMessage(content="x")],
            thread_id="  normalized  ",
            context_length=100_000,
            previous_summary=None,
            aggressive=False,
        )

    assert asyncio.run(_run()) is None


def test_compress_once_async_uses_sync_compress_for_immediate_persist(monkeypatch):
    set_summarization_config(SummarizationConfig(enabled=True, compaction_background_llm=True))
    called: list = []

    async def _fake_compress(*_a, **kw):
        called.append(kw.get("session_key"))
        return [HumanMessage(content="c")], True

    monkeypatch.setattr(
        "evoflow.agents.middlewares.context_compaction_middleware._engine.compress_messages",
        _fake_compress,
    )

    import asyncio

    from evoflow.agents.middlewares.context_compaction_middleware import _compress_once_async

    plan_kw = {
        "context_length": 100_000,
        "threshold_ratio": 0.5,
        "aggressive_ratio": 0.85,
        "protect_first_n": 3,
        "protect_tail_messages": 20,
        "protect_tail_tool_rounds": 3,
    }
    compressed, changed = asyncio.run(
        _compress_once_async(
            [HumanMessage(content="x")],
            thread_id="t-bg",
            session_key="agent:test:sync-persist",
            compress_policy={},
            plan_kw=plan_kw,
        )
    )
    assert changed is True
    assert called == ["agent:test:sync-persist"]
    set_summarization_config(SummarizationConfig(enabled=True))


def test_emergency_compress_forces_plan(monkeypatch):
    big = [HumanMessage(content="word " * 5000), AIMessage(content="a"), HumanMessage(content="b"), AIMessage(content="c")]
    for _ in range(6):
        big.extend([HumanMessage(content="x " * 2000), AIMessage(content="y " * 2000)])

    async def _fake_build(*_a, force=False, **_k):
        if force:
            return big[:4]
        return None

    monkeypatch.setattr(
        "evoflow.agents.middlewares.context_compaction_middleware.build_ephemeral_model_messages",
        _fake_build,
    )
    with patch(
        "evoflow.agents.middlewares.context_compaction_middleware.emit_compaction_start",
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.emit_compaction_end",
    ):
        compressed, changed = emergency_compress_messages(big, _runtime(thread_id="t-emerg"))
    assert changed is True
    assert len(compressed) == 4


def test_try_apply_pending_summary_skips_store_when_plan_none(monkeypatch):
    engine = ContextCompactionEngine()
    msgs = [HumanMessage(content="hi"), AIMessage(content="ok")]
    pending = "[CONTEXT COMPACTION — REFERENCE ONLY]\n## 目标\npending\n"
    monkeypatch.setattr(
        "evoflow.agents.context_compaction_core.plan_compaction",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(engine, "set_previous_summary", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("should not persist")))
    out = engine.try_apply_pending_summary(
        msgs,
        thread_id="t-skip",
        summary=pending,
        context_length=100_000,
        threshold_ratio=0.5,
        aggressive_ratio=0.85,
        protect_first_n=3,
        protect_tail_messages=20,
    )
    assert out is None


def test_needs_aggressive_second_pass_uses_aggressive_threshold():
    msgs = [HumanMessage(content="word " * 90_000)]
    plan_kw = {
        "context_length": 100_000,
        "threshold_ratio": 0.5,
        "aggressive_ratio": 0.85,
    }
    assert _needs_aggressive_second_pass(msgs, plan_kw=plan_kw) is True
    small = [HumanMessage(content="hi")]
    assert _needs_aggressive_second_pass(small, plan_kw=plan_kw) is False


def test_resolve_compaction_plan_force_uses_emergency_when_protect_blocks():
    from evoflow.agents.context_compaction_core import _resolve_compaction_plan

    msgs: list = [HumanMessage(content="start")]
    for i in range(10):
        msgs.append(AIMessage(content=f"ai {i}", tool_calls=[{"name": "read_file", "args": {"path": f"/f{i}.txt"}, "id": f"c{i}"}]))
        msgs.append(ToolMessage(content="x " * 8000, tool_call_id=f"c{i}", name="read_file"))
    msgs.append(HumanMessage(content="latest"))
    msgs.append(AIMessage(content="tail"))

    plan = _resolve_compaction_plan(
        msgs,
        context_length=8_000,
        threshold_ratio=0.32,
        aggressive_ratio=0.85,
        protect_first_n=3,
        protect_tail_messages=20,
        protect_tail_tool_rounds=3,
        aggressive=False,
        force=True,
    )
    assert plan is not None
    assert plan.original_count == len(msgs)
    assert len(plan.middle) >= 1


def test_message_token_estimate_counts_reasoning_content():
    from evoflow.agents.context_compaction_core import message_token_estimate

    msg = AIMessage(content="answer", additional_kwargs={"reasoning_content": "think " * 200})
    plain = message_token_estimate(AIMessage(content="answer"))
    rich = message_token_estimate(msg)
    assert rich > plain


def test_prune_old_tool_results_uses_token_threshold():
    from langchain_core.messages import ToolMessage

    from evoflow.agents.context_compaction_core import (
        _PRUNED_TOOL_PLACEHOLDER,
        _prune_old_tool_results,
    )

    msgs: list = [HumanMessage(content="start")]
    for i in range(8):
        msgs.append(AIMessage(content=f"a{i}"))
        msgs.append(ToolMessage(content=("word " * 80) if i < 6 else "ok", tool_call_id=f"c{i}", name="custom_tool"))
    msgs.extend([HumanMessage(content="recent"), AIMessage(content="tail")])

    pruned = _prune_old_tool_results(msgs, protect_tail_count=3, protect_tail_tokens=200)
    pruned_tools = [m for m in pruned if getattr(m, "type", None) == "tool"]
    assert any(m.content == _PRUNED_TOOL_PLACEHOLDER for m in pruned_tools)
    assert any(m.content == "ok" for m in pruned_tools)


def test_apply_compaction_does_not_insert_missing_tool_placeholders():
    from evoflow.agents.context_compaction_core import CompactionPlan, apply_compaction_with_summary

    ai = AIMessage(
        content="",
        tool_calls=[{"name": "grep", "args": {"q": "x"}, "id": "call_1"}],
    )
    working = [HumanMessage(content="head"), ai, HumanMessage(content="tail")]
    plan = CompactionPlan(
        working=working,
        head_end=1,
        compress_end=2,
        middle=[ai],
        middle_tokens=10,
        original_count=3,
    )
    out = apply_compaction_with_summary(plan, "summary body")
    tool_msgs = [m for m in out if getattr(m, "type", None) == "tool"]
    assert tool_msgs == []


def test_set_previous_summary_caps_huge_text():
    engine = ContextCompactionEngine()
    huge = "[CONTEXT COMPACTION — REFERENCE ONLY]\n" + ("detail " * 50_000)
    stored = engine.set_previous_summary("t-cap", huge, context_length=10_000)
    from evoflow.agents.context_compaction_core import count_text_tokens

    assert count_text_tokens(stored) <= int(10_000 * 0.05) + 500


def test_compaction_token_snapshot_includes_gate_overhead():
    from evoflow.agents.context_compaction_core import (
        compaction_token_snapshot,
        estimate_gate_tokens,
        estimate_messages_tokens,
    )

    msgs = [HumanMessage(content="hello world"), AIMessage(content="ok")]
    snap = compaction_token_snapshot(msgs, context_length=128_000)
    assert snap["message_count"] == 2
    assert snap["history_tokens"] == estimate_messages_tokens(msgs)
    assert snap["gate_tokens"] == estimate_gate_tokens(msgs)
    assert snap["overhead_tokens"] == snap["gate_tokens"] - snap["history_tokens"]
    assert snap["context_k"] == 128
    assert snap["pct_of_context"] > 0


def test_log_compaction_pass_result_emits_delta(caplog):
    import logging

    from evoflow.agents.context_compaction_core import log_compaction_pass_result

    before = [HumanMessage(content="x" * 4000)]
    after = [HumanMessage(content="x" * 1000)]
    caplog.set_level(logging.INFO, logger="evoflow.agents.context_compaction_core")
    log_compaction_pass_result(
        before,
        after,
        context_length=128_000,
        thread_id="thread-test-123",
        model_name="test-model",
        pass_label="pass2-aggressive",
    )
    assert any("PASS pass2-aggressive" in r.message for r in caplog.records)
    assert any("Δ -" in r.message for r in caplog.records)


def test_build_ephemeral_db_summary_hydrated_skip_does_not_raise_unbound_local():
    """Hydrated summary + below threshold: single gate skips without compress LLM."""
    import asyncio

    from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages

    msgs = [
        HumanMessage(content="start"),
        HumanMessage(
            content="[CONTEXT COMPACTION — REFERENCE ONLY]\n## 目标\nhydrated summary",
            name="conversation_summary",
        ),
        HumanMessage(content="recent"),
        AIMessage(content="ok"),
    ]
    rt = _runtime(thread_id="t-db-skip", session_key="agent:main:main")

    with patch(
        "evoflow.persistence.chat_message_repositories.find_latest_compaction_seq",
        return_value=5,
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._emit_stream_context_usage",
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.log_compaction_skipped",
    ):
        out = asyncio.run(build_ephemeral_model_messages(msgs, rt))

    assert out is None or len(out) == len(msgs)


def test_build_ephemeral_same_turn_hydrated_does_not_refold_over_threshold():
    """Regression: gate deny on same turn must not structural-refold DB-hydrated stitch."""
    import asyncio

    from evoflow.agents.context_compaction_core import ContextCompactionEngine, MAIN_SUMMARY_PREFIX, estimate_gate_tokens
    from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages

    big = "word " * 25000
    msgs = [
        AIMessage(content="bridge assistant"),
        ToolMessage(content="bridge tool", tool_call_id="tc-br", name="read"),
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nsummary body", name="conversation_summary"),
        HumanMessage(content="recent user"),
        AIMessage(content=big),
    ]
    ctx = 32_000
    gate_tokens = estimate_gate_tokens(msgs)
    assert gate_tokens >= int(ctx * 0.78)

    turn_id = "turn-passthrough"
    ContextCompactionEngine().mark_compress_completed(
        "t-passthrough",
        before_gate_tokens=gate_tokens,
        after_gate_tokens=int(gate_tokens * 0.85),
        message_count=len(msgs),
        run_id=turn_id,
    )
    rt = _runtime(thread_id="t-passthrough", session_key="agent:main:passthrough")
    refold_calls: list[int] = []

    def _refold_must_not_run(*_a, **_k):
        refold_calls.append(1)
        raise AssertionError("try_refold_with_cached_summary must not run on hydrated same-turn")

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-same"),
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._engine.try_refold_with_cached_summary",
        side_effect=_refold_must_not_run,
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._compress_with_followup_async",
        side_effect=AssertionError("compress LLM must not run on hydrated same-turn"),
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._emit_stream_context_usage",
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.log_compaction_skipped",
    ):
        out = asyncio.run(build_ephemeral_model_messages(msgs, rt))

    assert refold_calls == []
    assert out is None or len(out) == len(msgs)


def test_build_ephemeral_hydrated_passthrough_preserves_summary_in_payload():
    """Regression: partition stripped summary before passthrough check → refold mangled stitch."""
    import asyncio

    from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX, is_conversation_summary_human
    from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages

    summary_msg = HumanMessage(
        content=f"{MAIN_SUMMARY_PREFIX}\nDB summary body",
        name="conversation_summary",
    )
    msgs = [
        AIMessage(content="bridge"),
        ToolMessage(content="tool", tool_call_id="tc1", name="read"),
        summary_msg,
        AIMessage(content="post tail assistant"),
        ToolMessage(content="post tool", tool_call_id="tc2", name="read"),
    ]
    rt = _runtime(thread_id="t-keep-summary", session_key="agent:main:keep-summary")

    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=("turn-x", "lg-x"),
    ), patch(
        "evoflow.agents.compaction_trigger._session_has_compaction_summary",
        return_value=True,
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._engine.try_refold_with_cached_summary",
        side_effect=AssertionError("refold must not run on hydrated passthrough"),
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._emit_stream_context_usage",
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.log_compaction_skipped",
    ):
        out = asyncio.run(build_ephemeral_model_messages(msgs, rt))

    assert out is None or len(out) == len(msgs) or any(is_conversation_summary_human(m) for m in out)
    if out is not None:
        assert len(out) == len(msgs)


def test_emit_bound_model_context_usage_when_compaction_skipped(monkeypatch):
    from evoflow.agents.middlewares.context_compaction_middleware import (
        ContextCompactionMiddleware,
        _reset_compaction_call_markers,
    )
    from langchain_core.messages import HumanMessage, AIMessage

    emitted: list[dict] = []
    monkeypatch.setattr(
        "evoflow.agents.middlewares.context_compaction_middleware.emit_context_usage",
        lambda **kw: emitted.append(kw),
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.context_compaction_middleware.build_ephemeral_model_messages_sync",
        lambda *_a, **_k: None,
    )
    _reset_compaction_call_markers()
    msgs = [HumanMessage(content="u"), AIMessage(content="a")]
    rt = _runtime(thread_id="t-bound", session_key="agent:test:bound")
    req = SimpleNamespace(messages=msgs, runtime=rt, state={})
    mw = ContextCompactionMiddleware()
    mw._patch_empty_tool_messages = lambda r: r  # type: ignore[method-assign]
    mw._invoke_model = lambda r, h: h(r)  # type: ignore[method-assign]
    mw.wrap_model_call(req, lambda r: r)
    assert len(emitted) == 1
    assert emitted[0]["note"] == "model_bound"
    assert emitted[0]["message_count"] == 2


def test_emit_context_usage_payload():
    from evoflow.agents.context_compaction_events import emit_context_usage

    captured: list = []

    def _writer(payload):
        captured.append(payload)

    with patch("langgraph.config.get_stream_writer", return_value=_writer):
        emit_context_usage(
            used_tokens=18000,
            window_tokens=128000,
            message_count=12,
            before_tokens=98000,
            compacted=True,
            note="conversation_fold",
        )
    assert len(captured) == 1
    row = captured[0]
    assert row["type"] == "context_usage"
    assert row["used_tokens"] == 18000
    assert row["before_tokens"] == 98000
    assert row["compacted"] is True


def test_emit_context_usage_http_inject_when_no_stream_writer(monkeypatch):
    from evoflow.agents.context_compaction_events import emit_context_usage

    injected: list[tuple[str, dict]] = []

    def _inject(tid, payload):
        injected.append((tid, payload))

    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: None)
    monkeypatch.setattr(
        "evoflow.agents.context_compaction_events._inject_evf_frame_cross_thread",
        _inject,
    )

    emit_context_usage(
        used_tokens=12_000,
        window_tokens=128_000,
        message_count=8,
        before_tokens=45_000,
        compacted=True,
        note="conversation_fold",
        thread_id="tid-ctx-ring",
    )

    assert len(injected) == 1
    tid, payload = injected[0]
    assert tid == "tid-ctx-ring"
    assert payload["type"] == "context_usage"
    assert payload["used_tokens"] == 12_000
    assert payload["before_tokens"] == 45_000
    assert payload["compacted"] is True


def test_compress_with_followup_emits_start_before_llm(monkeypatch):
  import asyncio
  from evoflow.agents.middlewares import context_compaction_middleware as mw

  order: list[str] = []

  async def _slow_compress(*_a, **_k):
      order.append("compress_llm")
      return [HumanMessage(content="c")], True

  def _start(**_k):
      order.append("start")

  def _end(**_k):
      order.append("end")

  monkeypatch.setattr(mw, "_compress_once_async", _slow_compress)
  monkeypatch.setattr(mw, "emit_compaction_start", _start)
  monkeypatch.setattr(mw, "emit_compaction_end", _end)
  monkeypatch.setattr(mw, "_engine", mw._engine)
  monkeypatch.setattr(mw._engine, "should_compress", lambda *_a, **_k: False)
  monkeypatch.setattr(mw._engine, "mark_compress_completed", lambda *_a, **_k: None)

  asyncio.run(
      mw._compress_with_followup_async(
          [HumanMessage(content="u"), AIMessage(content="a")],
          thread_id="t-order",
          session_key="agent:test:order",
          compress_policy={},
          plan_kw={"context_length": 128_000, "threshold_ratio": 0.5, "aggressive_ratio": 0.85},
      )
  )
  assert order == ["start", "compress_llm", "end"]


def test_should_compress_does_not_refire_every_hop_with_hydrated_summary() -> None:
    from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX

    engine = ContextCompactionEngine()
    big = "token " * 4000
    msgs = [
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nbody", name="conversation_summary"),
        *[AIMessage(content=f"{big}{i}") for i in range(12)],
    ]
    assert not engine.should_compress(
        msgs,
        thread_id="t-hydrated-summary",
        context_length=128_000,
        threshold_ratio=0.75,
        aggressive_ratio=0.92,
    )


def test_should_compress_rearms_mid_run_when_context_refills_past_fold() -> None:
    from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX, estimate_gate_tokens

    engine = ContextCompactionEngine()
    big = "token " * 5000
    msgs = [
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nbody", name="conversation_summary"),
        *[AIMessage(content=f"{big}{i}") for i in range(14)],
    ]
    ctx = 128_000
    gate = estimate_gate_tokens(msgs)
    threshold_ratio = 0.50
    threshold = int(ctx * threshold_ratio)
    assert gate >= threshold
    turn_id = "turn-stable"
    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=(turn_id, "lg-1"),
    ):
        engine.mark_compress_completed(
            "t-refill",
            before_gate_tokens=gate,
            after_gate_tokens=gate,
            message_count=len(msgs),
            run_id=turn_id,
        )
        assert not engine.should_compress(
            msgs,
            thread_id="t-refill",
            context_length=ctx,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
            run_id=turn_id,
        )
        refloor = int(gate * 1.22)
        bigger = [
            HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nbody", name="conversation_summary"),
            *[AIMessage(content=f"{big}{i}" * 4) for i in range(14)],
        ]
        assert estimate_gate_tokens(bigger) >= refloor
        # Same turn below aggressive threshold: still blocked.
        aggressive = int(ctx * 0.92)
        if estimate_gate_tokens(bigger) < aggressive:
            assert not engine.should_compress(
                bigger,
                thread_id="t-refill",
                context_length=ctx,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=0.92,
                compaction_cooldown_seconds=120.0,
                compaction_hysteresis_enabled=True,
                run_id=turn_id,
            )
        else:
            assert engine.should_compress(
                bigger,
                thread_id="t-refill",
                context_length=ctx,
                threshold_ratio=threshold_ratio,
                aggressive_ratio=0.92,
                compaction_cooldown_seconds=120.0,
                compaction_hysteresis_enabled=True,
                run_id=turn_id,
            )


def test_should_compress_does_not_refire_same_hop_after_recent_fold() -> None:
    from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX, estimate_gate_tokens

    engine = ContextCompactionEngine()
    big = "token " * 5000
    msgs = [
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nbody", name="conversation_summary"),
        *[AIMessage(content=f"{big}{i}") for i in range(14)],
    ]
    ctx = 128_000
    gate = estimate_gate_tokens(msgs)
    engine.mark_compress_completed(
        "t-same-hop",
        before_gate_tokens=gate,
        after_gate_tokens=gate,
        message_count=len(msgs),
    )
    assert not engine.should_compress(
        msgs,
        thread_id="t-same-hop",
        context_length=ctx,
        threshold_ratio=0.50,
        aggressive_ratio=0.92,
        compaction_cooldown_seconds=120.0,
        compaction_hysteresis_enabled=True,
    )


def test_should_compress_with_summary_when_cooldown_expired() -> None:
    import time

    from evoflow.agents.compaction_trigger import CompactionTriggerSnapshot, get_compaction_trigger_cache
    from evoflow.agents.context_compaction_core import MAIN_SUMMARY_PREFIX, estimate_gate_tokens

    engine = ContextCompactionEngine()
    big = "token " * 5000
    msgs = [
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nbody", name="conversation_summary"),
        *[AIMessage(content=f"{big}{i}") for i in range(14)],
    ]
    ctx = 128_000
    gate = estimate_gate_tokens(msgs)
    threshold_ratio = 0.50
    assert gate >= int(ctx * threshold_ratio)
    get_compaction_trigger_cache()._snapshots["t-expired"] = CompactionTriggerSnapshot(
        run_id="turn-old",
        before_gate_tokens=gate,
        after_gate_tokens=gate,
        message_count=len(msgs),
        monotonic_at=time.monotonic() - 300,
    )
    with patch(
        "evoflow.agents.compaction_trigger.resolve_turn_run_id",
        return_value=("turn-new", "lg-x"),
    ):
        assert engine.should_compress(
            msgs,
            thread_id="t-expired",
            context_length=ctx,
            threshold_ratio=threshold_ratio,
            aggressive_ratio=0.92,
            compaction_cooldown_seconds=120.0,
            compaction_hysteresis_enabled=True,
        )


def test_should_passthrough_db_hydrated_on_same_turn_block() -> None:
    from evoflow.agents.context_compaction_core import (
        MAIN_SUMMARY_PREFIX,
        should_passthrough_db_hydrated_transcript,
    )

    msgs = [
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nbody", name="conversation_summary"),
        AIMessage(content="tail"),
    ]
    gate = {
        "should_trigger": False,
        "trigger_reason": "summary_present_awaiting_refill",
    }
    assert should_passthrough_db_hydrated_transcript(msgs, gate) is True
    assert should_passthrough_db_hydrated_transcript(msgs, gate, force=True) is False
    assert should_passthrough_db_hydrated_transcript(msgs, {**gate, "should_trigger": True}) is False
    assert should_passthrough_db_hydrated_transcript([AIMessage(content="no summary")], gate) is False


def test_build_ephemeral_evaluates_trigger_policy_once() -> None:
    import asyncio

    from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages

    msgs = [HumanMessage(content="u"), AIMessage(content="a")]
    rt = _runtime(thread_id="t-once", session_key="agent:main:once")
    evaluate_calls: list[str] = []
    real_evaluate = __import__(
        "evoflow.agents.compaction_trigger",
        fromlist=["get_compaction_trigger_cache"],
    ).get_compaction_trigger_cache().evaluate

    def _counting_evaluate(*args, **kwargs):
        evaluate_calls.append(str(kwargs.get("log_phase") or ""))
        return real_evaluate(*args, **kwargs)

    with patch(
        "evoflow.agents.compaction_trigger.CompactionTriggerCache.evaluate",
        side_effect=_counting_evaluate,
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware._emit_stream_context_usage",
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.log_compaction_skipped",
    ):
        asyncio.run(build_ephemeral_model_messages(msgs, rt))

    assert evaluate_calls == ["before_conversation_fold"]
