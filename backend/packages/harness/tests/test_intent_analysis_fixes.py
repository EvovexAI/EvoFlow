"""Regression tests for session / mission intent analysis fixes."""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.message_analysis_utils import (
    is_first_model_response_after_user,
    is_real_user_message,
    resolve_transcript_messages_for_analysis,
)
from evoflow.agents.middlewares.mission_state_middleware import MissionStateMiddleware
from evoflow.agents.middlewares.session_intent_middleware import _build_intent_block, _human_texts
from evoflow.agents.mission_state.queue import MissionStateQueue
from evoflow.agents.mission_state.state_manager import decide_next_mode, reset_thread_state
from evoflow.agents.mission_state.updater import _conversation_window
from evoflow.config.session_intent_config import SessionIntentConfig, load_session_intent_config_from_dict


def test_decide_next_mode_uses_bootstrap_for_first_snapshot() -> None:
    reset_thread_state("t-bootstrap")
    mode, _ = decide_next_mode("t-bootstrap", has_existing=False, low_conf=False, keyword_hit=False)
    assert mode == "bootstrap"


def test_mission_queue_replaces_stale_bootstrap_snapshot() -> None:
    q = MissionStateQueue()
    q._queue.clear()
    q.add(thread_id="t1", messages=[HumanMessage(content="first")], mode="bootstrap", turn_id="1")
    q.add(thread_id="t1", messages=[HumanMessage(content="second")], mode="incremental", turn_id="2")
    assert q._queue["t1"].mode == "incremental"
    assert q._queue["t1"].messages[0].content == "second"


def test_is_real_user_message_skips_compaction_and_tool_history() -> None:
    assert is_real_user_message(HumanMessage(content="real ask")) is True
    assert (
        is_real_user_message(
            HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nbody", name="conversation_summary")
        )
        is False
    )
    assert is_real_user_message(HumanMessage(content="[tool:history]\nbody", name="tool_history")) is False


def test_session_intent_ignores_synthetic_user_rows() -> None:
    load_session_intent_config_from_dict(SessionIntentConfig(enabled=True, max_turns=3, llm_rollup_enabled=False).model_dump())
    texts = _human_texts(
        [
            HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nold", name="conversation_summary"),
            HumanMessage(content="first goal"),
            HumanMessage(content="second goal"),
        ],
        max_turns=5,
    )
    assert texts == ["first goal", "second goal"]
    block = _build_intent_block(
        [
            HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nold", name="conversation_summary"),
            HumanMessage(content="first goal"),
            HumanMessage(content="second goal"),
        ]
    )
    assert "first goal" in block
    assert "CONTEXT COMPACTION" not in block


def test_conversation_window_skips_compaction_user_rows() -> None:
    conv = _conversation_window(
        [
            HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nsummary", name="conversation_summary"),
            HumanMessage(content="build auth"),
            AIMessage(content="ok"),
        ],
        max_pairs=3,
    )
    assert "CONTEXT COMPACTION" not in conv
    assert "build auth" in conv


def test_first_model_response_detection() -> None:
    msgs = [HumanMessage(content="fix auth", id="u1"), AIMessage(content="我先看看结构")]
    assert is_first_model_response_after_user(msgs) is True
    msgs.append(ToolMessage(content="tool result", tool_call_id="tc1"))
    assert is_first_model_response_after_user(msgs) is False
    msgs = [
        HumanMessage(content="fix auth", id="u1"),
        AIMessage(content="", tool_calls=[{"id": "1", "name": "read", "args": {}}]),
    ]
    assert is_first_model_response_after_user(msgs) is True
    msgs.append(ToolMessage(content="file content", tool_call_id="tc1"))
    assert is_first_model_response_after_user(msgs) is False


def test_mission_state_schedules_on_first_model_reply(monkeypatch) -> None:
    mw = MissionStateMiddleware()
    scheduled: list[str] = []

    class _FakeQueue:
        def add(self, *, thread_id: str, messages, mode: str, turn_id: str = "") -> None:
            scheduled.append(thread_id)

    monkeypatch.setattr(
        "evoflow.agents.middlewares.mission_state_middleware.get_mission_state_queue",
        lambda: _FakeQueue(),
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.mission_state_middleware.load_mission_state",
        lambda _tid: None,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.mission_state_middleware.decide_next_mode",
        lambda *_a, **_k: ("bootstrap", 0),
    )
    state = {
        "messages": [
            HumanMessage(content="帮我重构", id="u1"),
            AIMessage(content="好的，我先扫描仓库"),
        ]
    }
    rt = SimpleNamespace(context={"thread_id": "t-sched"})
    mw.after_model(state, rt)
    assert scheduled == ["t-sched"]
    mw.after_model(state, rt)
    assert scheduled == ["t-sched"]


def test_resolve_transcript_prefers_db(monkeypatch) -> None:
    runtime = [HumanMessage(content="checkpoint only")]

    class _FakeMsg:
        content = "from db"

    def _fake_rows(_session_key: str, *, limit: int = 40):
        return [{"role": "user", "content": "from db", "message_id": "m1"}]

    def _fake_lc(rows):
        return [_FakeMsg()]

    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        lambda _tid: "sk1",
    )
    monkeypatch.setattr(
        "evoflow.persistence.chat_message_repositories._list_lead_chat_rows",
        _fake_rows,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_transcript_hydration_middleware.lead_transcript_rows_to_lc_messages",
        _fake_lc,
    )
    out = resolve_transcript_messages_for_analysis(thread_id="t1", runtime_messages=runtime)
    assert out[0].content == "from db"
