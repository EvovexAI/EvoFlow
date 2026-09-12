"""parse_index pipeline: parse → chunk → embed → index."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.config.model_config import ModelConfig
from evoflow.knowledge.embedding import get_embeddings
from evoflow.knowledge.owned import blob_store, jobs
from evoflow.knowledge.owned.assets import (
    embed_text_for_chunk,
    extract_and_rewrite_images,
    insert_assets,
    link_assets_to_chunks,
)
from evoflow.knowledge.owned.chunking import split_text
from evoflow.knowledge.owned.doc_links import rebuild_doc_links, update_document_metadata
from evoflow.knowledge.owned.embedding_bind import model_config_for_base_row
from evoflow.knowledge.owned.metadata import extract_tags, parse_frontmatter
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now
from evoflow.knowledge.owned.retrieve import delete_fts_for_doc, index_fts, pack_embedding
from evoflow.knowledge.parser import parse_file

logger = logging.getLogger(__name__)


def _model_config_for_base(base: dict[str, Any]) -> ModelConfig:
    return model_config_for_base_row(base)


async def run_parse_index(
    job: dict[str, Any],
    *,
    skip_embedding: bool = False,
    skip_embedding_reason: str | None = None,
) -> None:
    job_id = job["id"]
    kb_id = job["kb_id"]
    doc_id = job.get("doc_id")
    if not doc_id:
        raise ValueError("parse_index requires doc_id")

    jobs.update_progress(job_id, {"phase": "loading", "percent": 5, "message": "读取文档"})

    with db() as conn:
        base = conn.execute(
            "SELECT * FROM kb_bases WHERE id=? AND deleted_at IS NULL", (kb_id,)
        ).fetchone()
        doc = conn.execute(
            "SELECT * FROM kb_documents WHERE id=? AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
    if not base or not doc:
        raise ValueError("knowledge base or document not found")

    base_d = dict(base)
    doc_d = dict(doc)
    now = utc_now()
    with db() as conn:
        conn.execute(
            "UPDATE kb_documents SET parse_status='processing', error_message='', updated_at=? WHERE id=?",
            (now, doc_id),
        )

    blob_path = doc_d.get("blob_path") or ""
    if not blob_path:
        raise ValueError("document has no blob_path")
    path = blob_store.resolve_blob(blob_path)

    jobs.update_progress(job_id, {"phase": "parsing", "percent": 15, "message": "解析正文"})
    try:
        text = parse_file(path)
    except Exception as exc:
        with db() as conn:
            conn.execute(
                "UPDATE kb_documents SET parse_status='failed', error_message=?, updated_at=? WHERE id=?",
                (str(exc)[:2000], utc_now(), doc_id),
            )
        raise

    jobs.update_progress(job_id, {"phase": "assets", "percent": 25, "message": "抽取图片"})
    # Prefer original source folder for relative image paths when available
    text, assets = extract_and_rewrite_images(
        text, kb_id=kb_id, doc_id=doc_id, source_path=path
    )

    jobs.update_progress(job_id, {"phase": "chunking", "percent": 35, "message": "分块"})
    fm, _body = parse_frontmatter(text)
    tags = extract_tags(text, fm)
    update_document_metadata(doc_id, tags=tags, frontmatter=fm)
    try:
        rebuild_doc_links(kb_id, doc_id, text)
    except Exception:
        logger.debug("doc links rebuild skipped", exc_info=True)

    pieces = split_text(
        text,
        chunk_size=int(base_d.get("chunk_size") or 512),
        chunk_overlap=int(base_d.get("chunk_overlap") or 80),
        strategy=str(base_d.get("chunk_strategy") or "recursive"),
    )

    with db() as conn:
        # clear old
        old_ids = [
            r["id"]
            for r in conn.execute("SELECT id FROM kb_chunks WHERE doc_id=?", (doc_id,)).fetchall()
        ]
        delete_fts_for_doc(conn, doc_id)
        if old_ids:
            placeholders = ",".join("?" * len(old_ids))
            conn.execute(f"DELETE FROM kb_chunk_embeddings WHERE chunk_id IN ({placeholders})", old_ids)
        conn.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
        conn.execute("DELETE FROM kb_assets WHERE doc_id=?", (doc_id,))

        # Drop previous asset files so reindex does not accumulate blobs
        try:
            import shutil

            from evoflow.knowledge.owned.paths import files_dir

            asset_dir = files_dir() / kb_id / doc_id / "assets"
            if asset_dir.is_dir():
                shutil.rmtree(asset_dir, ignore_errors=True)
        except Exception:
            logger.debug("asset dir cleanup skipped", exc_info=True)

        chunk_rows: list[tuple] = []
        for i, piece in enumerate(pieces):
            cid = new_id("chk_")
            chunk_rows.append(
                (
                    cid,
                    kb_id,
                    doc_id,
                    i,
                    piece.content,
                    piece.context_header,
                    piece.token_estimate,
                    piece.heading_path,
                    piece.chunk_kind,
                    1,
                    now,
                    now,
                )
            )
        conn.executemany(
            """
            INSERT INTO kb_chunks(
              id, kb_id, doc_id, ordinal, content, context_header, token_estimate,
              heading_path, chunk_kind, enabled, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            chunk_rows,
        )
        insert_assets(conn, assets)
        link_assets_to_chunks(conn, assets, chunk_rows)
        for cid, _kb, _doc, _ord, content, header, *_rest in chunk_rows:
            fts_text = f"{header}\n{content}".strip() if header else content
            index_fts(conn, chunk_id=cid, kb_id=kb_id, doc_id=doc_id, content=fts_text)

    if not pieces:
        with db() as conn:
            conn.execute(
                """
                UPDATE kb_documents SET parse_status='completed', chunk_count=0,
                  error_message='', updated_at=? WHERE id=?
                """,
                (utc_now(), doc_id),
            )
        jobs.update_progress(job_id, {"phase": "done", "percent": 100, "message": "无文本块"})
        return

    # Collect chunk ids for embed or keyword-only completion
    chunk_ids: list[str] = []
    with db() as conn:
        rows = conn.execute(
            "SELECT id FROM kb_chunks WHERE doc_id=? ORDER BY ordinal",
            (doc_id,),
        ).fetchall()
        chunk_ids = [str(r["id"]) for r in rows]

    if skip_embedding:
        reason = (skip_embedding_reason or "embedding 未就绪").strip()
        note = f"已分块并可关键词检索；向量化已跳过（{reason[:180]}）"
        now = utc_now()
        with db() as conn:
            conn.execute(
                """
                UPDATE kb_documents SET parse_status='completed', chunk_count=?,
                  error_message=?, updated_at=? WHERE id=?
                """,
                (len(chunk_ids), note[:2000], now, doc_id),
            )
        jobs.update_progress(
            job_id,
            {
                "phase": "done",
                "percent": 100,
                "message": f"已分块 {len(chunk_ids)}（跳过向量）",
            },
        )
        logger.info(
            "owned parse_index skip embedding doc=%s chunks=%s reason=%s",
            doc_id,
            len(chunk_ids),
            reason,
        )
        return

    # Embed in batches so large docs (esp. Ark multimodal 1-req-per-chunk) can
    # report progress and fail with a clear phase instead of silent hang.
    jobs.update_progress(
        job_id,
        {"phase": "embedding", "percent": 55, "message": f"嵌入 {len(pieces)} 块"},
    )
    mc = _model_config_for_base(base_d)
    embed_inputs = []
    with db() as conn:
        rows = conn.execute(
            "SELECT id, content, context_header FROM kb_chunks WHERE doc_id=? ORDER BY ordinal",
            (doc_id,),
        ).fetchall()
        chunk_ids = []
        for r in rows:
            chunk_ids.append(r["id"])
            header = (r["context_header"] or "").strip()
            body = embed_text_for_chunk(r["content"] or "")
            embed_inputs.append(f"{header}\n{body}".strip() if header else body)

    from evoflow.knowledge.embedding.base import MAX_BATCH_SIZE

    model_name = str(getattr(mc, "model", "") or base_d.get("embedding_model") or "").lower()
    base_url = str(getattr(mc, "base_url", "") or base_d.get("embedding_base_url") or "").lower()
    multimodal = (
        "multimodal" in model_name
        or "embedding-vision" in model_name
        or ("/api/plan/" in base_url and "embed" in model_name)
    )
    # Multimodal = one HTTP call per chunk; keep batches small for progress + 429 recovery.
    batch_size = 8 if multimodal else (
        32 if str(base_d.get("embedding_mode") or "").lower() == "cloud" else MAX_BATCH_SIZE
    )
    vectors: list[list[float]] = []
    total = len(embed_inputs)
    for start in range(0, total, batch_size):
        batch = embed_inputs[start : start + batch_size]
        done_n = start + len(batch)
        pct = 55 + int(40 * (done_n / max(total, 1)))
        jobs.update_progress(
            job_id,
            {
                "phase": "embedding",
                "percent": min(94, pct),
                "message": f"嵌入 {done_n}/{total} 块",
            },
        )
        part = await get_embeddings(batch, mc, batch_size=len(batch))
        vectors.extend(part)

    if not vectors or len(vectors) != len(chunk_ids):
        raise RuntimeError("embedding result size mismatch")

    dim = len(vectors[0])
    model_name = str(base_d.get("embedding_model") or "")
    now = utc_now()
    with db() as conn:
        for cid, vec in zip(chunk_ids, vectors, strict=True):
            conn.execute(
                """
                INSERT OR REPLACE INTO kb_chunk_embeddings(
                  chunk_id, kb_id, doc_id, dim, embedding, model, created_at
                ) VALUES (?,?,?,?,?,?,?)
                """,
                (cid, kb_id, doc_id, dim, pack_embedding(list(vec)), model_name, now),
            )
        if not base_d.get("embedding_dim"):
            conn.execute(
                "UPDATE kb_bases SET embedding_dim=?, updated_at=? WHERE id=?",
                (dim, now, kb_id),
            )
        conn.execute(
            """
            UPDATE kb_documents SET parse_status='completed', chunk_count=?,
              error_message='', updated_at=? WHERE id=?
            """,
            (len(chunk_ids), now, doc_id),
        )

    # Optional summary enqueue
    if int(base_d.get("summary_enabled") or 0) == 1:
        try:
            jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="summary_doc", priority=200)
        except Exception:
            logger.debug("summary enqueue skipped", exc_info=True)
    elif int(base_d.get("wiki_enabled") or 0) == 1:
        try:
            jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="wiki_ingest", priority=220)
        except Exception:
            logger.debug("wiki enqueue skipped", exc_info=True)

    if int(base_d.get("graph_enabled") or 0) == 1:
        try:
            jobs.enqueue(kb_id=kb_id, doc_id=doc_id, type="kg_extract", priority=240)
        except Exception:
            logger.debug("kg enqueue skipped", exc_info=True)

    jobs.update_progress(
        job_id,
        {"phase": "done", "percent": 100, "message": f"已索引 {len(chunk_ids)} 块"},
    )


