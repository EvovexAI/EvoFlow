"""Install / preflight / uninstall Organization Packs (资源包)."""

from __future__ import annotations

import logging
import re
import shutil
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from evoflow.organizations import registry as org_registry
from evoflow.organizations.manifest import (
    LoadedPack,
    PackManifestError,
    deep_apply_placeholders,
    load_agent_definition,
    load_json_ref,
    load_pack_from_source,
    resolve_pack_rel,
)

logger = logging.getLogger(__name__)


class OrganizationInstallError(RuntimeError):
    def __init__(self, message: str, *, rolled_back: bool = False) -> None:
        super().__init__(message)
        self.rolled_back = rolled_back


def _now_stamp() -> str:
    # 毫秒精度：同一秒内重复安装同一 pack 不会再撞 org_instance_id 唯一键
    return datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")[:-3]


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
        "knowledge": [],
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

    for ref in list(prim.get("knowledge") or []):
        if isinstance(ref, dict) and str(ref.get("name") or "").strip():
            will["knowledge"].append(str(ref["name"]))

    for ref in list(prim.get("extensions") or []):
        if isinstance(ref, dict):
            label = str(ref.get("from") or ref.get("ref") or ref.get("path") or ref.get("id") or "?")
            will["extensions"].append(label)

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
        if role:
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


_KB_REF_RE = re.compile(r"\$\{KB_REF:([^}]+)\}")


def _apply_kb_refs(obj: Any, kb_refs: dict[str, str]) -> tuple[Any, list[str]]:
    """递归把 ``${KB_REF:ref}`` 替换为安装期解析出的真实 kb_id。

    返回 ``(新对象, 未命中的 ref 列表)``；未命中的保留原文，由员工 hire 的
    kb 校验按冲突策略兜底。
    """
    unknown: list[str] = []

    def _walk(o: Any) -> Any:
        if isinstance(o, str):
            if "${KB_REF:" not in o:
                return o

            def _repl(m: re.Match[str]) -> str:
                ref = m.group(1).strip()
                kb_id = kb_refs.get(ref)
                if not kb_id:
                    if ref not in unknown:
                        unknown.append(ref)
                    return m.group(0)
                return kb_id

            return _KB_REF_RE.sub(_repl, o)
        if isinstance(o, list):
            return [_walk(x) for x in o]
        if isinstance(o, dict):
            return {k: _walk(v) for k, v in o.items()}
        return o

    return _walk(obj), unknown


def _ensure_knowledge_base(pack: LoadedPack, ref: dict[str, Any]) -> tuple[str, bool]:
    """按 name 幂等 get-or-create owned 知识库；可选从目录导入文档。

    ``import_folder`` 支持包内相对路径（便携，推荐）与绝对路径（本机数据）。
    返回 ``(kb_id, created)``；文档导入为同步拷贝 + 异步索引，重复导入按
    content_hash 去重（unchanged 不重索引）。
    """
    from evoflow.knowledge.owned import service as owned_service

    name = str(ref.get("name") or "").strip()
    bases = owned_service.list_bases()
    existing = next((b for b in bases if str(b.get("name") or "").strip() == name), None)
    created = existing is None
    if existing is not None:
        kb_id = str(existing.get("id") or "")
    else:
        payload: dict[str, Any] = {"name": name}
        if ref.get("description"):
            payload["description"] = str(ref["description"])
        created_base = owned_service.create_base(payload)
        kb_id = str(created_base.get("id") or "")
    if not kb_id:
        raise OrganizationInstallError(f"knowledge base '{name}' could not be resolved")

    rel = str(ref.get("import_folder") or "").strip()
    if rel:
        p = Path(rel).expanduser()
        root = p if p.is_absolute() else resolve_pack_rel(pack, rel)
        if not root.is_dir():
            raise OrganizationInstallError(f"knowledge import_folder not found: {root}")
        stats = owned_service.import_local_folder(
            kb_id,
            str(root),
            upsert=bool(ref.get("upsert", True)),
            prune_missing=bool(ref.get("prune_missing", False)),
            folder_prefix=str(ref.get("folder_prefix") or ""),
        )
        logger.info(
            "org pack knowledge import kb=%s created=%s updated=%s unchanged=%s skipped=%s",
            kb_id,
            stats.get("created"),
            stats.get("updated"),
            stats.get("unchanged"),
            stats.get("skipped"),
        )
    return kb_id, created


