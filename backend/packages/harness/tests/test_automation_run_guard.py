"""Tests for unattended automation run guardrails."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.automation_runtime import is_unattended_automation, triggered_by_automation
from evoflow.agents.middlewares.automation_run_guard_middleware import (
    AutomationRunGuardMiddleware,
    _PROACTIVE_SOFT_WRAP_MARKER,
    _reset_wrap_state_for_tests,
)
from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages_sync
from evoflow.agents.middlewares.mission_state_middleware import MissionStateMiddleware
from evoflow.agents.middlewares.title_middleware import TitleMiddleware


@pytest.fixture(autouse=True)
def _clear_wrap_state() -> None:
    _reset_wrap_state_for_tests()
    yield
    _reset_wrap_state_for_tests()


def _runtime(context: dict) -> SimpleNamespace:
    return SimpleNamespace(context=context)


def test_is_unattended_automation() -> None:
    rt = _runtime({"triggered_by": "automation_scheduler"})
    assert is_unattended_automation(rt) is True
    assert is_unattended_automation(_runtime({"triggered_by": "proactive_engine"})) is True
    assert is_unattended_automation(_runtime({"triggered_by": "user"})) is False
    assert triggered_by_automation({"triggered_by": "automation_scheduler"}) is True
    assert triggered_by_automation({"triggered_by": "proactive_engine"}) is True
    assert triggered_by_automation({"triggered_by": "user"}) is False


def test_mission_state_skipped_for_automation() -> None:
    mw = MissionStateMiddleware()
    state = {"messages": [HumanMessage(content="run cron")]}
    rt = _runtime({"triggered_by": "automation_scheduler", "thread_id": "t-auto"})
    assert mw.after_model(state, rt) is None


def test_title_middleware_skipped_for_automation() -> None:
    mw = TitleMiddleware()
    state = {
        "messages": [
            HumanMessage(content="hi"),
            AIMessage(content="hello"),
        ]
    }
    rt = _runtime({"triggered_by": "automation_scheduler", "thread_id": "t-auto"})
    assert mw.after_model(state, rt) is None


def test_compaction_runs_for_automation() -> None:
    """Automation/proactive runs must go through compaction (not skipped)."""
    rt = _runtime({"triggered_by": "automation_scheduler", "thread_id": "t1"})
    msgs = [HumanMessage(content="hi"), AIMessage(content="ok")]
    out = build_ephemeral_model_messages_sync(msgs, rt)
    assert out is None  # below threshold, no fold


def test_automation_guard_strips_tools_at_limit(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_AUTOMATION_MAX_TOOL_ROUNDS", "1")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        ToolMessage(content="a", tool_call_id="1"),
        AIMessage(
            content="",
            tool_calls=[{"id": "2", "name": "web_search", "args": {}, "type": "tool_call"}],
        ),
    ]
    rt = _runtime({"triggered_by": "automation_scheduler"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result["messages"][0].tool_calls == []


def test_proactive_guard_disabled_by_default(monkeypatch) -> None:
    """Default EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS=0: no soft/hard wrap."""
    monkeypatch.delenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", raising=False)
    mw = AutomationRunGuardMiddleware()
    msgs = [
        *[ToolMessage(content=f"t{i}", tool_call_id=str(i)) for i in range(100)],
        AIMessage(
            content="",
            tool_calls=[{"id": "x", "name": "rg", "args": {}, "type": "tool_call"}],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    assert mw.after_model({"messages": msgs}, rt) is None
    assert mw.before_model({"messages": msgs}, rt) is None


def test_proactive_guard_hard_jumps_to_model_for_text_wrap(monkeypatch) -> None:
    """First hard hit: strip tools + Human nudge + jump_to=model (not silent end)."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "1")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        ToolMessage(content="a", tool_call_id="1"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "2", "name": "read_file", "args": {}, "type": "tool_call"},
                {
                    "id": "3",
                    "name": "proactive_submit_work",
                    "args": {"phase": "wrap_up"},
                    "type": "tool_call",
                },
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "model"
    assert result["messages"][0].tool_calls == []
    assert "值班步数保护" in str(result["messages"][0].content)
    assert isinstance(result["messages"][1], HumanMessage)
    assert "强制收尾" in str(result["messages"][1].content)


