from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").rstrip("/")
_ACTIVE_RUN_STATUSES = frozenset({"pending", "running", "interrupted"})
_CANCEL_STATUSES = frozenset(_ACTIVE_RUN_STATUSES)
_SWEEP_MAX_WAIT_S = float(os.getenv("EVOFLOW_STOP_SWEEP_MAX_WAIT_S", "4") or "4")
_SWEEP_POLL_INTERVAL_S = float(os.getenv("EVOFLOW_STOP_SWEEP_POLL_INTERVAL_S", "0.25") or "0.25")


def _parse_runs_items(runs_data: Any) -> list[dict[str, Any]]:
    items: Any = runs_data
    if isinstance(runs_data, dict):
        items = runs_data.get("items", runs_data.get("runs", []))
    if not isinstance(items, list):
        return []
    return [r for r in items if isinstance(r, dict)]


async def _fetch_thread_runs(client: httpx.AsyncClient, thread_id: str) -> list[dict[str, Any]]:
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    runs_url = f"{LANGGRAPH_BASE_URL}/threads/{tid}/runs"
    try:
        resp = await client.get(runs_url, params={"limit": 20})
    except Exception:
        logger.debug("fetch thread runs failed thread=%s", tid, exc_info=True)
        return []
    if resp.status_code != 200:
        return []
    return _parse_runs_items(resp.json())


def _run_id_from_item(run: dict[str, Any]) -> str:
    return str(run.get("run_id") or run.get("runId") or "").strip()


def _run_status_from_item(run: dict[str, Any]) -> str:
    return str(run.get("status") or "").strip().lower()


async def _post_cancel_run(
    client: httpx.AsyncClient,
    thread_id: str,
    run_id: str,
) -> str:
    """Return ``cancelled`` | ``already_gone`` | ``rejected``."""
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    if not tid or not rid:
        return "rejected"
    cancel_url = f"{LANGGRAPH_BASE_URL}/threads/{tid}/runs/{rid}/cancel"
    try:
        cancel_resp = await client.post(cancel_url)
    except Exception:
        logger.debug("cancel run failed thread=%s run=%s", tid, rid, exc_info=True)
        return "rejected"
    if cancel_resp.status_code < 400:
        return "cancelled"
    if cancel_resp.status_code == 404:
        # LangGraph: "No matching runs to cancel" — list 仍标 active 但 run 已不可 cancel
        return "already_gone"
    logger.debug(
        "cancel run rejected thread=%s run=%s status=%s",
        tid,
        rid,
        cancel_resp.status_code,
    )
    return "rejected"


async def list_active_langgraph_run_ids(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    exclude_run_ids: set[str] | None = None,
) -> list[str]:
    """Return run ids still pending/running/interrupted on the thread."""
    exclude = exclude_run_ids or set()
    out: list[str] = []
    for run in await _fetch_thread_runs(client, thread_id):
        run_id = _run_id_from_item(run)
        status = _run_status_from_item(run)
        if run_id and run_id not in exclude and status in _ACTIVE_RUN_STATUSES:
            out.append(run_id)
    return out


async def cancel_langgraph_run_ids(
    client: httpx.AsyncClient,
    thread_id: str,
    run_ids: list[str],
    *,
    gone_run_ids: set[str] | None = None,
) -> list[str]:
    """Cancel explicit run ids; 404 counts as already gone (not retried in sweep)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    gone = gone_run_ids if gone_run_ids is not None else set()
    cancelled: list[str] = []
    for rid in run_ids:
        run_id = str(rid or "").strip()
        if not run_id or run_id in gone:
            continue
        outcome = await _post_cancel_run(client, tid, run_id)
        if outcome == "cancelled":
            cancelled.append(run_id)
        elif outcome == "already_gone":
            gone.add(run_id)
    return cancelled


async def cancel_active_langgraph_runs(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    gone_run_ids: set[str] | None = None,
    only_run_ids: set[str] | None = None,
) -> list[str]:
    """Cancel list-visible active runs (user-stop sweep). Skips *gone_run_ids*.

    When *only_run_ids* is set, only those ids are cancelled — used so a stop sweep
    does not kill a newer run the user started while the sweep was still polling.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    gone = gone_run_ids if gone_run_ids is not None else set()
    only = only_run_ids
    to_cancel: list[str] = []
    for run in await _fetch_thread_runs(client, tid):
        run_id = _run_id_from_item(run)
        status = _run_status_from_item(run)
        if not run_id or run_id in gone or status not in _CANCEL_STATUSES:
            continue
        if only is not None and run_id not in only:
            continue
        to_cancel.append(run_id)
    return await cancel_langgraph_run_ids(client, tid, to_cancel, gone_run_ids=gone)


