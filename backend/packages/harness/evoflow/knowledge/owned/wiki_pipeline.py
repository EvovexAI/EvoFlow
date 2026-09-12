"""Wiki ingest / finalize jobs (Phase B, no Redis)."""

from __future__ import annotations

import logging
import re
from typing import Any

from evoflow.knowledge.owned import jobs, wiki
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import utc_now

logger = logging.getLogger(__name__)

_HEADING_RE = re.compile(r"^#{1,3}\s+(.+)$", re.MULTILINE)


def _slugify_concept(title: str) -> str:
    raw = re.sub(r"\s+", "-", (title or "").strip().lower())
    raw = re.sub(r"[^\w\u4e00-\u9fff\-]+", "", raw, flags=re.UNICODE)
    return (raw or "untitled")[:80]


def _doc_excerpt(doc_id: str, *, limit: int = 1200) -> str:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT content FROM kb_chunks
            WHERE doc_id=? AND enabled=1
            ORDER BY ordinal LIMIT 4
            """,
            (doc_id,),
        ).fetchall()
    parts = [str(r["content"] or "") for r in rows]
    text = "\n\n".join(parts).strip()
    return text[:limit]


async def run_wiki_ingest(job: dict[str, Any]) -> None:
    """Build/refresh summary (+ light concept) wiki pages for a KB or single doc."""
    job_id = job["id"]
    kb_id = job["kb_id"]
    doc_id = job.get("doc_id")
    jobs.update_progress(job_id, {"phase": "wiki_ingest", "percent": 10, "message": "生成 Wiki 页面"})

    with db() as conn:
        base = conn.execute(
            "SELECT * FROM kb_bases WHERE id=? AND deleted_at IS NULL", (kb_id,)
        ).fetchone()
        if not base:
            raise ValueError("knowledge base not found")
        if doc_id:
            docs = conn.execute(
                """
                SELECT * FROM kb_documents
                WHERE id=? AND kb_id=? AND deleted_at IS NULL AND parse_status='completed'
                """,
                (doc_id, kb_id),
            ).fetchall()
        else:
            docs = conn.execute(
                """
                SELECT * FROM kb_documents
                WHERE kb_id=? AND deleted_at IS NULL AND parse_status='completed'
                ORDER BY updated_at DESC
                """,
                (kb_id,),
            ).fetchall()

    wiki.ensure_folder(kb_id, "summary", name="文档摘要")
    wiki.ensure_folder(kb_id, "concept", name="概念")

    summary_slugs: list[tuple[str, str]] = []
    total = max(1, len(docs))
    for i, doc in enumerate(docs):
        d = dict(doc)
        did = d["id"]
        title = d.get("title") or d.get("file_name") or did
        slug = f"summary/{did}"
        summary = (d.get("summary_text") or "").strip()
        excerpt = _doc_excerpt(did)
        body_parts = [
            f"# {title}",
            "",
            f"> 来源文档：`{d.get('file_name') or did}`",
            "",
        ]
        if summary:
            body_parts.extend(["## 摘要", "", summary, ""])
        if excerpt:
            body_parts.extend(["## 摘录", "", excerpt, ""])
        body_parts.extend(
            [
                "## 导航",
                "",
                "- 返回 [[index|知识库索引]]",
                "",
            ]
        )
        # Concept stubs from first headings in excerpt/summary
        headings = _HEADING_RE.findall(excerpt)[:5]
        concept_links: list[str] = []
        for h in headings:
            cslug = f"concept/{_slugify_concept(h)}"
            concept_links.append(f"- [[{cslug}|{h.strip()}]]")
            wiki.upsert_page(
                kb_id=kb_id,
                slug=cslug,
                title=h.strip(),
                page_type="concept",
                body_md=(
                    f"# {h.strip()}\n\n"
                    f"相关文档：[[{slug}|{title}]]\n\n"
                    f"- 返回 [[index|知识库索引]]\n"
                ),
                summary=f"概念页（自文档「{title}」标题抽取）",
                source_refs=[f"{did}|{title}"],
                edit_source="pipeline",
            )
        if concept_links:
            body_parts.extend(["## 相关概念", "", *concept_links, ""])

        wiki.upsert_page(
            kb_id=kb_id,
            slug=slug,
            title=title,
            page_type="summary",
            body_md="\n".join(body_parts),
            summary=summary[:500] if summary else (excerpt[:240] if excerpt else ""),
            source_refs=[f"{did}|{title}"],
            edit_source="pipeline",
        )
        summary_slugs.append((slug, title))
        jobs.update_progress(
            job_id,
            {
                "phase": "wiki_ingest",
                "percent": 10 + int(70 * (i + 1) / total),
                "message": f"Wiki 页面 {i + 1}/{total}",
            },
        )

    # Index page
    lines = ["# 知识库索引", "", f"共 {len(summary_slugs)} 篇文档摘要。", "", "## 文档", ""]
    for slug, title in summary_slugs:
        lines.append(f"- [[{slug}|{title}]]")
    lines.extend(["", "## 说明", "", "本索引由 EvoFlow Wiki 管线自动生成；可手动编辑页面正文。", ""])
    # Also list existing summary pages if rebuild without docs filter emptied
    if not summary_slugs:
        for p in wiki.list_pages(kb_id, page_type="summary"):
            lines.append(f"- [[{p['slug']}|{p['title']}]]")
            summary_slugs.append((p["slug"], p["title"]))

    wiki.upsert_page(
        kb_id=kb_id,
        slug="index",
        title="知识库索引",
        page_type="index",
        body_md="\n".join(lines),
        summary="Wiki 总索引",
        edit_source="pipeline",
    )

    # Enable wiki flag (G2 stays opt-in via kg rebuild / graph_enabled)
    with db() as conn:
        conn.execute(
            "UPDATE kb_bases SET wiki_enabled=1, updated_at=? WHERE id=?",
            (utc_now(), kb_id),
        )

    # Chain finalize
    jobs.enqueue(kb_id=kb_id, doc_id=None, type="wiki_finalize", priority=250)
    jobs.update_progress(job_id, {"phase": "done", "percent": 100, "message": f"已生成 {len(summary_slugs)} 篇摘要页"})


async def run_wiki_finalize(job: dict[str, Any]) -> None:
    job_id = job["id"]
    kb_id = job["kb_id"]
    jobs.update_progress(job_id, {"phase": "wiki_finalize", "percent": 40, "message": "重建链接图"})
    stats = wiki.rebuild_link_index(kb_id)
    jobs.update_progress(
        job_id,
        {
            "phase": "done",
            "percent": 100,
            "message": f"链接图完成 pages={stats['pageCount']} edges={stats['edgeCount']}",
        },
    )


def enqueue_wiki_rebuild(kb_id: str, *, doc_id: str | None = None) -> dict[str, Any]:
    return jobs.enqueue(
        kb_id=kb_id,
        doc_id=doc_id,
        type="wiki_ingest",
        priority=220,
    )
