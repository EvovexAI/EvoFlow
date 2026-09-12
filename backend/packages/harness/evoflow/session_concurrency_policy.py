"""EvoFlow session concurrency policy (Python / LangGraph).

Rules (hard):
1. Same ``thread_id``: interrupt / multitask replace of the prior run is allowed
   (chat ``multitask_strategy=interrupt``).
2. Different ``thread_id``: automatic cancel of other sessions is forbidden.
3. ``evf_interactive`` is a **scheduling hint** only — never a license to kill
   other threads (use queue claim priority instead).

Cross-thread preempt (`EVOFLOW_CHAT_PREEMPT_PROACTIVE=1`) is an emergency escape
hatch for shared-loop starvation, not the default product behavior.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def may_auto_cancel_other_thread(
    *,
    actor_thread_id: str,
    target_thread_id: str,
) -> bool:
    """True only when actor and target are the same thread (self-interrupt)."""
    a = str(actor_thread_id or "").strip()
    t = str(target_thread_id or "").strip()
    if not a or not t:
        return False
    return a == t


def should_prefer_interactive_claim(run: dict[str, Any]) -> bool:
    """Scheduling hint: interactive chat runs should be claimed before background."""
    hints = _run_hints(run)
    if hints.get("evf_interactive") is True:
        return True
    if str(hints.get("evf_interactive") or "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    sk = str(hints.get("session_key") or hints.get("sessionKey") or "").strip().lower()
    if sk.startswith("proactive:"):
        return False
    if str(hints.get("source") or "").strip().lower() == "proactive":
        return False
    return False


def claim_priority_key(run: dict[str, Any]) -> tuple[int, float]:
    """Sort key for pending claims: interactive first, then older created_at."""
    interactive = 0 if should_prefer_interactive_claim(run) else 1
    created = run.get("created_at")
    age = 0.0
    if created is not None:
        try:
            if hasattr(created, "timestamp"):
                age = float(created.timestamp())
            else:
                from datetime import datetime

                age = datetime.fromisoformat(str(created).replace("Z", "+00:00")).timestamp()
        except Exception:
            age = 0.0
    return (interactive, age)


def _run_hints(run: dict[str, Any]) -> dict[str, Any]:
    kwargs = run.get("kwargs") if isinstance(run.get("kwargs"), dict) else {}
    cfg = kwargs.get("config") if isinstance(kwargs, dict) else {}
    conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
    ctx = kwargs.get("context") if isinstance(kwargs, dict) else {}
    meta = run.get("metadata") if isinstance(run.get("metadata"), dict) else {}
    out: dict[str, Any] = {}
    for src in (conf if isinstance(conf, dict) else {}, ctx if isinstance(ctx, dict) else {}, meta):
        out.update(src)
    return out


async def interrupt_thread(
    thread_id: str,
    *,
    base_url: str | None = None,
    limit: int = 20,
    op_timeout: float = 3.0,
) -> dict[str, Any]:
    """Cancel pending/running runs on **one** LangGraph thread only (same-session interrupt)."""
    import asyncio
    import os

    import httpx

    tid = str(thread_id or "").strip()
    summary: dict[str, Any] = {"thread_id": tid, "cancelled": [], "errors": 0}
    if not tid:
        summary["skipped"] = True
        return summary
    base = (base_url or os.getenv("EVOFLOW_LANGGRAPH_URL") or "http://127.0.0.1:8070/api/langgraph").rstrip(
        "/"
    )
    try:
        from evoflow.langgraph_run_config import resolve_langgraph_base_url

        base = (resolve_langgraph_base_url() or base).rstrip("/")
    except Exception:
        pass

    try:
        async with httpx.AsyncClient(timeout=op_timeout) as client:
            resp = await asyncio.wait_for(
                client.get(f"{base}/threads/{tid}/runs", params={"limit": limit}),
                timeout=op_timeout,
            )
            if resp.status_code >= 400:
                summary["errors"] += 1
                return summary
            data = resp.json()
            items = data if isinstance(data, list) else (data.get("items") or data.get("runs") or [])
            for run in items or []:
                if not isinstance(run, dict):
                    continue
                status = str(run.get("status") or "").strip().lower()
                run_id = str(run.get("run_id") or run.get("id") or "").strip()
                if not run_id or status not in {"pending", "running"}:
                    continue
                if not may_auto_cancel_other_thread(actor_thread_id=tid, target_thread_id=tid):
                    continue
                try:
                    c = await client.post(
                        f"{base}/threads/{tid}/runs/{run_id}/cancel",
                        json={"wait": False},
                    )
                    if c.status_code < 400:
                        summary["cancelled"].append(run_id)
                    else:
                        summary["errors"] += 1
                except Exception:
                    summary["errors"] += 1
                    logger.debug("interrupt_thread cancel failed tid=%s run=%s", tid, run_id, exc_info=True)
    except Exception:
        summary["errors"] += 1
        logger.debug("interrupt_thread failed tid=%s", tid, exc_info=True)
    return summary
