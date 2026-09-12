"""Tests for goal_report tool."""

from __future__ import annotations

import json
import sys

import pytest
from langchain.tools import ToolRuntime

# evoflow.tools.builtins.__init__ does `from .goal_report_tool import goal_report_tool`,
# which shadows the submodule attribute on the package.  Import the submodule
# explicitly first, then grab the real module object from sys.modules so
# monkeypatch can set attributes on it.
import evoflow.tools.builtins.goal_report_tool  # noqa: F401  — ensure registered

_grt_mod = sys.modules["evoflow.tools.builtins.goal_report_tool"]
goal_report_tool = _grt_mod.goal_report_tool


def _runtime(
    *,
    session_key: str = "agent:main:sk1",
    goal_mode: bool = True,
) -> ToolRuntime:
    return ToolRuntime(
        state={},
        context={"session_key": session_key, "goal_mode": goal_mode},
        config={"configurable": {}},
        stream_writer=lambda _event: None,
        tool_call_id="test-gr",
        store=None,
    )


def test_goal_report_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        _grt_mod,
        "load_goal_row",
        lambda sk: {
            "enabled": True,
            "goal_status": "active",
            "step_count": 1,
        },
    )
    patched: list[dict] = []

    def _patch(sk: str, **fields: object) -> None:
        patched.append({"sk": sk, **fields})

    monkeypatch.setattr(_grt_mod, "patch_goal_state", _patch)
    # Mock force_end_session_turn to verify session run_status is updated on complete
    ended_calls: list[dict] = []

    def _force_end(*, session_key=None, **kw):
        ended_calls.append({"session_key": session_key, **kw})
        return True

    monkeypatch.setattr(
        "evoflow.session_execution.lifecycle.force_end_session_turn",
        _force_end,
    )

    raw = goal_report_tool.invoke(
        {"action": "complete", "summary": "模块 A 已完成", "runtime": _runtime()},
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert data["action"] == "complete"
    assert patched[-1]["goal_status"] == "completed"
    assert patched[-1]["completion_outcome"] == "任务完成"
    assert patched[-1]["goal_summary"] == "模块 A 已完成"
    # Goal complete must also update session table run_status
    assert len(ended_calls) == 1
    assert ended_calls[0]["session_key"] == "agent:main:sk1"


def test_goal_report_rejects_non_goal_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_grt_mod, "goal_mode_from_runtime", lambda _rt: False)
    raw = goal_report_tool.invoke(
        {"action": "complete", "summary": "x", "runtime": _runtime(goal_mode=False)},
    )
    data = json.loads(raw)
    assert data["ok"] is False