async def run_summary_doc(job: dict[str, Any]) -> None:
    """Best-effort document summary via default Chat model; never fails parse."""
    job_id = job["id"]
    doc_id = job.get("doc_id")
    if not doc_id:
        return
    now = utc_now()
    with db() as conn:
        doc = conn.execute(
            "SELECT * FROM kb_documents WHERE id=? AND deleted_at IS NULL", (doc_id,)
        ).fetchone()
        chunks = conn.execute(
            "SELECT content FROM kb_chunks WHERE doc_id=? AND enabled=1 ORDER BY ordinal",
            (doc_id,),
        ).fetchall()
    if not doc:
        return

    body = "\n\n".join(str(r["content"] or "") for r in chunks).strip()
    if not body:
        with db() as conn:
            conn.execute(
                "UPDATE kb_documents SET summary_status='skipped', updated_at=? WHERE id=?",
                (now, doc_id),
            )
        jobs.update_progress(job_id, {"phase": "done", "percent": 100, "message": "无正文，跳过摘要"})
        return

    title = str(doc["title"] or doc["file_name"] or "")
    excerpt = body[:6000]
    prompt = (
        "请为以下知识库文档写 3～8 句中文摘要。点出主题、关键实体与表格/结论要点；"
        "禁止臆造未出现的信息。只输出摘要正文。\n\n"
        f"标题：{title}\n\n正文：\n{excerpt}"
    )

    with db() as conn:
        conn.execute(
            "UPDATE kb_documents SET summary_status='processing', updated_at=? WHERE id=?",
            (now, doc_id),
        )
    jobs.update_progress(job_id, {"phase": "summarizing", "percent": 40, "message": "生成摘要"})

    try:
        from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model
        from evoflow.models import create_chat_model

        model = create_chat_model(thinking_enabled=False, invocation_kind="kb_summary")
        resp = await ainvoke_internal_chat_model(model, [{"role": "user", "content": prompt}])
        text = str(getattr(resp, "content", "") or resp).strip()
        if not text:
            raise ValueError("empty summary")
        if len(text) > 4000:
            text = text[:3999] + "…"
        done = utc_now()
        with db() as conn:
            conn.execute(
                """
                UPDATE kb_documents
                SET summary_status='completed', summary_text=?, updated_at=?
                WHERE id=?
                """,
                (text, done, doc_id),
            )
        jobs.update_progress(job_id, {"phase": "done", "percent": 100, "message": "摘要完成"})
    except Exception as exc:
        logger.info("owned summary skipped/failed: %s", exc)
        fail = utc_now()
        # No chat model / network → skipped; other errors → failed
        status = "skipped" if "not found" in str(exc).lower() or "Model" in str(exc) else "failed"
        with db() as conn:
            conn.execute(
                "UPDATE kb_documents SET summary_status=?, updated_at=? WHERE id=?",
                (status, fail, doc_id),
            )
        jobs.update_progress(
            job_id,
            {"phase": "done", "percent": 100, "message": f"摘要{status}"},
        )

    try:
        with db() as conn:
            base = conn.execute(
                "SELECT wiki_enabled FROM kb_bases WHERE id=?", (job.get("kb_id"),)
            ).fetchone()
        if base and int(base["wiki_enabled"] or 0) == 1 and job.get("kb_id"):
            jobs.enqueue(
                kb_id=job["kb_id"],
                doc_id=doc_id,
                type="wiki_ingest",
                priority=220,
            )
    except Exception:
        logger.debug("wiki enqueue after summary skipped", exc_info=True)

