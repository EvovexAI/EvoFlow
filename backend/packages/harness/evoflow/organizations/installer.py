"""Install / preflight / uninstall Organization Packs (资源包)."""

from __future__ import annotations

import logging
import re
import shutil
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from evoflow.organizations import registry as org_registry
from evoflow.organizations.manifest import (
    LoadedPack,
    PackManifestError,
    apply_placeholders,
    deep_apply_placeholders,
    load_agent_definition,
    load_json_ref,
    load_pack_from_source,
    resolve_pack_rel,
)

logger = logging.getLogger(__name__)

# Per-pack_id install mutex (same-process). Prevents concurrent org.install of the
# same pack from racing create_agent/hire then rolling back each other's artifacts.
_PACK_INSTALL_LOCKS: dict[str, threading.Lock] = {}
_PACK_INSTALL_LOCKS_GUARD = threading.Lock()


def _pack_install_lock(pack_id: str) -> threading.Lock:
    key = str(pack_id or "").strip() or "_"
    with _PACK_INSTALL_LOCKS_GUARD:
        lock = _PACK_INSTALL_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PACK_INSTALL_LOCKS[key] = lock
        return lock


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


# Employee hire keys the org installer forwards from employees/*.json (config or top-level).
_EMP_HIRE_FORWARD_KEYS = (
    "workspace_path",
    "knowledge_vault_ids",
    "skills",
    "tools",
    "mcp_servers",
    "autonomy_level",
    "responsibilities",
    "kpis",
    "max_turns",
    "timeout_seconds",
    "daily_budget_usd",
    "soul_md",
    "model_name",
    "kb_injection",
    "think_mode",
    "thinking_enabled",
)


def _knowledge_readiness(kb_ids: list[str]) -> dict[str, Any]:
    """Snapshot owned-KB indexing progress for install return payload."""
    bases_out: list[dict[str, Any]] = []
    ready_all = True
    try:
        from evoflow.knowledge.owned import service as owned_service

        listed = {str(b.get("id") or ""): b for b in (owned_service.list_bases() or [])}
        for kid in kb_ids:
            kid = str(kid or "").strip()
            if not kid:
                continue
            b = listed.get(kid) or {}
            health = b.get("documentHealth") if isinstance(b.get("documentHealth"), dict) else {}
            pending = int(health.get("pending") or 0)
            processing = int(health.get("processing") or 0)
            failed = int(health.get("failed") or 0)
            ready_docs = int(health.get("ready") or 0)
            total = int(b.get("documentCount") or ready_docs + pending + processing + failed)
            is_ready = pending == 0 and processing == 0 and failed == 0
            if not is_ready:
                ready_all = False
            bases_out.append(
                {
                    "id": kid,
                    "name": b.get("name"),
                    "document_count": total,
                    "document_health": {
                        "ready": ready_docs,
                        "pending": pending,
                        "processing": processing,
                        "failed": failed,
                    },
                    "ready": is_ready,
                    "status": b.get("status"),
                }
            )
    except Exception as e:
        logger.debug("knowledge readiness snapshot failed: %s", e, exc_info=True)
        ready_all = False
        bases_out = [{"id": k, "ready": False, "error": str(e)} for k in kb_ids if k]
    return {
        "ready": ready_all and bool(bases_out or not kb_ids),
        "knowledge": bases_out,
        "note": None
        if ready_all
        else "knowledge bases still indexing; poll knowledge.bases / documentHealth",
    }


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


