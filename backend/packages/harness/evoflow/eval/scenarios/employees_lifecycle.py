"""Scenario: hire → pause/resume → worklog shape (no mocks)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_initiative, expect_role


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as employees_admin
    from evoflow.proactive.models import Initiative, InitiativeActionType, InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.timeutil import utc_now_iso_z

    code = "eval-lifecycle"
    agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": "Eval Lifecycle",
            "description": "eval",
            "soul": "Lifecycle test.",
        }
    )
    hired = employees_admin.hire(
        {
            "agent_code": code,
            "role_name": "生命周期员",
            "responsibilities": ["值班"],
            "kpis": ["on-time"],
        }
    )

    paused = employees_admin.pause_role(code)
    resumed = employees_admin.resume_role(code)

    now = utc_now_iso_z()
    ProactiveRepository.save_initiative(
        Initiative(
            id="init_eval_lifecycle",
            role_agent_code=code,
            title="评测工作项",
            description="seed",
            status=InitiativeStatus.COMPLETED,
            action_type=InitiativeActionType.ANALYSIS,
            round_id="round:eval",
            goal="seed",
            created_at=now,
            updated_at=now,
        )
    )
    day = date.today().isoformat()
    worklog = employees_admin.worklog(code, day=day)

    assertions = [
        check(
            "hired",
            hired.get("agent_code") == code,
            inputs={"agent_code": code, "role_name": "生命周期员"},
            expected=code,
            actual=hired.get("agent_code"),
            api="employees_admin.hire",
        ),
        check(
            "paused",
            paused.get("status") == "paused",
            inputs={"agent_code": code},
            expected="paused",
            actual=paused.get("status"),
            api="employees_admin.pause_role",
        ),
        check(
            "resumed",
            resumed.get("status") == "active",
            inputs={"agent_code": code},
            expected="active",
            actual=resumed.get("status"),
            api="employees_admin.resume_role",
        ),
        check(
            "worklog_shape",
            isinstance(worklog, dict) and "rounds" in worklog,
            inputs={"agent_code": code, "day": day},
            expected="dict with key 'rounds'",
            actual=list(worklog.keys())[:12] if isinstance(worklog, dict) else type(worklog).__name__,
            api="employees_admin.worklog",
        ),
        check(
            "worklog_has_initiative",
            int(worklog.get("initiative_count") or 0) >= 1,
            inputs={"agent_code": code, "seed_initiative": "init_eval_lifecycle"},
            expected=">=1",
            actual=worklog.get("initiative_count"),
            api="employees_admin.worklog",
        ),
    ]
    persist = [
        expect_agent(code, agent_name="Eval Lifecycle"),
        expect_role(code, status="active", role_name="生命周期员"),
        expect_initiative("init_eval_lifecycle", status=InitiativeStatus.COMPLETED.value),
    ]
    return finalize(
        assertions + persist,
        metrics={"agent_code": code},
        steps=[
            {"step": 1, "api": "agents_admin.create_agent", "inputs": {"agent_code": code}},
            {"step": 2, "api": "employees_admin.hire", "result": {"status": hired.get("status")}},
            {"step": 3, "api": "employees_admin.pause_role", "result": paused.get("status")},
            {"step": 4, "api": "employees_admin.resume_role", "result": resumed.get("status")},
            {"step": 5, "api": "ProactiveRepository.save_initiative"},
            {"step": 6, "api": "employees_admin.worklog", "result": {"initiative_count": worklog.get("initiative_count")}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
