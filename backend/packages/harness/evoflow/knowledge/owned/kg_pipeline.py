"""G2 kg_extract: LLM (or heuristic) entity-relation extraction into SQLite."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from evoflow.knowledge.owned import jobs, kg
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import utc_now

logger = logging.getLogger(__name__)

_MAX_CHUNKS_PER_JOB = 40
_JSON_ARRAY_RE = re.compile(r"\[[\s\S]*\]")
_QUOTE_ENTITY_RE = re.compile(r"[「『《]([^」』》]{1,40})[」』》]")
_IS_RE = re.compile(
    r"([\u4e00-\u9fffA-Za-z0-9_\-]{2,30})\s*(?:是|为|属于|包含|依赖|调用|使用|基于)\s*"
    r"([\u4e00-\u9fffA-Za-z0-9_\-]{2,30})"
)


def extract_triples_heuristic(text: str) -> list[tuple[str, str, str]]:
    """Deterministic fallback when Chat model unavailable."""
    triples: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    def _add(src: str, rel: str, dst: str) -> None:
        key = (src, rel, dst)
        if key in seen or src == dst:
            return
        seen.add(key)
        triples.append(key)

    for m in _IS_RE.finditer(text or ""):
        _add(m.group(1), "是", m.group(2))

    quoted = _QUOTE_ENTITY_RE.findall(text or "")
    for i in range(len(quoted) - 1):
        _add(quoted[i], "相关", quoted[i + 1])

    # Heading-like lines as concepts co-occurring
    headings = re.findall(r"^#{1,3}\s+(.+)$", text or "", flags=re.MULTILINE)
    for i in range(len(headings) - 1):
        _add(headings[i].strip()[:40], "相关", headings[i + 1].strip()[:40])

    return triples[:20]


async def extract_triples_llm(text: str) -> list[tuple[str, str, str]] | None:
    """Ask default Chat model for JSON triples; None on failure."""
    excerpt = (text or "").strip()[:3500]
    if not excerpt:
        return []
    prompt = (
        "从下面文本抽取实体关系三元组。只输出 JSON 数组，每项为 "
        '{"src":"实体A","rel":"关系","dst":"实体B"}。'
        "最多 12 条；禁止臆造；不要 Markdown 围栏。\n\n"
        f"{excerpt}"
    )
    try:
        from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
        from evoflow.models import create_chat_model

        model = create_chat_model(thinking_enabled=False, invocation_kind="kg_extract")
        resp = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
        raw = str(getattr(resp, "content", "") or resp).strip()
        m = _JSON_ARRAY_RE.search(raw)
        if not m:
            return None
        data = json.loads(m.group(0))
        out: list[tuple[str, str, str]] = []
        if not isinstance(data, list):
            return None
        for item in data[:12]:
            if not isinstance(item, dict):
                continue
            src = str(item.get("src") or item.get("source") or "").strip()
            rel = str(item.get("rel") or item.get("relation") or "相关").strip()
            dst = str(item.get("dst") or item.get("target") or "").strip()
            if src and dst:
                out.append((src, rel or "相关", dst))
        return out
    except Exception as exc:
        logger.debug("kg llm extract failed: %s", exc)
        return None


async def run_kg_extract(job: dict[str, Any]) -> None:
    job_id = job["id"]
    kb_id = job["kb_id"]
    doc_id = job.get("doc_id")
    payload = job.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = {}

    jobs.update_progress(job_id, {"phase": "kg_extract", "percent": 5, "message": "实体抽取"})

    with db() as conn:
        if doc_id:
            chunks = conn.execute(
                """
                SELECT id, content FROM kb_chunks
                WHERE kb_id=? AND doc_id=? AND enabled=1
                ORDER BY ordinal LIMIT ?
                """,
                (kb_id, doc_id, _MAX_CHUNKS_PER_JOB),
            ).fetchall()
        else:
            chunks = conn.execute(
                """
                SELECT id, content FROM kb_chunks
                WHERE kb_id=? AND enabled=1
                ORDER BY created_at DESC LIMIT ?
                """,
                (kb_id, _MAX_CHUNKS_PER_JOB),
            ).fetchall()

    force_heuristic = bool(payload.get("heuristicOnly"))
    total = max(1, len(chunks))
    edges = 0
    for i, ch in enumerate(chunks):
        text = ch["content"] or ""
        triples: list[tuple[str, str, str]] = []
        if not force_heuristic:
            llm = await extract_triples_llm(text)
            if llm is not None:
                triples = llm
        if not triples:
            triples = extract_triples_heuristic(text)
        if triples:
            stats = kg.add_triples(kb_id, triples, chunk_id=ch["id"])
            edges += int(stats.get("edgesAdded") or 0)
        jobs.update_progress(
            job_id,
            {
                "phase": "kg_extract",
                "percent": 5 + int(90 * (i + 1) / total),
                "message": f"抽取 {i + 1}/{total}",
            },
        )

    with db() as conn:
        conn.execute(
            "UPDATE kb_bases SET graph_enabled=1, updated_at=? WHERE id=?",
            (utc_now(), kb_id),
        )

    st = kg.stats(kb_id)
    jobs.update_progress(
        job_id,
        {
            "phase": "done",
            "percent": 100,
            "message": f"实体图 nodes={st['nodeCount']} edges={st['edgeCount']} (+{edges})",
        },
    )


def enqueue_kg_extract(
    kb_id: str,
    *,
    doc_id: str | None = None,
    heuristic_only: bool = False,
) -> dict[str, Any]:
    return jobs.enqueue(
        kb_id=kb_id,
        doc_id=doc_id,
        type="kg_extract",
        priority=240,
        payload={"heuristicOnly": heuristic_only} if heuristic_only else {},
    )