def _collect_conflicts(
    will: dict[str, list[str]],
    *,
    pack_id: str | None = None,
) -> list[dict[str, str]]:
    """Shared conflict scan for preflight and install (same data sources)."""
    from evoflow.admin import agents as agents_admin
    from evoflow.admin.errors import NotFoundError
    from evoflow.proactive.repositories import ProactiveRepository

    conflicts: list[dict[str, str]] = []
    pid = str(pack_id or "").strip()
    if pid:
        active = org_registry.find_active_instance_for_pack(pid)
        if active:
            conflicts.append(
                {
                    "type": "org_instance",
                    "id": active,
                    "reason": "pack_already_installed",
                    "owned_by": active,
                }
            )

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
        # Same lock as install so preflight sees a stable world vs concurrent install.
        with _pack_install_lock(pack.pack_id):
            conflicts = _collect_conflicts(will, pack_id=pack.pack_id)
        policy = _conflict_policy(options)
        blocking = conflicts if policy == "fail" else []
        missing_deps: list[str] = []
        deps = pack.manifest.get("dependencies") if isinstance(pack.manifest.get("dependencies"), dict) else {}
        # Platform range check is advisory in Phase 1 (no semver engine yet).
        if deps.get("platform"):
            missing_deps.append(f"platform range declared: {deps['platform']} (not enforced in Phase 1)")

        warnings: list[str] = []
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


