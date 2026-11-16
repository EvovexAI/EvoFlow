"""Compare an on-disk Organization Pack against the live runtime (agents / employees / extensions).

Showcase packs are often folder-linked for extensions/skills but **copied** for
agents/SOUL/employees at install time. After the pack evolves, runtime drifts.
This module reports the gap; ``sync`` = reinstall with conflict_policy=replace.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from evoflow.organizations.manifest import LoadedPack, PackManifestError, load_agent_definition, load_json_ref, load_pack_from_source


def _sha(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


def _read_text(path: Path | None) -> str:
    if path is None or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def _agent_codes_from_pack(pack: LoadedPack) -> list[str]:
    codes: list[str] = []
    for ref in list((pack.manifest.get("primitives") or {}).get("agents") or []):
        if not isinstance(ref, dict):
            continue
        frm = str(ref.get("from") or "").strip()
        if not frm:
            continue
        try:
            data = load_agent_definition(pack, frm)
        except PackManifestError:
            continue
        code = str(data.get("agent_code") or data.get("name") or Path(frm).stem).strip().lower()
        if code:
            codes.append(code)
    # employees often share agent_code
    for ref in list((pack.manifest.get("team") or {}).get("employees") or []):
        if not isinstance(ref, dict):
            continue
        frm = str(ref.get("from") or "").strip()
        if not frm:
            continue
        try:
            emp = load_json_ref(pack, frm)
        except PackManifestError:
            continue
        code = str(emp.get("agent_code") or emp.get("code") or Path(frm).stem).strip().lower()
        if code and code not in codes:
            codes.append(code)
    return codes


def _extension_ids_from_pack(pack: LoadedPack) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ref in list((pack.manifest.get("primitives") or {}).get("extensions") or []):
        if not isinstance(ref, dict):
            continue
        eid = ""
        link = bool(ref.get("link"))
        path = str(ref.get("path") or "").strip()
        frm = str(ref.get("from") or "").strip()
        if frm:
            try:
                from evoflow.organizations.manifest import resolve_pack_rel

                root = resolve_pack_rel(pack, frm)
                man = root / "evoflow.extension.json"
                if not man.is_file() and (pack.root / "evoflow.extension.json").is_file() and frm in (".", "./"):
                    man = pack.root / "evoflow.extension.json"
                if man.is_file():
                    data = json.loads(man.read_text(encoding="utf-8"))
                    eid = str(data.get("id") or "").strip()
            except Exception:
                eid = ""
        if not eid and path:
            # folder path may itself be the extension root
            p = Path(path)
            man = p / "evoflow.extension.json"
            if man.is_file():
                try:
                    eid = str(json.loads(man.read_text(encoding="utf-8")).get("id") or "").strip()
                except Exception:
                    eid = p.name
            else:
                eid = p.name
        if eid:
            out.append({"id": eid, "link": link, "from": frm, "path": path})
    return out


def audit_pack_drift(pack_path: str) -> dict[str, Any]:
    """Return a structured drift report for one pack directory/zip."""
    pack = load_pack_from_source(source_type="path", path=pack_path)
    pack_id = str(pack.manifest.get("id") or "").strip()
    pack_ver = str(pack.manifest.get("version") or "").strip()

    from evoflow.config.agents_config import _agent_soul_file, load_agent_soul
    from evoflow.organizations.registry import list_org_instances
    from evoflow.persistence import config_repositories as cfg_repo

    agent_rows: list[dict[str, Any]] = []
    for code in _agent_codes_from_pack(pack):
        # pack soul next to yaml
        pack_soul = ""
        pack_soul_path = ""
        for ref in list((pack.manifest.get("primitives") or {}).get("agents") or []):
            if not isinstance(ref, dict):
                continue
            frm = str(ref.get("from") or "").strip()
            if not frm:
                continue
            try:
                data = load_agent_definition(pack, frm)
            except PackManifestError:
                continue
            ac = str(data.get("agent_code") or data.get("name") or Path(frm).stem).strip().lower()
            if ac != code:
                continue
            pack_soul = str(data.get("soul") or "")
            # also record file if present
            soul_file = pack.root / "agents" / f"{code}.SOUL.md"
            if soul_file.is_file():
                pack_soul_path = str(soul_file)
                if not pack_soul.strip():
                    pack_soul = soul_file.read_text(encoding="utf-8", errors="replace")
            break
        if not pack_soul:
            soul_file = pack.root / "agents" / f"{code}.SOUL.md"
            if soul_file.is_file():
                pack_soul_path = str(soul_file)
                pack_soul = soul_file.read_text(encoding="utf-8", errors="replace")

        exists = bool(cfg_repo.agent_exists(code))
        live_soul = load_agent_soul(code) or ""
        live_path = str(_agent_soul_file(code))
        same = bool(pack_soul.strip()) and (pack_soul.strip() == live_soul.strip())
        status = "ok"
        if not exists:
            status = "missing_in_runtime"
        elif not pack_soul.strip():
            status = "missing_in_pack"
        elif not live_soul.strip():
            status = "empty_runtime_soul"
        elif not same:
            status = "soul_drift"
        agent_rows.append(
            {
                "agent_code": code,
                "status": status,
                "exists_in_db": exists,
                "pack_soul_sha": _sha(pack_soul) if pack_soul.strip() else "",
                "live_soul_sha": _sha(live_soul) if live_soul.strip() else "",
                "pack_soul_len": len(pack_soul),
                "live_soul_len": len(live_soul),
                "pack_soul_path": pack_soul_path,
                "live_soul_path": live_path,
            }
        )

    # extensions
    from evoflow.admin.ui_extensions_registry import read_registry

    try:
        reg = {str(r.get("id") or ""): r for r in read_registry()}
    except Exception:
        reg = {}
    ext_rows: list[dict[str, Any]] = []
    for ext in _extension_ids_from_pack(pack):
        eid = ext["id"]
        row = reg.get(eid)
        if row is None:
            ext_rows.append({**ext, "status": "missing_in_runtime"})
            continue
        install_path = str(row.get("install_path") or "").strip()
        source = str(row.get("source") or "")
        linked = source.endswith("folder-link") or bool((row.get("manifest") or {}).get("service", {}).get("link"))
        # if pack uses link/from "." expect install_path == pack.root
        expected = str(pack.root.resolve())
        path_ok = False
        if install_path:
            try:
                path_ok = Path(install_path).resolve() == Path(expected).resolve() or expected.startswith(
                    str(Path(install_path).resolve())
                ) or str(Path(install_path).resolve()).startswith(expected)
            except Exception:
                path_ok = False
        status = "ok" if linked and path_ok else ("linked_other_path" if linked else "copied_or_stale")
        if not linked:
            status = "copied_snapshot"
        ext_rows.append(
            {
                **ext,
                "status": status,
                "runtime_source": source,
                "runtime_install_path": install_path,
                "pack_root": expected,
            }
        )

    instances = []
    for it in list_org_instances(status=""):
        if str(it.get("pack_id") or "") == pack_id:
            instances.append(
                {
                    "org_instance_id": it.get("org_instance_id"),
                    "pack_version": it.get("pack_version"),
                    "status": it.get("status"),
                    "artifacts": it.get("artifacts"),
                    "version_match": str(it.get("pack_version") or "") == pack_ver,
                }
            )

    problems = (
        [r for r in agent_rows if r["status"] != "ok"]
        + [r for r in ext_rows if r["status"] not in ("ok",)]
        + [i for i in instances if not i.get("version_match")]
    )

    return {
        "ok": True,
        "pack_id": pack_id,
        "pack_version": pack_ver,
        "pack_path": str(pack.root),
        "pack_name": pack.manifest.get("name"),
        "agents": agent_rows,
        "extensions": ext_rows,
        "org_instances": instances,
        "summary": {
            "agent_ok": sum(1 for r in agent_rows if r["status"] == "ok"),
            "agent_drift": sum(1 for r in agent_rows if r["status"] != "ok"),
            "extension_ok": sum(1 for r in ext_rows if r["status"] == "ok"),
            "extension_drift": sum(1 for r in ext_rows if r["status"] != "ok"),
            "stale_instances": sum(1 for i in instances if not i.get("version_match")),
            "problem_count": len(problems),
        },
        "recommendation": (
            "pack 为权威：evoflow org sync <pack目录> --conflict replace"
            if problems
            else "pack 与运行态一致（或仅 folder-link 正常）"
        ),
    }


def sync_pack_to_runtime(pack_path: str, *, conflict: str = "replace") -> dict[str, Any]:
    """Reinstall pack into runtime with replace policy (SOUL/agents/employees refresh)."""
    from evoflow.organizations.installer import install_organization

    drift = audit_pack_drift(pack_path)
    result = install_organization(
        source={"type": "path", "path": pack_path},
        options={"conflict_policy": conflict or "replace"},
    )
    return {
        "ok": True,
        "before": drift.get("summary"),
        "install": result,
        "after": audit_pack_drift(pack_path).get("summary"),
    }
