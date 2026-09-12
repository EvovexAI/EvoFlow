"""DecisionGate - routes risky initiatives through human approval.

Approval channels:
1. **Feishu** - interactive message card with [同意] [拒绝] buttons
2. **Desktop** - Tauri window notification with authorize/reject actions

Flow:
  Initiative.needs_approval() → create Approval (pending) → push to channels
  → wait for callback (POST /api/proactive/approval/{id})
  → on approve: engine.execute_initiative()
  → on reject: update initiative status = rejected
  → on timeout: escalate or auto-reject
"""

from __future__ import annotations

import asyncio
import logging

from evoflow.proactive.models import (
    Approval,
    ApprovalStatus,
    Initiative,
    InitiativeStatus,
    ProactiveRole,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Escalation thresholds (minutes)
_ESCALATION_LEVEL1_MINUTES = 30  # After 30min, escalate notification
_ESCALATION_LEVEL2_MINUTES = 120  # After 2h, auto-reject


def _parse_iso_datetime(value: str | None):
    """Parse ISO timestamps used on approvals (``+08:00`` / ``Z`` / naive→UTC)."""
    from datetime import UTC, datetime

    s = str(value or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except ValueError:
        return None


class DecisionGate:
    """Manages the human-decision approval flow for initiatives."""

    # Default timeout by action_type (minutes), when role config has no override.
    # These are far more generous than the old flat 30min to avoid the 94%
    # timeout rate that made the approval channel useless.
    _DEFAULT_TIMEOUT_BY_TYPE: dict[str, int] = {
        "analysis": 120,         # 2h  - reports can wait
        "report": 120,           # 2h
        "code_change": 1440,     # 24h - needs careful review
        "optimization": 1440,    # 24h - needs impact assessment
        "alert": 60,             # 1h  - alerts need faster response
        "task_delegation": 240,  # 4h  - coordination needed
    }

    @staticmethod
    def _parse_iso(value: str | None):
        return _parse_iso_datetime(value)

    def __init__(self) -> None:
        self._pending_timeout_task: asyncio.Task | None = None

    def _resolve_timeout_minutes(
        self, role: ProactiveRole | None, initiative: Initiative | None
    ) -> int:
        """Resolve the effective approval timeout for this initiative.

        Priority:
          1. role.config.approval_timeout_by_type[action_type]
          2. built-in default by action_type (generous; avoids 30min death spiral)
          3. role.config.approval_timeout_minutes (legacy flat)
          4. 120
        """
        action = initiative.action_type.value if initiative else "analysis"
        # 1. Role-level per-type override
        if role and role.config.approval_timeout_by_type:
            custom = role.config.approval_timeout_by_type.get(action)
            if custom and int(custom) > 0:
                return int(custom)
        # 2. Built-in default by type (preferred over legacy flat 30min)
        builtin = self._DEFAULT_TIMEOUT_BY_TYPE.get(action)
        if builtin and int(builtin) > 0:
            return int(builtin)
        # 3. Role-level flat override
        if role and role.config.approval_timeout_minutes > 0:
            return int(role.config.approval_timeout_minutes)
        return 120

    # ── Create approval ────────────────────────────────────────

    async def request_approval(
        self,
        role: ProactiveRole,
        initiative: Initiative,
    ) -> Approval:
        """Create a pending approval and push to configured channels.

        Called by the engine when an initiative needs human decision.
        """
        approval_id = ProactiveRepository.new_approval_id()
        channels = role.config.approval_channels or ["desktop", "feishu"]
        channel_str = "both" if len(channels) > 1 else (channels[0] if channels else "desktop")

        approval = Approval(
            id=approval_id,
            initiative_id=initiative.id,
            task_id="",
            role_agent_code=role.agent_code,
            channel=channel_str,
            status=ApprovalStatus.PENDING,
            created_at=utc_now_iso_z(),
            updated_at=utc_now_iso_z(),
        )
        ProactiveRepository.save_approval(approval)

        # Update initiative to link approval + set effective timeout
        initiative.approval_id = approval_id
        initiative.status = InitiativeStatus.PENDING_APPROVAL
        initiative.approval_timeout_minutes = self._resolve_timeout_minutes(role, initiative)
        ProactiveRepository.save_initiative(initiative)

        # Push to channels
        await self._push_to_channels(role, initiative, approval)

        logger.info(
            "proactive.approval.requested initiative=%s role=%s channel=%s timeout=%dm",
            initiative.id,
            role.agent_code,
            channel_str,
            initiative.approval_timeout_minutes,
        )
        return approval

    async def request_approval_for_task(
        self,
        role: ProactiveRole,
        task: dict,
    ) -> Approval:
        """Create a pending approval hanging off a work-item Task."""
        from evoflow.proactive.work_items import (
            task_action_type,
            task_risk_level,
            task_to_bridge_initiative,
        )

        tid = str(task.get("id") or task.get("task_id") or "").strip()
        if not tid:
            raise ValueError("task id required for approval")

        existing = ProactiveRepository.get_approval_by_task(tid)
        if existing and existing.status == ApprovalStatus.PENDING:
            return existing

        approval_id = ProactiveRepository.new_approval_id()
        channels = role.config.approval_channels or ["desktop", "feishu"]
        channel_str = "both" if len(channels) > 1 else (channels[0] if channels else "desktop")

        # Persist a bridge initiative so FK(initiative_id) and channel cards work.
        # Id is stable ``task:<tid>`` (see task_to_bridge_initiative).
        synthetic = task_to_bridge_initiative(task)
        if not str(synthetic.role_agent_code or "").strip():
            synthetic.role_agent_code = role.agent_code
        from evoflow.proactive.models import InitiativeStatus

        synthetic.status = InitiativeStatus.PENDING_APPROVAL
        synthetic.approval_timeout_minutes = self._resolve_timeout_minutes(role, synthetic)
        ProactiveRepository.save_initiative(synthetic)

        approval = Approval(
            id=approval_id,
            initiative_id=synthetic.id,
            task_id=tid,
            role_agent_code=role.agent_code,
            channel=channel_str,
            status=ApprovalStatus.PENDING,
            created_at=utc_now_iso_z(),
            updated_at=utc_now_iso_z(),
        )
        ProactiveRepository.save_approval(approval)

        synthetic.approval_id = approval_id
        ProactiveRepository.save_initiative(synthetic)

        await self._push_to_channels(role, synthetic, approval)

        logger.info(
            "proactive.approval.requested task=%s role=%s risk=%s type=%s timeout=%dm",
            tid,
            role.agent_code,
            task_risk_level(task).value,
            task_action_type(task).value,
            synthetic.approval_timeout_minutes,
        )
        return approval

    # ── Decision callback ──────────────────────────────────────

    async def process_decision(
        self,
        approval_id: str,
        *,
        decision: str,  # "approved" | "rejected"
        decided_by: str = "user",
        comment: str = "",
        rejection_reason: str = "",
    ) -> Initiative | None:
        """Process a human decision (from Feishu callback or desktop API)."""
        approval = ProactiveRepository.get_approval(approval_id)
        if not approval:
            logger.warning("proactive.approval not found: %s", approval_id)
            return None
        if approval.status != ApprovalStatus.PENDING:
            logger.warning(
                "proactive.approval already decided: %s status=%s",
                approval_id,
                approval.status.value,
            )
            return None

        # Update approval
        approval.status = ApprovalStatus(decision)
        approval.decided_by = decided_by
        approval.decided_at = utc_now_iso_z()
        approval.decision_comment = comment
        if decision == "rejected" and rejection_reason:
            approval.rejection_reason = rejection_reason
        elif decision == "rejected" and comment:
            approval.rejection_reason = comment
        ProactiveRepository.save_approval(approval)

        # Leave-a-trail: desktop/API inbound. Feishu card callbacks are logged in
        # FeishuChannel._process_proactive_card_decision (richer message_id/raw).
        try:
            by = str(decided_by or "").strip().lower()
            if not by.startswith("feishu"):
                from evoflow.persistence.channel_push_repositories import safe_record_push

                safe_record_push(
                    direction="inbound",
                    channel="desktop",
                    kind="approval_decision",
                    event="callback",
                    transport="api",
                    approval_id=approval.id,
                    task_id=str(approval.task_id or ""),
                    initiative_id=str(approval.initiative_id or ""),
                    role_agent_code=str(approval.role_agent_code or ""),
                    external_message_id=str(approval.feishu_message_id or ""),
                    title=str(decision),
                    content_summary=(
                        rejection_reason
                        or comment
                        or f"decision={decision} by={decided_by}"
                    )[:400],
                    payload={
                        "decision": decision,
                        "decided_by": decided_by,
                        "comment": (comment or "")[:200],
                        "rejection_reason": (rejection_reason or "")[:200],
                    },
                    status="ok",
                    triggered_by="user_callback",
                )
        except Exception:
            logger.debug("proactive.approval: push_log inbound failed", exc_info=True)

        # Task-native work item
        task_id = str(approval.task_id or "").strip()
        if task_id:
            from evoflow.proactive.work_items import (
                load_work_item_task,
                set_work_item_status,
                task_to_bridge_initiative,
            )

            task = load_work_item_task(task_id)
            if not task:
                return None

            bridge_id = f"task:{task_id}"
            synthetic = ProactiveRepository.get_initiative(bridge_id)
            if synthetic is None:
                synthetic = task_to_bridge_initiative(task)
                if not str(synthetic.role_agent_code or "").strip():
                    synthetic.role_agent_code = approval.role_agent_code
            synthetic.approval_id = approval.id

            if decision == "approved":
                synthetic.status = InitiativeStatus.APPROVED
                synthetic.approved_by = decided_by
                synthetic.approved_at = utc_now_iso_z()
                ProactiveRepository.save_initiative(synthetic)
                cur = str(task.get("status") or "").strip().lower()
                # Handoff gate: parent already completed — approve → wake downstream.
                if cur in {"completed", "reviewed", "awaiting_close"}:
                    try:
                        from evoflow.admin.tasks import (
                            dispatch_handlers_after_approval,
                            task_has_pending_handoff_approval,
                        )

                        if task_has_pending_handoff_approval(task) or task.get(
                            "handlers_pending_approval"
                        ):
                            # Run create+wake off the event-loop thread so a
                            # legacy HTTP wake cannot deadlock Gateway.
                            import asyncio

                            await asyncio.to_thread(
                                dispatch_handlers_after_approval, task_id
                            )
                    except Exception:
                        logger.exception(
                            "proactive.approval: handoff dispatch failed task=%s",
                            task_id,
                        )
                elif cur in {"waiting_user", "pending", "proposed", ""}:
                    # Legacy start-of-work approval: release to pending (do not clobber).
                    set_work_item_status(task_id, "pending")
                logger.info(
                    "proactive.approval.approved task=%s by=%s",
                    task_id,
                    decided_by,
                )
                return synthetic

            cur = str(task.get("status") or "").strip().lower()
            # Rejected handoff on an already-completed parent: keep completed, clear gate.
            if cur in {"completed", "reviewed", "awaiting_close"}:
                try:
                    from evoflow.collab.storage import (
                        get_project_storage,
                        patch_collab_main_task_in_project_storage,
                    )

                    patch_collab_main_task_in_project_storage(
                        get_project_storage(),
                        task_id,
                        {"handlers_pending_approval": False},
                    )
                except Exception:
                    logger.debug(
                        "proactive.approval: clear handoff flag failed task=%s",
                        task_id,
                        exc_info=True,
                    )
                synthetic.status = InitiativeStatus.REJECTED
                ProactiveRepository.save_initiative(synthetic)
                reason = (
                    approval.rejection_reason or approval.decision_comment or comment or ""
                ).strip()
                self._record_rejection_memory(synthetic, reason)
                logger.info(
                    "proactive.approval.rejected_handoff task=%s by=%s",
                    task_id,
                    decided_by,
                )
                return None

            set_work_item_status(
                task_id, "cancelled", result=rejection_reason or comment or "rejected"
            )
            synthetic.status = InitiativeStatus.REJECTED
            ProactiveRepository.save_initiative(synthetic)
            reason = (
                approval.rejection_reason or approval.decision_comment or comment or ""
            ).strip()
            self._record_rejection_memory(synthetic, reason)
            logger.info(
                "proactive.approval.rejected task=%s by=%s",
                task_id,
                decided_by,
            )
            return None

        # Update initiative (legacy)
        initiative = ProactiveRepository.get_initiative(approval.initiative_id)
        if not initiative:
            return None

        if decision == "approved":
            initiative.status = InitiativeStatus.APPROVED
            initiative.approved_by = decided_by
            initiative.approved_at = utc_now_iso_z()
            ProactiveRepository.save_initiative(initiative)
            logger.info(
                "proactive.approval.approved initiative=%s by=%s",
                initiative.id,
                decided_by,
            )
        else:
            initiative.status = InitiativeStatus.REJECTED
            ProactiveRepository.save_initiative(initiative)
            reason = (
                approval.rejection_reason or approval.decision_comment or comment or ""
            ).strip()
            self._record_rejection_memory(initiative, reason)
            logger.info(
                "proactive.approval.rejected initiative=%s by=%s",
                initiative.id,
                decided_by,
            )

        return initiative

    def _record_rejection_memory(self, initiative: Initiative, reason: str) -> None:
        """Feed rejection into role memory so the next duty round avoids repeats.

        Write **once** into ``strategies`` (policy). Do not also append the same
        note to ``observations`` — work_log already carries the rejected item,
        and dual-listing made duty briefs read the same驳回 three times.
        """
        try:
            from evoflow.proactive.repositories import ProactiveMemoryRepository

            title = str(initiative.title or "").strip() or initiative.id
            note = f"用户驳回「{title[:80]}」"
            if reason:
                note += f"：{reason[:160]}"
            note += "。勿换皮重提同题；应改方案或 initiative_updates 推进旧事项。"
            mem = ProactiveMemoryRepository.get(initiative.role_agent_code)
            key = note[:40]
            mem.strategies = [s for s in (mem.strategies or []) if key not in str(s)]
            mem.strategies.append(note)
            if len(mem.strategies) > 40:
                mem.strategies = mem.strategies[-40:]
            # Drop prior duplicate copies accidentally stored as observations.
            mem.observations = [
                o for o in (mem.observations or []) if key not in str(o)
            ]
            if len(mem.observations) > 100:
                mem.observations = mem.observations[-100:]
            ProactiveMemoryRepository.save(mem)
        except Exception:
            logger.debug(
                "proactive.approval: failed to record rejection memory initiative=%s",
                initiative.id,
                exc_info=True,
            )

    # ── Timeout / escalation ────────────────────────────────────

    async def check_timeouts(self) -> list[Approval]:
        """Check all pending approvals for timeout / escalation.

        Returns the list of approvals that were escalated or timed out.

        Timeout logic (post-O1 fix):
        - The effective timeout comes from ``_resolve_timeout_minutes`` which
          honours per-action-type overrides (e.g. code_change=24h).
        - Escalation (re-notify) fires at 50% of the timeout.
        - Auto-reject fires at 100% of the timeout (no longer ``timeout*4``).
        """
        from datetime import UTC, datetime

        pending = ProactiveRepository.list_pending_approvals()
        acted: list[Approval] = []

        for approval in pending:
            created = self._parse_iso(approval.created_at)
            if not created:
                continue

            now = datetime.now(UTC)
            age_minutes = (now - created).total_seconds() / 60.0

            initiative = None
            if approval.initiative_id:
                initiative = ProactiveRepository.get_initiative(approval.initiative_id)
            elif approval.task_id:
                from evoflow.proactive.work_items import (
                    load_work_item_task,
                    task_to_bridge_initiative,
                )

                task = load_work_item_task(approval.task_id)
                if task:
                    initiative = task_to_bridge_initiative(task)
            role = ProactiveRepository.get_role(approval.role_agent_code)
            # If Feishu card never landed (channel down at create time), keep retrying
            # in background to avoid blocking the tick loop.
            if (
                role
                and initiative
                and not str(approval.feishu_message_id or "").strip()
                and "feishu"
                in {
                    str(c).strip().lower()
                    for c in (role.config.approval_channels or ["desktop", "feishu"])
                }
            ):
                asyncio.create_task(
                    self._retry_push_feishu_background(role, initiative, approval)
                )
            timeout_mins = self._resolve_timeout_minutes(role, initiative)
            escalate_mins = timeout_mins * 0.5

            if age_minutes >= timeout_mins:
                approval.status = ApprovalStatus.TIMEOUT
                approval.decided_at = utc_now_iso_z()
                ProactiveRepository.save_approval(approval)

                if approval.task_id:
                    from evoflow.proactive.work_items import set_work_item_status

                    set_work_item_status(
                        approval.task_id,
                        "cancelled",
                        result="approval timeout",
                    )
                elif initiative and not str(initiative.id or "").startswith("task:"):
                    initiative.status = InitiativeStatus.TIMEOUT_REJECTED
                    ProactiveRepository.save_initiative(initiative)

                acted.append(approval)
                logger.warning(
                    "proactive.approval.timeout initiative=%s (auto-rejected after %dm, limit=%dm)",
                    approval.initiative_id,
                    int(age_minutes),
                    timeout_mins,
                )

            elif age_minutes >= escalate_mins and approval.escalation_level == 0:
                approval.escalation_level = 1
                ProactiveRepository.save_approval(approval)

                if initiative and role:
                    await self._push_escalation(role, initiative, approval)

                acted.append(approval)
                logger.warning(
                    "proactive.approval.escalate initiative=%s (pending %dm)",
                    approval.initiative_id,
                    int(age_minutes),
                )

        return acted

    # ── Channel push ───────────────────────────────────────────

    async def _push_to_channels(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
    ) -> None:
        """Push approval request to configured channels (Feishu / desktop).

        Feishu interactive card is the default human gate — always attempted
        unless the role explicitly opts out with approval_channels that omit
        feishu *and* set a sentinel. In practice we always include feishu when
        the list is empty/default, and still push feishu for handoff reviews.
        """
        configured = list(role.config.approval_channels or [])
        # Default: desktop + feishu. If role only listed desktop historically,
        # still push Feishu for approval cards (product default).
        channels = set(configured) if configured else {"desktop", "feishu"}
        channels.add("feishu")
        channels.add("desktop")

        # Push desktop and feishu concurrently so one slow channel
        # does not block the other.
        tasks: list[asyncio.Task] = []
        tasks.append(asyncio.create_task(self._push_desktop_safe(role, initiative, approval)))
        if "feishu" in channels:
            tasks.append(
                asyncio.create_task(self._push_feishu_safe(role, initiative, approval))
            )
        if tasks:
            await asyncio.gather(*tasks)

    async def _push_feishu(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
        *,
        triggered_by: str = "system",
    ) -> None:
        """Push an interactive approval card with [同意] [拒绝] buttons to Feishu."""
        from evoflow.persistence.channel_push_repositories import safe_record_push

        try:
            from app.channels.service import get_channel_service

            service = get_channel_service()
            if service is None:
                logger.warning("proactive.feishu.push: channel service unavailable")
                safe_record_push(
                    direction="outbound",
                    channel="feishu",
                    kind="approval_card",
                    event="send_failed",
                    transport="interactive_card",
                    approval_id=approval.id,
                    task_id=str(approval.task_id or ""),
                    initiative_id=str(initiative.id or ""),
                    role_agent_code=str(role.agent_code or ""),
                    title=str(initiative.title or ""),
                    content_summary="channel service unavailable",
                    status="error",
                    error="channel_service_unavailable",
                    triggered_by=triggered_by,
                )
                return

            channel = service._channels.get("feishu")
            if channel is None or not channel.is_running:
                logger.warning("proactive.feishu.push: feishu channel not running")
                safe_record_push(
                    direction="outbound",
                    channel="feishu",
                    kind="approval_card",
                    event="send_failed",
                    transport="interactive_card",
                    approval_id=approval.id,
                    task_id=str(approval.task_id or ""),
                    initiative_id=str(initiative.id or ""),
                    role_agent_code=str(role.agent_code or ""),
                    title=str(initiative.title or ""),
                    content_summary="feishu channel not running",
                    status="error",
                    error="feishu_not_running",
                    triggered_by=triggered_by,
                )
                return

            # Prefer employee-bound bot + open_id when available
            from evoflow.proactive.feishu_notify import resolve_role_feishu_target

            target = resolve_role_feishu_target(role)
            if not target:
                from app.gateway.channel_result_push import resolve_push_target

                resolved = resolve_push_target(
                    push_enabled=True,
                    push_channel="feishu",
                    push_target_id="",
                )
                if not resolved:
                    logger.warning("proactive.feishu.push: no target resolved")
                    safe_record_push(
                        direction="outbound",
                        channel="feishu",
                        kind="approval_card",
                        event="send_failed",
                        transport="interactive_card",
                        approval_id=approval.id,
                        task_id=str(approval.task_id or ""),
                        initiative_id=str(initiative.id or ""),
                        role_agent_code=str(role.agent_code or ""),
                        title=str(initiative.title or ""),
                        content_summary="no Feishu push target resolved",
                        status="error",
                        error="no_target",
                        triggered_by=triggered_by,
                    )
                    return
                _, target_id = resolved
                receive_id_type = "chat_id"
            else:
                target_id, receive_id_type = target

            card_ref = str(approval.task_id or "").strip() or initiative.id
            if card_ref.startswith("task:"):
                card_ref = card_ref[5:]

            summary = ""
            shareable: list[dict] = []
            card_kind = "approval"
            next_handlers: list[dict] = []
            task_row: dict | None = None
            tid = str(approval.task_id or "").strip()
            if tid:
                try:
                    from evoflow.admin.tasks import task_summary_of
                    from evoflow.collab.task_handlers import task_handlers_of
                    from evoflow.collab.task_outputs import (
                        shareable_approval_outputs,
                        task_outputs_of,
                    )
                    from evoflow.proactive.work_items import load_work_item_task

                    task_row = load_work_item_task(tid)
                    if task_row:
                        summary = task_summary_of(task_row)
                        shareable = shareable_approval_outputs(task_outputs_of(task_row))
                        next_handlers = task_handlers_of(task_row)
                        st = str(task_row.get("status") or "").strip().lower()
                        if st in {"completed", "reviewed", "awaiting_close"} or task_row.get(
                            "handlers_pending_approval"
                        ):
                            card_kind = "handoff"
                except Exception:
                    logger.debug(
                        "proactive.feishu.push: load task outputs failed task=%s",
                        tid,
                        exc_info=True,
                    )

            # Handoff: keep card lean (summary + next handlers). Skip dumping
            # initiative description / Task ids into Feishu body.
            if card_kind == "handoff":
                description = summary or str(initiative.title or "").strip()
            else:
                description = initiative.description
                if summary and summary not in description:
                    description = (
                        f"{description}\n\n交付摘要：{summary}".strip()
                        if description
                        else summary
                    )

            # Prefer the bot that already owns this chat (same as normal Feishu replies).
            # Learned default often comes from 小V/私聊 inbound — sending as Settings
            # primary into that chat causes 230002. Only use role agent for open_id DM.
            if receive_id_type == "open_id":
                send_account = str(role.agent_code or "").strip()
            else:
                send_account = ""
                try:
                    owned = str(
                        getattr(channel, "_chat_account", {}).get(str(target_id), "") or ""
                    ).strip()
                    if owned:
                        send_account = owned
                    else:
                        from app.channels.feishu_automation_learned_chat import (
                            read_learned_feishu_automation_account_id,
                            read_learned_feishu_automation_chat_id,
                        )

                        learned_chat = str(
                            read_learned_feishu_automation_chat_id() or ""
                        ).strip()
                        if learned_chat == str(target_id).strip():
                            send_account = str(
                                read_learned_feishu_automation_account_id() or ""
                            ).strip()
                except Exception:
                    logger.debug(
                        "proactive.feishu.push: resolve chat owner failed",
                        exc_info=True,
                    )

            # Normalize Feishu id type (ou_ = user open_id).
            tid_s = str(target_id or "").strip()
            if tid_s.startswith("ou_"):
                receive_id_type = "open_id"
                if not send_account:
                    send_account = str(role.agent_code or "").strip()

            msg_id = await channel.send_proactive_approval_card(
                target_id,
                approval_id=approval.id,
                initiative_id=card_ref,
                role_name=role.role_name,
                department=role.department,
                title=initiative.title,
                description=description,
                risk_level=initiative.risk_level.value,
                action_type=initiative.action_type.value,
                rationale=initiative.rationale,
                expected_outcome=initiative.expected_outcome,
                agent_code=role.agent_code,
                timeout_minutes=int(
                    getattr(approval, "approval_timeout_minutes", None)
                    or getattr(initiative, "approval_timeout_minutes", None)
                    or 30
                ),
                receive_id_type=receive_id_type,
                account_id=send_account,
                summary=summary,
                outputs=shareable,
                card_kind=card_kind,
                next_handlers=next_handlers,
            )

            # If owner bot failed (or unknown after restart), try a few alternates.
            if not msg_id and receive_id_type == "chat_id":
                tried = {send_account, ""}
                for alt in ("xiaomi", str(role.agent_code or "").strip()):
                    if not alt or alt in tried:
                        continue
                    tried.add(alt)
                    logger.info(
                        "proactive.feishu.push: retry approval card with account=%s",
                        alt,
                    )
                    msg_id = await channel.send_proactive_approval_card(
                        target_id,
                        approval_id=approval.id,
                        initiative_id=card_ref,
                        role_name=role.role_name,
                        department=role.department,
                        title=initiative.title,
                        description=description,
                        risk_level=initiative.risk_level.value,
                        action_type=initiative.action_type.value,
                        rationale=initiative.rationale,
                        expected_outcome=initiative.expected_outcome,
                        agent_code=role.agent_code,
                        timeout_minutes=int(
                            getattr(approval, "approval_timeout_minutes", None)
                            or getattr(initiative, "approval_timeout_minutes", None)
                            or 30
                        ),
                        receive_id_type=receive_id_type,
                        account_id=alt,
                        summary=summary,
                        outputs=shareable,
                        card_kind=card_kind,
                        next_handlers=next_handlers,
                    )
                    if msg_id:
                        send_account = alt
                        break

            card_summary = (summary or description or initiative.title or "")[:400]
            if msg_id:
                approval.feishu_message_id = msg_id
                ProactiveRepository.save_approval(approval)
                logger.info(
                    "proactive.feishu.pushed interactive card initiative=%s msg_id=%s account=%s",
                    initiative.id,
                    msg_id,
                    send_account or "primary",
                )
                safe_record_push(
                    direction="outbound",
                    channel="feishu",
                    kind="approval_card",
                    event="sent",
                    transport="interactive_card",
                    approval_id=approval.id,
                    task_id=str(approval.task_id or ""),
                    initiative_id=str(initiative.id or ""),
                    role_agent_code=str(role.agent_code or ""),
                    receive_id=str(target_id or ""),
                    receive_id_type=str(receive_id_type or ""),
                    sender_account_id=str(send_account or ""),
                    external_message_id=str(msg_id),
                    title=str(initiative.title or ""),
                    content_summary=card_summary,
                    payload={
                        "card_kind": card_kind,
                        "handlers": [
                            {
                                "role": h.get("role") or h.get("role_name"),
                                "agent_code": h.get("agent_code"),
                                "content": str(h.get("content") or "")[:160],
                            }
                            for h in (next_handlers or [])[:6]
                            if isinstance(h, dict)
                        ],
                        "output_count": len(shareable),
                    },
                    status="ok",
                    triggered_by=triggered_by,
                )
                # Attach non-code file deliverables (docs/pdf/images…), never source code.
                if shareable:
                    try:
                        file_results = await channel.send_proactive_approval_output_files(
                            target_id,
                            outputs=shareable,
                            workspace_path=str(
                                getattr(role.config, "workspace_path", "") or ""
                            ),
                            receive_id_type=receive_id_type,
                            account_id=send_account,
                        )
                        ok_n = 0
                        for fr in file_results or []:
                            if not isinstance(fr, dict):
                                continue
                            ok = bool(fr.get("ok"))
                            if ok:
                                ok_n += 1
                            safe_record_push(
                                direction="outbound",
                                channel="feishu",
                                kind="approval_file",
                                event="sent" if ok else "send_failed",
                                transport="file",
                                approval_id=approval.id,
                                task_id=str(approval.task_id or ""),
                                initiative_id=str(initiative.id or ""),
                                role_agent_code=str(role.agent_code or ""),
                                receive_id=str(target_id or ""),
                                receive_id_type=str(receive_id_type or ""),
                                sender_account_id=str(send_account or ""),
                                external_message_id=str(fr.get("message_id") or ""),
                                title=str(fr.get("filename") or "file"),
                                content_summary=str(fr.get("path") or fr.get("filename") or ""),
                                payload=fr,
                                status="ok" if ok else "error",
                                error=str(fr.get("error") or ""),
                                triggered_by=triggered_by,
                            )
                        if ok_n:
                            logger.info(
                                "proactive.feishu.pushed %d output file(s) for approval=%s",
                                ok_n,
                                approval.id,
                            )
                    except Exception as exc:
                        logger.debug(
                            "proactive.feishu.output files push failed",
                            exc_info=True,
                        )
                        safe_record_push(
                            direction="outbound",
                            channel="feishu",
                            kind="approval_file",
                            event="send_failed",
                            transport="file",
                            approval_id=approval.id,
                            task_id=str(approval.task_id or ""),
                            initiative_id=str(initiative.id or ""),
                            role_agent_code=str(role.agent_code or ""),
                            receive_id=str(target_id or ""),
                            receive_id_type=str(receive_id_type or ""),
                            sender_account_id=str(send_account or ""),
                            title="approval_outputs",
                            content_summary="batch send failed",
                            status="error",
                            error=str(exc)[:200],
                            triggered_by=triggered_by,
                        )
            else:
                logger.warning("proactive.feishu.push: card creation returned no msg_id")
                safe_record_push(
                    direction="outbound",
                    channel="feishu",
                    kind="approval_card",
                    event="send_failed",
                    transport="interactive_card",
                    approval_id=approval.id,
                    task_id=str(approval.task_id or ""),
                    initiative_id=str(initiative.id or ""),
                    role_agent_code=str(role.agent_code or ""),
                    receive_id=str(target_id or ""),
                    receive_id_type=str(receive_id_type or ""),
                    sender_account_id=str(send_account or ""),
                    title=str(initiative.title or ""),
                    content_summary=card_summary or "card creation returned no msg_id",
                    status="error",
                    error="no_msg_id",
                    triggered_by=triggered_by,
                )

        except Exception as exc:
            logger.error("proactive.feishu.push error", exc_info=True)
            safe_record_push(
                direction="outbound",
                channel="feishu",
                kind="approval_card",
                event="send_failed",
                transport="interactive_card",
                approval_id=getattr(approval, "id", "") or "",
                task_id=str(getattr(approval, "task_id", "") or ""),
                initiative_id=str(getattr(initiative, "id", "") or ""),
                role_agent_code=str(getattr(role, "agent_code", "") or ""),
                title=str(getattr(initiative, "title", "") or ""),
                content_summary="exception during feishu push",
                status="error",
                error=str(exc)[:200],
                triggered_by=triggered_by,
            )

    async def _push_desktop(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
    ) -> None:
        """Push a desktop notification via SSE / WebSocket.

        The frontend (EvoPanel Tauri app) listens on the SSE stream and
        can show a native notification with authorize/reject buttons.
        """
        try:
            from evoflow.collab.ws_notify import broadcast_to_channels

            payload = {
                "approval_id": approval.id,
                "initiative_id": initiative.id,
                "task_id": str(approval.task_id or "").strip() or None,
                "role_name": role.role_name,
                "role_agent_code": role.agent_code,
                "title": initiative.title,
                "description": initiative.description,
                "risk_level": initiative.risk_level.value,
                "action_type": initiative.action_type.value,
            }
            await broadcast_to_channels(
                ["proactive"],
                "proactive_approval_request",
                payload,
            )
            logger.info("proactive.desktop.pushed initiative=%s", initiative.id)
        except Exception:
            logger.debug("proactive.desktop.push: broadcast failed (non-fatal)", exc_info=True)

    # ── Background-safe wrappers (fire-and-forget, timeout-protected) ──

    async def _retry_push_feishu_background(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
    ) -> None:
        """Background retry of feishu push — never blocks the tick loop."""
        try:
            logger.info(
                "proactive.approval.feishu retry (background) approval=%s",
                approval.id,
            )
            await self._push_feishu(role, initiative, approval)
        except Exception:
            logger.debug(
                "proactive.approval.feishu retry failed approval=%s",
                approval.id,
                exc_info=True,
            )

    async def _push_desktop_safe(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
    ) -> None:
        """Desktop push wrapper that never raises."""
        try:
            await self._push_desktop(role, initiative, approval)
        except Exception:
            logger.debug(
                "proactive.desktop.push failed (safe) initiative=%s",
                initiative.id,
                exc_info=True,
            )

    async def _push_feishu_safe(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
    ) -> None:
        """Feishu push wrapper with 15s timeout — never blocks the caller."""
        try:
            await asyncio.wait_for(
                self._push_feishu(role, initiative, approval),
                timeout=15.0,
            )
        except TimeoutError:
            logger.warning(
                "proactive.feishu.push timeout (>15s) approval=%s initiative=%s",
                approval.id,
                initiative.id,
            )
        except Exception:
            logger.debug(
                "proactive.feishu.push failed (safe) approval=%s",
                approval.id,
                exc_info=True,
            )

    async def _push_escalation(
        self,
        role: ProactiveRole,
        initiative: Initiative,
        approval: Approval,
    ) -> None:
        """Re-notify with escalation urgency (resend interactive card)."""
        try:
            await self._push_feishu(
                role, initiative, approval, triggered_by="escalation"
            )
            logger.info("proactive.escalation.pushed initiative=%s", initiative.id)
        except Exception:
            logger.debug("proactive.escalation.push failed", exc_info=True)
