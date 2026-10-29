"""Scan Asset Hub Markdown frontmatter for Tier 0/1 catalog rows."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from evoflow.assets.injection_budget import (
    TIER0_CATALOG_MAX_ROWS,
    TIER0_CATALOG_PER_KIND,
    TIER0_EPISODE_MAX_ITEMS,
    TIER0_SKILLS_MAX_ITEMS,
    TIER0_STANDING_CHARS,
    cap_text_chars,
)
from evoflow.assets.paths import EntityRef, entity_root, resolve_entity_file

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_CATALOG_DESC_CHARS = 24
_KIND_TAG = {
    "standing": "summary",
    "fact": "fact",
    "episode": "episode",
    "craft": "craft",
    "journal": "journal",
}
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


def _catalog_limit_reached(n: int, limit: int) -> bool:
    """True when ``limit`` is a positive cap and ``n`` already hit it. ``<=0`` = unlimited."""
    return int(limit or 0) > 0 and n >= int(limit)


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
        if _catalog_limit_reached(len(rows), limit):
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
        if _catalog_limit_reached(len(rows), limit):
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
    files = sorted(
        (p for p in root.glob("*.md") if p.is_file() and p.name.upper() != "README.MD"),
        key=_mtime_sort_key,
        reverse=True,
    )
    for craft_file in files:
        if _catalog_limit_reached(len(rows), limit):
            break
        try:
            text = craft_file.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = parse_frontmatter(text)
        name = (meta.get("name") or craft_file.stem).strip()
        desc = cap_text_chars(
            (meta.get("description") or meta.get("summary") or name).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"craft/{craft_file.name}"
        rows.append({"kind": "craft", "id": name, "name": name, "description": desc, "path": rel})
    return rows


def list_journal_catalog(entity: EntityRef, *, limit: int = TIER0_CATALOG_PER_KIND) -> list[dict[str, Any]]:
    """Journal/reflection day files for Tier-0 catalog (filenames only; limit<=0 = all)."""
    root = entity_root(entity.normalized()) / "memory" / "journal"
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    files = sorted(
        (p for p in root.glob("*.md") if p.is_file() and p.name.upper() != "README.MD"),
        key=_mtime_sort_key,
        reverse=True,
    )
    for path in files:
        if _catalog_limit_reached(len(rows), limit):
            break
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = parse_frontmatter(text)
        title = (meta.get("title") or meta.get("summary") or "").strip()
        if not title:
            for line in body.splitlines():
                if line.startswith("#"):
                    title = line.lstrip("# ").strip()
                    break
        if not title:
            title = path.stem[:40]
        summary = cap_text_chars(
            (meta.get("summary") or title).strip(),
            _CATALOG_DESC_CHARS,
        )
        rel = f"memory/journal/{path.name}"
        rows.append(
            {
                "kind": "journal",
                "id": title,
                "title": title,
                "summary": summary,
                "date": (meta.get("date") or "").strip(),
                "path": rel,
            }
        )
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
    if list_journal_catalog(entity, limit=1):
        return True
    standing = read_standing_text(entity)
    if standing_is_placeholder(standing):
        return False
    return len(standing.strip()) >= 12


def _catalog_cell(text: str) -> str:
    """Escape newlines for compact catalog lines."""
    return str(text or "").replace("\n", " ").strip()


_TASK_GROUP_RE = re.compile(r"^\s*#\s*Task\s+Group:\s*(.+?)\s*$", re.MULTILINE)
_TASK_REGISTRY_RE = re.compile(r"^\s*##\s*Task\s+\d+:\s*(.+?)\s*$", re.MULTILINE)


def _read_memory_index_label(entity: EntityRef) -> tuple[str, int, list[str]]:
    """Parse MEMORY.md to derive a short catalog label.

    Returns ``(label, task_group_count, task_group_names)``.

    - When MEMORY.md is the default skeleton or empty: ``("(registry — empty; "
      "consolidate to populate)", 0, [])``.
    - When MEMORY.md has at least one Task Group: ``"(registry — N task groups: "
      "a · b · c)", N, [a, b, c, ...])``.
    """
    try:
        from evoflow.assets.paths import entity_root

        mem_path = entity_root(entity.normalized()) / "memory" / "MEMORY.md"
        if not mem_path.is_file():
            return ("(registry — not yet created)", 0, [])
        text = mem_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ("(registry — unreadable)", 0, [])

    # Strip front-matter-style scaffolding and front-comment lines.
    body_lines = [ln for ln in text.splitlines() if ln.strip()]
    has_real_content = any(
        ln.strip().startswith("# Task Group:") or ln.strip().startswith("## Task ")
        for ln in body_lines
    )
    if not has_real_content:
        return ("(registry — empty; consolidate to populate)", 0, [])

    names = [m.group(1).strip() for m in _TASK_GROUP_RE.finditer(text)]
    return (
        f"(registry — {len(names)} task group{'s' if len(names) != 1 else ''}: "
        + " · ".join(names[:3])
        + ("…" if len(names) > 3 else "")
        + ")",
        len(names),
        names,
    )


def _format_kind_section_lines(
    *,
    heading: str,
    rows: list[tuple[str, str]],
) -> list[str]:
    """Render one kind block: heading + all filename rows (no row cap)."""
    if not rows:
        return []
    out = [f"{heading}:"]
    out.extend(f"- {p} · {lbl}".rstrip() for p, lbl in rows)
    return out


def format_entity_catalog_xml(
    entity: EntityRef,
    *,
    include_standing: bool = True,
    include_facts: bool = True,
    include_episodes: bool = True,
    include_craft: bool = True,
    include_journal: bool = True,
    tag: str = "catalog",
) -> str:
    """Build a compact catalog block — one line per entity asset.

    Line format: ``<kind> <path> — <label>``

    Filenames/short titles only; **no per-kind row cap** (``TIER0_CATALOG_PER_KIND<=0``).
    MEMORY.md is pinned. Full bodies stay on-demand via ``assets`` read/search.
    """
    sections: list[str] = []
    if include_standing:
        standing = read_standing_text(entity, max_chars=TIER0_STANDING_CHARS)
        if standing and not standing_is_placeholder(standing):
            sections.append(
                "========= MEMORY_SUMMARY BEGINS =========\n"
                f"{standing}\n"
                "========= MEMORY_SUMMARY ENDS ========="
            )

    body_lines: list[str] = []
    label, _n, _names = _read_memory_index_label(entity)
    body_lines.append(f"summary memory/MEMORY.md — {label}")

    kind_buckets: list[tuple[str, list[tuple[str, str, str]]]] = []
    if include_craft:
        kind_buckets.append(
            (
                "craft",
                [("craft", r["path"], _catalog_cell(r["name"])) for r in list_craft_catalog(entity)],
            )
        )
    if include_facts:
        kind_buckets.append(
            (
                "fact",
                [("fact", r["path"], _catalog_cell(r["title"])) for r in list_fact_catalog(entity)],
            )
        )
    if include_episodes:
        kind_buckets.append(
            (
                "episode",
                [
                    ("episode", r["path"], _catalog_cell(r["title"]))
                    for r in list_episode_catalog(entity)
                ],
            )
        )
    if include_journal:
        kind_buckets.append(
            (
                "journal",
                [
                    ("journal", r["path"], _catalog_cell(r["title"]))
                    for r in list_journal_catalog(entity)
                ],
            )
        )

    for _kind, rows in kind_buckets:
        for k, p, lbl in rows:
            body_lines.append(f"{_KIND_TAG.get(k, k)} {p} — {lbl}".rstrip())

    if body_lines:
        body = "\n".join(body_lines)
        sections.append(f"<{tag}>\n{body}\n</{tag}>")

    if not sections:
        return ""
    return "\n\n".join(sections)


def format_entity_catalog_lines(
    entity: EntityRef,
    *,
    include_facts: bool = True,
    include_episodes: bool = True,
    include_craft: bool = True,
    include_journal: bool = True,
) -> list[str]:
    """Catalog lines for system-prompt: all short titles, grouped by kind (no row cap).

    ``memory/MEMORY.md`` 置顶。craft / facts / episodic / journal 全量文件名索引；
    正文仍不注入——需要细节再用 ``assets`` read/search。
    """
    lines: list[str] = ["- memory/MEMORY.md · (search primary · 索引)"]

    craft_rows = (
        [(r["path"], _catalog_cell(r["name"])) for r in list_craft_catalog(entity)]
        if include_craft
        else []
    )
    facts_rows = (
        [(r["path"], _catalog_cell(r["title"])) for r in list_fact_catalog(entity)]
        if include_facts
        else []
    )
    episode_rows = (
        [(r["path"], _catalog_cell(r["title"])) for r in list_episode_catalog(entity)]
        if include_episodes
        else []
    )
    journal_rows = (
        [(r["path"], _catalog_cell(r["title"])) for r in list_journal_catalog(entity)]
        if include_journal
        else []
    )

    for heading, rows in (
        ("craft · 经验/做法", craft_rows),
        ("facts · 事实", facts_rows),
        ("episodic · 过程复盘", episode_rows),
        ("journal · 反思", journal_rows),
    ):
        lines.extend(_format_kind_section_lines(heading=heading, rows=rows))
    return lines
