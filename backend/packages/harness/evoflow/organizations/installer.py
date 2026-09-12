"""Install / preflight / uninstall Organization Packs (资源包)."""

from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from evoflow.organizations.manifest import (
    LoadedPack,
    PackManifestError,
    deep_apply_placeholders,
    load_agent_definition,
    load_json_ref,
    load_pack_from_source,
    resolve_pack_rel,
)
from evoflow.organizations import registry as org_registry

logger = logging.getLogger(__name__)


class OrganizationInstallError(RuntimeError):
    def __init__(self, message: str, *, rolled_back: bool = False) -> None:
        super().__init__(message)
        self.rolled_back = rolled_back


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def _id_prefix(options: dict[str, Any] | None) -> str:
    return str((options or {}).get("id_prefix") or "").strip().lower()


def _prefixed(code: str, prefix: str) -> str:
    c = str(code or "").strip().lower()
    if not c:
        return c
    if prefix and not c.startswith(prefix):
        return f"{prefix}{c}"
    return c


def _conflict_policy(options: dict[str, Any] | None) -> str:
    p = str((options or {}).get("conflict_policy") or "fail").strip().lower()
    return p if p in ("fail", "skip", "replace") else "fail"


def _plan_will_install(pack: LoadedPack, *, prefix: str) -> dict[str, list[str]]:
    m = pack.manifest
    prim = m.get("primitives") if isinstance(m.get("primitives"), dict) else {}
    will: dict[str, list[str]] = {
        "agents": [],
        "employees": [],
        "apps": [],
        "skills": [],
        "mcp": [],
        "vaults": [],
        "extensions": [],
    }

    for ref in list(prim.get("agents") or []):
        if not isinstance(ref, dict):
            continue
        from_path = str(ref.get("from") or "").strip()
        if not from_path:
            continue
        agent = load_agent_definition(pack, from_path)
        code = str(ref.get("id_override") or agent.get("agent_code") or agent.get("name") or "").strip()
        if code:
            will["agents"].append(_prefixed(code, prefix))

    for ref in list(prim.get("skills") or []):
        if not isinstance(ref, dict):
            continue
        if ref.get("path"):
            skill_dir = resolve_pack_rel(pack, str(ref["path"]))
            name = skill_dir.name
            skill_md = skill_dir / "SKILL.md"
            if skill_md.is_file():
                try:
                    from evoflow.skills.installer import _validate_skill_frontmatter

                    ok, _, sn = _validate_skill_frontmatter(skill_dir, strict_keys=False)
                    if ok and sn:
                        name = sn
                except Exception:
                    pass
            will["skills"].append(name)
        elif ref.get("slug"):
            will["skills"].append(str(ref["slug"]))

    for ref in list(prim.get("extensions") or []):
        if isinstance(ref, dict) and (ref.get("ref") or ref.get("path")):
            will["extensions"].append(str(ref.get("ref") or ref.get("path")))

    for ref in list(prim.get("mcp") or []):
        if isinstance(ref, dict) and ref.get("from"):
            will["mcp"].append(str(ref["from"]))

    for ref in list(prim.get("vaults") or []):
        if isinstance(ref, dict) and ref.get("id"):
            will["vaults"].append(_prefixed(str(ref["id"]), prefix))

    team = m.get("team") if isinstance(m.get("team"), dict) else {}
    for ref in list(team.get("employees") or []):
        if not isinstance(ref, dict):
            continue
        from_path = str(ref.get("from") or "").strip()
        if not from_path:
            continue
        emp = load_json_ref(pack, from_path)
        code = str(emp.get("agent_code") or "").strip()
        if code:
            will["employees"].append(_prefixed(code, prefix))

    pipes = m.get("pipelines") if isinstance(m.get("pipelines"), dict) else {}
    for ref in list(pipes.get("apps") or []):
        if not isinstance(ref, dict):
            continue
        from_path = str(ref.get("from") or "").strip()
        if not from_path:
            continue
        app = load_json_ref(pack, from_path)
        name = str(app.get("name") or Path(from_path).stem).strip()
        will["apps"].append(name)

    return will


