"""Module scenario: 技能 — enable toggle + bind to agent."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_agent_skill, expect_skill_enabled


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import skills as skills_admin

    listed = skills_admin.list_skills(enabled_only=False)
    skills = list(listed.get("skills") or [])
    pick = next(
        (
            s
            for s in skills
            if isinstance(s, dict) and s.get("name") and s.get("category") != "custom"
        ),
        skills[0] if skills else None,
    )
    skill_name = str((pick or {}).get("name") or "").strip()

    disabled = None
    enabled_only_names: list[str] = []
    reenabled = None
    if skill_name:
        disabled = skills_admin.set_skill_enabled(skill_name, enabled=False)
        enabled_only_names = [
            str(s.get("name") or "")
            for s in (skills_admin.list_skills(enabled_only=True).get("skills") or [])
        ]
        reenabled = skills_admin.set_skill_enabled(skill_name, enabled=True)

    agent_code = "eval-mod-skills"
    try:
        agents_admin.create_agent(
            {
                "agent_code": agent_code,
                "agent_name": "技能绑定评测",
                "description": "skills module",
                "soul": "skills bind",
                "skills": [],
            }
        )
    except Exception:  # noqa: BLE001
        pass
    bound = agents_admin.update_agent(agent_code, {"skills": [skill_name] if skill_name else []})
    got = agents_admin.get_agent(agent_code)
    agent_skills = list(got.get("skills") or bound.get("skills") or [])

    assertions = [
        check(
            "skills_listed",
            len(skills) >= 1 and bool(skill_name),
            inputs={"enabled_only": False},
            expected=">=1 skill",
            actual={"count": len(skills), "picked": skill_name},
            api="skills_admin.list_skills",
        ),
        check(
            "disable_skill",
            bool(skill_name) and disabled is not None and disabled.get("enabled") is False,
            inputs={"name": skill_name, "enabled": False},
            expected=False,
            actual=(disabled or {}).get("enabled"),
            api="skills_admin.set_skill_enabled",
        ),
        check(
            "enabled_only_excludes",
            bool(skill_name) and skill_name not in enabled_only_names,
            inputs={"enabled_only": True},
            expected=f"{skill_name} not in list",
            actual=enabled_only_names[:30],
            api="skills_admin.list_skills(enabled_only=True)",
        ),
        check(
            "reenable_skill",
            bool(skill_name) and reenabled is not None and reenabled.get("enabled") is True,
            inputs={"name": skill_name, "enabled": True},
            expected=True,
            actual=(reenabled or {}).get("enabled"),
            api="skills_admin.set_skill_enabled",
        ),
        check(
            "bind_to_agent",
            bool(skill_name) and skill_name in agent_skills,
            inputs={"agent_code": agent_code, "skills": [skill_name]},
            expected=[skill_name],
            actual=agent_skills,
            api="agents_admin.update_agent",
        ),
    ]
    persist = [expect_agent(agent_code, agent_name="技能绑定评测")]
    if skill_name:
        persist.append(expect_skill_enabled(skill_name, True))
        persist.append(expect_agent_skill(agent_code, skill_name))
    return finalize(
        assertions + persist,
        metrics={"skill_name": skill_name, "agent_code": agent_code},
        steps=[
            {"step": 1, "api": "list_skills", "result": {"count": len(skills), "picked": skill_name}},
            {"step": 2, "api": "set_skill_enabled(False/True)"},
            {"step": 3, "api": "agents_admin.update_agent(skills=...)", "result": agent_skills},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
