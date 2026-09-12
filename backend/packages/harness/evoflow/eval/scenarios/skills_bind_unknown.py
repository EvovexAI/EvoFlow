"""Skills negative: binding an unknown skill name must be rejected."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_no_agent_skill

_GHOST = "skill_that_does_not_exist_eval_xx"


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.errors import ValidationError

    code = "eval-skill-ghost"
    agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": "幽灵技能绑定",
            "description": "unknown skill",
            "soul": "ghost",
            "skills": [],
        }
    )

    rejected = False
    err = ""
    persisted: list[str] = []
    try:
        agents_admin.update_agent(code, {"skills": [_GHOST]})
        got = agents_admin.get_agent(code)
        persisted = list(got.get("skills") or [])
    except ValidationError as exc:
        rejected = True
        err = str(exc)[:200]
        got = agents_admin.get_agent(code)
        persisted = list(got.get("skills") or [])

    assertions = [
        check(
            "bind_unknown_rejected",
            rejected,
            inputs={"agent_code": code, "skills": [_GHOST]},
            expected="ValidationError(unknown skill(s): …)",
            actual={"rejected": rejected, "error": err},
            api="agents_admin.update_agent",
        ),
        check(
            "ghost_not_persisted",
            _GHOST not in persisted,
            inputs={"agent_code": code},
            expected=f"{_GHOST} 不在 agent.skills",
            actual=persisted,
            api="agents_admin.get_agent",
        ),
    ]
    persist = [
        expect_agent(code, agent_name="幽灵技能绑定"),
        expect_no_agent_skill(code, _GHOST),
    ]
    return finalize(
        assertions + persist,
        metrics={"agent_code": code, "ghost": _GHOST, "persisted": persisted},
        steps=[
            {"step": 1, "module": "skills", "api": "create_agent(skills=[])"},
            {"step": 2, "module": "skills", "api": "update_agent(ghost) → ValidationError"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
