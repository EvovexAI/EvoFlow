"""L2 智能体：非法名拒绝 + skills 绑定 + tags 更新."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_absent


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import skills as skills_admin
    from evoflow.admin.errors import ValidationError

    bad_ok = False
    bad_err = ""
    try:
        agents_admin.create_agent(
            {
                "agent_code": "Bad Name!",
                "agent_name": "非法",
                "description": "should fail",
                "soul": "x",
            }
        )
    except ValidationError as exc:
        bad_ok = True
        bad_err = str(exc)
    except Exception as exc:  # noqa: BLE001
        bad_ok = "invalid" in str(exc).lower() or "match" in str(exc).lower()
        bad_err = str(exc)

    skill_names = [
        str(s.get("name") or "")
        for s in (skills_admin.list_skills(enabled_only=True).get("skills") or [])
        if s.get("name")
    ]
    pick = skill_names[:2] if skill_names else []

    code = "eval-mod-agent-l2"
    try:
        agents_admin.delete_agent(code, confirm_cascade=True)
    except Exception:  # noqa: BLE001
        pass
    created = agents_admin.create_agent(
        {
            "agent_code": code,
            "agent_name": "模块L2智能体",
            "description": "agents detail",
            "soul": "L2",
            "skills": pick,
            "tags": ["eval", "module-l2"],
        }
    )
    got = agents_admin.get_agent(code)
    skills_got = list(got.get("skills") or created.get("skills") or [])
    tags_got = list(got.get("tags") or created.get("tags") or [])

    updated = agents_admin.update_agent(code, {"skills": pick[:1] if pick else [], "tags": ["eval"]})
    got2 = agents_admin.get_agent(code)
    skills2 = list(got2.get("skills") or updated.get("skills") or [])

    agents_admin.delete_agent(code, confirm_cascade=True)

    assertions = [
        check(
            "invalid_name_rejected",
            bad_ok,
            inputs={"agent_code": "Bad Name!"},
            expected="ValidationError",
            actual=bad_err or "no error",
            api="agents_admin.create_agent",
        ),
        check(
            "created_with_skills",
            created.get("agent_code") == code,
            inputs={"agent_code": code, "skills": pick},
            expected=code,
            actual=created.get("agent_code"),
            api="agents_admin.create_agent",
        ),
        check(
            "skills_persisted",
            (not pick) or all(s in skills_got for s in pick),
            inputs={"skills": pick},
            expected=pick,
            actual=skills_got,
            api="agents_admin.get_agent",
        ),
        check(
            "tags_persisted",
            "eval" in [str(t) for t in tags_got],
            inputs={"tags": ["eval", "module-l2"]},
            expected="含 eval",
            actual=tags_got,
            api="agents_admin.get_agent",
        ),
        check(
            "skills_updated",
            (not pick) or skills2 == pick[:1] or set(skills2) == set(pick[:1]),
            inputs={"skills": pick[:1]},
            expected=pick[:1],
            actual=skills2,
            api="agents_admin.update_agent",
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
        metrics={"agent_code": code, "skills": pick},
        steps=[
            {"step": 1, "api": "create_agent(invalid) → ValidationError"},
            {"step": 2, "api": "create_agent + get_agent", "result": {"skills": skills_got, "tags": tags_got}},
            {"step": 3, "api": "update_agent(skills)", "result": skills2},
            {"step": 4, "api": "delete_agent"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
