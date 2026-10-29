"""Proactive Feishu notifications — bind-first, 1:1, no spam.

Routing contract
----------------
* **Who may receive**: only a role that has an *explicit* Feishu binding
  (``config.feishu_open_id`` or ``RolePushPolicy`` with feishu enabled +
  target). Listing ``feishu`` in ``approval_channels`` alone is not a binding.
* **Who sends**: the same role's bot (``agent_code``). Never borrow another
  employee's account because it once "owned" a learned chat.
* **Where we never push for these cards**: gateway learned / automation
  default chat (``resolve_push_target`` / ``feishu.automation_learned_chat_id``).
  That path is reserved for cron automations with ``feishu_push_enabled``.
* **Kinds**:
  - ``review`` / ``wrap_digest`` / ``running_work`` → the *working* employee's
    binding (or silent skip if unbound / opted out).
  - ``tree_receipt`` (协作待闭环) → first bound among
    ``raised_by`` → root ``assigned_to`` → main agent ``xiaomi``;
    unbound → record ``no_target`` and do **not** retry-spam.

Desktop / in-app surfaces are unaffected; this module only gates Feishu.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_MAIN_AGENT_CODE = "xiaomi"
_NON_AGENT_RAISERS = frozenset({"", "user", "system", "human", "owner"})


def _approval_channels(role: Any) -> list[str]:
    raw = list(getattr(getattr(role, "config", None), "approval_channels", None) or [])
    return [str(c).strip().lower() for c in raw if str(c).strip()]


def _feishu_channel_not_opted_out(role: Any) -> bool:
    """False only when approval_channels is non-empty and omits feishu.

    Empty list means "no explicit opt-out" — still requires a real binding
    before any outbound card is attempted (see ``_outbound_feishu_target``).
    """
    channels = _approval_channels(role)
    if not channels:
        return True
    return "feishu" in channels


def _outbound_feishu_target(role: Any) -> tuple[str, str] | None:
    """Resolve Feishu push target only when the role is actually bound.

    Listing ``feishu`` in ``approval_channels`` is not a binding. Historical
    defaults included it for every employee, which made unbound wrap-ups
    record ``feishu_not_running``. A real target is ``feishu_open_id`` or a
    valid RolePushPolicy binding. Explicit channel lists that omit feishu
    stay opted out even if a stale open id remains.
    """
    if not _feishu_channel_not_opted_out(role):
        return None
    return resolve_role_feishu_target(role)


def _send_account_for_target(role: Any, receive_id: str = "", receive_id_type: str = "") -> str:
    """Sender is the bound role's own bot — 1:1 with the binding owner.

    Do not resolve via learned automation chat ownership: that caused
    unrelated bots (e.g. douyin-analyst) to deliver other roles' cards.
    """
    del receive_id, receive_id_type  # binding target does not pick the sender
    return str(getattr(role, "agent_code", "") or "").strip()


def resolve_role_feishu_target(role: Any) -> tuple[str, str] | None:
    """Return ``(receive_id, receive_id_type)`` for this employee.

    Order:
    1. Legacy ``config.feishu_open_id`` (QR bind)
    2. ``RolePushPolicy.resolve_target("feishu")`` when push enabled
    3. ``None`` if unbound
    """
    from .push_binding_repo import RolePushBindingRepository

    cfg = getattr(role, "config", None)
    open_id = str(getattr(cfg, "feishu_open_id", "") or "").strip()
    if open_id:
        logger.debug(
            "[feishu_notify] using legacy feishu_open_id for %s",
            getattr(role, "agent_code", "?"),
        )
        return open_id, "open_id"

    agent_code = str(getattr(role, "agent_code", "") or "").strip()
    if agent_code:
        try:
            policy = RolePushBindingRepository.get_policy(agent_code)
            if policy and policy.should_push_to("feishu"):
                target = policy.resolve_target("feishu")
                if target:
                    target_id, target_type = target
                    logger.info(
                        "[feishu_notify] resolved target from RolePushPolicy: agent=%s target=%s type=%s",
                        agent_code,
                        target_id,
                        target_type,
                    )
                    return target_id, target_type
            elif policy:
                logger.debug(
                    "[feishu_notify] policy exists but feishu not enabled for %s",
                    agent_code,
                )
        except Exception as e:
            logger.debug(
                "[feishu_notify] failed to load RolePushPolicy for %s: %s",
                agent_code,
                e,
                exc_info=True,
            )

    logger.debug(
        "[feishu_notify] no Feishu push target for agent_code=%s (unbound)",
        agent_code,
    )
    return None


def _load_role(agent_code: str) -> Any | None:
    code = str(agent_code or "").strip()
    if not code or code.lower() in _NON_AGENT_RAISERS:
        return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return ProactiveRepository.get_role(code)
    except Exception:
        logger.debug("feishu_notify: load role failed code=%s", code, exc_info=True)
        return None


def resolve_tree_receipt_notify_role(
    *,
    raised_by: str = "",
    assigned_to: str = "",
) -> Any | None:
    """Pick the single bound role that should receive「协作待闭环」.

    Priority (first with a real outbound Feishu target wins):
    1. ``raised_by`` when it is an agent_code
    2. root ``assigned_to``
    3. main agent ``xiaomi``

    Returns ``None`` when nobody is bound — caller must not fall back to a
    machine-wide learned chat.
    """
    candidates: list[str] = []
    for raw in (raised_by, assigned_to, _MAIN_AGENT_CODE):
        code = str(raw or "").strip()
        if not code or code.lower() in _NON_AGENT_RAISERS:
            continue
        if code not in candidates:
            candidates.append(code)

    for code in candidates:
        role = _load_role(code)
        if role is None and code == _MAIN_AGENT_CODE:
            role = type(
                "R",
                (),
                {"agent_code": _MAIN_AGENT_CODE, "role_name": "小V", "config": None},
            )()
        if role is None:
            continue
        if _outbound_feishu_target(role):
            return role
    return None


def _feishu_channel():
    from evoflow.runtime.ports import get_channel_service

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
    assigned_to: str = "",
    claim_push_id: str = "",
) -> str | None:
    """Push one-shot「协作待闭环」to the bound notify role only.

    Target is resolved via :func:`resolve_tree_receipt_notify_role` (raised_by →
    assigned_to → xiaomi). No learned/default chat fallback.

    * Unbound → finalize audit as ``no_target`` and return the deterministic
      external id so the root stamp stays (no retry spam).
    * Channel down → return ``None`` so the caller can release and retry later.

    Callers that already claimed via ``try_claim_tree_receipt`` should pass
    ``claim_push_id`` so we finalize that pending audit row.
    """
    rid = str(root_task_id or "").strip()
    if not rid:
        return None

    from evoflow.persistence.channel_push_repositories import (
        finalize_tree_receipt_claim,
        tree_receipt_external_id,
        tree_receipt_outbound_exists,
    )

    ext = tree_receipt_external_id(rid)
    if not claim_push_id:
        try:
            if tree_receipt_outbound_exists(rid, statuses=("ok",)):
                return ext
        except Exception:
            logger.debug("feishu_notify.tree_receipt: exists probe failed", exc_info=True)

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
        "下游已全部结案。请提出人/产品验收后，将根单从「待闭环」改为 **已完成**；未验收前整单不算结束。"
    )
    text = "\n".join(body_bits)
    claim_id = str(claim_push_id or "").strip()

    role = resolve_tree_receipt_notify_role(raised_by=raised_by, assigned_to=assigned_to)
    if role is None:
        role = type(
            "R",
            (),
            {"agent_code": _MAIN_AGENT_CODE, "role_name": "小V", "config": None},
        )()

    def _record(
        *,
        ok: bool,
        receive_id: str = "",
        receive_id_type: str = "",
        sender_account_id: str = "",
        error: str = "",
        message_id: str = "",
    ) -> None:
        notify_code = str(getattr(role, "agent_code", "") or "")
        payload = {
            "transport": "markdown",
            "child_task_id": child_task_id,
            "notify_agent_code": notify_code,
            "raised_by": str(raised_by or "").strip(),
            "assigned_to": str(assigned_to or "").strip(),
            "reason": "collab_tree_all_descendants_terminal",
        }
        if claim_id:
            finalize_tree_receipt_claim(
                claim_id,
                ok=ok,
                receive_id=receive_id,
                receive_id_type=receive_id_type,
                sender_account_id=sender_account_id,
                role_agent_code=notify_code,
                content_summary=(
                    text[:400] if ok or text else (error or "send failed")
                ),
                error=error,
                payload=payload,
            )
            return
        _log_notify(
            kind="tree_receipt",
            role=role,
            ok=ok,
            message_id=message_id or (ext if ok else ""),
            task_id=rid,
            receive_id=receive_id,
            receive_id_type=receive_id_type,
            sender_account_id=sender_account_id,
            title=title,
            content_summary=(text[:400] if text else error)
            or (
                "feishu channel unavailable"
                if error == "feishu_not_running"
                else ""
            ),
            error=error,
            payload=payload,
            transport="markdown",
        )

    target = _outbound_feishu_target(role) if role else None
    # resolve_tree_receipt_notify_role already required a target; re-check for
    # stub / race. Unbound → consume claim, keep stamp (return ext).
    if not target:
        logger.info(
            "[feishu_notify] tree_receipt skip unbound root=%s raised_by=%s assigned_to=%s",
            rid,
            raised_by,
            assigned_to,
        )
        _record(ok=False, error="no_target")
        return ext

    channel = _feishu_channel()
    if channel is None:
        _record(ok=False, error="feishu_not_running")
        return None

    receive_id, receive_id_type = target
    if str(receive_id).startswith("ou_"):
        receive_id_type = "open_id"
    send_account = _send_account_for_target(role, receive_id, receive_id_type)

    try:
        # Push-log audit is owned by send_proactive_markdown. _record here is
        # only needed to finalize the tree_receipt claim (when claim_id set);
        # without a claim it would double-write the push log, so skip then.
        await channel.send_proactive_markdown(
            receive_id,
            text,
            receive_id_type=receive_id_type,
            account_id=send_account,
            kind="tree_receipt",
            role_agent_code=str(getattr(role, "agent_code", "") or ""),
            task_id=rid,
            title="协作待闭环",
            triggered_by="system",
        )
        if claim_id:
            _record(
                ok=True,
                receive_id=receive_id,
                receive_id_type=receive_id_type,
                sender_account_id=send_account,
                message_id=ext,
            )
        return ext
    except Exception as exc:
        logger.warning("feishu_notify.tree_receipt push failed root=%s", rid, exc_info=True)
        if claim_id:
            _record(
                ok=False,
                receive_id=receive_id,
                receive_id_type=receive_id_type,
                sender_account_id=send_account,
                error=str(exc)[:200],
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
    tid = str(task_id or "").strip()
    if not tid:
        return None
    target = _outbound_feishu_target(role)
    if not target:
        return None
    channel = _feishu_channel()
    if channel is None:
        logger.debug("feishu_notify.review: channel unavailable (bound role)")
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
    """Send duty-round digest card after a heartbeat/patrol ends.

    Unbound roles skip silently — desktop work journal already holds the report.
    """
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

    # Bind-first: never emit feishu_not_running for employees without a Feishu target.
    target = _outbound_feishu_target(role)
    if not target:
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
    receive_id, receive_id_type = target
    if str(receive_id).startswith("ou_"):
        receive_id_type = "open_id"
    send_account = _send_account_for_target(role, receive_id, receive_id_type)
    content_preview = think_summary[:400]
    if not content_preview and has_named_item:
        for it in items:
            if it.get("is_journal"):
                continue
            item_title = str(it.get("title") or it.get("preview") or "").strip()
            if item_title:
                content_preview = item_title[:400]
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
    tid = str(task_id or "").strip()
    if not tid:
        return None
    target = _outbound_feishu_target(role)
    if not target:
        return None
    channel = _feishu_channel()
    if channel is None:
        logger.debug("feishu_notify.running: channel unavailable (bound role)")
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
