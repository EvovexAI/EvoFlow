"""Fast local markdown keyword search — no MCP / Node required.

Used when the OHS MCP session is still warming or returns empty so UI / agents
stay responsive. Disk remains the source of truth for note bodies.
"""

from __future__ import annotations

import re
from pathlib import Path

from evoflow.knowledge.vault.models import KnowledgeSearchResult
from evoflow.knowledge.vault.normalize import make_citation
from evoflow.knowledge.vault.paths import iter_markdown_notes

_TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff]{2,}", re.UNICODE)


def tokenize_query(query: str) -> list[str]:
    raw = str(query or "").strip().lower()
    if not raw:
        return []
    tokens = [t for t in _TOKEN_RE.findall(raw) if t]
    # Also keep short CJK / ascii tokens from split
    for part in re.split(r"\s+", raw):
        p = part.strip()
        if len(p) >= 1 and p not in tokens:
            tokens.append(p)
    # Prefer longer tokens first for scoring
    tokens.sort(key=len, reverse=True)
    # Dedupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for t in tokens:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out[:12]


def _score_note(path: str, title: str, body: str, tokens: list[str]) -> tuple[float, str]:
    blob = f"{path}\n{title}\n{body}".lower()
    title_l = title.lower()
    path_l = path.lower()
    score = 0.0
    hit_at = -1
    for tok in tokens:
        if tok in title_l:
            score += 8.0
        if tok in path_l:
            score += 3.0
        idx = blob.find(tok)
        if idx >= 0:
            score += 2.0 + min(2.0, body.lower().count(tok) * 0.15)
            if hit_at < 0 or idx < hit_at:
                hit_at = idx
    if score <= 0:
        return 0.0, ""
    # Snippet around first hit in body (skip path/title prefix offset roughly)
    body_l = body.lower()
    snip_at = body_l.find(tokens[0]) if tokens else -1
    for tok in tokens:
        i = body_l.find(tok)
        if i >= 0 and (snip_at < 0 or i < snip_at):
            snip_at = i
    if snip_at < 0:
        snippet = body.strip()[:240]
    else:
        start = max(0, snip_at - 80)
        end = min(len(body), snip_at + 200)
        snippet = body[start:end].strip()
        if start > 0:
            snippet = "…" + snippet
        if end < len(body):
            snippet = snippet + "…"
    return score, snippet[:800]


def filesystem_keyword_search(
    *,
    vault_id: str,
    vault_path: str,
    query: str,
    top_k: int = 8,
    ignore_patterns: str = "",
    note_limit: int = 800,
) -> list[KnowledgeSearchResult]:
    """Scan vault markdown on disk and return ranked keyword hits."""
    root = Path(str(vault_path or "")).expanduser()
    if not root.is_dir():
        return []
    tokens = tokenize_query(query)
    if not tokens:
        return []
    try:
        notes = iter_markdown_notes(root, ignore_patterns=ignore_patterns or None, limit=note_limit)
    except Exception:
        return []

    hits: list[KnowledgeSearchResult] = []
    for note in notes:
        rel = str((note or {}).get("path") or "").replace("\\", "/")
        if not rel:
            continue
        abs_path = root / Path(*rel.split("/"))
        try:
            text = abs_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        title = str((note or {}).get("title") or Path(rel).stem)
        for line in text.splitlines()[:40]:
            s = line.strip()
            if s.startswith("#"):
                title = s.lstrip("#").strip() or title
                break
        score, snippet = _score_note(rel, title, text, tokens)
        if score <= 0:
            continue
        hits.append(
            KnowledgeSearchResult(
                vaultId=vault_id,
                path=rel,
                title=title,
                score=round(score, 3),
                snippet=snippet,
                provider="filesystem",
                citation=make_citation(vault_id, rel),
            )
        )
    hits.sort(key=lambda h: float(h.score or 0), reverse=True)
    return hits[: max(1, int(top_k))]
