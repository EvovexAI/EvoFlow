"""Substring search over an entity's Asset Hub Markdown tree (runtime-aligned).

Local asset search algorithm:

- Walk ``memory/`` + ``craft/`` under the entity root (skip hidden / ``_inbox`` optional).
- Match queries as case-insensitive substrings unless ``case_sensitive``.
- Modes: ``any`` (default), ``all_on_same_line``, ``all_within_lines``.
- Return path-relative hits with optional context lines; cap ``max_results``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Iterable

from evoflow.assets.paths import EntityRef, entity_root

logger = logging.getLogger(__name__)

MAX_SEARCH_RESULTS = 50
_TEXT_SUFFIXES = {".md", ".markdown", ".mdx", ".txt", ".yaml", ".yml", ".json"}
_SKIP_DIR_NAMES = {".git", ".obsidian", "__pycache__", "node_modules"}


class MatchMode(str, Enum):
    ANY = "any"
    ALL_ON_SAME_LINE = "all_on_same_line"
    ALL_WITHIN_LINES = "all_within_lines"


@dataclass
class SearchHit:
    path: str
    match_line: int
    line_start: int
    line_end: int
    snippet: str
    matched_queries: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "matchLine": self.match_line,
            "lineStart": self.line_start,
            "lineEnd": self.line_end,
            "snippet": self.snippet,
            "matchedQueries": list(self.matched_queries),
        }


def search_entity_assets(
    entity: EntityRef,
    queries: list[str] | str,
    *,
    path: str | None = None,
    kinds: list[str] | str | None = None,
    match_mode: MatchMode | str = MatchMode.ANY,
    case_sensitive: bool = False,
    context_lines: int = 1,
    max_results: int = 20,
    include_inbox: bool = False,
    within_lines: int = 5,
) -> dict[str, Any]:
    """Search Markdown under one entity. Returns ``{queries, matches, truncated}``.

    ``kinds`` scopes search to asset families that share the same MD+frontmatter shape:
    ``facts`` / ``episodic`` / ``journal`` / ``craft`` / ``standing`` / ``handbook`` (MEMORY.md)
    / ``all`` (default).
    """
    e = entity.normalized()
    root = entity_root(e)
    if not root.is_dir():
        return {"queries": _norm_queries(queries), "matches": [], "truncated": False}

    qlist = _norm_queries(queries)
    if not qlist or any(not q for q in qlist):
        raise ValueError("queries must be non-empty strings")

    if isinstance(match_mode, MatchMode):
        mode = match_mode
    else:
        mode = MatchMode(str(match_mode or "any").strip().lower())
    if mode == MatchMode.ALL_WITHIN_LINES and within_lines < 1:
        raise ValueError("within_lines must be >= 1")

    cap = max(1, min(int(max_results or 20), MAX_SEARCH_RESULTS))
    ctx = max(0, min(int(context_lines or 0), 5))

    scopes = _resolve_kind_scopes(kinds)
    start = root
    rel_scope = str(path or "").strip().replace("\\", "/").lstrip("/")
    if rel_scope:
        candidate = (root / rel_scope).resolve()
        if not str(candidate).startswith(str(root.resolve())):
            raise ValueError("path escapes entity root")
        if not candidate.exists():
            return {"queries": qlist, "matches": [], "truncated": False, "path": rel_scope}
        start = candidate
        scopes = None  # explicit path wins

    matcher = _Matcher(qlist, mode, case_sensitive=case_sensitive, within_lines=within_lines)
    hits: list[SearchHit] = []
    for file_path in _iter_text_files(start, root=root, include_inbox=include_inbox):
        if scopes is not None and not _path_in_scopes(root, file_path, scopes):
            continue
        _search_file(root, file_path, matcher, ctx, hits)
        if len(hits) >= cap * 3:
            break

    hits.sort(key=lambda h: (h.path, h.match_line))
    truncated = len(hits) > cap
    hits = hits[:cap]
    return {
        "queries": qlist,
        "matchMode": mode.value,
        "path": rel_scope or None,
        "kinds": _norm_kinds(kinds),
        "matches": [h.to_dict() for h in hits],
        "truncated": truncated,
        "entityType": e.entity_type,
        "entityId": e.entity_id,
    }


# kind → relative path prefixes (or exact files) under entity root
_KIND_SCOPES: dict[str, tuple[str, ...]] = {
    "facts": ("memory/facts/",),
    "fact": ("memory/facts/",),
    "episodic": ("memory/episodic/",),
    "episode": ("memory/episodic/",),
    "process": ("memory/episodic/",),
    "journal": ("memory/journal/",),
    "反思": ("memory/journal/",),
    "craft": ("craft/",),
    "experience": ("craft/",),
    "经验": ("craft/",),
    "skill": ("craft/",),
    "standing": ("memory/standing.md",),
    "summary": ("memory/standing.md",),
    "handbook": ("memory/MEMORY.md", "memory/facts/"),
    "memory": ("memory/MEMORY.md", "memory/facts/", "memory/episodic/", "memory/journal/", "memory/standing.md"),
    "all": (),
}


def _norm_kinds(kinds: list[str] | str | None) -> list[str] | None:
    if kinds is None:
        return None
    if isinstance(kinds, str):
        parts = [p.strip() for p in kinds.replace(";", ",").split(",") if p.strip()]
    else:
        parts = [str(p).strip() for p in kinds if str(p).strip()]
    return parts or None


def _resolve_kind_scopes(kinds: list[str] | str | None) -> set[str] | None:
    """Return allowed path prefixes/files, or None for unrestricted."""
    parts = _norm_kinds(kinds)
    if not parts:
        return None
    if any(p.lower() in ("all", "*", "全部") for p in parts):
        return None
    scopes: set[str] = set()
    for p in parts:
        key = p.lower()
        mapped = _KIND_SCOPES.get(key) or _KIND_SCOPES.get(p)
        if mapped is None:
            # treat as relative path hint
            scopes.add(p.replace("\\", "/").lstrip("/") + ("" if p.endswith(".md") else "/"))
            continue
        if not mapped:
            return None
        scopes.update(mapped)
    return scopes or None


def _path_in_scopes(root: Path, file_path: Path, scopes: set[str]) -> bool:
    rel = _rel(root, file_path)
    for s in scopes:
        if s.endswith(".md"):
            if rel == s or rel.endswith("/" + s):
                return True
        elif rel == s.rstrip("/") or rel.startswith(s):
            return True
    return False


def _norm_queries(queries: list[str] | str) -> list[str]:
    if isinstance(queries, str):
        parts = [q.strip() for q in queries.split(",") if q.strip()]
        return parts or ([queries.strip()] if queries.strip() else [])
    out: list[str] = []
    for q in queries or []:
        s = str(q or "").strip()
        if s:
            out.append(s)
    return out


@dataclass
class _Matcher:
    queries: list[str]
    mode: MatchMode
    case_sensitive: bool = False
    within_lines: int = 5

    def flags_for_line(self, line: str) -> list[bool]:
        hay = line if self.case_sensitive else line.lower()
        return [
            (q if self.case_sensitive else q.lower()) in hay for q in self.queries
        ]

    def matched_names(self, flags: list[bool]) -> list[str]:
        return [q for q, ok in zip(self.queries, flags, strict=False) if ok]


def _iter_text_files(start: Path, *, root: Path, include_inbox: bool) -> Iterable[Path]:
    if start.is_file():
        if start.suffix.lower() in _TEXT_SUFFIXES:
            yield start
        return
    stack = [start]
    while stack:
        d = stack.pop()
        try:
            entries = sorted(d.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            continue
        for p in entries:
            name = p.name
            if name.startswith(".") or name in _SKIP_DIR_NAMES:
                continue
            if p.is_dir():
                rel = _rel(root, p)
                parts = Path(rel).parts
                if not include_inbox and "_inbox" in parts:
                    continue
                stack.append(p)
            elif p.is_file() and p.suffix.lower() in _TEXT_SUFFIXES:
                yield p


def _rel(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return path.name


def _search_file(
    root: Path,
    path: Path,
    matcher: _Matcher,
    context_lines: int,
    hits: list[SearchHit],
) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    lines = text.splitlines()
    if not lines:
        return
    flags = [matcher.flags_for_line(ln) for ln in lines]
    rel = _rel(root, path)

    if matcher.mode == MatchMode.ANY:
        for i, f in enumerate(flags):
            if any(f):
                hits.append(_build_hit(rel, lines, i, i, context_lines, matcher.matched_names(f)))
    elif matcher.mode == MatchMode.ALL_ON_SAME_LINE:
        for i, f in enumerate(flags):
            if all(f):
                hits.append(_build_hit(rel, lines, i, i, context_lines, matcher.matched_names(f)))
    else:
        window = max(1, matcher.within_lines)
        for start in range(len(lines)):
            if not any(flags[start]):
                continue
            last = min(len(lines) - 1, start + window - 1)
            merged = [False] * len(matcher.queries)
            end = start
            for j in range(start, last + 1):
                for k, bit in enumerate(flags[j]):
                    merged[k] = merged[k] or bit
                end = j
                if all(merged):
                    hits.append(
                        _build_hit(rel, lines, start, end, context_lines, matcher.matched_names(merged))
                    )
                    break


def _build_hit(
    rel: str,
    lines: list[str],
    match_start: int,
    match_end: int,
    context_lines: int,
    matched: list[str],
) -> SearchHit:
    a = max(0, match_start - context_lines)
    b = min(len(lines) - 1, match_end + context_lines)
    snippet = "\n".join(lines[a : b + 1])
    return SearchHit(
        path=rel,
        match_line=match_start + 1,
        line_start=a + 1,
        line_end=b + 1,
        snippet=snippet[:2000],
        matched_queries=matched,
    )