def _collect_conflicts(will: dict[str, list[str]]) -> list[dict[str, str]]:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.errors import NotFoundError
    from evoflow.proactive.repositories import ProactiveRepository

    conflicts: list[dict[str, str]] = []
    for code in will.get("agents") or []:
        try:
            agents_admin.get_agent(code)
            owner = org_registry.find_artifact_owner("agent", code)
            conflicts.append(
                {
                    "type": "agent",
                    "id": code,
                    "reason": "already_exists",
                    "owned_by": owner or "",
                }
            )
        except NotFoundError:
            pass
        except Exception:
            logger.debug("conflict check agent skipped code=%s", code, exc_info=True)

    for code in will.get("employees") or []:
        role = ProactiveRepository.get_role(code)
        if role and str(role.status or "").lower() != "archived":
            owner = org_registry.find_artifact_owner("employee", code)
            conflicts.append(
                {
                    "type": "employee",
                    "id": code,
                    "reason": "already_exists",
                    "owned_by": owner or "",
                }
            )
    return conflicts


def preflight_organization(
    *,
    source: dict[str, Any],
    workspace_path: str | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    pack: LoadedPack | None = None
    try:
        pack = load_pack_from_source(
            source_type=str(source.get("type") or ""),
            path=source.get("path"),
            url=source.get("url"),
            repo=source.get("repo"),
        )
        prefix = _id_prefix(options)
        will = _plan_will_install(pack, prefix=prefix)
        conflicts = _collect_conflicts(will)
        policy = _conflict_policy(options)
        blocking = conflicts if policy == "fail" else []
        missing_deps: list[str] = []
        deps = pack.manifest.get("dependencies") if isinstance(pack.manifest.get("dependencies"), dict) else {}
        # Platform range check is advisory in Phase 1 (no semver engine yet).
        if deps.get("platform"):
            missing_deps.append(f"platform range declared: {deps['platform']} (not enforced in Phase 1)")

        warnings: list[str] = []
        if will.get("extensions"):
            warnings.append("extensions install skipped in Phase 1 (no Tauri from Gateway)")
        if will.get("mcp"):
            warnings.append("mcp registration skipped in Phase 1")
        if will.get("vaults"):
            warnings.append("vault import skipped in Phase 1")
        if not (workspace_path or "").strip():
            ws = pack.manifest.get("workspace") if isinstance(pack.manifest.get("workspace"), dict) else {}
            if not ws.get("path"):
                warnings.append("workspace_path not set; employee workspace_path placeholders may be empty")

        ok = len(blocking) == 0
        return {
            "ok": ok,
            "pack_id": pack.pack_id,
            "pack_version": pack.pack_version,
            "kind": pack.kind,
            "will_install": will,
            "conflicts": blocking,
            "all_conflicts": conflicts,
            "missing_deps": missing_deps,
            "warnings": warnings,
        }
    except PackManifestError as e:
        return {
            "ok": False,
            "pack_id": "",
            "pack_version": "",
            "kind": "",
            "will_install": {},
            "conflicts": [],
            "all_conflicts": [],
            "missing_deps": [],
            "warnings": [],
            "error": str(e),
        }
    finally:
        if pack is not None:
            pack.cleanup()


def _undo_stack() -> list[tuple[str, Callable[[], None]]]:
    return []


def install_organization(
    *,
    source: dict[str, Any],
    workspace_path: str | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Install a resource pack. Rollback on failure when possible."""
    pre = preflight_organization(source=source, workspace_path=workspace_path, options=options)
    if not pre.get("ok"):
        err = pre.get("error") or "preflight failed"
        if pre.get("conflicts"):
            err = f"conflicts: {pre['conflicts']}"
        raise OrganizationInstallError(str(err), rolled_back=False)

    pack = load_pack_from_source(
        source_type=str(source.get("type") or ""),
        path=source.get("path"),
        url=source.get("url"),
        repo=source.get("repo"),
    )
    prefix = _id_prefix(options)
    policy = _conflict_policy(options)
    org_root = str(pack.root)
    org_ws = str(workspace_path or "").strip()
    ws_cfg = pack.manifest.get("workspace") if isinstance(pack.manifest.get("workspace"), dict) else {}
    if not org_ws:
        org_ws = str(ws_cfg.get("path") or "").strip()
    if org_ws and bool(ws_cfg.get("create_if_missing", True)):
        Path(org_ws).mkdir(parents=True, exist_ok=True)
        tpl = str(ws_cfg.get("template") or "").strip()
        if tpl:
            try:
                src = resolve_pack_rel(pack, tpl)
                if src.is_dir():
                    for child in src.iterdir():
                        dest = Path(org_ws) / child.name
                        if child.is_dir() and not dest.exists():
                            shutil.copytree(child, dest)
                        elif child.is_file() and not dest.exists():
                            shutil.copy2(child, dest)
            except PackManifestError as e:
                logger.warning("workspace template skipped: %s", e)

    try:
        from evoflow.admin import agents as agents_admin
        from evoflow.admin import apps as apps_admin
        from evoflow.admin import employees as employees_admin
        from evoflow.admin.errors import ConflictError
        from evoflow.skills.installer import install_skill_from_directory
        from evoflow.skills.loader import clear_skills_cache

        undo = _undo_stack()
        artifacts: dict[str, list[str]] = {
            "agents": [],
            "employees": [],
            "apps": [],
            "skills": [],
            "extensions": [],
            "vaults": [],
            "mcp": [],
        }
        warnings: list[str] = list(pre.get("warnings") or [])

        try:
            prim = pack.manifest.get("primitives") if isinstance(pack.manifest.get("primitives"), dict) else {}

            # 1) skills
            for ref in list(prim.get("skills") or []):
                if not isinstance(ref, dict):
                    continue
                if ref.get("slug"):
                    warnings.append(f"skill slug install skipped (Phase 2): {ref['slug']}")
                    continue
                rel = str(ref.get("path") or "").strip()
                if not rel:
                    continue
                skill_dir = resolve_pack_rel(pack, rel)
                try:
                    result = install_skill_from_directory(skill_dir)
                    sname = str(result.get("skill_name") or skill_dir.name)
                    artifacts["skills"].append(sname)

                    def _undo_skill(name: str = sname) -> None:
                        try:
                            from evoflow.admin import skills as skills_admin

                            skills_admin.delete_skill(name)
                        except Exception:
                            logger.debug("rollback skill failed name=%s", name, exc_info=True)

                    undo.append(("skill", _undo_skill))
                except Exception as e:
                    if "already" in str(e).lower() or "exist" in str(e).lower():
                        if policy == "fail":
                            raise OrganizationInstallError(f"skill conflict: {e}") from e
                        warnings.append(f"skill skipped: {e}")
                    else:
                        raise

            clear_skills_cache()

            # 2) agents
            for ref in list(prim.get("agents") or []):
                if not isinstance(ref, dict):
                    continue
                from_path = str(ref.get("from") or "").strip()
                if not from_path:
                    continue
                agent_def = load_agent_definition(pack, from_path)
                code = str(
                    ref.get("id_override") or agent_def.get("agent_code") or agent_def.get("name") or ""
                ).strip()
                code = _prefixed(code, prefix)
                if not code:
                    continue
                payload = {
                    "agent_code": code,
                    "agent_name": str(agent_def.get("agent_name") or code),
                    "description": str(agent_def.get("description") or ""),
                    "agent_type": str(agent_def.get("agent_type") or "custom"),
                    "skills": list(agent_def.get("skills") or []),
                    "tools": list(agent_def.get("tools") or []),
                    "tool_groups": list(agent_def.get("tool_groups") or []),
                    "mcp_servers": list(agent_def.get("mcp_servers") or []),
                    "tags": list(agent_def.get("tags") or []),
                    "soul": str(agent_def.get("soul") or agent_def.get("system_prompt") or ""),
                }
                if agent_def.get("system_prompt") and not payload["soul"]:
                    payload["system_prompt"] = agent_def["system_prompt"]
                try:
                    agents_admin.create_agent(payload)
                    artifacts["agents"].append(code)

                    def _undo_agent(c: str = code) -> None:
                        try:
                            agents_admin.delete_agent(c)
                        except Exception:
                            logger.debug("rollback agent failed code=%s", c, exc_info=True)

                    undo.append(("agent", _undo_agent))
                except ConflictError as e:
                    if policy == "fail":
                        raise OrganizationInstallError(str(e)) from e
                    if policy == "skip":
                        warnings.append(f"agent exists, skipped: {code}")
                    else:
                        agents_admin.update_agent(code, payload)
                        artifacts["agents"].append(code)
                        warnings.append(f"agent replaced: {code}")

            # 3) employees
            team = pack.manifest.get("team") if isinstance(pack.manifest.get("team"), dict) else {}
            for ref in list(team.get("employees") or []):
                if not isinstance(ref, dict):
                    continue
                from_path = str(ref.get("from") or "").strip()
                if not from_path:
                    continue
                emp = load_json_ref(pack, from_path)
                emp = deep_apply_placeholders(emp, org_workspace=org_ws, org_root=org_root)
                code = _prefixed(str(emp.get("agent_code") or "").strip(), prefix)
                if not code:
                    continue
                cfg = emp.get("config") if isinstance(emp.get("config"), dict) else {}
                hire_data: dict[str, Any] = {
                    "agent_code": code,
                    "role_name": str(emp.get("role_name") or code),
                    "position_code": str(emp.get("position_code") or ""),
                    "department": str(emp.get("department") or ""),
                    "reports_to": _prefixed(str(emp.get("reports_to") or "").strip(), prefix)
                    if emp.get("reports_to")
                    else "",
                    "status": "active",
                }
                for k in (
                    "workspace_path",
                    "knowledge_vault_ids",
                    "skills",
                    "autonomy_level",
                    "responsibilities",
                    "domain_scope",
                    "kpis",
                    "max_turns",
                    "timeout_seconds",
                    "tool_groups",
                    "daily_budget_usd",
                ):
                    if k in cfg:
                        hire_data[k] = cfg[k]
                    elif k in emp:
                        hire_data[k] = emp[k]
                if cfg.get("schedule") and not hire_data.get("heartbeat_rrule"):
                    hire_data["heartbeat_rrule"] = cfg["schedule"]
                if cfg.get("budget_daily_usd") is not None and "daily_budget_usd" not in hire_data:
                    hire_data["daily_budget_usd"] = cfg["budget_daily_usd"]
                try:
                    employees_admin.hire(hire_data)
                    artifacts["employees"].append(code)

                    def _undo_emp(c: str = code) -> None:
                        try:
                            from evoflow.proactive.repositories import ProactiveRepository

                            ProactiveRepository.delete_role(c)
                        except Exception:
                            logger.debug("rollback employee failed code=%s", c, exc_info=True)

                    undo.append(("employee", _undo_emp))
                except ConflictError as e:
                    if policy == "fail":
                        raise OrganizationInstallError(str(e)) from e
                    warnings.append(f"employee exists, skipped: {code}")
                except Exception as e:
                    msg = str(e).lower()
                    if "already" in msg or "exist" in msg:
                        if policy == "fail":
                            raise OrganizationInstallError(str(e)) from e
                        warnings.append(f"employee skipped: {code} ({e})")
                    else:
                        raise

            # 4) apps / pipelines
            pipes = pack.manifest.get("pipelines") if isinstance(pack.manifest.get("pipelines"), dict) else {}
            for ref in list(pipes.get("apps") or []):
                if not isinstance(ref, dict):
                    continue
                from_path = str(ref.get("from") or "").strip()
                if not from_path:
                    continue
                app_doc = load_json_ref(pack, from_path)
                app_doc = deep_apply_placeholders(app_doc, org_workspace=org_ws, org_root=org_root)
                steps = list(app_doc.get("steps") or [])
                for step in steps:
                    if isinstance(step, dict) and step.get("assigned_agent"):
                        step["assigned_agent"] = _prefixed(str(step["assigned_agent"]), prefix)
                created = apps_admin.create_app(
                    name=str(app_doc.get("name") or Path(from_path).stem),
                    description=str(app_doc.get("description") or ""),
                    icon=str(app_doc.get("icon") or ""),
                    category=str(app_doc.get("category") or "general"),
                    parameters=list(app_doc.get("parameters") or []),
                    steps=steps,
                    goal_template=str(app_doc.get("goal_template") or ""),
                    validation_template=list(app_doc.get("validation_template") or []),
                    flowchart_mermaid=str(app_doc.get("flowchart_mermaid") or ""),
                    execution_mode=str(app_doc.get("execution_mode") or "workflow"),
                    auto_run=bool(app_doc.get("auto_run") or False),
                    source="organization_pack",
                    tags=list(app_doc.get("tags") or []) + [f"org:{pack.pack_id}"],
                    canvas=app_doc.get("canvas") if isinstance(app_doc.get("canvas"), dict) else None,
                    plan=app_doc.get("plan") if isinstance(app_doc.get("plan"), dict) else None,
                )
                app_id = str(created.get("app_id") or created.get("appId") or "")
                if app_id:
                    artifacts["apps"].append(app_id)

                    def _undo_app(aid: str = app_id) -> None:
                        try:
                            apps_admin.delete_app(aid)
                        except Exception:
                            logger.debug("rollback app failed id=%s", aid, exc_info=True)

                    undo.append(("app", _undo_app))

            if prim.get("extensions"):
                warnings.append("extensions not installed (Phase 1)")
            if prim.get("mcp"):
                warnings.append("mcp not registered (Phase 1)")
            if prim.get("vaults"):
                warnings.append("vaults not imported (Phase 1)")

            org_instance_id = f"org_{pack.pack_id}_{_now_stamp()}"
            instance = org_registry.insert_org_instance(
                org_instance_id=org_instance_id,
                pack_id=pack.pack_id,
                pack_version=pack.pack_version,
                kind=pack.kind,
                workspace_path=org_ws or None,
                manifest=pack.manifest,
                artifacts=artifacts,
            )
            instance["warnings"] = warnings
            return instance

        except Exception as e:
            logger.exception("organization install failed pack_id=%s", pack.pack_id)
            for _label, fn in reversed(undo):
                try:
                    fn()
                except Exception:
                    logger.debug("rollback step failed", exc_info=True)
            if isinstance(e, OrganizationInstallError):
                raise OrganizationInstallError(str(e), rolled_back=True) from e
            raise OrganizationInstallError(str(e), rolled_back=True) from e
    finally:
        pack.cleanup()


def uninstall_organization(
    org_instance_id: str,
    *,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    opts = options or {}
    keep_primitives = bool(opts.get("keep_primitives", False))
    keep_workspace = bool(opts.get("keep_workspace", True))
    keep_vault_data = bool(opts.get("keep_vault_data", True))
    del keep_vault_data  # Phase 1: vaults not installed

    inst = org_registry.get_org_instance(org_instance_id)
    if not inst:
        raise OrganizationInstallError(f"Organization instance not found: {org_instance_id}")
    if inst.get("status") == "uninstalled":
        return {"ok": True, "org_instance_id": org_instance_id, "removed": {}, "kept": {}}

    arts = inst.get("artifacts") or {}
    removed: dict[str, list[str]] = {
        "employees": [],
        "apps": [],
        "extensions": [],
        "agents": [],
        "skills": [],
        "mcp": [],
        "vaults": [],
    }
    kept: dict[str, Any] = {"agents": [], "skills": [], "workspace_path": None, "vaults": []}

    from evoflow.admin import agents as agents_admin
    from evoflow.admin import apps as apps_admin
    from evoflow.admin import skills as skills_admin
    from evoflow.proactive.repositories import ProactiveRepository

    for code in list(arts.get("employees") or []):
        try:
            ProactiveRepository.delete_role(code)
            removed["employees"].append(code)
        except Exception as e:
            logger.warning("uninstall employee failed code=%s err=%s", code, e)

    for aid in list(arts.get("apps") or []):
        try:
            apps_admin.delete_app(aid)
            removed["apps"].append(aid)
        except Exception as e:
            logger.warning("uninstall app failed id=%s err=%s", aid, e)

    if not keep_primitives:
        for code in list(arts.get("agents") or []):
            try:
                agents_admin.delete_agent(code)
                removed["agents"].append(code)
            except Exception as e:
                logger.warning("uninstall agent failed code=%s err=%s", code, e)
                kept["agents"].append(code)
        for sname in list(arts.get("skills") or []):
            try:
                skills_admin.delete_skill(sname)
                removed["skills"].append(sname)
            except Exception as e:
                logger.warning("uninstall skill failed name=%s err=%s", sname, e)
                kept["skills"].append(sname)
    else:
        kept["agents"] = list(arts.get("agents") or [])
        kept["skills"] = list(arts.get("skills") or [])

    ws = inst.get("workspace_path")
    if ws and not keep_workspace:
        try:
            shutil.rmtree(ws, ignore_errors=True)
        except Exception:
            logger.debug("workspace delete failed path=%s", ws, exc_info=True)
    else:
        kept["workspace_path"] = ws

    org_registry.mark_uninstalled(org_instance_id)
    return {
        "ok": True,
        "org_instance_id": org_instance_id,
        "removed": removed,
        "kept": kept,
    }