def _install_extension_ref(pack: LoadedPack, ref: dict[str, Any], *, source: str) -> dict[str, Any] | None:
    """安装一个 extensions 原语条目；legacy ``{id}`` 形态返回 None（调用方记 warning）。"""
    from evoflow.admin.ui_extensions_registry import (
        ExtensionValidationError,
        register_directory,
        upsert_row,
    )

    if ref.get("from"):
        src = resolve_pack_rel(pack, str(ref["from"]))
        return register_directory(src, link=ref.get("link"), source=source)
    if ref.get("path"):
        p = Path(str(ref["path"])).expanduser()
        return register_directory(p, link=bool(ref.get("link", True)), source=source)
    if ref.get("manifest") is not None:
        install_path = str(ref.get("install_path") or "").strip()
        if not install_path:
            raise ExtensionValidationError("extension entry with manifest requires install_path")
        manifest = ref["manifest"]
        return upsert_row(manifest if isinstance(manifest, dict) else {}, install_path, source)
    return None


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
            "knowledge": [],
            "extensions": [],
            "vaults": [],
            "mcp": [],
        }
        warnings: list[str] = list(pre.get("warnings") or [])

        try:
            prim = pack.manifest.get("primitives") if isinstance(pack.manifest.get("primitives"), dict) else {}

            # 0) knowledge（必须在 employees 前：hire 会校验 kb id 已存在）
            kb_refs: dict[str, str] = {}
            for ref in list(prim.get("knowledge") or []):
                if not isinstance(ref, dict):
                    continue
                name = str(ref.get("name") or "").strip()
                if not name:
                    warnings.append("knowledge entry missing name, skipped")
                    continue
                try:
                    kb_id, created = _ensure_knowledge_base(pack, ref)
                except Exception as e:
                    if policy == "fail":
                        raise OrganizationInstallError(f"knowledge install failed: {e}") from e
                    warnings.append(f"knowledge skipped: {e}")
                    continue
                ref_key = str(ref.get("ref") or "").strip() or name
                kb_refs[ref_key] = kb_id
                kb_refs[name] = kb_id
                artifacts["knowledge"].append(kb_id)
                if created:

                    def _undo_kb(k: str = kb_id) -> None:
                        try:
                            from evoflow.knowledge.owned import service as owned_service

                            owned_service.delete_base(k)
                        except Exception:
                            logger.debug("rollback knowledge base failed kb=%s", k, exc_info=True)

                    undo.append(("knowledge", _undo_kb))
                warnings.append(f"knowledge base '{name}' ready ({'created' if created else 'reused'})")

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
                code = str(ref.get("id_override") or agent_def.get("agent_code") or agent_def.get("name") or "").strip()
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
                emp, kb_unknown = _apply_kb_refs(emp, kb_refs)
                code = _prefixed(str(emp.get("agent_code") or "").strip(), prefix)
                if not code:
                    continue
                for u in kb_unknown:
                    warnings.append(
                        f"employee {code}: KB_REF '{u}' 未命中（manifest 未声明同名 knowledge 原语），保留原文"
                    )
                cfg = emp.get("config") if isinstance(emp.get("config"), dict) else {}
                hire_data: dict[str, Any] = {
                    "agent_code": code,
                    "role_name": str(emp.get("role_name") or code),
                    "position_code": str(emp.get("position_code") or ""),
                    "department": str(emp.get("department") or ""),
                    "reports_to": _prefixed(str(emp.get("reports_to") or "").strip(), prefix) if emp.get("reports_to") else "",
                    "status": "active",
                }
                for k in (
                    "workspace_path",
                    "knowledge_vault_ids",
                    "skills",
                    "autonomy_level",
                    "responsibilities",
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
                    if policy == "skip":
                        warnings.append(f"employee exists, skipped: {code}")
                    else:
                        # replace：删旧岗重建（复用 hire 全套校验/默认值，kb 绑定等随之更新）；
                        # 重建失败时用快照还原，避免把已有员工删没。
                        from evoflow.proactive.repositories import ProactiveRepository as _PR

                        snapshot = _PR.get_role(code)
                        try:
                            _PR.delete_role(code)
                        except Exception as del_e:
                            warnings.append(f"employee replace skipped (delete failed): {del_e}")
                            continue
                        try:
                            employees_admin.hire(hire_data)
                            artifacts["employees"].append(code)
                            warnings.append(f"employee replaced: {code}")
                        except Exception as re_e:
                            if snapshot is not None:
                                try:
                                    _PR.save_role(snapshot)
                                    warnings.append(f"employee replace failed (restored original): {re_e}")
                                except Exception:
                                    warnings.append(f"employee replace failed (restore also failed): {re_e}")
                            else:
                                warnings.append(f"employee replace failed: {re_e}")
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
                app_doc, kb_unknown = _apply_kb_refs(app_doc, kb_refs)
                for u in kb_unknown:
                    warnings.append(f"app '{app_doc.get('name', from_path)}': KB_REF '{u}' 未命中，保留原文")
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

            # 5) extensions（注册表与面板共享：evoflow.admin.ui_extensions_registry）
            ext_source = f"org_pack:{pack.pack_id}"
            for ref in list(prim.get("extensions") or []):
                if not isinstance(ref, dict):
                    continue
                try:
                    row = _install_extension_ref(pack, ref, source=ext_source)
                except Exception as e:
                    if policy == "fail":
                        raise OrganizationInstallError(f"extension install failed: {e}") from e
                    warnings.append(f"extension skipped: {e}")
                    continue
                if row is None:
                    warnings.append(f"extension id-only entry recorded only (legacy): {ref.get('id')}")
                    continue
                ext_id = str(row.get("id") or "")
                if not ext_id:
                    continue
                artifacts["extensions"].append(ext_id)
                if str(row.get("source") or "").endswith("folder-link"):
                    warnings.append(f"extension '{ext_id}' 为 folder-link（登记本机路径，包不可便携）")

                def _undo_ext(eid: str = ext_id) -> None:
                    try:
                        from evoflow.admin.ui_extensions_registry import remove_row

                        remove_row(eid)
                    except Exception:
                        logger.debug("rollback extension failed id=%s", eid, exc_info=True)

                undo.append(("extension", _undo_ext))

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
    # keep_vault_data 为历史别名；知识库默认保留（数据安全），显式 delete_knowledge 才删
    keep_knowledge = bool(opts.get("keep_knowledge", bool(opts.get("keep_vault_data", True))))

    inst = org_registry.get_org_instance(org_instance_id)
    if not inst:
        raise OrganizationInstallError(f"Organization instance not found: {org_instance_id}")
    if inst.get("status") == "uninstalled":
        return {"ok": True, "org_instance_id": org_instance_id, "removed": {}, "kept": {}}

    arts = inst.get("artifacts") or {}
    removed: dict[str, list[str]] = {
        "employees": [],
        "apps": [],
        "knowledge": [],
        "extensions": [],
        "agents": [],
        "skills": [],
        "mcp": [],
        "vaults": [],
    }
    kept: dict[str, Any] = {"agents": [], "skills": [], "workspace_path": None, "knowledge": []}

    from evoflow.admin import agents as agents_admin
    from evoflow.admin import apps as apps_admin
    from evoflow.admin import skills as skills_admin
    from evoflow.admin.ui_extensions_registry import remove_row as ext_remove_row
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

    for eid in list(arts.get("extensions") or []):
        try:
            ext_remove_row(eid)
            removed["extensions"].append(eid)
        except Exception as e:
            logger.warning("uninstall extension failed id=%s err=%s", eid, e)

    kb_ids = list(arts.get("knowledge") or [])
    if not keep_knowledge:
        from evoflow.knowledge.owned import service as owned_service

        for kb_id in kb_ids:
            try:
                owned_service.delete_base(kb_id)
                removed["knowledge"].append(kb_id)
            except Exception as e:
                logger.warning("uninstall knowledge base failed kb=%s err=%s", kb_id, e)
    else:
        kept["knowledge"] = kb_ids

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
