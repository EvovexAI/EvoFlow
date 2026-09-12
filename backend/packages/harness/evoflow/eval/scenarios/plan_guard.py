"""Scenario: PlanGuard blocks side-effect tools when workspace scenario inactive.

Uses real ``get_activated_scenarios`` — isolated home starts with no activation.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_count


def _run(home: Path) -> dict:
    del home
    from langchain_core.messages import ToolMessage

    from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware
    from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

    activated = list(get_activated_scenarios() or [])
    mw = PlanGuardMiddleware()
    tool_call = {"name": "web_search", "args": {"query": "news"}, "id": "ws1"}
    req = SimpleNamespace(
        tool_call=tool_call,
        state={"messages": []},
        runtime=SimpleNamespace(context={"thread_id": "eval-plan-guard"}),
    )

    def _handler(_r: object) -> ToolMessage:
        raise AssertionError("handler should not run when workspace scenario is inactive")

    result = mw.wrap_tool_call(req, _handler)  # type: ignore[arg-type]
    blocked = isinstance(result, ToolMessage) and getattr(result, "status", None) == "error"
    content = str(getattr(result, "content", "") or "")
    assertions = [
        check(
            "no_activation_in_isolated_home",
            len(activated) == 0,
            inputs={"EVOFLOW_HOME": "temp isolated"},
            expected=[],
            actual=activated,
            api="get_activated_scenarios",
        ),
        check(
            "returns_tool_message",
            isinstance(result, ToolMessage),
            inputs={"tool_call": tool_call},
            expected="ToolMessage",
            actual=type(result).__name__,
            api="PlanGuardMiddleware.wrap_tool_call",
        ),
        check(
            "status_error",
            blocked,
            inputs={"tool": "web_search"},
            expected="error",
            actual=str(getattr(result, "status", None)),
            api="PlanGuardMiddleware.wrap_tool_call",
        ),
        check(
            "mentions_inactive",
            "未激活" in content or "workspace" in content.lower() or "scenario" in content.lower(),
            inputs={"tool": "web_search"},
            expected="内容含 未激活/workspace/scenario",
            actual=content[:200],
            api="PlanGuardMiddleware.wrap_tool_call",
        ),
    ]
    persist = [
        check_db_count("db_apps_unchanged", "evoflow_apps", 0),
        check_db_count("db_mcp_servers_unchanged", "evoflow_mcp_servers", 0),
    ]
    return finalize(
        assertions + persist,
        metrics={"activated": activated},
        steps=[
            {"step": 1, "api": "get_activated_scenarios", "result": activated},
            {"step": 2, "api": "PlanGuardMiddleware.wrap_tool_call", "inputs": tool_call, "result": content[:160]},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
