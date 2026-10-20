"""SQLite job queue (no Redis)."""

from __future__ import annotations

import json
import logging
from datetime import UTC
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now
from evoflow.knowledge.owned.kb_conn import db_for_kb

logger = logging.getLogger(__name__)


def enqueue(
    *,
    kb_id: str,
    type: str,
    doc_id: str | None = None,
    priority: int = 100,
    payload: dict[str, Any] | None = None,
    run_after: str | None = None,
) -> dict[str, Any]:
    now = utc_now()
    # Coalesce concurrent rebuild requests for the same document. This keeps
    # sync, manual rebuild, and retry paths from issuing duplicate embeddings.
    if doc_id and type in ("parse_index", "reindex"):
        with db() as conn:
            existing = conn.execute(
                """
                SELECT * FROM kb_jobs
                WHERE kb_id=? AND doc_id=? AND type IN ('parse_index', 'reindex')
                  AND state IN ('queued', 'running')
                ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
                LIMIT 1
                """,
                (kb_id, doc_id),
            ).fetchone()
        if existing:
            return _job_row(existing) or {"id": existing["id"], "state": existing["state"]}

    job_id = new_id("job_")
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_jobs(
              id, kb_id, doc_id, type, state, attempts, max_attempts, priority,
              run_after, progress_json, error_message, locked_by, payload_json,
              created_at, updated_at
            ) VALUES (?,?,?,?, 'queued', 0, 3, ?, ?, '{}', '', '', ?, ?, ?)
            """,
            (
                job_id,
                kb_id,
                doc_id,
                type,
                priority,
                run_after or now,
                json.dumps(payload or {}, ensure_ascii=False),
                now,
                now,
            ),
        )
        if doc_id:
            conn.execute(
                "UPDATE kb_documents SET latest_job_id=?, updated_at=? WHERE id=?",
                (job_id, now, doc_id),
            )
    # The job queue is central, but the document row lives in the KB's own index
    # DB — mirror ``latest_job_id`` there so document reads see it.
    if doc_id:
        try:
            from evoflow.knowledge.owned.kb_conn import db_for_kb

            with db_for_kb(kb_id) as kb_conn:
                kb_conn.execute(
                    "UPDATE kb_documents SET latest_job_id=?, updated_at=? WHERE id=?",
                    (job_id, now, doc_id),
                )
        except Exception:
            logger.debug("latest_job_id mirror skipped for doc=%s", doc_id, exc_info=True)
    return get_job(job_id) or {"id": job_id, "state": "queued"}


def _doc_titles_for_kb(kb_id: str, doc_ids: list[Any]) -> dict[str, str]:
    """Map doc_id → display title from the KB-local documents table."""
    ids = sorted({str(x or "").strip() for x in doc_ids if str(x or "").strip()})
    if not ids or not kb_id:
        return {}
    out: dict[str, str] = {}
    try:
        with db_for_kb(kb_id) as conn:
            ph = ",".join("?" * len(ids))
            rows = conn.execute(
                f"SELECT id, title, file_name FROM kb_documents WHERE id IN ({ph})",
                ids,
            ).fetchall()
        for row in rows:
            title = str(row["title"] or "").strip() or str(row["file_name"] or "").strip()
            if title:
                out[str(row["id"])] = title
    except Exception:
        logger.debug("doc title lookup failed kb=%s", kb_id, exc_info=True)
    return out


def _enrich_jobs_with_titles(kb_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    titles = _doc_titles_for_kb(kb_id, [j.get("docId") or j.get("doc_id") for j in items])
    for job in items:
        did = str(job.get("docId") or job.get("doc_id") or "").strip()
        job["docTitle"] = titles.get(did) or ""
    return items


def list_jobs(kb_id: str, *, limit: int = 50, states: list[str] | None = None) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit or 50), 200))
    with db() as conn:
        if states:
            placeholders = ",".join("?" * len(states))
            # Active ledger: running first, then priority / age (FIFO within priority).
            rows = conn.execute(
                f"""
                SELECT * FROM kb_jobs
                WHERE kb_id=? AND state IN ({placeholders})
                ORDER BY
                  CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                  priority ASC,
                  created_at ASC
                LIMIT ?
                """,
                (kb_id, *states, lim),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM kb_jobs
                WHERE kb_id=?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (kb_id, lim),
            ).fetchall()
    return _enrich_jobs_with_titles(kb_id, [_job_row(r) for r in rows])


def job_stats(kb_id: str) -> dict[str, Any]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT state, count(*) AS c FROM kb_jobs
            WHERE kb_id=?
            GROUP BY state
            """,
            (kb_id,),
        ).fetchall()
        error_rows = conn.execute(
            """
            SELECT id, doc_id, type, state, attempts, max_attempts,
                   error_message, updated_at, finished_at
            FROM kb_jobs
            WHERE kb_id=? AND state='error' AND COALESCE(error_message, '') <> ''
            ORDER BY COALESCE(finished_at, updated_at, created_at) DESC
            LIMIT 20
            """
            ,
            (kb_id,),
        ).fetchall()
    # Document rows are KB-local; the job queue above is central.
    pending_docs = 0
    try:
        with db_for_kb(kb_id) as kb_conn:
            pending_docs = kb_conn.execute(
                """
                SELECT count(*) FROM kb_documents
                WHERE kb_id=? AND deleted_at IS NULL
                  AND parse_status IN ('pending', 'processing')
                """,
                (kb_id,),
            ).fetchone()[0]
    except Exception:
        logger.debug("pending doc count skipped for kb=%s", kb_id, exc_info=True)
    by_state = {str(r["state"]): int(r["c"]) for r in rows}
    errors = _enrich_jobs_with_titles(kb_id, [_job_row(row) for row in error_rows])
    return {
        "byState": by_state,
        "queued": by_state.get("queued", 0),
        "running": by_state.get("running", 0),
        "done": by_state.get("done", 0),
        "error": by_state.get("error", 0),
        "pendingDocs": int(pending_docs or 0),
        "active": by_state.get("queued", 0) + by_state.get("running", 0),
        "errors": errors,
    }


