"""Link scheduled automation LangGraph runs to EvoPanel ``evoflow_chat_sessions``."""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


def automation_session_key(task_id: str, thread_mode: str, run_id: str) -> str:
    """``fresh`` → one sidebar row per run; ``sticky`` → one row per task."""
    mode = str(thread_mode or "fresh").strip().lower()
    tid = str(task_id or "").strip()
    if not tid:
        return ""
    if mode == "sticky":
        return f"automation:{tid}:sticky"
    rid = str(run_id or "").strip() or "run"
    return f"automation:{tid}:run-{rid}"


def _automation_session_title(task_name: str, started_at_iso: str | None = None) -> str:
    name = str(task_name or "自动化").strip() or "自动化"
    try:
        if started_at_iso:
            dt = datetime.fromisoformat(str(started_at_iso).replace("Z", "+00:00"))
            if dt.tzinfo:
                dt = dt.astimezone().replace(tzinfo=None)
            ts = dt.strftime("%m-%d %H:%M")
        else:
            ts = datetime.now().strftime("%m-%d %H:%M")
    except Exception:
        ts = datetime.now().strftime("%m-%d %H:%M")
    return f"定时·{name}·{ts}"


def _automation_session_context(
    task_id: str,
    task: dict[str, Any],
    *,
    trigger_type: str,
    run_id: str,
) -> dict[str, Any]:
    ctx: dict[str, Any] = {
        "source": "automation",
        "automation_task_id": str(task_id or "").strip(),
        "automation_trigger_type": str(trigger_type or "schedule"),
        "automation_run_id": str(run_id or "").strip(),
    }
    ws = str(task.get("workspace") or "").strip()
    if ws:
        ctx["local_workspace_root"] = ws
    return ctx


def prepare_automation_chat_session(
    *,
    task_id: str,
    task: dict[str, Any],
    thread_id: str,
    session_key: str,
    prompt: str,
    run_id: str,
    trigger_type: str,
    started_at_iso: str | None = None,
    is_plan_mode: bool = False,
    memory_enabled: bool = False,
) -> str | None:
    """Before ``runs.wait``: upsert sidebar session and append the user prompt (like normal chat send)."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return None
    body = str(prompt or "").strip()
    if not body:
        return None
    try:
        from evoflow.persistence import chat_session_service as chat_svc
        from evoflow.persistence import session_repositories as sess_repo

        now_ms = int(time.time() * 1000)
        title = _automation_session_title(str(task.get("name") or ""), started_at_iso)
        ctx = _automation_session_context(
            task_id,
            task,
            trigger_type=trigger_type,
            run_id=run_id,
        )
        existing = sess_repo.load_session_map().get(sk) or {}
        created_ms = int(existing.get("createdAt") or 0) or now_ms
        from evoflow.agents.automation_runtime import automation_default_scenario_keys

        flat: dict[str, Any] = {}
        ws_root = str(task.get("workspace") or ctx.get("local_workspace_root") or "").strip()
        if ws_root:
            flat["local_workspace_root"] = ws_root
        is_new = not bool(existing)
        sess_repo.upsert_session_row(
            sk,
            thread_id=tid,
            title=title,
            created_at_ms=created_ms,
            updated_at_ms=now_ms,
            context=ctx,
            session_status=sess_repo.SESSION_STATUS_ACTIVE,
            is_plan_mode=bool(is_plan_mode),
            memory_enabled=bool(memory_enabled),
            activated_scenarios=automation_default_scenario_keys(),
            **flat,
        )
        try:
            from evoflow.authz.runtime_identity import (
                resolve_identity_from_automation,
                stamp_session_from_identity,
            )

            stamp_session_from_identity(sk, resolve_identity_from_automation(task_id))
        except Exception:
            logger.debug(
                "automation_chat_session: ownership stamp failed session_key=%s",
                sk,
                exc_info=True,
            )
        # New automation rows stay out of the main sidebar until the user opens them.
        # Sticky re-runs keep the user's unhide choice.
        if is_new:
            sess_repo.set_session_hidden_from_list(sk, hidden=True)
        identity_pid = None
        try:
            from evoflow.authz.runtime_identity import resolve_identity_from_automation

            identity_pid = resolve_identity_from_automation(task_id).get("principal_id")
        except Exception:
            identity_pid = None
        chat_svc.append_message_and_touch_session(
            sk,
            role="user",
            content=body,
            run_id=str(run_id or "").strip() or None,
            thread_id=tid,
            principal_id=identity_pid,
        )
        logger.info(
            "automation_chat_session: prepared session_key=%s thread_id=%s task_id=%s",
            sk,
            tid,
            task_id,
        )
        return sk
    except Exception:
        logger.warning(
            "automation_chat_session: prepare failed session_key=%s thread_id=%s task_id=%s",
            sk,
            tid,
            task_id,
            exc_info=True,
        )
        return None


async def finalize_automation_chat_session(
    *,
    thread_id: str,
    session_key: str,
    run_messages: list[Any] | None = None,
) -> dict[str, Any]:
    """After run ends: mark session idle; transcript was written in real-time via TranscriptMiddleware."""
    del run_messages
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return {"ok": True, "skipped": True, "reason": "no_thread_or_session"}
    try:
        from evoflow.session_execution.lifecycle import force_end_session_turn

        force_end_session_turn(session_key=sk, thread_id=tid, source="automation_finalize")
        logger.info("automation_chat_session: finalized session_key=%s thread_id=%s", sk, tid)
        return {"ok": True, "sessionKey": sk, "threadId": tid}
    except Exception:
        logger.warning(
            "automation_chat_session: finalize failed session_key=%s thread_id=%s",
            sk,
            tid,
            exc_info=True,
        )
        return {"ok": False, "sessionKey": sk, "threadId": tid}


def persist_automation_run_chat_session(
    *,
    task_id: str,
    task: dict[str, Any],
    thread_id: str,
    session_key: str,
    prompt: str,
    run_id: str,
    trigger_type: str,
    started_at_iso: str | None = None,
    is_plan_mode: bool = False,
    memory_enabled: bool = False,
) -> str | None:
    """Legacy one-shot persist (prepare only). Prefer prepare + finalize in the runner."""
    return prepare_automation_chat_session(
        task_id=task_id,
        task=task,
        thread_id=thread_id,
        session_key=session_key,
        prompt=prompt,
        run_id=run_id,
        trigger_type=trigger_type,
        started_at_iso=started_at_iso,
        is_plan_mode=is_plan_mode,
        memory_enabled=memory_enabled,
    )
