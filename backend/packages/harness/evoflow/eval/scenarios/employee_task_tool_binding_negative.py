"""Employee task: tool whitelist negative — forbidden tools must not resolve."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_no_agent_skill
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    expect_tools_include,
    runtime_contract_metrics,
    snapshot_agent_runtime,
)

_CODE = "eval-emp-tools-neg"
_ALLOWED = ["read"]
_FORBIDDEN = ["web_search", "bash", "browser"]


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.errors import ValidationError

    ensure_agent(
        agent_code=_CODE,
        agent_name="工具绑定负面智能体",
        description="tools negative",
        soul="Minimal tools only.",
        system_prompt="You may only use read.",
        tools=list(_ALLOWED),
    )
    snap = snapshot_agent_runtime(_CODE)

    unknown_skill_rejected = False
    err_msg = ""
    try:
        agents_admin.update_agent(_CODE, {"skills": ["___eval_skill_does_not_exist___"]})
    except ValidationError as exc:
        unknown_skill_rejected = True
        err_msg = str(exc)
    except Exception as exc:  # noqa: BLE001
        # some paths may raise generic errors
        unknown_skill_rejected = "skill" in str(exc).lower() or "unknown" in str(exc).lower()
        err_msg = str(exc)

    assertions = [
        check(
            "tools_config_frozen",
            snap.get("tools_config") == _ALLOWED
            or set(snap.get("tools_config") or []) == set(_ALLOWED),
            inputs={"tools": _ALLOWED},
            expected=_ALLOWED,
            actual=snap.get("tools_config"),
            api="ensure_agent",
        ),
        expect_tools_include(_CODE, _ALLOWED, forbidden=_FORBIDDEN),
        check(
            "unknown_skill_rejected",
            unknown_skill_rejected,
            inputs={"skills": ["___eval_skill_does_not_exist___"]},
            expected="ValidationError / reject",
            actual=err_msg or "no error",
            api="agents_admin.update_agent",
        ),
    ]
    persist = [
        expect_agent(_CODE, agent_name="工具绑定负面智能体"),
        expect_no_agent_skill(_CODE, "___eval_skill_does_not_exist___"),
    ]
    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        extra={"tools_expected": _ALLOWED, "tools_forbidden": _FORBIDDEN},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_agent tools=[read]"},
            {"step": 2, "api": "resolve_agent_tool_names_for_agent"},
            {"step": 3, "api": "update_agent unknown skill → reject"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
