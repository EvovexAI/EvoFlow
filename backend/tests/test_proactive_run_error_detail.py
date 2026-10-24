"""A LangGraph run failure must keep its root cause, not just a machine code.

Regression guard: ``ProactiveEngine._run_langgraph_agent`` used to return a bare
code (``run_error``) and drop the original exception message. That message was
logged but never propagated, so the Task ended up as
「员工执行失败：run_error」 — which tells nobody what actually broke.
"""

from __future__ import annotations

import pytest

from evoflow.proactive.run_errors import (
    classify_run_exception,
    format_run_error_detail,
)


class _Resp:
    def __init__(self, status_code: int | None):
        self.status_code = status_code


class _Boom(Exception):
    def __init__(self, msg: str, status_code: int | None = None):
        super().__init__(msg)
        self.response = _Resp(status_code) if status_code is not None else None


class _GraphRecursionError(Exception):
    pass


def test_classify_keeps_detail_for_generic_failure():
    code, detail = classify_run_exception(_Boom("connection refused to 127.0.0.1:8070"))
    assert code == "run_error"
    assert "connection refused" in detail


def test_classify_maps_graph_build_422():
    code, detail = classify_run_exception(_Boom("invalid graph config", status_code=422))
    assert code == "graph_build_error"
    assert "invalid graph config" in detail


def test_classify_maps_http_status():
    code, _detail = classify_run_exception(_Boom("boom", status_code=500))
    assert code == "http_500"


def test_classify_detects_recursion_error_by_type_name():
    code, _detail = classify_run_exception(_GraphRecursionError("Recursion limit of 25 reached"))
    assert code == "recursion_limit"


def test_classify_detects_recursion_error_by_message():
    code, _detail = classify_run_exception(_Boom("Recursion limit of 25 reached"))
    assert code == "recursion_limit"


def test_format_detail_keeps_root_cause():
    assert format_run_error_detail("run_error", "connection refused") == "run_error: connection refused"


def test_format_detail_without_message_is_pure_code():
    assert format_run_error_detail("run_error", "") == "run_error"
    assert format_run_error_detail("run_error", "   ") == "run_error"


def test_format_detail_collapses_newlines_and_caps_length():
    out = format_run_error_detail("run_error", "line1\nline2", limit=8)
    assert "\n" not in out
    assert out.endswith("line1 li")


async def test_engine_error_path_propagates_root_cause(monkeypatch: pytest.MonkeyPatch):
    """The engine must return the exception message, not a bare code."""
    from evoflow.proactive.engine import ProactiveEngine
    from evoflow.proactive.models import ProactiveRole

    boom = _Boom("connection refused to 127.0.0.1:8070")

    class _Runs:
        async def wait(self, *a, **k):
            raise boom

    class _Threads:
        async def create(self, *a, **k):
            return {"thread_id": "thread-test"}

    class _Client:
        runs = _Runs()
        threads = _Threads()

    monkeypatch.setattr(ProactiveEngine, "_get_client", lambda self: _Client())
    monkeypatch.setattr(
        "evoflow.langgraph_connectivity.create_langgraph_thread",
        _fake_create_thread,
    )
    monkeypatch.setattr(
        "evoflow.proactive.chat_session.prepare_proactive_chat_session",
        lambda **k: None,
    )
    monkeypatch.setattr(
        "evoflow.proactive.chat_session.finalize_proactive_chat_session",
        lambda **k: {"ok": True},
    )

    engine = ProactiveEngine()
    role = ProactiveRole(agent_code="emp-test", role_name="测试岗")

    run_error, cost_info = await engine._run_langgraph_agent(
        role=role,
        system_prompt="s",
        user_prompt="u",
        session_key="duty:test",
        round_id="round-test",
    )

    assert run_error is not None
    assert "connection refused" in run_error
    assert run_error != "run_error"
    assert cost_info is None


async def _fake_create_thread(client, **kwargs):
    return {"thread_id": "thread-test"}
