"""Apply (copy) selected asset subtrees from one entity to another."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Literal

from evoflow.assets.locks import atomic_write_text, lock_for
from evoflow.assets.paths import EntityRef, entity_root, profile_field_names

logger = logging.getLogger(__name__)

ConflictPolicy = Literal["skip", "rename", "overwrite"]
ApplyScope = Literal["profile", "memory", "craft", "journal"]

_DEFAULT_SCOPES: tuple[ApplyScope, ...] = ("profile", "craft")


def _scope_rel_dirs(scope: str) -> list[str]:
    s = str(scope or "").strip().lower()
    if s == "profile":
        return ["profile"]
    if s == "craft":
        return ["craft"]
    if s == "memory":
        # facts / episodic / standing — not journal (separate scope)
        return ["memory/facts", "memory/episodic", "memory/standing.md"]
    if s == "journal":
        return ["memory/journal"]
    raise ValueError(f"unsupported scope: {scope}")


def _copy_path(src: Path, dest: Path, *, conflict: ConflictPolicy) -> str:
    """Copy file or directory. Returns action: copied|skipped|renamed|overwritten."""
    if not src.exists():
        return "missing"
    if src.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            if conflict == "skip":
                return "skipped"
            if conflict == "rename":
                stem, suffix = dest.stem, dest.suffix
                n = 1
                while dest.exists():
                    dest = dest.with_name(f"{stem}-applied{n}{suffix}")
                    n += 1
                shutil.copy2(src, dest)
                return "renamed"
            # overwrite
            shutil.copy2(src, dest)
            return "overwritten"
        shutil.copy2(src, dest)
        return "copied"

    # directory
    if not any(src.rglob("*")):
        dest.mkdir(parents=True, exist_ok=True)
        return "copied"
    if dest.exists() and conflict == "skip":
        # merge file-by-file with skip
        copied = 0
        skipped = 0
        for fp in src.rglob("*"):
            if not fp.is_file() or fp.name.startswith("."):
                continue
            rel = fp.relative_to(src)
            target = dest / rel
            if target.exists():
                skipped += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(fp, target)
            copied += 1
        return "copied" if copied and not skipped else ("skipped" if skipped and not copied else "merged")
    if dest.exists() and conflict == "overwrite":
        for fp in src.rglob("*"):
            if not fp.is_file() or fp.name.startswith("."):
                continue
            rel = fp.relative_to(src)
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(fp, target)
        return "overwritten"
    if dest.exists() and conflict == "rename":
        n = 1
        base = dest
        while dest.exists():
            dest = base.parent / f"{base.name}-applied{n}"
            n += 1
        shutil.copytree(src, dest)
        return "renamed"
    shutil.copytree(src, dest, dirs_exist_ok=False)
    return "copied"


def _copy_profile_dir(src: Path, dst: Path, dst_e: EntityRef, *, conflict: ConflictPolicy) -> str:
    """Profile 按目标实体类型过滤。

    user 与 agent/employee 的画像文件集不同（paths._USER/_AGENT_PROFILE_FILES）：
    把 user 的 basic-info/preferences 拷进 employee 树只会产生死文件（其
    profile 读取只认 identity/SOUL/system/soul-summary）。不在目标集合里的
    文件一律跳过并如实上报。
    """
    if not src.exists():
        return "missing"
    allowed = set(profile_field_names(dst_e))
    if not allowed:
        return "skipped-unsupported"
    files = list(src.rglob("*")) if src.is_dir() else [src]
    copied = 0
    skipped = 0
    overwritten = 0
    for fp in files:
        if not fp.is_file() or fp.name.startswith("."):
            continue
        rel = fp.relative_to(src) if src.is_dir() else Path(fp.name)
        if fp.name not in allowed:
            skipped += 1
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if conflict == "skip":
                skipped += 1
                continue
            shutil.copy2(fp, target)
            overwritten += 1
        else:
            shutil.copy2(fp, target)
            copied += 1
    if copied and (skipped or overwritten):
        return "merged"
    if copied:
        return "copied"
    if overwritten and not skipped:
        return "overwritten"
    if overwritten:
        return "merged"
    return "skipped"


def _rewrite_entity_frontmatter(dst: Path, dst_e: EntityRef) -> None:
    """拷贝过去的 md 把 frontmatter 的 entity/entity_id 改成目标实体。"""
    from evoflow.assets.catalog import parse_frontmatter
    from evoflow.assets.usage import upsert_frontmatter_fields

    files = list(dst.rglob("*.md")) if dst.is_dir() else [dst]
    for fp in files:
        if not fp.is_file():
            continue
        try:
            text = fp.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, _body = parse_frontmatter(text)
        if not meta:
            continue
        if meta.get("entity") == dst_e.entity_type and meta.get("entity_id") == dst_e.entity_id:
            continue
        updated = upsert_frontmatter_fields(text, {"entity": dst_e.entity_type, "entity_id": dst_e.entity_id})
        if updated != text:
            with lock_for(fp):
                atomic_write_text(fp, updated)


def apply_assets_to_entity(
    source: EntityRef,
    target: EntityRef,
    *,
    scopes: list[str] | None = None,
    conflict: ConflictPolicy = "skip",
) -> dict[str, Any]:
    """Copy selected asset scopes from source → target entity.

    Default scopes: profile + craft (does **not** copy user memory unless asked).
    """
    from evoflow.assets.hub import ensure_entity_tree
    from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

    src_e = source.normalized()
    dst_e = target.normalized()
    if src_e == dst_e:
        raise ValueError("source and target must differ")

    ensure_entity_tree(src_e)
    ensure_entity_tree(dst_e)
    src_root = entity_root(src_e)
    dst_root = entity_root(dst_e)

    wanted = [str(s).strip().lower() for s in (scopes or list(_DEFAULT_SCOPES)) if str(s).strip()]
    if not wanted:
        wanted = list(_DEFAULT_SCOPES)

    details: list[dict[str, Any]] = []
    copied_rels: list[str] = []
    for scope in wanted:
        for rel in _scope_rel_dirs(scope):
            src_path = src_root / rel
            dst_path = dst_root / rel
            if scope == "profile":
                action = _copy_profile_dir(src_path, dst_path, dst_e, conflict=conflict)
                details.append({"scope": scope, "path": rel, "action": action})
                if action in {"copied", "overwritten", "merged"}:
                    copied_rels.append(rel)
                continue
            action = _copy_path(src_path, dst_path, conflict=conflict)
            details.append({"scope": scope, "path": rel, "action": action})
            if action in {"copied", "overwritten", "merged", "renamed"}:
                copied_rels.append(rel)
    for rel in copied_rels:
        try:
            _rewrite_entity_frontmatter(dst_root / rel, dst_e)
        except Exception:
            logger.debug("entity frontmatter rewrite skipped: %s", rel, exc_info=True)

    # If profile/SOUL copied onto agent/employee, refresh soul-summary
    if "profile" in wanted and dst_e.entity_type in ("agent", "employee"):
        try:
            from evoflow.assets.soul_summary import schedule_soul_summary_consolidate

            schedule_soul_summary_consolidate(dst_e, delay_s=2.0)
        except Exception:
            pass

    copied = sum(1 for d in details if d["action"] in {"copied", "overwritten", "renamed", "merged"})
    skipped = sum(1 for d in details if d["action"] == "skipped")
    return {
        "ok": True,
        "source": {"entityType": src_e.entity_type, "entityId": src_e.entity_id},
        "target": {"entityType": dst_e.entity_type, "entityId": dst_e.entity_id},
        "scopes": wanted,
        "conflict": conflict,
        "copied": copied,
        "skipped": skipped,
        "details": details,
        "destRoot": str(dst_root.resolve()),
    }