def get_job(job_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM kb_jobs WHERE id=?", (job_id,)).fetchone()
    return _job_row(row) if row else None


def claim_next(worker_id: str) -> dict[str, Any] | None:
    now = utc_now()
    with db() as conn:
        row = conn.execute(
            """
            SELECT * FROM kb_jobs
            WHERE state='queued' AND run_after <= ?
            ORDER BY priority ASC, created_at ASC
            LIMIT 1
            """,
            (now,),
        ).fetchone()
        if not row:
            return None
        job_id = row["id"]
        cur = conn.execute(
            """
            UPDATE kb_jobs
            SET state='running', locked_by=?, locked_at=?, attempts=attempts+1,
                updated_at=?, progress_json=?
            WHERE id=? AND state='queued'
            """,
            (
                worker_id,
                now,
                now,
                json.dumps({"phase": "starting", "message": "任务已领取"}, ensure_ascii=False),
                job_id,
            ),
        )
        if cur.rowcount != 1:
            return None
        row = conn.execute("SELECT * FROM kb_jobs WHERE id=?", (job_id,)).fetchone()
    return _job_row(row) if row else None


def update_progress(job_id: str, progress: dict[str, Any]) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE kb_jobs SET progress_json=?, updated_at=? WHERE id=?",
            (json.dumps(progress, ensure_ascii=False), utc_now(), job_id),
        )


