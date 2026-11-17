"""Detect and apply Organization Pack upgrades from market catalogs."""

from __future__ import annotations

import logging
import re
from typing import Any

from evoflow.organizations.registry import list_org_instances

logger = logging.getLogger(__name__)


def compare_versions(a: str, b: str) -> int:
    """Return 1 if a>b, -1 if a<b, 0 if equal / incomparable-as-equal."""
    sa = str(a or "").strip()
    sb = str(b or "").strip()
    if sa == sb:
        return 0
    try:
        from packaging.version import InvalidVersion, Version

        try:
            va, vb = Version(sa), Version(sb)
            return (va > vb) - (va < vb)
        except InvalidVersion:
            pass
    except ImportError:
        pass

    def _parts(s: str) -> list[int]:
        nums = [int(x) for x in re.findall(r"\d+", s)]
        return nums or [0]

    pa, pb = _parts(sa), _parts(sb)
    n = max(len(pa), len(pb))
    pa += [0] * (n - len(pa))
    pb += [0] * (n - len(pb))
    if pa > pb:
        return 1
    if pa < pb:
        return -1
    # Non-numeric suffix tie-break: prefer lexicographic full string
    if sa > sb:
        return 1
    if sa < sb:
        return -1
    return 0


def installed_packs_index(status: str = "active") -> dict[str, dict[str, Any]]:
    """Map pack_id → {version, org_instance_id, instances} (keeps highest version)."""
    out: dict[str, dict[str, Any]] = {}
    for it in list_org_instances(status=status or "active"):
        if not isinstance(it, dict):
            continue
        pid = str(it.get("pack_id") or "").strip()
        if not pid:
            continue
        ver = str(it.get("pack_version") or "").strip() or "0"
        oid = str(it.get("org_instance_id") or "").strip()
        cur = out.get(pid)
        if cur is None:
            out[pid] = {
                "pack_id": pid,
                "version": ver,
                "org_instance_id": oid,
                "instances": [it],
            }
            continue
        cur["instances"].append(it)
        if compare_versions(ver, str(cur.get("version") or "0")) > 0:
            cur["version"] = ver
            cur["org_instance_id"] = oid
    return out


def annotate_catalog_packs(packs: list[Any]) -> list[dict[str, Any]]:
    """Attach install/update fields onto catalog pack rows."""
    installed = installed_packs_index()
    out: list[dict[str, Any]] = []
    for raw in packs:
        if not isinstance(raw, dict):
            continue
        p = dict(raw)
        pid = str(p.get("id") or "").strip()
        avail = str(p.get("version") or "").strip()
        row = installed.get(pid)
        if row:
            inst_ver = str(row.get("version") or "")
            p["_installed"] = True
            p["_installedVersion"] = inst_ver
            p["_installedInstanceId"] = row.get("org_instance_id")
            cmp = compare_versions(avail, inst_ver) if avail else 0
            p["_updateAvailable"] = cmp > 0
            p["_sameVersion"] = cmp == 0
            p["_installedNewer"] = cmp < 0
        else:
            p["_installed"] = False
            p["_installedVersion"] = ""
            p["_updateAvailable"] = False
            p["_sameVersion"] = False
            p["_installedNewer"] = False
        out.append(p)
    return out


def list_available_updates() -> list[dict[str, Any]]:
    """Installed packs that have a newer version in the merged market catalog."""
    from evoflow.organizations.market_sources import fetch_merged_catalog, pack_download_url

    cat = fetch_merged_catalog(force=False)
    packs = annotate_catalog_packs(list(cat.get("packs") or []))
    updates: list[dict[str, Any]] = []
    for p in packs:
        if not p.get("_updateAvailable"):
            continue
        updates.append(
            {
                "pack_id": p.get("id"),
                "name": p.get("name") or p.get("id"),
                "installed_version": p.get("_installedVersion"),
                "available_version": p.get("version"),
                "org_instance_id": p.get("_installedInstanceId"),
                "zip_url": p.get("_zipUrl") or pack_download_url(p),
                "path": p.get("path"),
                "kind": p.get("kind"),
                "source_id": p.get("_sourceId"),
                "catalog_pack": p,
            }
        )
    return updates


def resolve_upgrade_source(
    pack_id: str,
    *,
    source: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build install source for upgrade; prefer explicit source, else catalog zip_url/path."""
    if isinstance(source, dict) and str(source.get("type") or "").strip():
        return {
            "type": str(source.get("type") or "").strip(),
            "path": source.get("path"),
            "url": source.get("url"),
            "repo": source.get("repo"),
        }
    from evoflow.organizations.market_sources import fetch_merged_catalog, pack_download_url

    pid = str(pack_id or "").strip()
    cat = fetch_merged_catalog(force=True)
    for raw in cat.get("packs") or []:
        if not isinstance(raw, dict):
            continue
        if str(raw.get("id") or "").strip() != pid:
            continue
        zip_url = str(raw.get("_zipUrl") or pack_download_url(raw) or "").strip()
        path = str(raw.get("path") or "").strip()
        if zip_url:
            return {"type": "zip_url", "url": zip_url, "path": None, "repo": None}
        if path:
            return {"type": "market_path", "path": path, "url": None, "repo": None}
        break
    raise ValueError(f"市场目录中未找到可升级的包: {pid}")


def upgrade_organization(
    *,
    pack_id: str,
    source: dict[str, Any] | None = None,
    workspace_path: str | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Install newer pack with replace, then drop stale org instance records."""
    from evoflow.organizations.installer import install_organization, uninstall_organization

    pid = str(pack_id or "").strip()
    if not pid:
        raise ValueError("pack_id is required")
    src = resolve_upgrade_source(pid, source=source)
    opts = dict(options or {})
    opts["conflict_policy"] = "replace"
    opts["force_portable"] = True

    before = installed_packs_index().get(pid) or {}
    old_ids = [
        str(it.get("org_instance_id") or "")
        for it in (before.get("instances") or [])
        if str(it.get("org_instance_id") or "")
    ]

    result = install_organization(
        source=src,
        workspace_path=workspace_path,
        options=opts,
    )
    new_id = str(result.get("org_instance_id") or "")
    removed: list[str] = []
    for oid in old_ids:
        if not oid or oid == new_id:
            continue
        try:
            # Primitives already replaced by new install; only drop stale instance rows.
            uninstall_organization(
                oid,
                options={
                    "keep_primitives": True,
                    "keep_workspace": True,
                    "keep_knowledge": True,
                },
            )
            removed.append(oid)
        except Exception as e:
            logger.warning("upgrade: failed to remove stale instance %s: %s", oid, e)
            result.setdefault("warnings", []).append(f"旧实例未清理: {oid} ({e})")

    result["upgraded"] = True
    result["pack_id"] = pid
    result["previous_version"] = before.get("version") or ""
    result["removed_instances"] = removed
    return result


__all__ = [
    "compare_versions",
    "installed_packs_index",
    "annotate_catalog_packs",
    "list_available_updates",
    "resolve_upgrade_source",
    "upgrade_organization",
]
