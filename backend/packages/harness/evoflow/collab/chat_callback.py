"""Collab chat completion callback: target run ends → notify initiator only.

Register at ``employees.chat_send`` / optional ``wake``; finish from duty_run or
session run end. Full audit lives in ``evoflow_collab_chat_calls`` + events.

Resume path (auto_resume): enqueue a ``<task-notification>`` continuation turn on
the initiator's existing LangGraph thread (same pattern as background bash) —
not a duty soft-wake (no ``# 值班``) and not a fake visible user 「协作回执」 bubble.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_TERMINAL_ALREADY = frozenset(
    {
        "finished",
        "skipped",
        "delivered",
        "awaiting_resume",  # notify done; continuation deferred until initiator idle
        "resumed",
        "processed",
        "failed",
        "delivery_failed",
    }
)

# Sticky "idle/done" from execution heal often fires before the new panel turn starts.
_SOFT_FINISH_STATUSES = frozenset({"done", "idle"})


def _bool_arg(v: Any, default: bool = True) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in {"1", "true", "yes", "on"}:
        return True
    if s in {"0", "false", "no", "off"}:
        return False
    return default


def register_collab_chat_call(
    *,
    target_agent: str,
    target_session_key: str = "",
    target_duty_run_id: str = "",
    initiator_agent: str = "",
    initiator_session_key: str = "",
    initiator_principal_id: str = "",
    notify_on_complete: bool | Any = True,
    auto_resume: bool | Any = True,
    source: str = "chat_send",
    goal_preview: str = "",
) -> dict[str, Any]:
    """Create an audit row for a collab chat invocation."""
    from evoflow.persistence import collab_chat_call_repositories as repo

    notify = _bool_arg(notify_on_complete, True)
    resume = _bool_arg(auto_resume, True)
    init_sk = str(initiator_session_key or "").strip()
    init_agent = str(initiator_agent or "").strip()
    # No initiator binding → still record, but mark skipped when notify would be useless.
    status = "open"
    if not notify:
        status = "skipped"
    elif not init_sk and not init_agent:
        status = "skipped"

    doc = repo.create_call(
        target_agent=target_agent,
        target_session_key=target_session_key,
        target_duty_run_id=target_duty_run_id,
        initiator_agent=init_agent,
        initiator_session_key=init_sk,
        initiator_principal_id=initiator_principal_id,
        notify_on_complete=notify,
        auto_resume=resume,
        source=source,
        goal_preview=goal_preview,
        status=status,
    )
    if doc and status == "skipped":
        repo.append_call_event(
            str(doc.get("call_id") or ""),
            "skipped",
            detail={
                "reason": "notify_off" if not notify else "no_initiator",
                "notify_on_complete": notify,
            },
            actor="system",
        )
    return doc or {}


def bind_duty_run(call_id: str, duty_run_id: str, *, target_session_key: str = "") -> dict[str, Any] | None:
    from evoflow.persistence import collab_chat_call_repositories as repo

    cid = str(call_id or "").strip()
    rid = str(duty_run_id or "").strip()
    if not cid or not rid:
        return None
    fields: dict[str, Any] = {"target_duty_run_id": rid, "status": "bound"}
    sk = str(target_session_key or "").strip()
    if sk:
        fields["target_session_key"] = sk
    out = repo.patch_call(cid, **fields)
    repo.append_call_event(
        cid,
        "bound_run",
        detail={"duty_run_id": rid, "target_session_key": sk},
        actor="system",
    )
    return out


def _agent_from_session_key(session_key: str) -> str:
    sk = str(session_key or "").strip()
    if not sk:
        return ""
    try:
        from evoflow.proactive.chat_session import parse_proactive_session_key

        return str(parse_proactive_session_key(sk).get("agent_code") or "").strip()
    except Exception:
        return ""


def _is_soft_finish(run_status: str, summary: str = "") -> bool:
    rs = str(run_status or "").strip().lower()
    if rs in _SOFT_FINISH_STATUSES:
        return True
    s = str(summary or "").strip().lower()
    return "langgraph_idle" in s or s.endswith(":idle") or s.endswith(":done")


def _target_replied_after_call(call: dict[str, Any], session_key: str) -> bool:
    """True when target session has an assistant message after this call was registered."""
    sk = str(session_key or call.get("target_session_key") or "").strip()
    created = str(call.get("created_at") or "").strip()
    if not sk or not created:
        return False
    try:
        from evoflow.persistence.db import get_db

        row = get_db().execute(
            """
            SELECT 1 FROM evoflow_chat_messages
            WHERE session_key = ?
              AND role = 'assistant'
              AND created_at > ?
              AND TRIM(COALESCE(content_json, '')) NOT IN ('', '{}', '{"content":""}')
            ORDER BY seq DESC
            LIMIT 1
            """,
            (sk, created),
        ).fetchone()
        return row is not None
    except Exception:
        logger.debug("collab_chat_callback: reply-after-call check failed", exc_info=True)
        return False


def _summary_from_target_session(
    session_key: str, *, fallback: str = "", since: str = ""
) -> str:
    """Best-effort last assistant text from the target trail.

    【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】
    改了什么：加 ``since`` 时间下界（传回执单的 ``created_at``），SQL 只取该时刻
    之后的 assistant 消息；调用点全部传单子创建时间。
    为什么（本轮现场实测两次复现）：本轮目标跑挂在 LLM 调用（8384 404），它一个字
    都没回，而旧实现只按 session_key 取「最后一条 assistant」——取到的是 5 天前
    （11-22 17:52 / 17:54）那条无关发言，并被当作「对方摘要」投给发起人。发起人
    看到的是别的任务的历史结论，而不是「本次失败、对方没回」。无下界 = 拿旧数据
    冒充本轮结果，这是假回执，不是文案瑕疵。
    边界：``since`` 为空时不加过滤（保留旧行为，供无单子的软结束路径调用）。
    """
    sk = str(session_key or "").strip()
    if not sk:
        return str(fallback or "").strip()
    bound = str(since or "").strip()
    try:
        from evoflow.persistence.db import get_db

        if bound:
            rows = get_db().execute(
                """
                SELECT content_json FROM evoflow_chat_messages
                WHERE session_key = ? AND role = 'assistant' AND created_at > ?
                ORDER BY seq DESC LIMIT 8
                """,
                (sk, bound),
            ).fetchall()
        else:
            rows = get_db().execute(
                """
                SELECT content_json FROM evoflow_chat_messages
                WHERE session_key = ? AND role = 'assistant'
                ORDER BY seq DESC LIMIT 8
                """,
                (sk,),
            ).fetchall()
        import json

        for row in rows or []:
            raw = row[0] if not hasattr(row, "keys") else row["content_json"]
            try:
                obj = json.loads(str(raw or "") or "{}")
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            text = obj.get("content")
            if isinstance(text, list):
                parts = []
                for p in text:
                    if isinstance(p, dict) and p.get("type") == "text":
                        parts.append(str(p.get("text") or ""))
                    elif isinstance(p, str):
                        parts.append(p)
                text = "".join(parts)
            text_s = str(text or "").strip()
            if text_s:
                return text_s[:800]
    except Exception:
        logger.debug("collab_chat_callback: summary from session failed", exc_info=True)
    return str(fallback or "").strip()


def bind_open_calls_for_target(
    *,
    target_agent: str,
    duty_run_id: str = "",
    target_session_key: str = "",
) -> int:
    """Attach duty_run/session onto unbound open calls for this agent (task_create path)."""
    from evoflow.persistence import collab_chat_call_repositories as repo

    code = str(target_agent or "").strip()
    rid = str(duty_run_id or "").strip()
    sk = str(target_session_key or "").strip()
    if not code or (not rid and not sk):
        return 0
    n = 0
    for call in repo.find_open_by_target_agent(code, unbound_only=True):
        cid = str(call.get("call_id") or "").strip()
        if not cid:
            continue
        try:
            bind_duty_run(cid, rid or str(call.get("target_duty_run_id") or ""), target_session_key=sk)
            n += 1
        except Exception:
            logger.debug("collab_chat_callback: bind open call failed call=%s", cid, exc_info=True)
    return n


def on_target_run_finished(
    *,
    duty_run_id: str = "",
    session_key: str = "",
    run_status: str = "completed",
    summary: str = "",
    error: str = "",
    target_agent: str = "",
) -> list[dict[str, Any]]:
    """Match open calls and deliver initiator callbacks. Safe to call often."""
    from evoflow.persistence import collab_chat_call_repositories as repo

    rid = str(duty_run_id or "").strip()
    sk = str(session_key or "").strip()
    code = str(target_agent or "").strip() or _agent_from_session_key(sk)
    calls: list[dict[str, Any]] = []
    if rid:
        calls.extend(repo.find_open_by_duty_run(rid))
    if sk:
        for c in repo.find_open_by_target_session(sk):
            cid = str(c.get("call_id") or "")
            if cid and not any(str(x.get("call_id") or "") == cid for x in calls):
                calls.append(c)
    # task_create registers before duty_run_id exists → match unbound open rows by agent.
    if code:
        for c in repo.find_open_by_target_agent(code, unbound_only=True):
            cid = str(c.get("call_id") or "")
            if cid and not any(str(x.get("call_id") or "") == cid for x in calls):
                calls.append(c)
    if not calls:
        return []

    soft = _is_soft_finish(run_status, summary)
    # 【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】
    # 改了什么：摘要的「从会话补真话」下放到逐单解析，并带上该单的 created_at 作时间下界。
    # 为什么：原来一次性算 summ、且不带下界 → 本轮没回复时会把几天前的旧发言当本轮摘要。
    raw_summ = str(summary or "").strip()
    need_real = (not raw_summ) or raw_summ.startswith("session_run_ended:")

    logger.info(
        "collab_chat_callback: on_finish calls=%s soft=%s status=%s session=%s duty=%s summ=%s",
        len(calls),
        soft,
        run_status,
        sk[:64],
        rid[:32],
        (raw_summ or "")[:80],
    )

    results: list[dict[str, Any]] = []
    for call in calls:
        try:
            cid = str(call.get("call_id") or "").strip()
            # 【第135轮】摘要必须绑定到这张单：只有本轮真的有新发言才算「对方摘要」，
            # 否则回落到生命周期文案，绝不再拿旧消息冒充。
            summ = raw_summ
            if need_real:
                real = _summary_from_target_session(
                    sk, since=str(call.get("created_at") or "").strip()
                )
                if real:
                    summ = real
            # Soft idle/done without a post-call assistant reply = premature heal.
            # Keep the call open until the target actually answers.
            if soft and not _target_replied_after_call(call, sk):
                logger.info(
                    "collab_chat_callback: finish_deferred soft_without_reply call=%s",
                    cid,
                )
                if cid:
                    repo.append_call_event(
                        cid,
                        "finish_deferred",
                        detail={
                            "reason": "soft_finish_without_reply",
                            "run_status": run_status,
                            "summary": str(summary or "")[:200],
                        },
                        actor="system",
                    )
                results.append(
                    {
                        "ok": True,
                        "skipped": True,
                        "reason": "soft_finish_without_reply",
                        "call_id": cid,
                    }
                )
                continue
            # Late-bind so audit trail shows the real target session / duty run.
            if cid and (rid or sk):
                if not str(call.get("target_duty_run_id") or "").strip() or not str(
                    call.get("target_session_key") or ""
                ).strip():
                    bind_duty_run(cid, rid, target_session_key=sk)
                    call = repo.get_call(cid) or call
            results.append(
                _finish_and_deliver(
                    call,
                    run_status=run_status,
                    summary=summ,
                    error=error,
                )
            )
        except Exception as exc:
            logger.exception(
                "collab_chat_callback: finish failed call=%s",
                call.get("call_id"),
            )
            results.append({"ok": False, "call_id": call.get("call_id"), "error": str(exc)})
    return results


def _finish_and_deliver(
    call: dict[str, Any],
    *,
    run_status: str,
    summary: str,
    error: str,
) -> dict[str, Any]:
    from evoflow.persistence import collab_chat_call_repositories as repo
    from evoflow.timeutil import utc_now_iso_z

    cid = str(call.get("call_id") or "").strip()
    if not cid:
        return {"ok": False, "error": "missing_call_id"}
    cur = repo.get_call(cid) or call
    st0 = str(cur.get("status") or "").strip().lower()
    if st0 in _TERMINAL_ALREADY:
        return {"ok": True, "skipped": True, "reason": "already_terminal", "call_id": cid, "status": st0}

    now = utc_now_iso_z()
    rs = str(run_status or "completed").strip().lower() or "completed"
    summ = str(summary or "").strip()[:800]
    err = str(error or "").strip()[:500]

    repo.patch_call(
        cid,
        status="finished",
        run_status=rs,
        summary=summ,
        error=err,
        finished_at=now,
    )
    repo.append_call_event(
        cid,
        "run_finished",
        detail={"run_status": rs, "summary": summ[:200], "error": err[:200]},
        actor=str(cur.get("target_agent") or ""),
    )

    if not cur.get("notify_on_complete"):
        repo.patch_call(cid, status="skipped")
        repo.append_call_event(cid, "skipped", detail={"reason": "notify_off"}, actor="system")
        return {"ok": True, "skipped": True, "reason": "notify_off", "call_id": cid}

    init_sk = str(cur.get("initiator_session_key") or "").strip()
    init_agent = str(cur.get("initiator_agent") or "").strip()
    if not init_sk and not init_agent:
        repo.patch_call(cid, status="skipped")
        repo.append_call_event(cid, "skipped", detail={"reason": "no_initiator"}, actor="system")
        return {"ok": True, "skipped": True, "reason": "no_initiator", "call_id": cid}

    fresh = repo.get_call(cid) or cur
    desktop_ok = _push_desktop(fresh)
    inject_ok = _inject_initiator_session(fresh)
    resume_ok = False
    resume_deferred = False
    if fresh.get("auto_resume"):
        init_sk_busy = str(fresh.get("initiator_session_key") or "").strip()
        if init_sk_busy and _initiator_session_busy(init_sk_busy):
            # Notify now; continuation turn when initiator's own turn settles.
            resume_deferred = True
            repo.append_call_event(
                cid,
                "resume_deferred",
                detail={
                    "reason": "initiator_busy",
                    "initiator_session_key": init_sk_busy,
                },
                actor="system",
            )
        else:
            resume_ok = _maybe_resume_initiator(fresh)

    final_status = "delivered"
    if resume_ok:
        final_status = "resumed"
    elif resume_deferred:
        final_status = "awaiting_resume"
    if not desktop_ok and not inject_ok and not resume_ok and not resume_deferred:
        final_status = "delivery_failed"

    repo.patch_call(cid, status=final_status)
    repo.append_call_event(
        cid,
        "delivered" if final_status != "delivery_failed" else "delivery_failed",
        detail={
            "desktop": desktop_ok,
            "session_injected": inject_ok,
            "resumed": resume_ok,
            "resume_deferred": resume_deferred,
            "final_status": final_status,
        },
        actor="system",
    )
    return {
        "ok": final_status != "delivery_failed",
        "call_id": cid,
        "status": final_status,
        "desktop": desktop_ok,
        "session_injected": inject_ok,
        "resumed": resume_ok,
        "resume_deferred": resume_deferred,
    }


def _push_desktop(call: dict[str, Any]) -> bool:
    from evoflow.persistence import collab_chat_call_repositories as repo
    from evoflow.timeutil import utc_now_iso_z

    cid = str(call.get("call_id") or "")
    target = str(call.get("target_agent") or "").strip()
    init_sk = str(call.get("initiator_session_key") or "").strip()
    role_name = target
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(target)
        if role:
            role_name = str(role.role_name or target).strip() or target
    except Exception:
        pass

    rs = str(call.get("run_status") or "completed").strip().lower()
    ok_run = rs not in {"failed", "fail", "error", "cancelled", "canceled", "stopped"}
    title = f"{'协作完成' if ok_run else '协作异常'} · {role_name}"
    body = str(call.get("summary") or call.get("goal_preview") or "").strip() or (
        f"{role_name} 已结束本轮对话" if ok_run else f"{role_name} 本轮未正常结束"
    )
    payload = {
        "call_id": cid,
        "kind": "collab_chat_complete",
        "title": title,
        "body": body[:240],
        "target_agent": target,
        "target_role_name": role_name,
        "target_session_key": str(call.get("target_session_key") or ""),
        "initiator_agent": str(call.get("initiator_agent") or ""),
        "initiator_session_key": init_sk,
        "run_status": rs,
        "ok": ok_run,
    }

    pushed = False
    try:
        from evoflow.collab.ws_notify import broadcast_to_channels
        import asyncio

        async def _go() -> None:
            await broadcast_to_channels(
                ["proactive", "collab_chat"],
                "collab_chat_complete",
                payload,
            )

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(_go())
        else:
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pool.submit(lambda: asyncio.run(_go())).result(timeout=5)
        pushed = True
    except Exception:
        logger.debug("collab_chat_callback: broadcast failed call=%s", cid, exc_info=True)

    # Durable in-app notification even when live broadcast is unavailable.
    if init_sk:
        try:
            from evoflow.persistence.session_notification_repositories import (
                push_session_notification,
            )

            if push_session_notification(
                session_key=init_sk,
                kind="collab_chat_complete",
                title=title,
                outcome="ok" if ok_run else "error",
                body=body[:500],
                notification_id=f"collab-{cid}",
            ):
                pushed = True
        except Exception:
            logger.debug(
                "collab_chat_callback: session_notification failed call=%s",
                cid,
                exc_info=True,
            )

    if pushed:
        repo.patch_call(cid, desktop_notified_at=utc_now_iso_z())
        repo.append_call_event(cid, "desktop_pushed", detail={"title": title}, actor="system")
        return True
    repo.append_call_event(cid, "error", detail={"stage": "desktop", "error": "push_failed"}, actor="system")
    return False


def _resolve_target_role_name(target_agent: str) -> str:
    target = str(target_agent or "").strip()
    if not target:
        return ""
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(target)
        if role:
            return str(role.role_name or target).strip() or target
    except Exception:
        pass
    return target


def _build_collab_receipt_notification(call: dict[str, Any]) -> str:
    """Hidden continuation body (filtered from user bubbles like bash task-notification)."""
    import html as _html

    cid = str(call.get("call_id") or "").strip()
    target = str(call.get("target_agent") or "").strip()
    role_name = _resolve_target_role_name(target)
    rs = str(call.get("run_status") or "completed").strip().lower() or "completed"
    ok_run = rs not in {"failed", "fail", "error", "cancelled", "canceled", "stopped"}
    status = "completed" if ok_run else rs
    summ = str(call.get("summary") or "").strip()
    if summ.startswith("session_run_ended:"):
        summ = ""
    tgt_sk = str(call.get("target_session_key") or "").strip()
    summary_parts = [
        f"协作对象「{role_name}」(`{target}`) 本轮已结束（状态 {status}）。",
        f"回执单 {cid}。",
        "请根据回执继续编排；需要看对方过程请打开其会话。",
    ]
    if summ:
        summary_parts.append(f"对方摘要：{summ[:400]}")
    if tgt_sk:
        summary_parts.append(f"目标会话：{tgt_sk}")
    summary = _html.escape(" ".join(summary_parts), quote=False)
    lines = [
        "<task-notification>",
        f"<task-id>{_html.escape(cid or 'collab-receipt', quote=False)}</task-id>",
        "<kind>collab_chat_receipt</kind>",
        f"<title>{_html.escape(f'协作完成 · {role_name or target}', quote=False)}</title>",
        f"<status>{_html.escape(status, quote=False)}</status>",
        f"<summary>{summary}</summary>",
        "</task-notification>",
    ]
    return "\n".join(lines)


def _resolve_initiator_thread_id(session_key: str) -> str:
    sk = str(session_key or "").strip()
    if not sk:
        return ""
    try:
        from evoflow.persistence.session_repositories import (
            resolve_thread_bindings_for_session_keys,
        )

        bindings = resolve_thread_bindings_for_session_keys([sk])
        if bindings:
            return str(bindings[0][1] or "").strip()
    except Exception:
        logger.debug(
            "collab_chat_callback: resolve thread_id failed sk=%s",
            sk[:64],
            exc_info=True,
        )
    return ""


def _inject_initiator_session(call: dict[str, Any]) -> bool:
    """Audit-only mark: no visible fake-user 「协作回执」 bubble, no pending_inject.

    Do **not** park receipt XML on ``pending_inject``: that queue drains into the
    *next* initiator turn (including a normal user reply), which hijacks ordinary
    chat. Continuation context is delivered solely by
    ``_maybe_resume_initiator`` → ``schedule_task_notification_turn``.
    When ``auto_resume`` is off, desktop/session notification is enough.
    """
    from evoflow.persistence import collab_chat_call_repositories as repo
    from evoflow.timeutil import utc_now_iso_z

    cid = str(call.get("call_id") or "")
    init_sk = str(call.get("initiator_session_key") or "").strip()
    if not init_sk:
        return False

    text = _build_collab_receipt_notification(call)
    try:
        repo.patch_call(cid, session_injected_at=utc_now_iso_z())
        repo.append_call_event(
            cid,
            "session_injected",
            detail={
                "initiator_session_key": init_sk,
                "shape": "audit_only",
                "chars": len(text),
            },
            actor="system",
        )
        logger.info(
            "collab_chat_callback: session_injected(audit_only) call=%s initiator=%s chars=%s",
            cid,
            init_sk[:64],
            len(text),
        )
        return True
    except Exception:
        logger.debug("collab_chat_callback: inject failed call=%s", cid, exc_info=True)
        repo.append_call_event(cid, "error", detail={"stage": "inject"}, actor="system")
        return False


def _initiator_session_busy(session_key: str) -> bool:
    sk = str(session_key or "").strip()
    if not sk:
        return False
    try:
        from evoflow.persistence.db import get_db
        from evoflow.persistence.session_run_state import is_run_status_active

        row = get_db().execute(
            "SELECT run_status FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
            (sk,),
        ).fetchone()
        if not row:
            return False
        return is_run_status_active(str(row[0] or ""))
    except Exception:
        return False


def _maybe_resume_initiator(call: dict[str, Any]) -> bool:
    """Continue initiator chat via task-notification turn (no duty soft-wake)."""
    from evoflow.persistence import collab_chat_call_repositories as repo
    from evoflow.timeutil import utc_now_iso_z

    cid = str(call.get("call_id") or "")
    init_sk = str(call.get("initiator_session_key") or "").strip()
    init_agent = str(call.get("initiator_agent") or "").strip()
    # Authoritative owner is the initiator chat screen (proactive:{code}:…).
    # chat_send used to stamp source=xiaomi even when the call lived on a director chat.
    if init_sk:
        try:
            from evoflow.proactive.chat_session import parse_proactive_session_key

            owner = str(parse_proactive_session_key(init_sk).get("agent_code") or "").strip()
            if owner:
                init_agent = owner
        except Exception:
            pass
    if not init_agent or init_agent.lower() in {"user", "system", "main", "lead_agent"}:
        repo.append_call_event(
            cid,
            "resume_skipped",
            detail={
                "reason": "initiator_not_employee",
                "initiator_agent": init_agent,
                "initiator_session_key": init_sk,
            },
            actor="system",
        )
        return False
    if not init_sk:
        repo.append_call_event(
            cid,
            "resume_skipped",
            detail={"reason": "missing_initiator_session", "initiator_agent": init_agent},
            actor="system",
        )
        return False
    if _initiator_session_busy(init_sk):
        repo.append_call_event(
            cid,
            "resume_skipped",
            detail={"reason": "initiator_busy", "initiator_session_key": init_sk},
            actor="system",
        )
        return False

    thread_id = _resolve_initiator_thread_id(init_sk)
    if not thread_id:
        repo.append_call_event(
            cid,
            "resume_skipped",
            detail={
                "reason": "missing_thread_id",
                "initiator_session_key": init_sk,
            },
            actor="system",
        )
        logger.warning(
            "collab_chat_callback: resume skipped — no thread_id for %s call=%s",
            init_sk[:64],
            cid,
        )
        return False

    text = _build_collab_receipt_notification(call)
    mid = f"collab-receipt-turn:{cid}"
    try:
        from evoflow.tools.zcode_port.notify_continuation import (
            schedule_task_notification_turn,
        )

        accepted = schedule_task_notification_turn(
            thread_id=thread_id,
            session_key=init_sk,
            notification_text=text,
            message_id=mid,
            source="collab_chat_receipt",
        )
        logger.info(
            "collab_chat_callback: resume_notification call=%s agent=%s session=%s "
            "thread=%s accepted=%s",
            cid,
            init_agent,
            init_sk[:64],
            thread_id[:36],
            accepted,
        )
        if accepted:
            repo.patch_call(cid, resume_woke_at=utc_now_iso_z())
            repo.append_call_event(
                cid,
                "resume_woke",
                detail={
                    "initiator_agent": init_agent,
                    "initiator_session_key": init_sk,
                    "thread_id": thread_id,
                    "via": "task_notification",
                    "message_id": mid,
                },
                actor="system",
            )
            return True
        # Dedup / already claimed — treat as success so we don't soft-wake again.
        repo.append_call_event(
            cid,
            "resume_skipped",
            detail={
                "reason": "notification_deduped",
                "message_id": mid,
                "initiator_session_key": init_sk,
            },
            actor="system",
        )
        if not str(call.get("resume_woke_at") or "").strip():
            repo.patch_call(cid, resume_woke_at=utc_now_iso_z())
        return True
    except Exception as exc:
        logger.warning(
            "collab_chat_callback: resume notification failed call=%s err=%s",
            cid,
            str(exc)[:200],
            exc_info=True,
        )
        repo.append_call_event(
            cid,
            "error",
            detail={"stage": "resume", "error": str(exc)[:200]},
            actor="system",
        )
        return False


def try_resume_awaiting_for_initiator_session(session_key: str) -> list[dict[str, Any]]:
    """When an initiator turn ends, flush deferred collab continuation turns."""
    from evoflow.persistence import collab_chat_call_repositories as repo

    sk = str(session_key or "").strip()
    if not sk:
        return []
    # Still busy (another run started) → leave awaiting.
    if _initiator_session_busy(sk):
        return []
    pending = repo.find_pending_resume_by_initiator_session(sk)
    out: list[dict[str, Any]] = []
    for call in pending:
        cid = str(call.get("call_id") or "").strip()
        if not cid:
            continue
        # Refresh summary from target trail if we only have lifecycle noise.
        # 【self-evolution-bot · 2026-11-27 · 第135轮 · 模型:deepseek-v4-1-flash-261017】
        # 同 275 行同型缺陷：补摘要必须带本单创建时间作下界，否则拿到几天前的旧发言。
        summ = str(call.get("summary") or "").strip()
        if not summ or summ.startswith("session_run_ended:"):
            tgt = str(call.get("target_session_key") or "").strip()
            real = _summary_from_target_session(
                tgt, since=str(call.get("created_at") or "").strip()
            )
            if real:
                repo.patch_call(cid, summary=real[:800])
                call = repo.get_call(cid) or call
        try:
            ok = _maybe_resume_initiator(call)
            if ok:
                repo.patch_call(cid, status="resumed")
                repo.append_call_event(
                    cid,
                    "resume_deferred_flushed",
                    detail={"initiator_session_key": sk},
                    actor="system",
                )
            out.append({"ok": ok, "call_id": cid, "resumed": ok})
        except Exception as exc:
            logger.debug(
                "collab_chat_callback: deferred resume failed call=%s",
                cid,
                exc_info=True,
            )
            out.append({"ok": False, "call_id": cid, "error": str(exc)})
    return out


def mark_call_processed(call_id: str, *, processed_by: str = "") -> dict[str, Any] | None:
    from evoflow.persistence import collab_chat_call_repositories as repo
    from evoflow.timeutil import utc_now_iso_z

    cid = str(call_id or "").strip()
    if not cid:
        return None
    who = str(processed_by or "").strip() or "user"
    out = repo.patch_call(cid, status="processed", processed_at=utc_now_iso_z(), processed_by=who)
    repo.append_call_event(cid, "processed", detail={"processed_by": who}, actor=who)
    return out


def get_call_with_trail(call_id: str) -> dict[str, Any] | None:
    from evoflow.persistence import collab_chat_call_repositories as repo

    doc = repo.get_call(call_id)
    if not doc:
        return None
    doc["events"] = repo.list_events(str(doc.get("call_id") or ""))
    return doc
