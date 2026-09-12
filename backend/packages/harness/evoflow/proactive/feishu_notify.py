"""Proactive Feishu notifications for all smart employees.

Pushes interactive cards (review / wrap-up digest) and resolves targets preferring
the employee's bound PersonalAgent (``channels.feishu.accounts[agent_code]``)
and scanner ``open_id`` when available.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _role_wants_feishu(role: Any) -> bool:
    channels = list(getattr(getattr(role, "config", None), "approval_channels", None) or [])
    if not channels:
        channels = ["desktop", "feishu"]
    return "feishu" in channels


def _send_account_for_target(role: Any, receive_id: str, receive_id_type: str) -> str:
    """Pick the bot that owns this chat (learned / live map); open_id → role bot."""
    if receive_id_type == "open_id" or str(receive_id or "").startswith("ou_"):
        return str(getattr(role, "agent_code", "") or "").strip()
    try:
        channel = _feishu_channel()
        if channel is not None:
            owned = str(
                getattr(channel, "_chat_account", {}).get(str(receive_id), "") or ""
            ).strip()
            if owned:
                return owned
    except Exception:
        logger.debug("feishu_notify: chat owner lookup failed", exc_info=True)
    try:
        from app.channels.feishu_automation_learned_chat import (
            read_learned_feishu_automation_account_id,
            read_learned_feishu_automation_chat_id,
        )

        if str(read_learned_feishu_automation_chat_id() or "").strip() == str(receive_id).strip():
            return str(read_learned_feishu_automation_account_id() or "").strip()
    except Exception:
        logger.debug("feishu_notify: learned account lookup failed", exc_info=True)
    return ""


def resolve_role_feishu_target(role: Any) -> tuple[str, str] | None:
    """Return ``(receive_id, receive_id_type)`` for this employee.

    Prefer bound scanner ``open_id`` (DM), else gateway default chat.
    """
    cfg = getattr(role, "config", None)
    open_id = str(getattr(cfg, "feishu_open_id", "") or "").strip()
    if open_id:
        return open_id, "open_id"
    try:
        from app.gateway.channel_result_push import resolve_push_target

        resolved = resolve_push_target(
            push_enabled=True,
            push_channel="feishu",
            push_target_id="",
        )
        if resolved:
            _, chat_id = resolved
            cid = str(chat_id or "").strip()
            if cid:
                return cid, "chat_id"
    except Exception:
        logger.debug("feishu_notify: resolve default chat failed", exc_info=True)
    return None


def _feishu_channel():
    from app.channels.service import get_channel_service

    service = get_channel_service()
    if service is None:
        return None
    channel = service._channels.get("feishu")
    if channel is None or not channel.is_running:
        return None
    return channel


def _log_notify(
    *,
    kind: str,
    role: Any,
    ok: bool,
    message_id: str = "",
    receive_id: str = "",
    receive_id_type: str = "",
    sender_account_id: str = "",
    task_id: str = "",
    title: str = "",
    content_summary: str = "",
    error: str = "",
    payload: dict[str, Any] | None = None,
    transport: str = "interactive_card",
) -> None:
    try:
        from evoflow.persistence.channel_push_repositories import safe_record_push

        safe_record_push(
            direction="outbound",
            channel="feishu",
            kind=kind,
            event="sent" if ok else "send_failed",
            transport=str(transport or "interactive_card"),
            task_id=task_id,
            role_agent_code=str(getattr(role, "agent_code", "") or ""),
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=sender_account_id,
            external_message_id=message_id,
            title=title,
            content_summary=content_summary,
            payload=payload or {},
            status="ok" if ok else "error",
            error=error,
            triggered_by="system",
        )
    except Exception:
        logger.debug("feishu_notify: push_log failed kind=%s", kind, exc_info=True)


async def push_collab_tree_receipt(
    *,
    root_task_id: str,
    root_name: str = "",
    summary_lines: list[str] | None = None,
    child_task_id: str = "",
    raised_by: str = "",
) -> str | None:
    """Push a one-shot「协作树收口」markdown card to the default Feishu chat.

    Targets the gateway learned/default chat (same as automation / 小V 会话),
    preferably sent as the ``xiaomi`` bot when that account owns the chat.
    """
    rid = str(root_task_id or "").strip()
    if not rid:
        return None

    # Prefer xiaomi role for logging / account ownership; fall back to a stub.
    role: Any = None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role("xiaomi")
    except Exception:
        role = None
    if role is None:
        role = type("R", (), {"agent_code": "xiaomi", "role_name": "小V", "config": None})()

    channel = _feishu_channel()
    title = "协作待闭环"
    body_bits = [
        f"**{title}**",
        f"根任务 `{rid}`" + (f" · {root_name}" if root_name else ""),
    ]
    for line in summary_lines or []:
        s = str(line or "").strip()
        if s:
            body_bits.append(s)
    if child_task_id:
        body_bits.append(f"触发下游：`{child_task_id}`")
    if raised_by:
        body_bits.append(f"提起人：`{raised_by}`")
    body_bits.append(
        "下游已全部结案。请提出人/产品验收后，将根单从「待闭环」改为 **已完成**；"
        "未验收前整单不算结束。"
    )
    text = "\n".join(body_bits)

    if channel is None:
        _log_notify(
            kind="tree_receipt",
            role=role,
            ok=False,
            task_id=rid,
            title=title,
            content_summary="feishu channel unavailable",
            error="feishu_not_running",
            payload={"transport": "markdown"},
            transport="markdown",
        )
        return None

    # Prefer default/learned chat (user ↔ 小V); fall back to role binding.
    receive_id = ""
    receive_id_type = "chat_id"
    try:
        from app.gateway.channel_result_push import resolve_push_target

        resolved = resolve_push_target(
            push_enabled=True,
            push_channel="feishu",
            push_target_id="",
        )
        if resolved:
            _ch, receive_id = resolved
            receive_id = str(receive_id or "").strip()
    except Exception:
        logger.debug("feishu_notify.tree_receipt: resolve default chat failed", exc_info=True)
    if not receive_id:
        target = resolve_role_feishu_target(role)
        if not target:
            _log_notify(
                kind="tree_receipt",
                role=role,
                ok=False,
                task_id=rid,
                title=title,
                content_summary="no Feishu push target",
                error="no_target",
                transport="markdown",
            )
            return None
        receive_id, receive_id_type = target

    if str(receive_id).startswith("ou_"):
        receive_id_type = "open_id"
    send_account = _send_account_for_target(role, receive_id, receive_id_type) or "xiaomi"

    try:
        await channel.send_proactive_markdown(
            receive_id,
            text,
            receive_id_type=receive_id_type,
            account_id=send_account,
        )
        _log_notify(
            kind="tree_receipt",
            role=role,
            ok=True,
            task_id=rid,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            title=title,
            content_summary=text[:400],
            payload={"transport": "markdown", "child_task_id": child_task_id},
            transport="markdown",
        )
        # No message_id from markdown helper — stamp synthetic ok.
        return f"tree_receipt:{rid}"
    except Exception as exc:
        logger.warning("feishu_notify.tree_receipt push failed root=%s", rid, exc_info=True)
        _log_notify(
            kind="tree_receipt",
            role=role,
            ok=False,
            task_id=rid,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            title=title,
            content_summary=text[:400],
            error=str(exc)[:200],
            transport="markdown",
        )
        return None


async def push_review_card(
    role: Any,
    *,
    task_id: str,
    title: str,
    summary: str = "",
) -> str | None:
    """Send「交工待验收」card after a work item reaches ``reviewed``."""
    if not _role_wants_feishu(role):
        return None
    tid = str(task_id or "").strip()
    if not tid:
        return None
    channel = _feishu_channel()
    if channel is None:
        logger.debug("feishu_notify.review: channel unavailable")
        _log_notify(
            kind="review_card",
            role=role,
            ok=False,
            task_id=tid,
            title=str(title or tid),
            content_summary="feishu channel unavailable",
            error="feishu_not_running",
        )
        return None
    target = resolve_role_feishu_target(role)
    if not target:
        logger.warning("feishu_notify.review: no push target role=%s", getattr(role, "agent_code", ""))
        _log_notify(
            kind="review_card",
            role=role,
            ok=False,
            task_id=tid,
            title=str(title or tid),
            content_summary="no Feishu push target",
            error="no_target",
        )
        return None
    receive_id, receive_id_type = target
    if str(receive_id).startswith("ou_"):
        receive_id_type = "open_id"
    send_account = _send_account_for_target(role, receive_id, receive_id_type)
    try:
        mid = await channel.send_proactive_review_card(
            receive_id,
            task_id=tid,
            role_name=str(getattr(role, "role_name", "") or ""),
            department=str(getattr(role, "department", "") or ""),
            agent_code=str(getattr(role, "agent_code", "") or ""),
            title=str(title or tid),
            summary=str(summary or ""),
            receive_id_type=receive_id_type,
            account_id=send_account,
        )
        _log_notify(
            kind="review_card",
            role=role,
            ok=bool(mid),
            message_id=str(mid or ""),
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            task_id=tid,
            title=str(title or tid),
            content_summary=str(summary or title or "")[:400],
            error="" if mid else "no_msg_id",
        )
        return mid
    except Exception as exc:
        logger.warning(
            "feishu_notify.review push failed role=%s task=%s",
            getattr(role, "agent_code", ""),
            tid,
            exc_info=True,
        )
        _log_notify(
            kind="review_card",
            role=role,
            ok=False,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            task_id=tid,
            title=str(title or tid),
            content_summary=str(summary or "")[:400],
            error=str(exc)[:200],
        )
        return None


def _is_idle_patrol_summary(text: str) -> bool:
    """True when wrap text is empty-board health theater (should not ping the user)."""
    s = str(text or "").strip()
    if not s:
        return True
    markers = (
        "【巡检完成】",
        "【值班完成】",
        "系统健康",
        "无阻塞",
        "无阻塞性",
        "Gateway",
        "本岗看板无未结",
        "暂无未结",
        "无待办",
        "无需上级拍板",
        "巡检结束",
        "本轮值班结束",
    )
    hit = sum(1 for m in markers if m in s)
    if hit >= 2:
        return True
    if hit >= 1 and len(s) < 220 and not any(
        k in s for k in ("需要你", "请确认", "阻塞：", "失败", "请拍板", "派发", "待办：")
    ):
        return True
    return False


async def push_wrap_digest_card(
    role: Any,
    report: dict[str, Any] | None,
) -> str | None:
    """Send duty-round digest card after a heartbeat/patrol ends."""
    if not _role_wants_feishu(role):
        return None
    if not isinstance(report, dict):
        return None
    # Skip empty no-op rounds to avoid spam
    created = list(report.get("created_task_ids") or report.get("created_tasks") or [])
    counts = report.get("counts") if isinstance(report.get("counts"), dict) else {}
    pending = int(counts.get("pending_approval") or 0)
    completed = int(counts.get("completed") or 0)
    failed = int(counts.get("failed") or 0)
    executing = int(counts.get("executing") or 0)
    think_summary = str(report.get("think_summary") or report.get("summary") or "").strip()
    raw_items = report.get("items") if isinstance(report.get("items"), list) else []
    items: list[dict] = [x for x in raw_items if isinstance(x, dict)]
    has_named_item = any(
        str(it.get("title") or it.get("preview") or "").strip() and not it.get("is_journal")
        for it in items
    )
    idle_health = (
        _is_idle_patrol_summary(think_summary)
        and not has_named_item
        and not created
        and not pending
        and not failed
        and not executing
    )
    if idle_health:
        return None
    if (
        not created
        and not pending
        and not completed
        and not failed
        and not executing
        and not think_summary
        and not has_named_item
    ):
        return None

    channel = _feishu_channel()
    if channel is None:
        _log_notify(
            kind="wrap_digest",
            role=role,
            ok=False,
            title="工作汇报",
            content_summary="feishu channel unavailable",
            error="feishu_not_running",
        )
        return None
    target = resolve_role_feishu_target(role)
    if not target:
        _log_notify(
            kind="wrap_digest",
            role=role,
            ok=False,
            title="工作汇报",
            content_summary="no Feishu push target",
            error="no_target",
        )
        return None
    receive_id, receive_id_type = target
    if str(receive_id).startswith("ou_"):
        receive_id_type = "open_id"
    send_account = _send_account_for_target(role, receive_id, receive_id_type)
    content_preview = think_summary[:400]
    if not content_preview and has_named_item:
        for it in items:
            if it.get("is_journal"):
                continue
            title = str(it.get("title") or it.get("preview") or "").strip()
            if title:
                content_preview = title[:400]
                break
    try:
        mid = await channel.send_proactive_wrap_card(
            receive_id,
            role_name=str(getattr(role, "role_name", "") or ""),
            department=str(getattr(role, "department", "") or ""),
            agent_code=str(getattr(role, "agent_code", "") or ""),
            think_summary=think_summary,
            counts=counts,
            created_task_ids=[str(x) for x in created if x][:8],
            items=items[:12],
            next_heartbeat_at=str(report.get("next_heartbeat_at") or ""),
            receive_id_type=receive_id_type,
            account_id=send_account,
        )
        _log_notify(
            kind="wrap_digest",
            role=role,
            ok=bool(mid),
            message_id=str(mid or ""),
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            title="工作汇报",
            content_summary=content_preview,
            payload={"counts": counts, "created": created[:8], "item_n": len(items)},
            error="" if mid else "no_msg_id",
        )
        return mid
    except Exception as exc:
        logger.warning(
            "feishu_notify.wrap push failed role=%s",
            getattr(role, "agent_code", ""),
            exc_info=True,
        )
        _log_notify(
            kind="wrap_digest",
            role=role,
            ok=False,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            title="工作汇报",
            content_summary=content_preview,
            error=str(exc)[:200],
        )
        return None


async def push_running_work_card(
    role: Any,
    *,
    task_id: str,
    title: str,
) -> str | None:
    """Send「处理中」control card when a work item starts executing."""
    if not _role_wants_feishu(role):
        return None
    tid = str(task_id or "").strip()
    if not tid:
        return None
    channel = _feishu_channel()
    if channel is None:
        logger.debug("feishu_notify.running: channel unavailable")
        _log_notify(
            kind="running_work",
            role=role,
            ok=False,
            task_id=tid,
            title=str(title or tid),
            content_summary="feishu channel unavailable",
            error="feishu_not_running",
        )
        return None
    target = resolve_role_feishu_target(role)
    if not target:
        logger.warning("feishu_notify.running: no push target role=%s", getattr(role, "agent_code", ""))
        _log_notify(
            kind="running_work",
            role=role,
            ok=False,
            task_id=tid,
            title=str(title or tid),
            content_summary="no Feishu push target",
            error="no_target",
        )
        return None
    receive_id, receive_id_type = target
    if str(receive_id).startswith("ou_"):
        receive_id_type = "open_id"
    send_account = _send_account_for_target(role, receive_id, receive_id_type)
    try:
        mid = await channel.send_proactive_running_card(
            receive_id,
            task_id=tid,
            role_name=str(getattr(role, "role_name", "") or ""),
            department=str(getattr(role, "department", "") or ""),
            agent_code=str(getattr(role, "agent_code", "") or ""),
            title=str(title or tid),
            receive_id_type=receive_id_type,
            account_id=send_account,
        )
        _log_notify(
            kind="running_work",
            role=role,
            ok=bool(mid),
            message_id=str(mid or ""),
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            task_id=tid,
            title=str(title or tid),
            content_summary=str(title or tid)[:400],
            error="" if mid else "no_msg_id",
        )
        return mid
    except Exception as exc:
        logger.warning(
            "feishu_notify.running push failed role=%s task=%s",
            getattr(role, "agent_code", ""),
            tid,
            exc_info=True,
        )
        _log_notify(
            kind="running_work",
            role=role,
            ok=False,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=send_account,
            task_id=tid,
            title=str(title or tid),
            error=str(exc)[:200],
        )
        return None
