"""Export local employees / apps into an Organization Pack directory."""

from __future__ import annotations

import json
import logging
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

import yaml

from evoflow.organizations.manifest import PackManifestError, validate_manifest

logger = logging.getLogger(__name__)

_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")


class OrganizationExportError(RuntimeError):
    pass


def _safe_id(raw: str, *, fallback: str = "pack") -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", str(raw or "").strip().lower()).strip("-")
    if not s or not _ID_RE.match(s):
        s = fallback
    if not _ID_RE.match(s):
        s = "exported-pack"
    return s[:64]


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _agent_to_yaml(code: str) -> tuple[dict[str, Any], str]:
    from evoflow.config.agents_config import load_agent_config, load_agent_soul

    cfg = load_agent_config(code)
    if cfg is None:
        raise OrganizationExportError(f"Agent not found: {code}")
    soul = load_agent_soul(code) or ""
    data = {
        "agent_code": code,
        "agent_name": getattr(cfg, "agent_name", None) or code,
        "description": getattr(cfg, "description", None) or "",
        "agent_type": getattr(cfg, "agent_type", None) or "custom",
        "skills": list(getattr(cfg, "skills", None) or []),
        "tools": list(getattr(cfg, "tools", None) or []),
        "mcp_servers": list(getattr(cfg, "mcp_servers", None) or []),
        "tags": list(getattr(cfg, "tags", None) or []),
        "system_prompt_file": f"./{code}.SOUL.md",
    }
    return data, soul


def _employee_to_json(code: str) -> dict[str, Any]:
    from evoflow.proactive.repositories import ProactiveRepository

    role = ProactiveRepository.get_role(code)
    if role is None:
        raise OrganizationExportError(f"Employee not found: {code}")
    cfg = role.config
    out: dict[str, Any] = {
        "agent_code": code,
        "role_name": role.role_name or code,
        "position_code": role.position_code or "",
        "department": role.department or "",
        "reports_to": "",
        "config": {},
    }
    if cfg is not None:
        out["reports_to"] = str(getattr(cfg, "reports_to", "") or "")
        out["config"] = {
            "workspace_path": getattr(cfg, "workspace_path", "") or "${ORG_WORKSPACE}",
            "knowledge_vault_ids": list(getattr(cfg, "knowledge_vault_ids", None) or []),
            "skills": list(getattr(cfg, "skills", None) or []),
            "autonomy_level": str(getattr(cfg, "autonomy_level", "") or "approval_for_risky"),
            "responsibilities": list(getattr(cfg, "responsibilities", None) or []),
            "max_turns": int(getattr(cfg, "max_turns", 10) or 10),
            "timeout_seconds": int(getattr(cfg, "timeout_seconds", 0) or 0),
            "daily_budget_usd": float(getattr(cfg, "daily_budget_usd", 0) or 0),
        }
        hb = str(getattr(role, "heartbeat_rrule", "") or getattr(cfg, "heartbeat_rrule", "") or "")
        if hb:
            out["config"]["schedule"] = hb
    return out


def _app_to_json(app_id: str) -> dict[str, Any]:
    from evoflow.persistence import app_repositories

    doc = app_repositories.load_app(app_id)
    if doc is None:
        raise OrganizationExportError(f"App not found: {app_id}")
    # Drop runtime-only fields
    skip = {"id", "created_at", "updated_at", "status", "version"}
    out = {k: v for k, v in doc.items() if k not in skip}
    out.setdefault("name", doc.get("name") or app_id)
    out.setdefault("execution_mode", doc.get("execution_mode") or "workflow")
    return out


_EXPORT_DIR_SIZE_WARN_MB = 200


def _dir_size_mb(p: Path) -> float:
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total / (1024 * 1024)


