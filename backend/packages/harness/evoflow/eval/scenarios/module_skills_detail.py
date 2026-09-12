"""L2 技能：get_skill 形态 + 自定义目录安装/删除."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_absent


def _run(home: Path) -> dict:
    from evoflow.admin import skills as skills_admin
    from evoflow.admin.errors import NotFoundError
    from evoflow.skills.installer import install_skill_from_directory
    from evoflow.skills.loader import clear_skills_cache, get_skills_root_path

    listed = skills_admin.list_skills(enabled_only=False)
    public = next(
        (
            s
            for s in (listed.get("skills") or [])
            if isinstance(s, dict) and s.get("name") and s.get("category") != "custom"
        ),
        None,
    )
    pub_name = str((public or {}).get("name") or "")
    got_pub = skills_admin.get_skill(pub_name) if pub_name else {}

    skill_name = "eval-mod-skill-l2"
    src = home / "skill_src" / skill_name
    src.mkdir(parents=True, exist_ok=True)
    (src / "SKILL.md").write_text(
        "---\n"
        f"name: {skill_name}\n"
        "description: Eval module L2 custom skill\n"
        "---\n\n"
        "# Eval Mod Skill L2\n\n"
        "Used only by eval scenarios.\n",
        encoding="utf-8",
    )

    # Clean leftover from prior runs under this temp home's skills root
    try:
        skills_admin.delete_skill(skill_name)
    except Exception:  # noqa: BLE001
        pass
    clear_skills_cache()

    installed = install_skill_from_directory(src, skills_root=get_skills_root_path())
    clear_skills_cache()
    got_custom = skills_admin.get_skill(skill_name)
    deleted = skills_admin.delete_skill(skill_name)
    clear_skills_cache()
    gone = False
    try:
        skills_admin.get_skill(skill_name)
    except NotFoundError:
        gone = True
    except Exception:  # noqa: BLE001
        gone = True

    assertions = [
        check(
            "public_get_shape",
            bool(pub_name)
            and isinstance(got_pub, dict)
            and got_pub.get("name") == pub_name
            and "enabled" in got_pub,
            inputs={"name": pub_name},
            expected={"name": pub_name, "has_enabled": True},
            actual=got_pub,
            api="skills_admin.get_skill",
        ),
        check(
            "custom_install",
            bool(installed.get("success") or installed.get("skill_name") == skill_name),
            inputs={"source_dir": str(src), "skill_name": skill_name},
            expected=skill_name,
            actual=installed,
            api="install_skill_from_directory",
        ),
        check(
            "custom_get",
            got_custom.get("name") == skill_name and got_custom.get("category") == "custom",
            inputs={"name": skill_name},
            expected={"name": skill_name, "category": "custom"},
            actual=got_custom,
            api="skills_admin.get_skill",
        ),
        check(
            "custom_delete",
            bool(deleted.get("success", True)) and gone,
            inputs={"name": skill_name},
            expected={"gone": True},
            actual={"deleted": deleted, "gone": gone},
            api="skills_admin.delete_skill",
        ),
    ]
    persist = [
        check_db_absent(
            f"db_no_skill_{skill_name}",
            "SELECT name FROM evoflow_skills WHERE name=?",
            (skill_name,),
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"public": pub_name, "custom": skill_name},
        steps=[
            {"step": 1, "api": "get_skill(public)", "result": got_pub},
            {"step": 2, "api": "install_skill_from_directory", "result": installed},
            {"step": 3, "api": "get_skill(custom) / delete_skill", "result": {"gone": gone}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
