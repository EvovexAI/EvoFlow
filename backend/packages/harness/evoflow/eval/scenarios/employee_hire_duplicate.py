"""Agents negative: duplicate hire must conflict."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as employees_admin
    from evoflow.admin.errors import ConflictError

    code = "eval-hire-dup"
    agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": "重复雇佣评测",
            "description": "dup hire",
            "soul": "dup",
        }
    )
    first = employees_admin.hire(
        {
            "agent_code": code,
            "role_name": "首任岗",
            "responsibilities": ["值班"],
        }
    )
    second_err = ""
    conflict = False
    try:
        employees_admin.hire(
            {
                "agent_code": code,
                "role_name": "二任岗",
                "responsibilities": ["不应成功"],
            }
        )
    except ConflictError as exc:
        conflict = True
        second_err = str(exc)
    except Exception as exc:  # noqa: BLE001
        # other explicit validation also acceptable
        conflict = "already" in str(exc).lower() or "exist" in str(exc).lower()
        second_err = str(exc)

    still = employees_admin.get_role(code)
    role_name = str(still.get("role_name") or "")

    assertions = [
        check(
            "first_hire_ok",
            first.get("agent_code") == code,
            inputs={"agent_code": code},
            expected=code,
            actual=first.get("agent_code"),
            api="employees_admin.hire",
        ),
        check(
            "second_hire_rejected",
            conflict,
            inputs={"agent_code": code, "attempt": 2},
            expected="ConflictError / already exists",
            actual=second_err[:200],
            api="employees_admin.hire",
        ),
        check(
            "original_role_intact",
            role_name == "首任岗" or still.get("agent_code") == code,
            inputs={"agent_code": code},
            expected="首任岗仍在",
            actual={"role_name": role_name, "agent_code": still.get("agent_code")},
            api="employees_admin.get_role",
        ),
    ]
    persist = [
        expect_agent(code, agent_name="重复雇佣评测"),
        expect_role(code, role_name="首任岗"),
    ]
    return finalize(
        assertions + persist,
        metrics={"agent_code": code},
        steps=[
            {"step": 1, "module": "agents", "api": "create_agent+hire"},
            {"step": 2, "module": "agents", "api": "hire again → conflict"},
            {"step": 3, "module": "agents", "api": "get_role"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