def _export_extensions(
    out_dir: Path,
    extension_ids: list[str],
    warnings: list[str],
) -> tuple[list[dict[str, Any]], list[str]]:
    """导出扩展：copy 形态整目录拷进包；folder-link 形态仅带 manifest + 本机路径（非便携）。"""
    if not extension_ids:
        return [], []
    from evoflow.admin.ui_extensions_registry import ExtensionIOError, read_registry

    try:
        rows = {str(r.get("id") or ""): r for r in read_registry()}
    except ExtensionIOError as e:
        warnings.append(f"extensions export unavailable: {e}")
        return [], []

    refs: list[dict[str, Any]] = []
    exported: list[str] = []
    for eid in extension_ids:
        row = rows.get(eid)
        if row is None:
            warnings.append(f"extension not in registry: {eid}")
            continue
        manifest = row.get("manifest") if isinstance(row.get("manifest"), dict) else {}
        manifest = dict(manifest)
        manifest.setdefault("id", eid)
        ext_dir = out_dir / "extensions" / eid
        ext_dir.mkdir(parents=True, exist_ok=True)
        _write_json(ext_dir / "evoflow.extension.json", manifest)

        install_path = str(row.get("install_path") or "").strip()
        source = str(row.get("source") or "")
        is_link = source.endswith("folder-link") or bool((manifest.get("service") or {}).get("link", False))
        src = Path(install_path).expanduser() if install_path else None
        if src is None or not src.is_dir():
            refs.append({"path": install_path, "link": True})
            warnings.append(f"extension '{eid}' 仅导出 manifest（install_path 不存在: {install_path}）")
            exported.append(eid)
            continue
        if is_link:
            refs.append({"path": install_path, "link": True})
            warnings.append(
                f"extension '{eid}' 为 folder-link：导出 manifest + 本机路径（换机安装需把文件放入 extensions/{eid}/ 并改为 from 形态）"
            )
            exported.append(eid)
            continue
        try:
            size_mb = _dir_size_mb(src)
            if size_mb > _EXPORT_DIR_SIZE_WARN_MB:
                warnings.append(f"extension '{eid}' 目录 {size_mb:.0f}MB 超过护栏，仅导出 manifest + 路径")
                refs.append({"path": install_path, "link": True})
            else:
                if ext_dir.exists():
                    shutil.rmtree(ext_dir)
                shutil.copytree(src, ext_dir)
                refs.append({"from": f"./extensions/{eid}"})
            exported.append(eid)
        except OSError as e:
            warnings.append(f"extension '{eid}' copy failed: {e}")
            refs.append({"path": install_path, "link": True})
    return refs, exported


