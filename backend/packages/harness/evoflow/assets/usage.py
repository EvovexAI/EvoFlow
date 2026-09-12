"""Asset usage tracking + forgetting window (runtime max_unused_days).

Persists ``last_used_at`` / ``use_count`` in Markdown YAML frontmatter when present.
Files without frontmatter get a minimal frontmatter block prepended on first touch.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from evoflow.assets.catalog import parse_frontmatter
from evoflow.assets.paths import EntityRef, entity_root, resolve_entity_file

logger = logging.getLogger(__name__)

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


def max_unused_days() -> int:
    from evoflow.assets.pipeline_config import max_unused_days as _pipeline_max_unused_days

    return _pipeline_max_unused_days()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: str) -> datetime | None:
    s = str(value or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def upsert_frontmatter_fields(text: str, fields: dict[str, str]) -> str:
    """Set/replace simple scalar frontmatter keys; create block if missing."""
    raw = str(text or "")
    m = _FRONTMATTER_RE.match(raw)
    lines_out: list[str] = []
    keys_lower = {k.lower() for k in fields}
    if m:
        for line in m.group(1).splitlines():
            if ":" not in line:
                lines_out.append(line)
                continue
            key, _, _val = line.partition(":")
            if key.strip().lower() in keys_lower:
                continue
            lines_out.append(line)
        body = raw[m.end() :]
    else:
        body = raw
    for k, v in fields.items():
        lines_out.append(f"{k}: {v}")
    front = "\n".join(lines_out).strip()
    return f"---\n{front}\n---\n{body.lstrip()}" if body else f"---\n{front}\n---\n"


def touch_asset_citation(entity: EntityRef, rel_path: str) -> bool:
    """Bump ``last_cited_at`` / ``cite_count`` when an asset appears in ``<evo-asset-citation>``."""
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel or rel.endswith("/"):
        return False
    if "/_inbox/" in f"/{rel}/" or rel.startswith("memory/_inbox/"):
        return False
    try:
        path = resolve_entity_file(entity, rel)
    except ValueError:
        return False
    if not path.is_file() or path.suffix.lower() != ".md":
        return False
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    meta, _body = parse_frontmatter(text)
    try:
        count = int(str(meta.get("cite_count") or "0").strip() or "0")
    except ValueError:
        count = 0
    updated = upsert_frontmatter_fields(
        text,
        {
            "last_cited_at": _now_iso(),
            "cite_count": str(count + 1),
        },
    )
    if updated == text:
        return False
    try:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(updated, encoding="utf-8")
        tmp.replace(path)
        return True
    except OSError as exc:
        logger.debug("touch_asset_citation failed %s: %s", rel, exc)
        return False


def touch_asset_citations(entity: EntityRef, rel_paths: list[str]) -> int:
    n = 0
    seen: set[str] = set()
    for rel in rel_paths:
        key = str(rel or "").replace("\\", "/").lstrip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        if touch_asset_citation(entity, key):
            n += 1
    return n


def touch_asset_usage(entity: EntityRef, rel_path: str) -> bool:
    """Bump ``last_used_at`` / ``use_count`` on an asset file. Returns True if written."""
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel or rel.endswith("/"):
        return False
    # Don't track inbox drafts / merge artifacts
    if "/_inbox/" in f"/{rel}/" or rel.startswith("memory/_inbox/"):
        return False
    try:
        path = resolve_entity_file(entity, rel)
    except ValueError:
        return False
    if not path.is_file() or path.suffix.lower() != ".md":
        return False
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    meta, _body = parse_frontmatter(text)
    try:
        count = int(str(meta.get("use_count") or "0").strip() or "0")
    except ValueError:
        count = 0
    updated = upsert_frontmatter_fields(
        text,
        {
            "last_used_at": _now_iso(),
            "use_count": str(count + 1),
        },
    )
    if updated == text:
        return False
    try:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(updated, encoding="utf-8")
        tmp.replace(path)
        return True
    except OSError as exc:
        logger.debug("touch_asset_usage failed %s: %s", rel, exc)
        return False


def touch_asset_usages(entity: EntityRef, rel_paths: list[str]) -> int:
    n = 0
    seen: set[str] = set()
    for rel in rel_paths:
        key = str(rel or "").replace("\\", "/").lstrip("/")
        if not key or key in seen:
            continue
        seen.add(key)
        if touch_asset_usage(entity, key):
            n += 1
    return n


def read_usage_meta(entity: EntityRef, rel_path: str) -> dict[str, Any]:
    try:
        path = resolve_entity_file(entity, rel_path)
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
    except (ValueError, OSError):
        return {}
    meta, _ = parse_frontmatter(text)
    return {
        "last_used_at": meta.get("last_used_at") or meta.get("last_used") or "",
        "last_cited_at": meta.get("last_cited_at") or "",
        "use_count": meta.get("use_count") or "0",
        "cite_count": meta.get("cite_count") or "0",
        "created_at": meta.get("created_at") or "",
    }


def asset_is_stale(
    entity: EntityRef,
    rel_path: str,
    *,
    max_days: int | None = None,
) -> bool:
    """True when last_used_at (else created_at / mtime) is older than the window."""
    days = max_unused_days() if max_days is None else max(1, int(max_days))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    meta = read_usage_meta(entity, rel_path)
    stamp = _parse_iso(str(meta.get("last_used_at") or ""))
    cited = _parse_iso(str(meta.get("last_cited_at") or ""))
    if cited is not None and (stamp is None or cited > stamp):
        stamp = cited
    if stamp is None:
        stamp = _parse_iso(str(meta.get("created_at") or ""))
    if stamp is None:
        try:
            path = resolve_entity_file(entity, rel_path)
            stamp = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except (ValueError, OSError):
            return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp < cutoff


def usage_recency_score(meta: dict[str, str], path: Path | None = None) -> float:
    """Higher = more recently used (for catalog ordering)."""
    stamp = _parse_iso(str(meta.get("last_used_at") or meta.get("last_used") or ""))
    if stamp is None:
        stamp = _parse_iso(str(meta.get("created_at") or ""))
    if stamp is None and path is not None:
        try:
            return float(path.stat().st_mtime)
        except OSError:
            return 0.0
    if stamp is None:
        return 0.0
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.timestamp()


def prune_done_inbox(
    entity: EntityRef,
    *,
    max_days: int | None = None,
) -> dict[str, Any]:
    """Delete archived ``_inbox/_done/**`` files older than the unused window."""
    days = max_unused_days() if max_days is None else max(1, int(max_days))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    root = entity_root(entity.normalized()) / "memory" / "_inbox" / "_done"
    if not root.is_dir():
        return {"ok": True, "deleted": 0}
    deleted = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime >= cutoff:
            continue
        try:
            path.unlink()
            deleted += 1
        except OSError:
            continue
    # Clean empty dirs
    for d in sorted(root.rglob("*"), reverse=True):
        if d.is_dir():
            try:
                d.rmdir()
            except OSError:
                pass
    return {"ok": True, "deleted": deleted, "maxDays": days}


def _iter_trackable_md(entity: EntityRef) -> list[tuple[str, Path]]:
    root = entity_root(entity.normalized())
    if not root.is_dir():
        return []
    out: list[tuple[str, Path]] = []
    for path in root.rglob("*.md"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            continue
        low = f"/{rel.lower()}/"
        if "/_inbox/" in low or "/_done/" in low:
            continue
        if path.name.lower() in {"readme.md", "index.md"}:
            continue
        out.append((rel, path))
    return out


def collect_entity_usage_stats(
    entity: EntityRef,
    *,
    top_n: int = 12,
) -> dict[str, Any]:
    """Aggregate usage / freshness for Asset Center stats panel (KB-style cards)."""
    from evoflow.assets.hub import ensure_entity_tree

    e = entity.normalized()
    ensure_entity_tree(e)
    days = max_unused_days()
    rows: list[dict[str, Any]] = []
    total_uses = 0
    total_cites = 0
    touched = 0
    stale = 0
    craft_count = 0
    memory_count = 0
    for rel, path in _iter_trackable_md(e):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, _body = parse_frontmatter(text)
        try:
            count = int(str(meta.get("use_count") or "0").strip() or "0")
        except ValueError:
            count = 0
        try:
            cite_count = int(str(meta.get("cite_count") or "0").strip() or "0")
        except ValueError:
            cite_count = 0
        last_used = str(meta.get("last_used_at") or meta.get("last_used") or "").strip()
        last_cited = str(meta.get("last_cited_at") or "").strip()
        title = str(meta.get("title") or meta.get("name") or path.stem).strip() or path.stem
        summary = str(meta.get("summary") or meta.get("description") or "").strip()[:80]
        is_stale = asset_is_stale(e, rel, max_days=days)
        if count > 0 or cite_count > 0 or last_used or last_cited:
            touched += 1
        total_uses += max(0, count)
        total_cites += max(0, cite_count)
        if is_stale:
            stale += 1
        if rel.startswith("craft/"):
            craft_count += 1
        elif rel.startswith("memory/"):
            memory_count += 1
        rows.append(
            {
                "path": rel,
                "title": title,
                "summary": summary,
                "useCount": count,
                "citeCount": cite_count,
                "lastUsedAt": last_used,
                "lastCitedAt": last_cited,
                "stale": is_stale,
                "kind": (
                    "craft"
                    if rel.startswith("craft/")
                    else "episodic"
                    if "/episodic/" in rel
                    else "facts"
                    if "/facts/" in rel
                    else "journal"
                    if "/journal/" in rel
                    else "standing"
                    if "standing" in rel
                    else "memory"
                ),
            }
        )

    try:
        from evoflow.assets.phase2 import list_inbox_pending

        inbox_pending = len(list_inbox_pending(e))
    except Exception:
        inbox_pending = 0

    hot = sorted(
        rows,
        key=lambda r: (
            int(r["useCount"]) + int(r["citeCount"]),
            int(r["useCount"]),
            str(r["lastUsedAt"] or r["lastCitedAt"]),
        ),
        reverse=True,
    )
    hot = [r for r in hot if int(r["useCount"]) > 0 or int(r["citeCount"]) > 0][: max(1, int(top_n))]
    cold = [r for r in rows if r["stale"]]
    cold.sort(key=lambda r: str(r["lastUsedAt"] or ""))
    cold = cold[: max(1, int(top_n))]

    return {
        "ok": True,
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "maxUnusedDays": days,
        "totals": {
            "files": len(rows),
            "memoryFiles": memory_count,
            "craftFiles": craft_count,
            "touched": touched,
            "totalUses": total_uses,
            "totalCites": total_cites,
            "stale": stale,
            "inboxPending": inbox_pending,
        },
        "hot": hot,
        "stale": cold,
    }
