"""SQLite job queue (no Redis)."""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now

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
    job_id = new_id("job_")
    now = utc_now()
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
    return get_job(job_id) or {"id": job_id, "state": "queued"}


def list_jobs(kb_id: str, *, limit: int = 50, states: list[str] | None = None) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit or 50), 200))
    with db() as conn:
        if states:
            placeholders = ",".join("?" * len(states))
            rows = conn.execute(
                f"""
                SELECT * FROM kb_jobs
                WHERE kb_id=? AND state IN ({placeholders})
                ORDER BY created_at DESC
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
    return [_job_row(r) for r in rows]


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
        pending_docs = conn.execute(
            """
            SELECT count(*) FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
              AND parse_status IN ('pending', 'processing')
            """,
            (kb_id,),
        ).fetchone()[0]
    by_state = {str(r["state"]): int(r["c"]) for r in rows}
    return {
        "byState": by_state,
        "queued": by_state.get("queued", 0),
        "running": by_state.get("running", 0),
        "done": by_state.get("done", 0),
        "error": by_state.get("error", 0),
        "pendingDocs": int(pending_docs or 0),
        "active": by_state.get("queued", 0) + by_state.get("running", 0),
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
                        SET parse_status='failed', error_message=?, updated_at=?
                        WHERE id=? AND deleted_at IS NULL
                          AND parse_status IN ('pending', 'processing')
                        """,
                        (error[:2000], now, doc_id),
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


def reclaim_stale_running(*, older_than_seconds: int = 1800) -> int:
    """Re-queue jobs stuck in ``running`` (worker crash / process kill)."""
    import time
    from datetime import datetime, timezone

    cutoff_s = max(60, int(older_than_seconds or 1800))
    now = utc_now()
    try:
        # locked_at is ISO-ish from utc_now(); compare lexicographically when Zulu.
        threshold = datetime.now(timezone.utc).timestamp() - cutoff_s
    except Exception:
        threshold = time.time() - cutoff_s

    reclaimed = 0
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, locked_at, doc_id, type FROM kb_jobs
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
            reclaimed += 1
    return reclaimed


def list_orphan_parse_docs(
    kb_id: str | None = None,
    *,
    limit: int = 200,
    statuses: tuple[str, ...] = ("pending", "processing"),
) -> list[dict[str, Any]]:
    """Docs in given parse statuses with no queued/running parse_index/reindex job."""
    lim = max(1, min(int(limit or 200), 500))
    status_list = [str(s).strip() for s in (statuses or ()) if str(s).strip()]
    if not status_list:
        status_list = ["pending", "processing"]
    placeholders = ",".join("?" * len(status_list))
    with db() as conn:
        params: list[Any] = list(status_list)
        kb_clause = ""
        if kb_id:
            kb_clause = "AND d.kb_id=?"
            params.append(kb_id)
        rows = conn.execute(
            f"""
            SELECT d.id AS doc_id, d.kb_id, d.title, d.file_name, d.parse_status,
                   d.latest_job_id, d.error_message
            FROM kb_documents d
            WHERE d.deleted_at IS NULL
              AND d.parse_status IN ({placeholders})
              {kb_clause}
              AND NOT EXISTS (
                SELECT 1 FROM kb_jobs j
                WHERE j.doc_id = d.id
                  AND j.type IN ('parse_index', 'reindex')
                  AND j.state IN ('queued', 'running')
              )
            ORDER BY d.updated_at ASC
            LIMIT ?
            """,
            (*params, lim),
        ).fetchall()
    return [dict(r) for r in rows]


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