def complete(job_id: str, *, error: str | None = None, permanent: bool = False) -> None:
    now = utc_now()
    with db() as conn:
        row = conn.execute("SELECT * FROM kb_jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return
        doc_id = str(row["doc_id"] or "").strip()
        jtype = str(row["type"] or "").strip()
        kb_id = str(row["kb_id"] or "").strip()
        if error:
            attempts = int(row["attempts"] or 0)
            max_attempts = int(row["max_attempts"] or 3)
            if not permanent and attempts < max_attempts:
                conn.execute(
                    """
                    UPDATE kb_jobs SET state='queued', error_message=?, locked_by='',
                      locked_at=NULL, run_after=?, updated_at=?,
                      progress_json=?
                    WHERE id=?
                    """,
                    (
                        error[:2000],
                        now,
                        now,
                        json.dumps(
                            {"phase": "retry", "message": f"将重试: {error[:120]}"},
                            ensure_ascii=False,
                        ),
                        job_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE kb_jobs SET state='error', error_message=?, finished_at=?,
                      updated_at=?, locked_by='', locked_at=NULL
                    WHERE id=?
                    """,
                    (error[:2000], now, now, job_id),
                )
                # parse_index/reindex leave docs in ``processing`` on exception —
                # surface a terminal failed status so UI/search don't hang forever.
                if doc_id and jtype in ("parse_index", "reindex"):
                    conn.execute(
                        """
                        UPDATE kb_documents
                        SET parse_status='failed',
                            index_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                            keyword_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                            vector_status=CASE WHEN chunk_count > 0 THEN 'degraded' ELSE 'failed' END,
                            index_error=?, error_message=?, updated_at=?
                        WHERE id=? AND deleted_at IS NULL
                          AND parse_status IN ('pending', 'processing')
                        """,
                        (error[:2000], error[:2000], now, doc_id),
                    )
                    _mirror_doc_status(
                        kb_id,
                        doc_id,
                        """
                        UPDATE kb_documents
                        SET parse_status='failed',
                            index_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                            keyword_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                            vector_status=CASE WHEN chunk_count > 0 THEN 'degraded' ELSE 'failed' END,
                            index_error=?, error_message=?, updated_at=?
                        WHERE id=? AND deleted_at IS NULL
                          AND parse_status IN ('pending', 'processing')
                        """,
                        (error[:2000], error[:2000], now, doc_id),
                    )
        else:
            conn.execute(
                """
                UPDATE kb_jobs SET state='done', finished_at=?, updated_at=?,
                  locked_by='', locked_at=NULL,
                  progress_json=?
                WHERE id=?
                """,
                (
                    now,
                    now,
                    json.dumps(
                        {"phase": "done", "percent": 100, "message": "完成"},
                        ensure_ascii=False,
                    ),
                    job_id,
                ),
            )
            # A later successful run supersedes older terminal-error rows of the
            # same document + job type. Without this, ``job_stats`` keeps
            # returning the stale error rows and the UI index-status banner
            # shows a failure forever even though the document re-parsed fine.
            if doc_id:
                # ``created_at`` is second-precision; ``rowid`` gives the strict
                # insertion order needed for same-second retry chains.
                conn.execute(
                    """
                    UPDATE kb_jobs SET state='cancelled',
                      error_message='superseded by a successful re-run',
                      finished_at=?, updated_at=?, locked_by='', locked_at=NULL
                    WHERE kb_id=? AND doc_id=? AND type=? AND state='error'
                      AND rowid < (SELECT rowid FROM kb_jobs WHERE id=?)
                    """,
                    (now, now, kb_id, doc_id, jtype, job_id),
                )


def cancel_for_kb(kb_id: str) -> int:
    """Cancel queued/running jobs of a base so they don't retry against a deleted KB.

    Returns the number of jobs moved to ``cancelled``.
    """
    now = utc_now()
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE kb_jobs SET state='cancelled', error_message='knowledge base deleted',
              finished_at=?, updated_at=?, locked_by='', locked_at=NULL
            WHERE kb_id=? AND state IN ('queued', 'running')
            """,
            (now, now, kb_id),
        )
        return int(cur.rowcount or 0)


def cancel_jobs_for_doc(doc_id: str, *, reason: str = "document deleted") -> int:
    """Cancel queued/running jobs of one document (soft-delete safety net).

    Prevents the worker from claiming a job whose document row is already gone
    and burning retries on "knowledge base or document not found".
    """
    did = str(doc_id or "").strip()
    if not did:
        return 0
    now = utc_now()
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE kb_jobs SET state='cancelled', error_message=?,
              finished_at=?, updated_at=?, locked_by='', locked_at=NULL
            WHERE doc_id=? AND state IN ('queued', 'running')
            """,
            (reason, now, now, did),
        )
        return int(cur.rowcount or 0)


def purge_failed_orphan_jobs(*, limit: int = 500) -> int:
    """Cancel jobs whose owning KB or document was soft-deleted.

    Walks the central job queue, joins against ``kb_bases`` (deleted_at) and
    the per-KB ``kb_documents`` (deleted_at), and flips any non-terminal job
    to ``cancelled`` with a clear reason. This stops the worker from burning
    retries on rows that no longer exist and removes the long tail of
    ``knowledge base or document not found`` errors that show up in the UI
    banner after a KB is deleted or rebuilt.

    Returns the number of jobs cancelled.
    """
    now = utc_now()
    cancelled = 0
    seen: set[tuple[str, str | None]] = set()

    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, kb_id, doc_id
            FROM kb_jobs
            WHERE state IN ('queued', 'running', 'error')
            ORDER BY updated_at ASC
            LIMIT ?
            """,
            (int(limit),),
        ).fetchall()

        for row in rows:
            job_id = str(row["id"] or "")
            kb_id = str(row["kb_id"] or "").strip()
            doc_id = str(row["doc_id"] or "").strip() or None
            if not job_id or not kb_id:
                continue
            key = (kb_id, doc_id)
            if key in seen:
                continue
            seen.add(key)

            # KB soft-deleted?
            base = conn.execute(
                "SELECT 1 FROM kb_bases WHERE id=? AND deleted_at IS NULL",
                (kb_id,),
            ).fetchone()
            if base is None:
                conn.execute(
                    """
                    UPDATE kb_jobs SET state='cancelled',
                      error_message='knowledge base deleted (purged by reconcile)',
                      finished_at=?, updated_at=?, locked_by='', locked_at=NULL
                    WHERE id=? AND state IN ('queued', 'running', 'error')
                    """,
                    (now, now, job_id),
                )
                cancelled += 1
                continue

            # doc soft-deleted (per-KB index DB)?
            if doc_id:
                try:
                    with db_for_kb(kb_id) as kb_conn:
                        doc = kb_conn.execute(
                            "SELECT 1 FROM kb_documents WHERE id=? AND deleted_at IS NULL",
                            (doc_id,),
                        ).fetchone()
                except Exception:
                    logger.debug("orphan purge: doc lookup failed for %s/%s", kb_id, doc_id, exc_info=True)
                    continue
                if doc is None:
                    conn.execute(
                        """
                        UPDATE kb_jobs SET state='cancelled',
                          error_message='document deleted (purged by reconcile)',
                          finished_at=?, updated_at=?, locked_by='', locked_at=NULL
                        WHERE id=? AND state IN ('queued', 'running', 'error')
                        """,
                        (now, now, job_id),
                    )
                    cancelled += 1
    if cancelled:
        logger.info("owned kb purged %s orphan jobs", cancelled)
    return cancelled


def _mirror_doc_status(kb_id: str, doc_id: str, sql: str, params: tuple) -> None:
    """Apply a document-status update in the KB's own index DB.

    The job queue lives centrally while document rows live per KB, so terminal
    job transitions must be mirrored or the UI keeps showing stale status.
    """
    try:
        from evoflow.knowledge.owned.kb_conn import db_for_kb

        with db_for_kb(kb_id) as conn:
            conn.execute(sql, params)
    except Exception:
        logger.debug("doc status mirror skipped for doc=%s", doc_id, exc_info=True)


def reclaim_stale_running(*, older_than_seconds: int = 1800) -> int:
    """Re-queue or fail jobs stuck in ``running`` (worker crash / process kill).

    Reclaiming counts against the job's retry budget: a job that has exhausted
    ``max_attempts`` goes to terminal ``error`` (and its document to ``failed``)
    instead of bouncing between running/queued forever.
    """
    import time
    from datetime import datetime

    cutoff_s = max(60, int(older_than_seconds or 1800))
    now = utc_now()
    try:
        # locked_at is ISO-ish from utc_now(); compare lexicographically when Zulu.
        threshold = datetime.now(UTC).timestamp() - cutoff_s
    except Exception:
        threshold = time.time() - cutoff_s

    reclaimed = 0
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, locked_at, doc_id, type, kb_id, attempts, max_attempts FROM kb_jobs
            WHERE state='running'
            """
        ).fetchall()
        for row in rows:
            locked = str(row["locked_at"] or "").strip()
            stale = False
            if not locked:
                stale = True
            else:
                try:
                    # Accept "…Z" or "+00:00"
                    raw = locked.replace("Z", "+00:00")
                    ts = datetime.fromisoformat(raw).timestamp()
                    stale = ts < threshold
                except Exception:
                    stale = True
            if not stale:
                continue
            attempts = int(row["attempts"] or 0)
            max_attempts = int(row["max_attempts"] or 3)
            # attempts was already incremented at claim time, so attempts >=
            # max_attempts means the budget is spent — do not queue again.
            if attempts < max_attempts:
                conn.execute(
                    """
                    UPDATE kb_jobs SET state='queued', locked_by='', locked_at=NULL,
                      error_message=?, run_after=?, updated_at=?,
                      progress_json=?
                    WHERE id=? AND state='running'
                    """,
                    (
                        "reclaimed stale running job",
                        now,
                        now,
                        json.dumps(
                            {"phase": "retry", "message": "任务超时，已重新排队"},
                            ensure_ascii=False,
                        ),
                        row["id"],
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE kb_jobs SET state='error', error_message=?,
                      finished_at=?, updated_at=?, locked_by='', locked_at=NULL
                    WHERE id=? AND state='running'
                    """,
                    (
                        "reclaimed stale running job: retry budget exhausted",
                        now,
                        now,
                        row["id"],
                    ),
                )
                # Terminal failure for parse/reindex jobs must also surface on
                # the document row, same as jobs.complete(permanent error) does.
                doc_id = str(row["doc_id"] or "").strip()
                jtype = str(row["type"] or "").strip()
                kb_id = str(row["kb_id"] or "").strip()
                if doc_id and jtype in ("parse_index", "reindex"):
                    err = "task timed out repeatedly and was reclaimed (retry budget exhausted)"
                    try:
                        conn.execute(
                            """
                            UPDATE kb_documents
                            SET parse_status='failed',
                                index_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                                keyword_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                                vector_status=CASE WHEN chunk_count > 0 THEN 'degraded' ELSE 'failed' END,
                                index_error=?, error_message=?, updated_at=?
                            WHERE id=? AND deleted_at IS NULL
                              AND parse_status IN ('pending', 'processing')
                            """,
                            (err, err, now, doc_id),
                        )
                    except Exception:
                        # Document table may be in a per-KB index DB; the central
                        # DB mirror below covers the cross-DB case.
                        logger.debug("terminal doc-status update skipped in central db", exc_info=True)
                    _mirror_doc_status(
                        kb_id,
                        doc_id,
                        """
                        UPDATE kb_documents
                        SET parse_status='failed',
                            index_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                            keyword_status=CASE WHEN chunk_count > 0 THEN 'ready' ELSE 'failed' END,
                            vector_status=CASE WHEN chunk_count > 0 THEN 'degraded' ELSE 'failed' END,
                            index_error=?, error_message=?, updated_at=?
                        WHERE id=? AND deleted_at IS NULL
                          AND parse_status IN ('pending', 'processing')
                        """,
                        (err, err, now, doc_id),
                    )
            reclaimed += 1
    return reclaimed


