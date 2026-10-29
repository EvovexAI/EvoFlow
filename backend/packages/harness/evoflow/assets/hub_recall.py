"""Turn-tail Asset Hub recall — match **catalog titles only**, not file bodies.

When the user query hits a craft/fact/episode/journal title (or path stem),
remind the model with path + title so it ``assets read`` the right file.
No body substring search — that was noisy and duplicated L3.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from evoflow.assets.paths import EntityRef

logger = logging.getLogger(__name__)

_HUB_RECALL_TOP_K = 5
_HUB_RECALL_MAX_CHARS = 600


def hub_recall_enabled() -> bool:
    """Asset Hub turn-tail recall — **default on** (set EVOFLOW_HUB_RECALL=0 to disable).

    Independent of ``EVOFLOW_QUERY_RECALL`` (legacy SQLite / person-kernel archival).
    """
    raw = (os.getenv("EVOFLOW_HUB_RECALL") or "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    return True


_TOKEN_RE = re.compile(r"[\w\u4e00-\u9fff]{2,}", re.UNICODE)


def _query_needles(query: str, *, limit: int = 10) -> list[str]:
    """Whole query + tokens ≥2 chars for title substring match."""
    q = str(query or "").strip()
    if not q:
        return []
    needles: list[str] = [q[:80]]
    seen = {q[:80].lower()}
    for m in _TOKEN_RE.finditer(q):
        t = m.group(0)
        key = t.lower()
        if key in seen or len(t) < 2:
            continue
        seen.add(key)
        needles.append(t)
        if len(needles) >= limit:
            break
    return needles


def _title_haystack(path: str, title: str) -> str:
    """Match surface: path + stem + catalog title/label (no file body)."""
    stem = path.rsplit("/", 1)[-1].removesuffix(".md").removesuffix(".markdown")
    return f"{path} {stem} {title}".lower()


def _catalog_title_rows(entity: EntityRef) -> list[tuple[str, str]]:
    """``(path, title)`` from Tier-0 catalog sources only."""
    rows: list[tuple[str, str]] = []
    try:
        from evoflow.assets.catalog import (
            list_craft_catalog,
            list_episode_catalog,
            list_fact_catalog,
            list_journal_catalog,
        )
    except Exception:
        logger.debug("hub recall: catalog import failed", exc_info=True)
        return rows

    def _label(*parts: Any) -> str:
        bits = [str(p or "").strip() for p in parts if str(p or "").strip()]
        # Prefer human title; keep name/path stem in haystack via _title_haystack(path, …)
        return " · ".join(dict.fromkeys(bits)) if bits else ""

    try:
        for r in list_craft_catalog(entity):
            path = str(r.get("path") or "").strip()
            title = _label(r.get("description"), r.get("name"), path)
            if path:
                rows.append((path, title or path))
        for r in list_fact_catalog(entity):
            path = str(r.get("path") or "").strip()
            title = _label(r.get("title"), r.get("summary"), path)
            if path:
                rows.append((path, title or path))
        for r in list_episode_catalog(entity):
            path = str(r.get("path") or "").strip()
            title = _label(r.get("title"), r.get("summary"), path)
            if path:
                rows.append((path, title or path))
        for r in list_journal_catalog(entity):
            path = str(r.get("path") or "").strip()
            title = _label(r.get("title"), r.get("summary"), path)
            if path:
                rows.append((path, title or path))
    except Exception:
        logger.debug("hub recall: catalog list failed", exc_info=True)
    return rows


def _score_title(haystack: str, needles: list[str]) -> int:
    """Higher = more needle hits; 0 = no match. First needle (whole query) weighs more."""
    if not needles:
        return 0
    score = 0
    for i, n in enumerate(needles):
        if n.lower() in haystack:
            score += 3 if i == 0 else 1
    return score


def format_hub_asset_recall(
    entity: EntityRef,
    query: str,
    *,
    top_k: int = _HUB_RECALL_TOP_K,
    max_chars: int = _HUB_RECALL_MAX_CHARS,
) -> str:
    """Match ``query`` against catalog titles/paths only; return path·title list or \"\"."""
    q = str(query or "").strip()
    if not q or len(q) < 2:
        return ""
    low = q.lower().strip("?!！？。．… \t")
    if low in {"你好", "您好", "在吗", "hi", "hello", "嘿", "嗯", "ok", "好的", "谢谢"}:
        return ""

    needles = _query_needles(q)
    if not needles:
        return ""

    scored: list[tuple[int, str, str]] = []
    for path, title in _catalog_title_rows(entity):
        sc = _score_title(_title_haystack(path, title), needles)
        if sc <= 0:
            continue
        scored.append((sc, path, title))
    if not scored:
        return ""

    scored.sort(key=lambda t: (-t[0], t[1]))
    picked = scored[: max(1, int(top_k))]

    lines: list[str] = [
        "<!-- ASSET HUB RECALL — title match only; read these paths if relevant -->",
        "下列资产标题与本轮用户话匹配。需要细节 → `assets read` 该 path（勿凭空编）。",
    ]
    used = 0
    budget = max(120, int(max_chars))
    for _sc, path, title in picked:
        block = f"- `{path}` · {title}".rstrip()
        if used + len(block) > budget and used > 0:
            break
        lines.append(block)
        used += len(block)

    if len(lines) <= 2:
        return ""
    lines.append("<!-- END ASSET HUB RECALL -->")
    return "\n".join(lines).strip()
