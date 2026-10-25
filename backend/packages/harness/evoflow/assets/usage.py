"""Asset usage tracking + forgetting window (runtime max_unused_days).

Usage counters live in a sidecar ledger (``memory/.usage-ledger.json``) instead
of the asset files' frontmatter. Counting is a *read-side* side effect (every
``assets(search/read)`` bumps counters) — writing it back into the counted
file raced with every other writer (panel edits, journal append, Phase2) and
the last writer silently dropped content. The ledger keeps reads write-free.

Legacy frontmatter counters (``use_count`` / ``cite_count`` written before the
ledger existed) remain part of the picture: effective values are the max of
frontmatter and ledger per field — both only grow, so ``max`` is monotone and
needs no migration.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from evoflow.assets.catalog import parse_frontmatter
from evoflow.assets.locks import atomic_write_text
from evoflow.assets.paths import EntityRef, entity_root, resolve_entity_file

logger = logging.getLogger(__name__)

_LEDGER_NAME = ".usage-ledger.json"
_LEDGER_GUARD = threading.Lock()

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


def max_unused_days() -> int:
    from evoflow.assets.pipeline_config import max_unused_days as _pipeline_max_unused_days

    return _pipeline_max_unused_days()


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """Set/replace simple scalar frontmatter keys; create block if missing.

    Kept for callers that intentionally rewrite a file's frontmatter; usage
    counters no longer go through here (see module docstring).
    """
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


# ── Sidecar ledger ──────────────────────────────────────────────────


def _ledger_path(entity: EntityRef) -> Path:
    return entity_root(entity.normalized()) / "memory" / _LEDGER_NAME


def _read_ledger(entity: EntityRef) -> dict[str, dict[str, Any]]:
    try:
        raw = _ledger_path(entity).read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _is_trackable(entity: EntityRef, rel_path: str) -> Path | None:
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel or rel.endswith("/"):
        return None
    if "/_inbox/" in f"/{rel}/" or rel.startswith("memory/_inbox/"):
        return None
    try:
        path = resolve_entity_file(entity, rel)
    except ValueError:
        return None
    if not path.is_file() or path.suffix.lower() != ".md":
        return None
    return path


def _ledger_bump(entity: EntityRef, rel_path: str, *, used: bool, cited: bool) -> bool:
    """Add one use/cite to the ledger entry. Full RMW runs under one lock."""
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    try:
        with _LEDGER_GUARD:
            data = _read_ledger(entity)
            entry = dict(data.get(rel) or {})
            try:
                uses = int(entry.get("useCount") or 0)
            except (TypeError, ValueError):
                uses = 0
            try:
                cites = int(entry.get("citeCount") or 0)
            except (TypeError, ValueError):
                cites = 0
            now = _now_iso()
            changed = False
            if used:
                entry["useCount"] = uses + 1
                entry["lastUsedAt"] = now
                changed = True
            if cited:
                entry["citeCount"] = cites + 1
                entry["lastCitedAt"] = now
                changed = True
            if not changed:
                return False
            data[rel] = entry
            atomic_write_text(_ledger_path(entity), json.dumps(data, ensure_ascii=False))
            return True
    except OSError as exc:
        logger.debug("usage ledger bump failed %s: %s", rel, exc)
        return False


def _ledger_entry(entity: EntityRef, rel_path: str) -> dict[str, Any]:
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    return dict(_read_ledger(entity).get(rel) or {})


def overlay_ledger_meta(
    entity: EntityRef,
    rel_path: str,
    base_meta: dict[str, str],
) -> dict[str, str]:
    """Overlay the ledger onto frontmatter meta — per field, newer/max wins."""
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    led = _ledger_entry(entity, rel)

    def _pick(fm_value: str, led_value: str, key: str) -> str:
        if key.startswith("last"):
            a = _parse_iso(fm_value) if isinstance(fm_value, str) else None
            b = _parse_iso(led_value) if isinstance(led_value, str) else None
            if a is None:
                return str(led_value or "")
            if b is None:
                return str(fm_value or "")
            return fm_value if a >= b else led_value
        try:
            fa = int(str(fm_value or "0").strip() or 0)
        except (TypeError, ValueError):
            fa = 0
        try:
            fb = int(str(led_value or "0").strip() or 0)
        except (TypeError, ValueError):
            fb = 0
        return str(max(fa, fb))

    if not led:
        return dict(base_meta or {})
    out = dict(base_meta or {})
    if "useCount" in led or out.get("use_count"):
        out["use_count"] = _pick(out.get("use_count") or out.get("useCount") or "", str(led.get("useCount") or "0"), "useCount")
    if "citeCount" in led or out.get("cite_count"):
        out["cite_count"] = _pick(out.get("cite_count") or out.get("citeCount") or "", str(led.get("citeCount") or "0"), "citeCount")
    out["last_used_at"] = _pick(out.get("last_used_at") or out.get("last_used") or "", str(led.get("lastUsedAt") or ""), "last_used_at")
    out["last_cited_at"] = _pick(out.get("last_cited_at") or "", str(led.get("lastCitedAt") or ""), "last_cited_at")
    return out


# ── Public touch / read API (unchanged signatures) ──────────────────


def touch_asset_citation(entity: EntityRef, rel_path: str) -> bool:
    """Bump ``last_cited_at`` / ``cite_count`` in the sidecar ledger."""
    path = _is_trackable(entity, rel_path)
    if path is None:
        return False
    return _ledger_bump(entity, rel_path, used=False, cited=True)


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
    """Bump ``last_used_at`` / ``use_count`` in the sidecar ledger."""
    path = _is_trackable(entity, rel_path)
    if path is None:
        return False
    return _ledger_bump(entity, rel_path, used=True, cited=False)


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
    """Effective usage meta: frontmatter overlaid with the sidecar ledger."""
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    try:
        path = resolve_entity_file(entity, rel)
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
    except (ValueError, OSError):
        return {}
    meta, _ = parse_frontmatter(text)
    meta = overlay_ledger_meta(entity, rel, meta)
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
    cutoff = datetime.now(UTC) - timedelta(days=days)
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
            stamp = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        except (ValueError, OSError):
            return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=UTC)
    return stamp < cutoff


def usage_recency_score(meta: dict[str, str], path: Path | None = None) -> float:
    """Higher = more recently used (for catalog ordering).

    Accepts either raw frontmatter meta or ledger-overlaid meta (see
    ``overlay_ledger_meta``); callers with an entity in scope should overlay
    first or counters written before the ledger dominated the ordering.
    """
    stamp = _parse_iso(str(meta.get("last_used_at") or meta.get("last_used") or ""))
    cited = _parse_iso(str(meta.get("last_cited_at") or ""))
    if cited is not None and (stamp is None or cited > stamp):
        stamp = cited
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
        stamp = stamp.replace(tzinfo=UTC)
    return stamp.timestamp()


def prune_done_inbox(
    entity: EntityRef,
    *,
    max_days: int | None = None,
) -> dict[str, Any]:
    """Delete archived ``_inbox/_done/**`` files older than the unused window."""
    days = max_unused_days() if max_days is None else max(1, int(max_days))
    cutoff = datetime.now(UTC) - timedelta(days=days)
    root = entity_root(entity.normalized()) / "memory" / "_inbox" / "_done"
    if not root.is_dir():
        return {"ok": True, "deleted": 0}
    deleted = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
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
        meta = overlay_ledger_meta(e, rel, meta)
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
                "kind": ("craft" if rel.startswith("craft/") else "episodic" if "/episodic/" in rel else "facts" if "/facts/" in rel else "journal" if "/journal/" in rel else "standing" if "standing" in rel else "memory"),
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