def test_proactive_guard_soft_jumps_to_model_for_wrap_up(monkeypatch) -> None:
    """Soft reserve: strip dig tools, inject Human, jump_to=model so wrap-up can run."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    # soft = 10 - max(4, min(10, 3)) = 6
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
        AIMessage(
            content="继续看详情页",
            tool_calls=[
                {"id": "3", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "model"
    assert result["messages"][0].tool_calls == []
    assert "预留收尾" in str(result["messages"][0].content)
    assert isinstance(result["messages"][1], HumanMessage)
    assert _PROACTIVE_SOFT_WRAP_MARKER in str(result["messages"][1].content)
    assert "tasks progress" in str(result["messages"][1].content)


def test_proactive_guard_soft_keeps_task_cli_terminal(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "2",
                    "name": "terminal",
                    "args": {"command": "evoflow tasks progress Task_x --progress 80"},
                    "type": "tool_call",
                },
                {"id": "3", "name": "read", "args": {"path": "a.py"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") is None
    names = [tc["name"] for tc in result["messages"][0].tool_calls]
    assert names == ["terminal"]
    assert "evoflow tasks progress" in str(result["messages"][0].tool_calls[0]["args"])


def test_proactive_guard_ignores_prior_round_tool_history(monkeypatch) -> None:
    """Hydrated prior duty rounds must not burn the current-turn tool budget."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "2")
    mw = AutomationRunGuardMiddleware()
    prior = [ToolMessage(content=f"old-{i}", tool_call_id=f"old-{i}") for i in range(40)]
    msgs = [
        *prior,
        HumanMessage(content="本轮值班巡检开始"),
        ToolMessage(content="eslint ok", tool_call_id="cur-1"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "cur-2", "name": "read_file", "args": {"path": "a.py"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    assert mw.after_model({"messages": msgs}, rt) is None

    msgs_at_limit = [
        *msgs[:-1],
        ToolMessage(content="read ok", tool_call_id="cur-2"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "cur-3", "name": "web_search", "args": {}, "type": "tool_call"},
            ],
        ),
    ]
    result = mw.after_model({"messages": msgs_at_limit}, rt)
    assert result is not None
    # limit=2 → soft=hard=2; first hard hit jumps to model
    assert result.get("jump_to") == "model"
    assert result["messages"][0].tool_calls == []
    assert "值班步数保护" in str(result["messages"][0].content)


def test_proactive_guard_soft_exhausted_nudges_ends(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
        HumanMessage(content=f"{_PROACTIVE_SOFT_WRAP_MARKER}\nnudge1"),
        HumanMessage(content=f"{_PROACTIVE_SOFT_WRAP_MARKER}\nnudge2"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "x", "name": "read_file", "args": {"path": "a.py"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine", "thread_id": "t-soft-end"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "end"
    assert result["messages"][0].tool_calls == []


def test_proactive_guard_soft_survives_hydration_wipe(monkeypatch) -> None:
    """Soft Human wiped by DB hydration must still advance via out-of-band counter."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    rt = _runtime(
        {
            "triggered_by": "proactive_engine",
            "thread_id": "t-hydrate-loop",
            "round_id": "round:test-hydrate",
        }
    )
    base = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
    ]
    dig = AIMessage(
        content="继续巡检",
        tool_calls=[{"id": "r1", "name": "read", "args": {"path": "a.js"}, "type": "tool_call"}],
    )
    r1 = mw.after_model({"messages": [*base, dig]}, rt)
    assert r1 is not None
    assert r1.get("jump_to") == "model"
    assert isinstance(r1["messages"][1], HumanMessage)

    # Simulate hydration: only DB messages remain (wrap Human gone)
    hydrated = [*base, dig]
    reinjected = mw.before_model({"messages": hydrated}, rt)
    assert reinjected is not None
    assert _PROACTIVE_SOFT_WRAP_MARKER in str(reinjected["messages"][0].content)

    # Model digs again without Human in list — out-of-band soft=1 → second nudge
    dig2 = AIMessage(
        content="再看一眼",
        tool_calls=[{"id": "r2", "name": "rg", "args": {"pattern": "x"}, "type": "tool_call"}],
    )
    r2 = mw.after_model({"messages": hydrated[:-1] + [dig2]}, rt)
    assert r2 is not None
    assert r2.get("jump_to") == "model"

    dig3 = AIMessage(
        content="还看",
        tool_calls=[{"id": "r3", "name": "read", "args": {"path": "b.js"}, "type": "tool_call"}],
    )
    r3 = mw.after_model({"messages": hydrated[:-1] + [dig3]}, rt)
    assert r3 is not None
    assert r3.get("jump_to") == "end"


def test_proactive_guard_empty_board_soft_ends_fast(monkeypatch) -> None:
    """Empty Task board: soft should text-wrap once then end (not Task CLI loop)."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    from evoflow.agents.middlewares.automation_run_guard_middleware import (
        _PROACTIVE_SOFT_WRAP_EMPTY_BOARD_HUMAN,
    )

    mw = AutomationRunGuardMiddleware()
    rt = _runtime(
        {
            "triggered_by": "proactive_engine",
            "thread_id": "t-empty-board",
            "round_id": "round:empty",
        }
    )
    live = HumanMessage(
        content="<proactive_live_tasks>\n（暂无未结 — 可巡检结束；勿空建单）\n</proactive_live_tasks>"
    )
    base = [
        HumanMessage(content="# 值班 · 前端\n无待办"),
        live,
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
    ]
    dig = AIMessage(
        content="未结 Task 为空，继续巡检",
        tool_calls=[{"id": "r1", "name": "read", "args": {"path": "proactive.js"}, "type": "tool_call"}],
    )
    r1 = mw.after_model({"messages": [*base, dig]}, rt)
    assert r1 is not None
    assert r1.get("jump_to") == "model"
    assert "无未结 Task" in str(r1["messages"][1].content)
    assert _PROACTIVE_SOFT_WRAP_EMPTY_BOARD_HUMAN.split("\n")[0] in str(r1["messages"][1].content)

    dig2 = AIMessage(
        content="再巡检",
        tool_calls=[{"id": "r2", "name": "rg", "args": {"pattern": "x"}, "type": "tool_call"}],
    )
    r2 = mw.after_model({"messages": [*base, dig2]}, rt)
    assert r2 is not None
    assert r2.get("jump_to") == "end"
    assert r2["messages"][0].tool_calls == []


def test_proactive_guard_soft_keeps_tasks_tool(monkeypatch) -> None:
    """Soft limit must keep native ``tasks`` progress/state (not only Task CLI)."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
        AIMessage(
            content="结案",
            tool_calls=[
                {
                    "id": "ts1",
                    "name": "tasks",
                    "args": {
                        "action": "state",
                        "task_id": "Task_x",
                        "status": "completed",
                        "summary": "done",
                    },
                    "type": "tool_call",
                },
                {"id": "r1", "name": "read", "args": {"path": "a.py"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") is None
    names = [tc["name"] for tc in result["messages"][0].tool_calls]
    assert names == ["tasks"]
    assert result["messages"][0].tool_calls[0]["args"]["action"] == "state"


def test_tasks_tool_progress_resets_dig_budget(monkeypatch) -> None:
    """Successful native ``tasks`` progress ToolMessage restarts the dig window."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"dig-{i}", tool_call_id=f"dig-{i}") for i in range(6)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "prog-1",
                    "name": "tasks",
                    "args": {"action": "progress", "task_id": "Task_x", "progress": 50},
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(
            content='{"ok": true, "action": "progress", "result": {"progress": 50}}',
            tool_call_id="prog-1",
        ),
        ToolMessage(content="more dig", tool_call_id="dig-after"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "r1", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    assert mw.after_model({"messages": msgs}, rt) is None


def test_progress_after_soft_does_not_reinject_soft_wrap(monkeypatch) -> None:
    """After soft wrap + successful progress, do not re-inject「探测额度已尽」; resume dig."""
    from evoflow.agents.middlewares.automation_run_guard_middleware import (
        _PROACTIVE_DIG_RESUME_MARKER,
    )

    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    rt = _runtime(
        {
            "triggered_by": "proactive_engine",
            "thread_id": "t-progress-resume",
            "round_id": "round:progress-resume",
        }
    )
    base = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
    ]
    dig = AIMessage(
        content="继续看",
        tool_calls=[{"id": "r1", "name": "read", "args": {"path": "a.js"}, "type": "tool_call"}],
    )
    soft = mw.after_model({"messages": [*base, dig]}, rt)
    assert soft is not None
    assert soft.get("jump_to") == "model"
    assert _PROACTIVE_SOFT_WRAP_MARKER in str(soft["messages"][1].content)

    # Soft wrap Human wiped by hydration; progress ToolMessage landed (budget reset).
    after_progress = [
        *base,
        AIMessage(
            content="先回写进度",
            tool_calls=[
                {
                    "id": "prog-1",
                    "name": "tasks",
                    "args": {"action": "progress", "task_id": "Task_x", "progress": 40},
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(
            content='{"ok": true, "action": "progress", "result": {"progress": 40}}',
            tool_call_id="prog-1",
        ),
    ]
    resumed = mw.before_model({"messages": after_progress}, rt)
    assert resumed is not None
    body = str(resumed["messages"][0].content)
    assert _PROACTIVE_DIG_RESUME_MARKER in body
    assert _PROACTIVE_SOFT_WRAP_MARKER not in body

    # Further dig must be allowed in the new window.
    dig2 = AIMessage(
        content="继续修",
        tool_calls=[{"id": "r2", "name": "read", "args": {"path": "b.js"}, "type": "tool_call"}],
    )
    assert mw.after_model({"messages": [*after_progress, dig2]}, rt) is None

    # Pending soft wrap must stay cleared — no second soft re-inject.
    assert mw.before_model({"messages": [*after_progress, dig2]}, rt) is None


def test_failed_tasks_tool_state_does_not_reset_budget(monkeypatch) -> None:
    """Schema / tool errors on ``tasks`` state must not unlock a fresh dig window."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"dig-{i}", tool_call_id=f"dig-{i}") for i in range(6)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "bad-1",
                    "name": "tasks",
                    "args": {
                        "action": "state",
                        "task_id": "Task_x",
                        "status": "completed",
                        "outputs": "[{bad",
                    },
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(
            content=(
                "Error invoking tool 'tasks' with kwargs {...} with error:\n"
                " outputs: Input should be a valid list\n Please fix the error and try again."
            ),
            tool_call_id="bad-1",
        ),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "r1", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "model"
    assert result["messages"][0].tool_calls == []


def test_task_progress_resets_dig_budget(monkeypatch) -> None:
    """``evoflow tasks progress`` ToolMessage restarts the dig window."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    # soft = 6
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"dig-{i}", tool_call_id=f"dig-{i}") for i in range(6)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "prog-1",
                    "name": "terminal",
                    "args": {
                        "command": "evoflow tasks progress Task_x --progress 50"
                    },
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(content='{"ok": true}', tool_call_id="prog-1"),
        # After checkpoint, only 1 dig tool — below soft=6
        ToolMessage(content="more dig", tool_call_id="dig-after"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "r1", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    assert mw.after_model({"messages": msgs}, rt) is None


def test_progress_reset_cannot_bypass_hard_total(monkeypatch) -> None:
    """Hard cap is lifetime this duty turn — progress must not unlock infinite dig."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    # 9 dig + 1 progress success + 1 dig after = 11 total (>= hard 10)
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"dig-{i}", tool_call_id=f"dig-{i}") for i in range(9)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "prog-1",
                    "name": "terminal",
                    "args": {"command": "evoflow tasks progress Task_x --progress 50"},
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(content='{"ok": true}', tool_call_id="prog-1"),
        ToolMessage(content="after", tool_call_id="dig-after"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "r1", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    # Hard path: text wrap or end — not a free dig window
    assert result["messages"][0].tool_calls == []
    assert result.get("jump_to") in {"model", "end"}


def test_proactive_guard_soft_banner_only_once(monkeypatch) -> None:
    """Soft-stop banner must not spam every stripped dig turn in the same window."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"t{i}", tool_call_id=f"t{i}") for i in range(6)],
        HumanMessage(content=f"{_PROACTIVE_SOFT_WRAP_MARKER}\nnudge1"),
        AIMessage(
            content="再探一下",
            tool_calls=[
                {"id": "r2", "name": "read", "args": {"path": "b.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "model"
    # Already shown via prior Human nudge — do not re-append onto AI content.
    assert str(result["messages"][0].content) == "再探一下"
    assert _PROACTIVE_SOFT_WRAP_MARKER in str(result["messages"][1].content)


def test_failed_tasks_progress_does_not_reset_budget(monkeypatch) -> None:
    """Bad flags on progress must not unlock a fresh dig window."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"dig-{i}", tool_call_id=f"dig-{i}") for i in range(6)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "bad-1",
                    "name": "terminal",
                    "args": {
                        "command": "evoflow tasks progress Task_x --note x --percent 50"
                    },
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(
            content="error: unrecognized arguments: --note x --percent 50\nusage: ...",
            tool_call_id="bad-1",
        ),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "r1", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "model"
    assert result["messages"][0].tool_calls == []


def test_tasks_get_does_not_reset_budget(monkeypatch) -> None:
    """``tasks get`` / help are probes — must not unlock a new dig window."""
    monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "10")
    mw = AutomationRunGuardMiddleware()
    msgs = [
        HumanMessage(content="本轮值班"),
        *[ToolMessage(content=f"dig-{i}", tool_call_id=f"dig-{i}") for i in range(6)],
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "get-1",
                    "name": "terminal",
                    "args": {"command": "evoflow tasks get Task_x"},
                    "type": "tool_call",
                }
            ],
        ),
        ToolMessage(content='{"task_id":"Task_x"}', tool_call_id="get-1"),
        AIMessage(
            content="",
            tool_calls=[
                {"id": "r1", "name": "read", "args": {"path": "apps.js"}, "type": "tool_call"},
            ],
        ),
    ]
    rt = _runtime({"triggered_by": "proactive_engine"})
    result = mw.after_model({"messages": msgs}, rt)
    assert result is not None
    assert result.get("jump_to") == "model"
    assert result["messages"][0].tool_calls == []