def _export_knowledge(
    out_dir: Path,
    kb_names: list[str],
    warnings: list[str],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """导出知识库定义 + folder 同步源（自包含包）。

    返回 ``(primitives.knowledge 条目, {kb_id: ref})`` 映射——员工导出时把
    ``knowledge_vault_ids`` 里的 kb id 改写为 ``${KB_REF:ref}`` 占位符。
    """
    if not kb_names:
        return [], {}
    from evoflow.knowledge.owned import service as owned_service

    try:
        bases = owned_service.list_bases()
    except Exception as e:
        warnings.append(f"knowledge export unavailable: {e}")
        return [], {}

    by_name: dict[str, dict[str, Any]] = {}
    for b in bases:
        n = str(b.get("name") or "").strip()
        if n:
            by_name.setdefault(n, b)

    refs: list[dict[str, Any]] = []
    kb_id_to_ref: dict[str, str] = {}
    for i, nm in enumerate(kb_names):
        base = by_name.get(nm)
        if base is None:
            warnings.append(f"knowledge base not found: {nm}")
            continue
        kb_id = str(base.get("id") or "")
        ref = _safe_id(nm, fallback=f"kb-{i}")
        entry: dict[str, Any] = {
            "ref": ref,
            "name": nm,
            "description": str(base.get("description") or ""),
        }
        sync_source = ""
        if str(base.get("syncSourceType") or "") == "folder":
            sync_source = str(base.get("syncSourcePath") or "").strip()
        if sync_source:
            src = Path(sync_source).expanduser()
            if src.is_dir():
                dest = out_dir / "knowledge" / ref
                try:
                    size_mb = _dir_size_mb(src)
                    if size_mb > _EXPORT_DIR_SIZE_WARN_MB:
                        warnings.append(f"knowledge '{nm}' 源目录 {size_mb:.0f}MB 超护栏，仅记录本机路径（非便携）")
                        entry["import_folder"] = str(src)
                    else:
                        if dest.exists():
                            shutil.rmtree(dest)
                        shutil.copytree(src, dest)
                        entry["import_folder"] = f"./knowledge/{ref}"
                except OSError as e:
                    warnings.append(f"knowledge '{nm}' copy failed: {e}")
                    entry["import_folder"] = str(src)
            else:
                warnings.append(f"knowledge '{nm}' 同步源不存在: {sync_source}（导出为空库定义）")
        else:
            warnings.append(f"knowledge '{nm}' 无 folder 同步源（导出为空库定义）")
        refs.append(entry)
        if kb_id:
            kb_id_to_ref[kb_id] = ref
    return refs, kb_id_to_ref


def export_organization(
    *,
    pack: dict[str, Any],
    include: dict[str, Any] | None = None,
    output: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Export selected local resources into a pack directory (optional zip)."""
    inc = include or {}
    out_cfg = output or {}
    employee_codes = [str(x).strip().lower() for x in (inc.get("employee_codes") or []) if str(x).strip()]
    app_ids = [str(x).strip() for x in (inc.get("app_ids") or []) if str(x).strip()]
    agent_extra = [str(x).strip().lower() for x in (inc.get("agent_codes") or []) if str(x).strip()]
    skill_names = [str(x).strip() for x in (inc.get("skill_names") or []) if str(x).strip()]
    extension_ids = [str(x).strip() for x in (inc.get("extension_ids") or []) if str(x).strip()]
    kb_names = [str(x).strip() for x in (inc.get("knowledge_base_names") or []) if str(x).strip()]
    vault_ids = [str(x).strip() for x in (inc.get("vault_ids") or []) if str(x).strip()]
    include_vault_data = bool(inc.get("include_vault_data", False))
    if not employee_codes and not app_ids:
        raise OrganizationExportError("include.employee_codes or include.app_ids is required")

    pack_id = _safe_id(str(pack.get("id") or "exported-pack"))
    name = str(pack.get("name") or pack_id).strip() or pack_id
    version = str(pack.get("version") or "1.0.0").strip() or "1.0.0"
    description = str(pack.get("description") or "").strip()

    agent_codes: set[str] = set(employee_codes) | set(agent_extra)
    warnings: list[str] = []

    app_docs: dict[str, dict[str, Any]] = {}
    for aid in app_ids:
        doc = _app_to_json(aid)
        app_docs[aid] = doc
        for step in list(doc.get("steps") or []):
            if not isinstance(step, dict):
                continue
            ag = str(step.get("assigned_agent") or step.get("agent") or "").strip().lower()
            if ag and ag not in agent_codes:
                agent_codes.add(ag)
                warnings.append(f"auto-included agent {ag} referenced by app step")

    # Employees imply their agents
    for code in employee_codes:
        agent_codes.add(code)

    kind = str(pack.get("kind") or "").strip().lower()
    if not kind:
        if employee_codes and app_ids:
            kind = "full"
        elif app_ids:
            kind = "pipeline"
        else:
            kind = "team"

    out_dir = Path(str(out_cfg.get("dir") or "").strip() or f"./exports/{pack_id}").expanduser()
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "agents").mkdir()
    (out_dir / "employees").mkdir()
    (out_dir / "apps").mkdir()
    (out_dir / "skills").mkdir()
    (out_dir / "workspace").mkdir()
    (out_dir / "workspace" / ".gitkeep").write_text("", encoding="utf-8")

    agent_refs: list[dict[str, str]] = []
    for code in sorted(agent_codes):
        try:
            data, soul = _agent_to_yaml(code)
        except OrganizationExportError as e:
            warnings.append(str(e))
            continue
        _write_yaml(out_dir / "agents" / f"{code}.yaml", data)
        (out_dir / "agents" / f"{code}.SOUL.md").write_text(soul or f"# {code}\n", encoding="utf-8")
        agent_refs.append({"from": f"./agents/{code}.yaml"})

    # 知识库先于员工导出：员工 JSON 里的 kb id 要改写成 ${KB_REF:ref} 占位符
    knowledge_refs, kb_id_to_ref = _export_knowledge(out_dir, kb_names, warnings)

    emp_refs: list[dict[str, str]] = []
    for code in employee_codes:
        try:
            emp = _employee_to_json(code)
        except OrganizationExportError as e:
            warnings.append(str(e))
            continue
        cfg = emp.get("config") if isinstance(emp.get("config"), dict) else {}
        kb_field = list(cfg.get("knowledge_vault_ids") or [])
        if kb_field:
            rewritten = []
            for kid in kb_field:
                ref = kb_id_to_ref.get(str(kid))
                if ref:
                    rewritten.append(f"${{KB_REF:{ref}}}")
                else:
                    rewritten.append(kid)
                    warnings.append(
                        f"employee '{code}' 引用知识库 {kid} 未包含在 include.knowledge_base_names 中（安装后需手动补绑）"
                    )
            cfg["knowledge_vault_ids"] = rewritten
        _write_json(out_dir / "employees" / f"{code}.json", emp)
        emp_refs.append({"from": f"./employees/{code}.json"})

    app_refs: list[dict[str, str]] = []
    for aid, doc in app_docs.items():
        slug = _safe_id(str(doc.get("name") or aid), fallback=aid.lower().replace("_", "-")[:40])
        fname = f"{slug}.json"
        _write_json(out_dir / "apps" / fname, doc)
        app_refs.append({"from": f"./apps/{fname}"})

    skill_refs: list[dict[str, str]] = []
    if skill_names:
        try:
            from evoflow.skills.loader import find_skill_directory
        except Exception as e:  # pragma: no cover
            warnings.append(f"skills export unavailable: {e}")
            find_skill_directory = None  # type: ignore[assignment]
        for sk in skill_names:
            if find_skill_directory is None:
                break
            src = find_skill_directory(sk, require_enabled=False)
            if src is None or not src.is_dir():
                warnings.append(f"skill not found: {sk}")
                continue
            safe = _safe_id(sk, fallback="skill")
            dest = out_dir / "skills" / safe
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(src, dest)
            skill_refs.append({"from": f"./skills/{safe}"})

    ext_refs, ext_exported = _export_extensions(out_dir, extension_ids, warnings)
    if vault_ids and not include_vault_data:
        warnings.append("vault_ids recorded as refs; vault data not packed (include_vault_data=false)")
    elif vault_ids and include_vault_data:
        warnings.append("include_vault_data requested but vault body export not implemented yet")

    if kind in ("team", "full") and not emp_refs:
        raise OrganizationExportError("kind team|full requires at least one employee export")
    if kind in ("pipeline", "full") and not app_refs:
        raise OrganizationExportError("kind pipeline|full requires at least one app export")

    primitives: dict[str, Any] = {
        "agents": agent_refs,
        "skills": skill_refs,
    }
    if knowledge_refs:
        primitives["knowledge"] = knowledge_refs
    if ext_refs:
        primitives["extensions"] = ext_refs
    if vault_ids:
        primitives["vaults"] = [{"id": vid} for vid in vault_ids]

    manifest: dict[str, Any] = {
        "schema": 1,
        "kind": kind,
        "id": pack_id,
        "name": name,
        "version": version,
        "description": description,
        "workspace": {
            "template": "./workspace",
            "name": f"{name} 工作区",
            "create_if_missing": True,
        },
        "primitives": primitives,
        "metadata": {
            "author": "exported",
            "tags": ["exported"],
        },
    }
    if emp_refs:
        manifest["team"] = {"employees": emp_refs}
    if app_refs:
        manifest["pipelines"] = {"apps": app_refs}

    try:
        validate_manifest(manifest)
    except PackManifestError as e:
        raise OrganizationExportError(f"exported manifest invalid: {e}") from e

    _write_json(out_dir / "evoflow.organization.json", manifest)
    (out_dir / "README.md").write_text(
        f"# {name}\n\nExported Organization Pack (`{pack_id}` v{version}).\n",
        encoding="utf-8",
    )

    zip_path = None
    if bool(out_cfg.get("zip")):
        zip_path = Path(str(out_cfg.get("zip_path") or f"{out_dir}.zip"))
        if zip_path.exists():
            zip_path.unlink()
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for f in out_dir.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(out_dir).as_posix())

    return {
        "ok": True,
        "pack_id": pack_id,
        "output_dir": str(out_dir.resolve()),
        "zip_path": str(zip_path.resolve()) if zip_path else None,
        "warnings": warnings,
        "agents": [r["from"] for r in agent_refs],
        "employees": [r["from"] for r in emp_refs],
        "apps": [r["from"] for r in app_refs],
        "skills": [r["from"] for r in skill_refs],
        "extensions": ext_exported,
        "extension_ids": extension_ids,
        "knowledge_bases": [r.get("name") for r in knowledge_refs],
        "vault_ids": vault_ids,
    }
