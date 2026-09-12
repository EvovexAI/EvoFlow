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
        "tool_groups": list(getattr(cfg, "tool_groups", None) or []),
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
            "tool_groups": list(getattr(cfg, "tool_groups", None) or []),
            "max_turns": int(getattr(cfg, "max_turns", 10) or 10),
            "timeout_seconds": int(getattr(cfg, "timeout_seconds", 300) or 300),
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

    emp_refs: list[dict[str, str]] = []
    for code in employee_codes:
        try:
            emp = _employee_to_json(code)
        except OrganizationExportError as e:
            warnings.append(str(e))
            continue
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

    if extension_ids:
        warnings.append(
            "extension_ids recorded in manifest only (file copy not available from Gateway)"
        )
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
    if extension_ids:
        primitives["extensions"] = [{"id": eid} for eid in extension_ids]
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
        "extension_ids": extension_ids,
        "vault_ids": vault_ids,
    }
