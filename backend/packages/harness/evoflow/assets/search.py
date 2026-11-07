"""Substring search over an entity's Asset Hub Markdown tree (runtime-aligned).

Local asset search algorithm:

- Walk ``memory/`` + ``craft/`` under the entity root (skip hidden / ``_inbox`` optional).
- Match queries as case-insensitive substrings unless ``case_sensitive``.
- A string query is tokenized: comma / whitespace separate terms, ``"…"`` keeps a
  phrase together. Without this a multi-word query behaves as one literal substring
  and silently returns nothing ("工作流 运行 参数" → 0 hits even though all three
  words exist in the corpus) — callers read an empty result as "no such memory".
- Modes: ``any`` (default), ``all_on_same_line``, ``all_within_lines``.
- Hits are ranked (files matching more distinct terms first, path/title matches
  ahead of body matches), then capped by ``max_results``.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef, entity_root

logger = logging.getLogger(__name__)

MAX_SEARCH_RESULTS = 50
# Ranking needs the whole corpus walked (a path-ordered early break let one big
# file eat the budget), so bound the scan instead: an entity tree is tens of
# files, these caps only guard against a pathological vault.
MAX_SEARCH_FILES = 2000
MAX_SEARCH_HITS = 500
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
    score: int = 0

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
    scanned = 0
    stopped_early = False
    for file_path in _iter_text_files(start, root=root, include_inbox=include_inbox):
        if scopes is not None and not _path_in_scopes(root, file_path, scopes):
            continue
        scanned += 1
        if scanned > MAX_SEARCH_FILES or len(hits) >= MAX_SEARCH_HITS:
            stopped_early = True
            break
        _search_file(root, file_path, matcher, ctx, hits)

    # Rank before capping: sorting by path first let one long file's early lines
    # consume the whole budget, so a more relevant file never surfaced at all.
    hits.sort(key=lambda h: (-h.score, h.path, h.match_line))
    truncated = len(hits) > cap or stopped_early
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


_QUERY_SPLIT_RE = re.compile(r"[,，;；]+|\s+")
_PHRASE_RE = re.compile(r'"([^"]+)"')


def _tokenize_query(raw: str) -> list[str]:
    """Split a free-text query into terms; quoted spans stay one phrase.

    Splitting happens **before** replacing the separators: CJK has no word
    boundaries, so ``"海报 改字"`` must yield ["海报", "改字"] rather than the
    literal two-word substring that never appears in any file.
    """
    text = str(raw or "")
    if not text.strip():
        return []
    out: list[str] = []
    pos = 0
    for m in _PHRASE_RE.finditer(text):
        out.extend(t for t in _QUERY_SPLIT_RE.split(text[pos : m.start()]) if t)
        phrase = m.group(1).strip()
        if phrase:
            out.append(phrase)
        pos = m.end()
    out.extend(t for t in _QUERY_SPLIT_RE.split(text[pos:]) if t)
    dedup: list[str] = []
    seen: set[str] = set()
    for term in out:
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        dedup.append(term)
    return dedup


def _norm_queries(queries: list[str] | str) -> list[str]:
    if isinstance(queries, str):
        return _tokenize_query(queries) or ([queries.strip()] if queries.strip() else [])
    # Each item may itself carry spaces (the Asset Center router pre-splits only on
    # commas), so tokenize per item too — quoted phrases inside stay one term.
    out: list[str] = []
    for q in queries or []:
        out.extend(_tokenize_query(str(q or "")))
    return out


@dataclass
class _Matcher:
    queries: list[str]
    mode: MatchMode
    case_sensitive: bool = False
    within_lines: int = 5

    def flags_for_line(self, line: str) -> list[bool]:
        hay = line if self.case_sensitive else line.lower()
        return [(q if self.case_sensitive else q.lower()) in hay for q in self.queries]

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
    # A term in the filename is the strongest relevance signal we have: asset
    # titles are slug-copied into filenames, and the body of a craft file is
    # prose that often paraphrases instead of repeating the search term.
    path_flags = matcher.flags_for_line(rel)

    def add(match_start: int, match_end: int, merged: list[bool]) -> None:
        hit = _build_hit(rel, lines, match_start, match_end, context_lines, matcher.matched_names(merged))
        hit.score = _hit_score(merged, path_flags, match_start, lines[match_start])
        hits.append(hit)

    if matcher.mode == MatchMode.ANY:
        for i, f in enumerate(flags):
            if any(f):
                add(i, i, f)
    elif matcher.mode == MatchMode.ALL_ON_SAME_LINE:
        for i, f in enumerate(flags):
            if all(f):
                add(i, i, f)
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
                    add(start, end, merged)
                    break


def _hit_score(matched: list[bool], path_flags: list[bool], line_index: int, line_text: str) -> int:
    """Rank relevance: distinct terms > filename match > title/heading position."""
    score = sum(1 for ok in matched if ok) * 10
    score += sum(1 for ok in path_flags if ok) * 4
    stripped = str(line_text or "").lstrip()
    if stripped.startswith("#"):
        score += 6
    if line_index <= 12:  # frontmatter / H1 region
        score += 2
    return score


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
