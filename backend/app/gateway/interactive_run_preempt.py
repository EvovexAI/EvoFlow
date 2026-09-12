"""When the user starts an interactive chat stream, optionally free the shared LangGraph loop.

**Default OFF.** Multi-session concurrency keeps other sessions running; chat must
not cancel proactive/automation on other threads.

Legacy/emergency only: set ``EVOFLOW_CHAT_PREEMPT_PROACTIVE=1`` when job loops are
still shared and a long ``runs.wait`` starves ``runs/stream``. Prefer
``BG_JOB_ISOLATED_LOOPS`` / ``EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS=1`` instead.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def chat_preempt_proactive_enabled() -> bool:
    """Cross-thread preempt is OFF by default (never cancel other sessions).

    Opt in only for emergency shared-loop debugging: EVOFLOW_CHAT_PREEMPT_PROACTIVE=1.
    """
    raw = (os.getenv("EVOFLOW_CHAT_PREEMPT_PROACTIVE") or "0").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _session_hints(run: dict[str, Any]) -> dict[str, Any]:
    kwargs = run.get("kwargs") if isinstance(run.get("kwargs"), dict) else {}
    cfg = kwargs.get("config") if isinstance(kwargs, dict) else {}
    conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
    ctx = kwargs.get("context") if isinstance(kwargs, dict) else {}
    meta = run.get("metadata") if isinstance(run.get("metadata"), dict) else {}
    out: dict[str, Any] = {}
    for src in (conf if isinstance(conf, dict) else {}, ctx if isinstance(ctx, dict) else {}, meta):
        out.update(src)
    return out


def _is_preemptible_background_run(run: dict[str, Any], *, except_thread_id: str) -> bool:
    tid = str(run.get("thread_id") or "").strip()
    if not tid or tid == except_thread_id:
        return False
    status = str(run.get("status") or "").strip().lower()
    if status not in {"pending", "running"}:
        return False
    hints = _session_hints(run)
    if hints.get("evf_interactive") is True:
        return False
    if str(hints.get("evf_interactive") or "").strip().lower() in {"1", "true", "yes"}:
        return False
    sk = str(hints.get("session_key") or hints.get("sessionKey") or "").strip().lower()
    if sk.startswith("proactive:"):
        return True
    if str(hints.get("source") or "").strip().lower() == "proactive":
        return True
    if str(hints.get("proactive_agent_code") or "").strip():
        return True
    if hints.get("evf_interactive") is False:
        return True
    if str(hints.get("evf_interactive") or "").strip().lower() in {"0", "false", "no"}:
        return True
    return False


def _list_runs_sync() -> list[dict[str, Any]]:
    try:
        from langgraph_runtime_inmem.database import GLOBAL_STORE

        raw = GLOBAL_STORE.get("runs") or []
        return [r for r in raw if isinstance(r, dict)]
    except Exception:
        logger.debug("interactive preempt: GLOBAL_STORE peek failed", exc_info=True)
        return []


async def preempt_background_runs_for_chat(
    *,
    chat_thread_id: str,
    reason: str = "chat_stream",
) -> dict[str, Any]:
    """Cancel proactive/background LangGraph runs so interactive chat can schedule."""
    if not chat_preempt_proactive_enabled():
        return {"skipped": True, "reason": "disabled"}
    tid = str(chat_thread_id or "").strip()
    if not tid:
        return {"skipped": True, "reason": "no_thread"}

    summary: dict[str, Any] = {
        "chat_thread_id": tid,
        "reason": reason,
        "cancelled": [],
        "errors": 0,
    }

    runs = _list_runs_sync()
    if not runs:
        try:
            from langgraph_runtime_inmem.database import connect

            async with connect() as conn:
                raw = conn.store.get("runs") or []
                runs = [r for r in raw if isinstance(r, dict)]
        except Exception:
            logger.debug("interactive preempt: connect peek failed", exc_info=True)

    targets = [r for r in runs if _is_preemptible_background_run(r, except_thread_id=tid)]
    summary["matched"] = len(targets)
    if not targets:
        return summary

    try:
        import httpx
        from evoflow.langgraph_run_config import resolve_langgraph_base_url

        base = (resolve_langgraph_base_url() or "").rstrip("/")
    except Exception:
        base = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").rstrip("/")

    for run in targets:
        run_tid = str(run.get("thread_id") or "").strip()
        run_id = str(run.get("run_id") or "").strip()
        if not run_tid or not run_id:
            continue
        ok = False
        if base:
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    resp = await client.post(
                        f"{base}/threads/{run_tid}/runs/{run_id}/cancel",
                        json={"wait": False},
                    )
                    ok = resp.status_code < 400
            except Exception:
                ok = False
        if not ok:
            try:
                run["status"] = "interrupted"
                ok = True
            except Exception:
                summary["errors"] += 1
                continue
        if ok:
            summary["cancelled"].append({"thread_id": run_tid, "run_id": run_id})
            logger.info(
                "interactive preempt: cancelled background run thread=%s run=%s for chat=%s (%s)",
                run_tid,
                run_id,
                tid,
                reason,
            )

    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        write_run_latency_event(
            tid,
            "interactive_preempt",
            {
                "matched": summary.get("matched"),
                "cancelled_n": len(summary["cancelled"]),
                "reason": reason,
            },
        )
    except Exception:
        pass
    # Yield so cancelled coroutines can unwind before chat claims the loop.
    try:
        import asyncio

        await asyncio.sleep(0)
    except Exception:
        pass
    return summary