async def cancel_langgraph_runs_before_send(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    preferred_run_id: str | None = None,
) -> list[str]:
    """Send 前清理：只 cancel 会话绑定的 *preferred* run，绝不 list 后杀「最新一条」。

    前端常在 cancel 未完成时就 POST /runs/stream；若此处 fallthrough 去 cancel
    list 里的 newest，会把刚创建的新 run 杀掉 → 空 RUN_STARTED/FINISHED。
    preferred 缺失或不在 active 列表时直接返回（空闲多轮对话的主路径）。
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return []

    pref = str(preferred_run_id or "").strip() or None
    if not pref:
        return []

    initial_active = await list_active_langgraph_run_ids(client, tid)
    if pref not in initial_active:
        return []

    outcome = await _post_cancel_run(client, tid, pref)
    if outcome == "cancelled":
        return [pref]
    return []


async def sweep_langgraph_runs_until_idle(
    client: httpx.AsyncClient,
    thread_id: str,
    *,
    max_wait_s: float | None = None,
    poll_interval_s: float | None = None,
) -> tuple[list[str], list[str]]:
    """User stop：cancel + poll；404 视为已结束，避免对幽灵 run 反复 cancel。

    Only cancels runs that were already active when the sweep started. Runs created
    afterwards (e.g. user resent while stop still polling) are left alone.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return [], []

    wait_s = _SWEEP_MAX_WAIT_S if max_wait_s is None else max(0.0, float(max_wait_s))
    interval_s = _SWEEP_POLL_INTERVAL_S if poll_interval_s is None else max(0.05, float(poll_interval_s))
    deadline = time.monotonic() + wait_s
    cancelled_all: list[str] = []
    gone_run_ids: set[str] = set()

    initial_active = await list_active_langgraph_run_ids(client, tid)
    if not initial_active:
        return [], []
    target_run_ids = set(initial_active)

    while True:
        batch = await cancel_active_langgraph_runs(
            client,
            tid,
            gone_run_ids=gone_run_ids,
            only_run_ids=target_run_ids,
        )
        for rid in batch:
            if rid not in cancelled_all:
                cancelled_all.append(rid)

        active = await list_active_langgraph_run_ids(client, tid, exclude_run_ids=gone_run_ids)
        still_targeted = [rid for rid in active if rid in target_run_ids]
        if not still_targeted:
            if cancelled_all:
                logger.info(
                    "sweep_langgraph_runs_until_idle: thread=%s cancelled=%s gone=%s",
                    tid,
                    cancelled_all,
                    sorted(gone_run_ids),
                )
            return cancelled_all, []

        if time.monotonic() >= deadline:
            final_batch = await cancel_active_langgraph_runs(
                client,
                tid,
                gone_run_ids=gone_run_ids,
                only_run_ids=target_run_ids,
            )
            for rid in final_batch:
                if rid not in cancelled_all:
                    cancelled_all.append(rid)
            orphans = [
                rid
                for rid in await list_active_langgraph_run_ids(client, tid, exclude_run_ids=gone_run_ids)
                if rid in target_run_ids
            ]
            if orphans:
                logger.warning(
                    "sweep_langgraph_runs_until_idle: orphan runs remain thread=%s runs=%s cancelled=%s gone=%s",
                    tid,
                    orphans,
                    cancelled_all,
                    sorted(gone_run_ids),
                )
            return cancelled_all, orphans

        await asyncio.sleep(interval_s)
