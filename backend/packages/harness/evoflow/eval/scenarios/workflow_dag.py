"""Scenario: validate_app_definition catches cycles / dangling refs."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_count


def _run(home: Path) -> dict:
    del home
    from evoflow.collab.workflow_validator import validate_app_definition

    valid = {
        "name": "eval-valid",
        "execution_mode": "workflow",
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "A",
                "agent_code": "general-purpose",
                "goal": "step a",
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "B",
                "agent_code": "general-purpose",
                "goal": "step b",
                "depends_on": ["1"],
            },
        ],
    }
    cyclic = {
        "name": "eval-cycle",
        "execution_mode": "workflow",
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "A",
                "agent_code": "general-purpose",
                "goal": "a",
                "depends_on": ["2"],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "B",
                "agent_code": "general-purpose",
                "goal": "b",
                "depends_on": ["1"],
            },
        ],
    }
    dangling = {
        "name": "eval-dangling",
        "execution_mode": "workflow",
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "A",
                "agent_code": "general-purpose",
                "goal": "a",
                "depends_on": ["missing"],
            },
        ],
    }

    v_ok = validate_app_definition(valid)
    v_cycle = validate_app_definition(cyclic)
    v_dang = validate_app_definition(dangling)

    def _passed(res: dict) -> bool:
        if isinstance(res, dict):
            if "ok" in res:
                return bool(res["ok"])
            if "valid" in res:
                return bool(res["valid"])
            errs = res.get("errors") or res.get("issues") or []
            return len(errs) == 0
        return bool(res)

    assertions = [
        check(
            "valid_graph",
            _passed(v_ok),
            inputs=valid,
            expected={"ok/valid": True},
            actual=v_ok,
            api="validate_app_definition",
        ),
        check(
            "cycle_rejected",
            not _passed(v_cycle),
            inputs=cyclic,
            expected={"ok/valid": False},
            actual=v_cycle,
            api="validate_app_definition",
        ),
        check(
            "dangling_rejected",
            not _passed(v_dang),
            inputs=dangling,
            expected={"ok/valid": False},
            actual=v_dang,
            api="validate_app_definition",
        ),
    ]
    persist = [
        check_db_count("db_apps_unchanged", "evoflow_apps", 0),
        check_db_count("db_app_runs_unchanged", "evoflow_app_runs", 0),
    ]
    return finalize(
        assertions + persist,
        steps=[
            {"step": 1, "api": "validate_app_definition(valid)", "result": v_ok},
            {"step": 2, "api": "validate_app_definition(cyclic)", "result": v_cycle},
            {"step": 3, "api": "validate_app_definition(dangling)", "result": v_dang},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