def _install_extension_ref(
    pack: LoadedPack,
    ref: dict[str, Any],
    *,
    source: str,
    portable: bool = False,
) -> dict[str, Any] | None:
    """安装一个 extensions 原语条目；legacy ``{id}`` 形态返回 None（调用方记 warning）。

    ``portable=True``（zip/市场安装）强制 copy 到 ``ui-extensions/<id>/``，
    忽略 pack / manifest 上的 ``link``，避免链到已删除的临时解压目录。
    """
    from evoflow.admin.ui_extensions_registry import (
        ExtensionValidationError,
        register_directory,
        upsert_row,
    )
    from evoflow.organizations.pack_persist import clear_extension_service_link

    if ref.get("from"):
        src = resolve_pack_rel(pack, str(ref["from"]))
        link = False if portable else ref.get("link")
        row = register_directory(src, link=link, source=source)
        if portable and row:
            clear_extension_service_link(Path(str(row.get("install_path") or "")))
        return row
    if ref.get("path"):
        p = Path(str(ref["path"])).expanduser()
        link = False if portable else bool(ref.get("link", True))
        row = register_directory(p, link=link, source=source)
        if portable and row:
            clear_extension_service_link(Path(str(row.get("install_path") or "")))
        return row
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
    """Install a resource pack. Rollback on failure when possible.

    Conflict checks use the same ``_collect_conflicts`` as preflight, under a
    per-``pack_id`` lock so concurrent installs cannot race hire/create_agent.
    """
    pack = load_pack_from_source(
        source_type=str(source.get("type") or ""),
        path=source.get("path"),
        url=source.get("url"),
        repo=source.get("repo"),
    )
    from evoflow.organizations.pack_persist import (
        pack_needs_persist,
        persist_pack_tree,
        source_requires_portable,
    )

    prefix = _id_prefix(options)
    policy = _conflict_policy(options)
    # Capture portable intent before lock; actual persist runs AFTER replace uninstall
    # so we do not delete the tree we just copied into org-packs/.
    want_portable = source_requires_portable(source, options) or pack_needs_persist(pack)

    lock = _pack_install_lock(pack.pack_id)
    if not lock.acquire(blocking=True, timeout=120):
        raise OrganizationInstallError(
            f"install lock timeout for pack_id={pack.pack_id}",
            rolled_back=False,
        )
    try:
        from evoflow.admin import agents as agents_admin
        from evoflow.admin import apps as apps_admin
        from evoflow.admin import employees as employees_admin
        from evoflow.admin.errors import ConflictError
        from evoflow.skills.installer import install_skill_from_directory
        from evoflow.skills.loader import clear_skills_cache

        will = _plan_will_install(pack, prefix=prefix)
        # replace：先卸掉同 pack 的 active 实例，避免双实例 + 再撞 Role
        if policy == "replace":
            active_oid = org_registry.find_active_instance_for_pack(pack.pack_id)
            if active_oid:
                try:
                    uninstall_organization(
                        active_oid,
                        options={
                            "keep_primitives": False,
                            "keep_workspace": False,
                            "keep_knowledge": True,  # 知识库 upsert 复用；真删留给显式 uninstall
                            "_holding_pack_lock": True,
                        },
                    )
                except Exception as e:
                    logger.warning(
                        "replace: uninstall prior instance %s failed: %s",
                        active_oid,
                        e,
                    )

        # Persist after replace cleanup (zip/temp → durable org-packs/).
        portable = want_portable
        if pack_needs_persist(pack) or (portable and pack.cleanup_dirs):
            pack = persist_pack_tree(pack)
            portable = True

        org_root = str(pack.root)
        org_ws = str(workspace_path or "").strip()
        ws_cfg = pack.manifest.get("workspace") if isinstance(pack.manifest.get("workspace"), dict) else {}
        if not org_ws:
            org_ws = str(ws_cfg.get("path") or "").strip()
        if org_ws:
            org_ws = apply_placeholders(org_ws, org_workspace="", org_root=org_root)
            org_ws = apply_placeholders(org_ws, org_workspace=org_ws, org_root=org_root)
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

        conflicts = _collect_conflicts(will, pack_id=pack.pack_id)
        if policy == "fail" and conflicts:
            raise OrganizationInstallError(
                f"conflicts: {conflicts}",
                rolled_back=False,
            )

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
        warnings: list[str] = []
        if will.get("vaults"):
            warnings.append("vault import skipped in Phase 1")

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

            # 0.5) MCP（必须在 agents 前：create_agent 会校验 mcp_servers 已注册）
            from evoflow.admin import mcp as mcp_admin
            from evoflow.admin.errors import NotFoundError as _McpNotFound

            for ref in list(prim.get("mcp") or []):
                if not isinstance(ref, dict):
                    continue
                from_path = str(ref.get("from") or "").strip()
                if not from_path:
                    warnings.append("mcp entry missing from, skipped")
                    continue
                try:
                    mcp_doc = load_json_ref(pack, from_path)
                except Exception as e:
                    if policy == "fail":
                        raise OrganizationInstallError(f"mcp load failed: {e}") from e
                    warnings.append(f"mcp skipped (load failed): {e}")
                    continue
                name = str(mcp_doc.get("name") or Path(from_path).stem).strip()
                if not name:
                    warnings.append(f"mcp entry missing name: {from_path}")
                    continue
                cfg = {k: v for k, v in mcp_doc.items() if k != "name"}
                if not isinstance(cfg, dict) or not cfg:
                    warnings.append(f"mcp '{name}' empty config, skipped")
                    continue
                existed = False
                try:
                    mcp_admin.get_mcp_server(name)
                    existed = True
                except _McpNotFound:
                    existed = False
                except Exception:
                    existed = False
                try:
                    # MCP 常跨包共用：默认幂等复用；replace 才覆盖配置
                    if existed and policy != "replace":
                        warnings.append(f"mcp exists, reused: {name}")
                        if name not in artifacts["mcp"]:
                            artifacts["mcp"].append(name)
                        continue
                    mcp_admin.add_mcp_server(name, cfg)
                    artifacts["mcp"].append(name)
                    warnings.append(f"mcp {'replaced' if existed else 'registered'}: {name}")

                    def _undo_mcp(n: str = name, was_new: bool = not existed) -> None:
                        if not was_new:
                            return
                        try:
                            mcp_admin.remove_mcp_server(n)
                        except Exception:
                            logger.debug("rollback mcp failed name=%s", n, exc_info=True)

                    undo.append(("mcp", _undo_mcp))
                except Exception as e:
                    if policy == "fail":
                        raise OrganizationInstallError(f"mcp install failed: {e}") from e
                    warnings.append(f"mcp skipped: {e}")

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
                # link=true / mode=bound: register in place (DB only). Default copy for portable zips.
                # Zip/market installs always copy — bound paths to TEMP die after cleanup.
                skill_mode = str(ref.get("mode") or "").strip().lower()
                if portable:
                    skill_mode = "copy"
                elif not skill_mode:
                    skill_mode = "bound" if bool(ref.get("link")) else "copy"
                try:
                    result = install_skill_from_directory(skill_dir, mode=skill_mode)
                    sname = str(result.get("skill_name") or skill_dir.name)
                    artifacts["skills"].append(sname)
                    if skill_mode == "bound":
                        warnings.append(
                            f"skill '{sname}' registered in place "
                            f"(non-portable; source={skill_dir})"
                        )
                    elif skill_mode == "link":
                        warnings.append(
                            f"skill '{sname}' installed as folder-link "
                            f"(non-portable; source={skill_dir})"
                        )

                    def _undo_skill(name: str = sname) -> None:
                        try:
                            from evoflow.admin import skills as skills_admin

                            skills_admin.delete_skill(name)
                        except Exception:
                            logger.debug("rollback skill failed name=%s", name, exc_info=True)

                    undo.append(("skill", _undo_skill))
                except Exception as e:
                    msg = str(e)
                    scan_fail = "security scan" in msg.lower()
                    # Bound/link skills already live on disk; a doc false-positive
                    # (e.g. markdown ``../../docs``) must not abort agent/SOUL sync.
                    if scan_fail and skill_mode in ("bound", "link"):
                        sname = skill_dir.name
                        warnings.append(
                            f"skill '{sname}' security scan failed (kept existing / skipped): {msg}"
                        )
                        if sname not in artifacts["skills"]:
                            artifacts["skills"].append(sname)
                        continue
                    already = "already" in msg.lower() or "exist" in msg.lower()
                    if not already:
                        raise
                    # Skills are shared across packs (e.g. evoflow-onboarding in 1004+1008).
                    # Idempotent: reuse existing skill; do not fail the whole pack.
                    m = re.search(r"Skill '([^']+)'", msg)
                    sname = (m.group(1) if m else "") or skill_dir.name
                    if policy == "replace":
                        try:
                            from evoflow.admin import skills as skills_admin

                            try:
                                skills_admin.delete_skill(sname)
                            except Exception:
                                logger.debug("delete existing skill before replace failed name=%s", sname, exc_info=True)
                            result = install_skill_from_directory(skill_dir, mode=skill_mode)
                            sname = str(result.get("skill_name") or sname)
                            warnings.append(f"skill replaced: {sname}")
                        except Exception as re_e:
                            warnings.append(f"skill exists, replace failed (kept existing): {re_e}")
                    else:
                        warnings.append(f"skill exists, reused: {sname}")
                    if sname not in artifacts["skills"]:
                        artifacts["skills"].append(sname)

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
                    "mcp_servers": list(agent_def.get("mcp_servers") or []),
                    "tags": list(agent_def.get("tags") or []),
                    "soul": str(agent_def.get("soul") or agent_def.get("system_prompt") or ""),
                    # Pack author curated the allowlist; sync/install must not soft-cap at 12.
                    "confirm_wide_tools": True,
                    # team.employees 负责雇佣；禁止 create_agent 自动建岗，否则立刻撞 Role exists。
                    "as_employee": False,
                }
                if agent_def.get("system_prompt") and not payload["soul"]:
                    payload["system_prompt"] = agent_def["system_prompt"]
                for _extra in ("capability_pack", "tools_extra", "model", "max_turns", "timeout_seconds"):
                    if agent_def.get(_extra) is not None:
                        payload[_extra] = agent_def[_extra]
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
                known = set(_EMP_HIRE_FORWARD_KEYS) | {
                    "agent_code",
                    "role_name",
                    "position_code",
                    "department",
                    "reports_to",
                    "status",
                    "config",
                    "agent_name",
                    "description",
                    "from",
                    "schedule",
                    "budget_daily_usd",
                    "heartbeat_rrule",
                    "heartbeat_schedule",
                }
                for k in _EMP_HIRE_FORWARD_KEYS:
                    if k in cfg:
                        hire_data[k] = cfg[k]
                    elif k in emp:
                        hire_data[k] = emp[k]
                # Soft-warn on unknown keys so pack authors see silent drops.
                for k in list(cfg.keys()) + [x for x in emp.keys() if x != "config"]:
                    if k not in known and not str(k).startswith("_"):
                        warnings.append(
                            f"employee {code}: ignored unknown key '{k}' "
                            f"(not forwarded to hire; see installer whitelist)"
                        )
                if cfg.get("schedule") and not hire_data.get("heartbeat_rrule"):
                    hire_data["heartbeat_rrule"] = cfg["schedule"]
                if cfg.get("budget_daily_usd") is not None and "daily_budget_usd" not in hire_data:
                    hire_data["daily_budget_usd"] = cfg["budget_daily_usd"]
                # Align Agent.max_turns with employee declaration when yaml omitted it.
                if hire_data.get("max_turns") is not None and code in artifacts["agents"]:
                    try:
                        agents_admin.update_agent(
                            code, {"max_turns": int(hire_data["max_turns"])}
                        )
                    except Exception:
                        logger.debug(
                            "employee max_turns → agent mirror skipped code=%s",
                            code,
                            exc_info=True,
                        )
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
            ext_paths: list[str] = []
            for ref in list(prim.get("extensions") or []):
                if not isinstance(ref, dict):
                    continue
                try:
                    row = _install_extension_ref(pack, ref, source=ext_source, portable=portable)
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
                ip = str(row.get("install_path") or "").strip()
                if ip:
                    ext_paths.append(ip)
                if str(row.get("source") or "").endswith("folder-link"):
                    warnings.append(f"extension '{ext_id}' 为 folder-link（登记本机路径，包不可便携）")
                elif portable:
                    warnings.append(f"extension '{ext_id}' 已复制到 {ip or 'ui-extensions'}")

                def _undo_ext(eid: str = ext_id) -> None:
                    try:
                        from evoflow.admin.ui_extensions_registry import remove_row

                        remove_row(eid)
                    except Exception:
                        logger.debug("rollback extension failed id=%s", eid, exc_info=True)

                undo.append(("extension", _undo_ext))

            if prim.get("vaults"):
                warnings.append("vaults not imported (Phase 1)")

            # Durable locations for UI / agent setup
            artifacts["pack_root"] = [org_root]
            if ext_paths:
                artifacts["extension_paths"] = ext_paths
            if portable:
                warnings.append(f"资源包已落盘：{org_root}")

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
            readiness = _knowledge_readiness(list(artifacts.get("knowledge") or []))
            instance["warnings"] = warnings
            instance["pack_root"] = org_root
            instance["portable"] = portable
            instance["rolled_back"] = False
            instance["readiness"] = readiness
            if not readiness.get("ready"):
                warnings.append(
                    "install returned before knowledge indexing finished; see readiness.knowledge"
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
        try:
            lock.release()
        except RuntimeError:
            pass
        pack.cleanup()


def uninstall_organization(
    org_instance_id: str,
    *,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Uninstall an org instance.

    Defaults to a **true delete** of roles / agents / skills / MCP / extensions /
    pack disk tree / knowledge bases. Pass ``keep_primitives`` / ``keep_workspace`` /
    ``keep_knowledge`` to retain. Idempotent: a second call still attempts residual
    cleanup and reports ``not_removed``.
    """
    opts = options or {}
    keep_primitives = bool(opts.get("keep_primitives", False))
    # 默认清掉磁盘工作区 / org-packs；需要保留时显式 keep_workspace=true
    keep_workspace = bool(opts.get("keep_workspace", False))
    # keep_vault_data 为历史别名；默认真删知识库，保留请 keep_knowledge=true
    if "keep_knowledge" in opts:
        keep_knowledge = bool(opts.get("keep_knowledge"))
    elif "keep_vault_data" in opts:
        keep_knowledge = bool(opts.get("keep_vault_data"))
    else:
        keep_knowledge = False

    inst = org_registry.get_org_instance(org_instance_id)
    if not inst:
        raise OrganizationInstallError(f"Organization instance not found: {org_instance_id}")

    pack_id = str(inst.get("pack_id") or "").strip()
    holding = bool(opts.get("_holding_pack_lock"))
    lock = _pack_install_lock(pack_id) if pack_id and not holding else None
    if lock is not None:
        lock.acquire(blocking=True, timeout=120)

    try:
        arts = inst.get("artifacts") if isinstance(inst.get("artifacts"), dict) else {}
        # If artifacts empty (legacy / corrupted), fall back to manifest plan.
        if not any(arts.get(k) for k in ("employees", "agents", "extensions", "skills", "mcp", "knowledge")):
            try:
                from evoflow.organizations.manifest import LoadedPack

                # Reconstruct will-list from stored manifest alone (no pack files).
                man = inst.get("manifest") if isinstance(inst.get("manifest"), dict) else {}
                fake = LoadedPack(
                    root=Path(str((arts.get("pack_root") or [""])[0] or ".")),
                    manifest=man,
                    cleanup_dirs=[],
                )
                planned = _plan_will_install(fake, prefix="")
                for k in ("employees", "agents", "skills", "mcp", "extensions"):
                    if not arts.get(k) and planned.get(k):
                        arts = {**arts, k: list(planned[k])}
            except Exception:
                logger.debug("uninstall: manifest fallback plan skipped", exc_info=True)

        removed: dict[str, list[str]] = {
            "employees": [],
            "apps": [],
            "knowledge": [],
            "extensions": [],
            "agents": [],
            "skills": [],
            "mcp": [],
            "vaults": [],
            "pack_root": [],
        }
        kept: dict[str, Any] = {
            "agents": [],
            "skills": [],
            "mcp": [],
            "workspace_path": None,
            "knowledge": [],
            "pack_root": [],
        }
        not_removed: dict[str, list[str]] = {
            "employees": [],
            "apps": [],
            "knowledge": [],
            "extensions": [],
            "agents": [],
            "skills": [],
            "mcp": [],
            "pack_root": [],
        }

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
                not_removed["employees"].append(code)

        for aid in list(arts.get("apps") or []):
            try:
                apps_admin.delete_app(aid)
                removed["apps"].append(aid)
            except Exception as e:
                logger.warning("uninstall app failed id=%s err=%s", aid, e)
                not_removed["apps"].append(str(aid))

        for eid in list(arts.get("extensions") or []):
            try:
                ext_remove_row(eid)
                removed["extensions"].append(eid)
            except Exception as e:
                logger.warning("uninstall extension failed id=%s err=%s", eid, e)
                not_removed["extensions"].append(eid)

        kb_ids = list(arts.get("knowledge") or [])
        if not keep_knowledge:
            from evoflow.knowledge.owned import service as owned_service

            for kb_id in kb_ids:
                try:
                    owned_service.delete_base(kb_id)
                    removed["knowledge"].append(kb_id)
                except Exception as e:
                    logger.warning("uninstall knowledge base failed kb=%s err=%s", kb_id, e)
                    not_removed["knowledge"].append(kb_id)
        else:
            kept["knowledge"] = kb_ids

        if not keep_primitives:
            for code in list(arts.get("agents") or []):
                try:
                    agents_admin.delete_agent(code)
                    removed["agents"].append(code)
                except Exception as e:
                    logger.warning("uninstall agent failed code=%s err=%s", code, e)
                    not_removed["agents"].append(code)
                    kept["agents"].append(code)
            for sname in list(arts.get("skills") or []):
                try:
                    skills_admin.delete_skill(sname)
                    removed["skills"].append(sname)
                except Exception as e:
                    logger.warning("uninstall skill failed name=%s err=%s", sname, e)
                    not_removed["skills"].append(sname)
                    kept["skills"].append(sname)
            from evoflow.admin import mcp as mcp_admin

            for mname in list(arts.get("mcp") or []):
                try:
                    mcp_admin.remove_mcp_server(mname)
                    removed["mcp"].append(mname)
                except Exception as e:
                    logger.warning("uninstall mcp failed name=%s err=%s", mname, e)
                    not_removed["mcp"].append(mname)
                    kept["mcp"].append(mname)
        else:
            kept["agents"] = list(arts.get("agents") or [])
            kept["skills"] = list(arts.get("skills") or [])
            kept["mcp"] = list(arts.get("mcp") or [])

        # Disk: only delete trees under org-packs/ (portable copy). Never rmtree a
        # path-install source directory that happens to be recorded as pack_root.
        def _under_org_packs(path: Path) -> bool:
            try:
                from evoflow.organizations.pack_persist import org_packs_root

                path.resolve().relative_to(org_packs_root().resolve())
                return True
            except Exception:
                return False

        disk_targets: list[Path] = []
        ws = inst.get("workspace_path")
        if ws:
            disk_targets.append(Path(str(ws)))
        for pr in list(arts.get("pack_root") or []):
            if pr:
                disk_targets.append(Path(str(pr)))
        seen: set[str] = set()
        uniq_targets: list[Path] = []
        for p in disk_targets:
            try:
                key = str(p.resolve())
            except OSError:
                key = str(p)
            if key in seen:
                continue
            seen.add(key)
            uniq_targets.append(p)

        if not keep_workspace:
            for target in uniq_targets:
                if not _under_org_packs(target):
                    # Path-install / folder-link source — keep on disk, note in kept.
                    kept.setdefault("pack_root_skipped_source", [])
                    if isinstance(kept.get("pack_root_skipped_source"), list):
                        kept["pack_root_skipped_source"].append(str(target))
                    continue
                try:
                    if target.is_dir():
                        shutil.rmtree(target, ignore_errors=False)
                        removed["pack_root"].append(str(target))
                    elif not target.exists():
                        removed["pack_root"].append(str(target))
                    else:
                        not_removed["pack_root"].append(str(target))
                except Exception as e:
                    logger.warning("uninstall pack disk failed path=%s err=%s", target, e)
                    not_removed["pack_root"].append(str(target))
            if pack_id:
                try:
                    from evoflow.organizations.pack_persist import org_packs_root

                    fallback = org_packs_root() / pack_id
                    if fallback.is_dir():
                        try:
                            key = str(fallback.resolve())
                        except OSError:
                            key = str(fallback)
                        if key not in seen:
                            shutil.rmtree(fallback, ignore_errors=True)
                            removed["pack_root"].append(str(fallback))
                except Exception:
                    logger.debug("uninstall org-packs fallback skipped", exc_info=True)
        else:
            kept["workspace_path"] = ws
            kept["pack_root"] = [str(p) for p in uniq_targets]

        # Clear artifact index rows so residual inventory is empty.
        try:
            org_registry.clear_org_artifacts(org_instance_id)
        except Exception:
            logger.debug("clear_org_artifacts failed oid=%s", org_instance_id, exc_info=True)

        org_registry.mark_uninstalled(org_instance_id)

        # Residual scan: roles/agents that should be gone
        for code in list(arts.get("employees") or []):
            if ProactiveRepository.get_role(code) and code not in not_removed["employees"]:
                not_removed["employees"].append(code)
        if not keep_primitives:
            from evoflow.admin.errors import NotFoundError as _NF

            for code in list(arts.get("agents") or []):
                try:
                    agents_admin.get_agent(code)
                    if code not in not_removed["agents"]:
                        not_removed["agents"].append(code)
                except _NF:
                    pass
                except Exception:
                    pass

        ok = not any(not_removed.values())
        return {
            "ok": ok,
            "org_instance_id": org_instance_id,
            "removed": removed,
            "kept": kept,
            "not_removed": not_removed,
            "already_uninstalled": str(inst.get("status") or "") == "uninstalled",
        }
    finally:
        if lock is not None:
            try:
                lock.release()
            except RuntimeError:
                pass