def list_orphan_parse_docs(
    kb_id: str | None = None,
    *,
    limit: int = 200,
    statuses: tuple[str, ...] = ("pending", "processing"),
) -> list[dict[str, Any]]:
    """Docs in given parse statuses with no queued/running parse_index/reindex job.

    Documents live in per-KB index DBs while the job queue is central, so this
    cannot be a single JOIN: collect candidate docs per KB, then subtract the
    docs that still have an active job.
    """
    lim = max(1, min(int(limit or 200), 500))
    status_list = [str(s).strip() for s in (statuses or ()) if str(s).strip()]
    if not status_list:
        status_list = ["pending", "processing"]
    placeholders = ",".join("?" * len(status_list))

    scopes: list[str]
    if kb_id:
        scopes = [str(kb_id).strip()]
    else:
        from evoflow.knowledge.owned.service import list_bases

        scopes = [str(b.get("id") or "").strip() for b in list_bases() if b.get("id")]

    candidates: list[dict[str, Any]] = []
    for scope in scopes:
        if not scope:
            continue
        try:
            with db_for_kb(scope) as conn:
                rows = conn.execute(
                    f"""
                    SELECT d.id AS doc_id, d.kb_id, d.title, d.file_name, d.parse_status,
                           d.latest_job_id, d.error_message, d.updated_at
                    FROM kb_documents d
                    WHERE d.deleted_at IS NULL
                      AND d.parse_status IN ({placeholders})
                    ORDER BY d.updated_at ASC
                    LIMIT ?
                    """,
                    (*status_list, lim),
                ).fetchall()
        except Exception:
            logger.debug("orphan scan skipped kb=%s", scope, exc_info=True)
            continue
        candidates.extend(dict(r) for r in rows)

    if not candidates:
        return []

    # Subtract docs that still have an active parse job (central job queue).
    active: set[str] = set()
    try:
        with db() as conn:
            for r in conn.execute(
                """
                SELECT DISTINCT doc_id FROM kb_jobs
                WHERE doc_id IS NOT NULL
                  AND type IN ('parse_index', 'reindex')
                  AND state IN ('queued', 'running')
                """
            ).fetchall():
                active.add(str(r[0] or ""))
    except Exception:
        logger.debug("active job lookup failed", exc_info=True)

    out = [r for r in candidates if str(r.get("doc_id") or "") not in active]
    out.sort(key=lambda r: str(r.get("updated_at") or ""))
    return out[:lim]


def _job_row(row: Any) -> dict[str, Any]:
    d = dict(row)
    for key in ("progress_json", "payload_json"):
        raw = d.get(key) or "{}"
        try:
            d[key.replace("_json", "")] = json.loads(raw)
        except Exception:
            d[key.replace("_json", "")] = {}
    d["id"] = d.get("id")
    d["jobId"] = d.get("id")
    d["kbId"] = d.get("kb_id")
    d["docId"] = d.get("doc_id")
    return d
