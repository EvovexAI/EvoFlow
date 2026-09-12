"""Module scenario: 智能体 — CRUD roundtrip."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_absent


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin

    code = "eval-mod-agent"
    availability = agents_admin.check_agent_name(code)
    created = agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": "模块评测智能体",
            "description": "agents module scenario",
            "soul": "Module agents CRUD.",
            "skills": [],
        }
    )
    got = agents_admin.get_agent(code)
    listed = agents_admin.list_agents()
    codes = [str(a.get("agent_code") or "") for a in (listed.get("agents") or [])]
    updated = agents_admin.update_agent(
        code, {"description": "agents module scenario updated", "soul": "Updated soul."}
    )
    got2 = agents_admin.get_agent(code)
    deleted = agents_admin.delete_agent(code, confirm_cascade=True)
    # Prefer registry/list checks: get_agent may briefly hit in-memory cache.
    listed_after = agents_admin.list_agents()
    codes_after = [str(a.get("agent_code") or "") for a in (listed_after.get("agents") or [])]
    avail_after = agents_admin.check_agent_name(code)
    gone = code not in codes_after and avail_after.get("available") is True

    assertions = [
        check(
            "name_available",
            availability.get("available") is True or created.get("agent_code") == code,
            inputs={"name": code},
            expected=True,
            actual=availability,
            api="agents_admin.check_agent_name",
        ),
        check(
            "created",
            created.get("agent_code") == code,
            inputs={"agent_code": code, "agent_name": "模块评测智能体"},
            expected=code,
            actual=created.get("agent_code"),
            api="agents_admin.create_agent",
        ),
        check(
            "get_after_create",
            got.get("agent_code") == code,
            inputs={"agent_code": code},
            expected=code,
            actual=got.get("agent_code"),
            api="agents_admin.get_agent",
        ),
        check(
            "listed",
            code in codes,
            inputs={},
            expected=code,
            actual=codes[:30],
            api="agents_admin.list_agents",
        ),
        check(
            "updated",
            "updated" in str(got2.get("description") or updated.get("description") or ""),
            inputs={"description": "agents module scenario updated"},
            expected="description contains 'updated'",
            actual=got2.get("description"),
            api="agents_admin.update_agent",
        ),
        check(
            "deleted",
            bool(deleted.get("message")) and gone,
            inputs={"agent_code": code},
            expected={"listed": False, "available": True},
            actual={
                "delete": deleted,
                "listed_after": codes_after,
                "check_name": avail_after,
                "gone": gone,
            },
            api="agents_admin.delete_agent",
        ),
    ]
    persist = [
        check_db_absent(
            f"db_no_agent_{code}",
            "SELECT agent_code FROM evoflow_agents WHERE lower(agent_code)=lower(?)",
            (code,),
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"agent_code": code},
        steps=[
            {"step": 1, "api": "check_agent_name", "result": availability},
            {"step": 2, "api": "create_agent", "result": {"agent_code": created.get("agent_code")}},
            {"step": 3, "api": "list_agents / get_agent"},
            {"step": 4, "api": "update_agent", "result": {"description": got2.get("description")}},
            {"step": 5, "api": "delete_agent", "result": {"gone": gone}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
