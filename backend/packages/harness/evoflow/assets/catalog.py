"""Scan Asset Hub Markdown frontmatter for Tier 0/1 catalog rows."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from evoflow.assets.injection_budget import (
    TIER0_CATALOG_MAX_ROWS,
    TIER0_EPISODE_MAX_ITEMS,
    TIER0_SKILLS_MAX_ITEMS,
    TIER0_STANDING_CHARS,
    cap_text_chars,
)
from evoflow.assets.paths import EntityRef, entity_root, resolve_entity_file

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_CATALOG_DESC_CHARS = 24
_KIND_PREFIX = {"standing": "s", "fact": "f", "episode": "e", "craft": "c"}
_CLOSURE_SOURCES = frozenset({"goal_complete", "task_complete"})
_CLOSURE_TITLE_MARKERS = ("Goal「", "任务「", "已完成")


def _parse_evidence_source(meta: dict[str, str]) -> str:
    raw = str(meta.get("evidence") or "").strip()
    if not raw:
        return ""
    m = re.search(r"""['"]?source['"]?\s*:\s*['"]?([a-z_]+)""", raw, re.I)
    return (m.group(1) if m else "").strip().lower()


def _looks_like_closure_record(*, meta: dict[str, str], title: str) -> bool:
    """Task/goal closure lines are archival — not Tier-0 standing catalog."""
    if _parse_evidence_source(meta) in _CLOSURE_SOURCES:
        return True
    tags = str(meta.get("tags") or "").lower()
    if "episode" in tags and "已完成" in title:
        return True
    if any(marker in title for marker in _CLOSURE_TITLE_MARKERS) and "已完成" in title:
        return True
    return False


def fact_tier0_catalog_eligible(*, meta: dict[str, str], title: str) -> bool:
    """Tier-0 catalog lists only pin-worthy facts; archival/closures stay on disk."""
    tier = str(meta.get("access_tier") or "").strip().lower()
    if tier == "archival":
        return False
    if _looks_like_closure_record(meta=meta, title=title):
        return False
    return True


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    raw = str(text or "")
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        k = key.strip().lower()
        v = val.strip().strip("'\"")
        if k:
            meta[k] = v
    body = raw[m.end() :]
    return meta, body


def _mtime_sort_key(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _usage_sort_key(path: Path, meta: dict[str, str]) -> float:
    from evoflow.assets.usage import usage_recency_score

    return usage_recency_score(meta, path)


def list_fact_catalog(entity: EntityRef, *, limit: int = TIER0_SKILLS_MAX_ITEMS) -> list[dict[str, Any]]:
    root = entity_root(entity.normalized()) / "memory" / "facts"
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    scored: list[tuple[float, Path, dict[str, str], str]] = []
    for path in root.glob("*.md"):
        if not path.is_file() or path.name.upper() == "README.MD":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = parse_frontmatter(text)
        title = (meta.get("title") or "").strip()
        if not title:
            for line in body.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("# ").strip()
                    break
        if not title:
            title = path.stem[:40]
        if not fact_tier0_catalog_eligible(meta=meta, title=title):
            continue
        scored.append((_usage_sort_key(path, meta), path, meta, title))
    scored.sort(key=lambda t: t[0], reverse=True)
    for _score, path, meta, title in scored:
        if len(rows) >= limit:
            break
        summary = cap_text_chars(
            (meta.get("summary") or meta.get("description") or title).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"memory/facts/{path.name}"
        rows.append({"kind": "fact", "id": title, "title": title, "summary": summary, "path": rel})
    return rows


def list_episode_catalog(entity: EntityRef, *, limit: int = TIER0_EPISODE_MAX_ITEMS) -> list[dict[str, Any]]:
    root = entity_root(entity.normalized()) / "memory" / "episodic"
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    scored: list[tuple[float, Path, dict[str, str], str]] = []
    for path in root.glob("*.md"):
        if not path.is_file() or path.name.upper() == "README.MD":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = parse_frontmatter(text)
        title = (meta.get("title") or "").strip()
        if not title:
            for line in body.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("# ").strip()
                    break
        if not title:
            title = path.stem[:40]
        scored.append((_usage_sort_key(path, meta), path, meta, title))
    scored.sort(key=lambda t: t[0], reverse=True)
    for _score, path, meta, title in scored:
        if len(rows) >= limit:
            break
        summary = cap_text_chars(
            (meta.get("summary") or title).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"memory/episodic/{path.name}"
        rows.append(
            {
                "kind": "episode",
                "id": title,
                "title": title,
                "summary": summary,
                "date": (meta.get("date") or "").strip(),
                "path": rel,
            }
        )
    return rows


def list_craft_catalog(entity: EntityRef, *, limit: int = TIER0_SKILLS_MAX_ITEMS) -> list[dict[str, Any]]:
    root = entity_root(entity.normalized()) / "craft"
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    dirs = sorted(
        (p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")),
        key=_mtime_sort_key,
        reverse=True,
    )
    for d in dirs:
        skill = d / "SKILL.md"
        if not skill.is_file():
            continue
        if len(rows) >= limit:
            break
        try:
            text = skill.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = parse_frontmatter(text)
        name = (meta.get("name") or d.name).strip()
        desc = cap_text_chars(
            (meta.get("description") or meta.get("summary") or name).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"craft/{d.name}/SKILL.md"
        rows.append({"kind": "craft", "id": name, "name": name, "description": desc, "path": rel})
    return rows


def read_standing_text(entity: EntityRef, *, max_chars: int = 400) -> str:
    try:
        path = resolve_entity_file(entity.normalized(), "memory/standing.md")
        if not path.is_file():
            return ""
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return ""
    _, body = parse_frontmatter(text)
    # Drop leading heading for injection compactness
    lines = [ln for ln in body.splitlines() if ln.strip()]
    if lines and lines[0].startswith("#"):
        lines = lines[1:]
    body = "\n".join(lines).strip()
    return cap_text_chars(body, max_chars)


def standing_is_placeholder(text: str) -> bool:
    s = str(text or "").strip()
    if not s:
        return True
    # Drop schema marker line for emptiness check
    body = "\n".join(ln for ln in s.splitlines() if ln.strip() and ln.strip() != "v1").strip()
    if not body:
        return True
    placeholders = ("本工作区关注点", "会话冻结的近期关注", "（会话冻结", "（本工作区", "第一行保留 v1")
    return any(p in body for p in placeholders)


def catalog_has_content(entity: EntityRef) -> bool:
    """True when there is real catalog content (not empty skeleton placeholders)."""
    if list_fact_catalog(entity, limit=1):
        return True
    if list_episode_catalog(entity, limit=1):
        return True
    if list_craft_catalog(entity, limit=1):
        return True
    standing = read_standing_text(entity)
    if standing_is_placeholder(standing):
        return False
    return len(standing.strip()) >= 12


def _catalog_cell(text: str) -> str:
    """Escape newlines for compact catalog lines."""
    return str(text or "").replace("\n", " ").strip()


def format_entity_catalog_xml(
    entity: EntityRef,
    *,
    include_standing: bool = True,
    include_facts: bool = True,
    include_episodes: bool = True,
    include_craft: bool = True,
    tag: str = "catalog",
) -> str:
    """Build a compact catalog block (path + label per line; no full bodies)."""
    rows: list[tuple[str, str, str]] = []
    if include_standing:
        standing = read_standing_text(entity, max_chars=TIER0_STANDING_CHARS)
        if standing and not standing_is_placeholder(standing):
            rows.append(("standing", "memory/standing.md", _catalog_cell(standing)))
    if include_facts:
        for r in list_fact_catalog(entity):
            rows.append(("fact", r["path"], _catalog_cell(r["title"])))
    if include_episodes:
        for r in list_episode_catalog(entity):
            rows.append(("episode", r["path"], _catalog_cell(r["title"])))
    if include_craft:
        for r in list_craft_catalog(entity):
            rows.append(("craft", r["path"], _catalog_cell(r["name"])))
    if not rows:
        return ""
    cap = max(1, int(TIER0_CATALOG_MAX_ROWS))
    if len(rows) > cap:
        rows = rows[:cap]
    lines = [
        f'{_KIND_PREFIX.get(k, "x")} {p} {lbl}'.rstrip()
        for k, p, lbl in rows
    ]
    return f"<{tag}>\n" + "\n".join(lines) + f"\n</{tag}>"
