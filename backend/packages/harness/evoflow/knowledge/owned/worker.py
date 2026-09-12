"""Background worker for owned KB jobs (in-process, no Redis)."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import uuid
from typing import Any

from evoflow.knowledge.owned import jobs
from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.embedding_bind import embedding_runtime_ready_for_base_row
from evoflow.knowledge.owned.kg_pipeline import run_kg_extract
from evoflow.knowledge.owned.pipeline import run_parse_index, run_summary_doc
from evoflow.knowledge.owned.wiki_pipeline import run_wiki_finalize, run_wiki_ingest

logger = logging.getLogger(__name__)

_worker_lock = threading.Lock()
_started = False
_stop = threading.Event()
_WORKER_ID = f"gw-{uuid.uuid4().hex[:8]}"

# Idle poll was 0.75s and thrashed owned.sqlite; 5s is enough for KB job latency.
_DEFAULT_IDLE_POLL_S = 5.0


def owned_kb_worker_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_OWNED_KB_WORKER") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off", "disabled")


def owned_kb_idle_poll_seconds() -> float:
    raw = (os.getenv("EVOFLOW_OWNED_KB_POLL_S") or str(_DEFAULT_IDLE_POLL_S)).strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return _DEFAULT_IDLE_POLL_S


async def _dispatch(job: dict[str, Any]) -> None:
    jtype = job.get("type")
    try:
        if jtype == "parse_index" or jtype == "reindex":
            kb_id = str(job.get("kb_id") or job.get("kbId") or "").strip()
            skip_embedding = False
            skip_reason: str | None = None
            if kb_id:
                with db() as conn:
                    base = conn.execute(
                        "SELECT * FROM kb_bases WHERE id=? AND deleted_at IS NULL",
                        (kb_id,),
                    ).fetchone()
                if base is not None:
                    ready, reason = embedding_runtime_ready_for_base_row(dict(base))
                    if not ready:
                        # Do not burn the job as permanent failure — still parse / chunk /
                        # FTS so keyword search works. Vectors wait until a model is ready.
                        skip_embedding = True
                        skip_reason = reason or "embedding runtime unavailable"
                        logger.warning(
                            "owned kb job will skip vectors (embedding unavailable): "
                            "%s type=%s kb=%s reason=%s",
                            job.get("id"),
                            jtype,
                            kb_id,
                            skip_reason,
                        )
            await run_parse_index(
                job,
                skip_embedding=skip_embedding,
                skip_embedding_reason=skip_reason,
            )
            jobs.complete(job["id"])
        elif jtype == "summary_doc":
            await run_summary_doc(job)
            jobs.complete(job["id"])
        elif jtype == "wiki_ingest":
            await run_wiki_ingest(job)
            jobs.complete(job["id"])
        elif jtype == "wiki_finalize":
            await run_wiki_finalize(job)
            jobs.complete(job["id"])
        elif jtype == "kg_extract":
            await run_kg_extract(job)
            jobs.complete(job["id"])
        elif jtype == "mem_consolidate":
            from evoflow.memory.consolidate import run_consolidate_job

            await asyncio.to_thread(run_consolidate_job, job)
            jobs.complete(job["id"])
        elif jtype == "mem_kg_extract":
            from evoflow.memory.kg_extract import run_mem_kg_extract

            await run_mem_kg_extract(job)
            jobs.complete(job["id"])
        elif jtype == "mem_kg_batch":
            from evoflow.memory.kg_extract import run_mem_kg_batch

            await run_mem_kg_batch(job)
            jobs.complete(job["id"])
        else:
            jobs.complete(job["id"], error=f"unknown job type: {jtype}")
    except Exception as exc:
        logger.exception("owned kb job failed: %s", job.get("id"))
        jobs.complete(job["id"], error=str(exc))


async def _loop() -> None:
    poll_s = owned_kb_idle_poll_seconds()
    logger.info(
        "owned KB worker started id=%s idle_poll=%ss (disable with EVOFLOW_OWNED_KB_WORKER=0)",
        _WORKER_ID,
        poll_s,
    )
    reconcile_every = max(30.0, poll_s * 6)
    last_reconcile = 0.0
    while not _stop.is_set():
        if not owned_kb_worker_enabled():
            await asyncio.sleep(poll_s)
            continue
        now_mono = asyncio.get_running_loop().time()
        if now_mono - last_reconcile >= reconcile_every:
            last_reconcile = now_mono
            try:

                def _reconcile() -> int:
                    jobs.reclaim_stale_running()
                    from evoflow.knowledge.owned import service as owned_service

                    # Auto path: only pending/processing — never loop forever on failed.
                    result = owned_service.requeue_orphan_parse_docs(
                        limit=50, include_failed=False
                    )
                    return int(result.get("requeued") or 0)

                n = await asyncio.to_thread(_reconcile)
                if n:
                    logger.info("owned KB requeued %s orphan parse docs", n)
            except Exception:
                logger.debug("owned KB orphan reconcile skipped", exc_info=True)
        job = await asyncio.to_thread(jobs.claim_next, _WORKER_ID)
        if not job:
            await asyncio.sleep(poll_s)
            continue
        await _dispatch(job)
        # Drain backlog without idle delay between consecutive jobs.
    logger.info("owned KB worker stopped")

def ensure_owned_kb_worker_started() -> None:
    """Idempotent: spawn one asyncio task on the running loop, or a daemon thread."""
    global _started
    with _worker_lock:
        if _started:
            return
        if not owned_kb_worker_enabled():
            logger.info("owned KB worker not started (EVOFLOW_OWNED_KB_WORKER=0)")
            return
        _started = True
        _stop.clear()

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            loop.create_task(_loop())
            return

        def _thread_main() -> None:
            asyncio.run(_loop())

        t = threading.Thread(target=_thread_main, name="owned-kb-worker", daemon=True)
        t.start()


def stop_owned_kb_worker_for_tests() -> None:
    global _started
    _stop.set()
    with _worker_lock:
        _started = False
