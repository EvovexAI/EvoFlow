"""ProactiveRunner - background heartbeat scheduler for embodied AI roles.

Runs on the Gateway process (same lifecycle as automation_runner).
Every tick:
  1. Find roles whose next_heartbeat_at is due
  2. For each due role, run the ProactiveEngine.think() cycle
  3. For initiatives that need approval, push to DecisionGate
  4. For auto-executable initiatives, run ExecutionBridge
  5. Check pending approvals for timeout / escalation
  6. Update role heartbeat timestamps
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from evoflow.proactive.decision_gate import DecisionGate
from evoflow.proactive.engine import ProactiveEngine
from evoflow.proactive.models import (
    ApprovalStatus,
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveRole,
    needs_approval,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.proactive.work_items import (
    dispatch_rationale_zh as _dispatch_rationale_zh,
    dispatch_source_line as _dispatch_source_line,
)
from evoflow.timeutil import BEIJING_TZ, utc_now_iso_z

logger = logging.getLogger(__name__)

def _default_proactive_tick_seconds() -> int:
    raw = (os.getenv("EVOFLOW_PROACTIVE_TICK_SECONDS") or "60").strip()
    try:
        return max(10, int(raw))
    except ValueError:
        return 60


DEFAULT_TICK_INTERVAL = _default_proactive_tick_seconds()  # seconds between heartbeat checks
_MAX_CONCURRENT_THINK = 2  # max simultaneous think cycles


def _engine_pref_enabled_for_log() -> bool:
    """与 Panel「自动上班」总开关一致；缺省视为开。"""
    try:
        from evoflow.persistence.config_repositories import get_app_setting

        raw = get_app_setting("proactive.engine_enabled")
    except Exception:
        return True
    if raw is None:
        return True
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "disabled")


def _role_ui_badge_zh(
    role: ProactiveRole,
    *,
    busy: bool = False,
    engine_on: bool | None = None,
) -> tuple[str, str]:
    """与 Panel 名册/详情徽章对齐，只三种：工作中 / 在岗 / 已停。

    见 ``proactive.js`` ``roleDutyBadge``：关闭总开关、请假、归档、草稿、
    停止工作（auto_patrol_suspended）均显示「已停」。
    """
    if busy:
        return "工作中", "正在执行本轮任务"
    st = str(getattr(role, "status", "") or "").strip().lower()
    suspended = bool(getattr(getattr(role, "config", None), "auto_patrol_suspended", False))
    if engine_on is None:
        engine_on = _engine_pref_enabled_for_log()
    stopped = st in {"paused", "archived", "draft"} or (
        st == "active" and ((not engine_on) or suspended)
    )
    if stopped:
        if st == "draft":
            tip = "草稿未确认，确认后才会排班"
        elif st == "paused":
            tip = "请假中，不会自动巡检"
        elif st == "archived":
            tip = "已归档，不会自动巡检"
        elif suspended:
            tip = "该员工自动巡检已关；菜单「上班」可恢复"
        elif not engine_on:
            tip = "总开关已关闭，到期也不会跑"
        else:
            tip = "不会自动巡检"
        return "已停", tip
    if st == "active":
        nxt = str(getattr(role, "next_heartbeat_at", "") or "").strip()
        tip = f"下次自动巡检 {nxt}" if nxt else "按计划自动巡检"
        return "在岗", tip
    return "已停", st or "—"


def _log_duty_run_about_to_start(
    *,
    role: ProactiveRole,
    trigger_reason: str,
    trigger_source: str = "",
    scheduled: bool = False,
    busy_now: bool = False,
    extra: str = "",
) -> None:
    """中文可读：下次值班真正开跑前打清触发原因 / 谁在跑 / 当前状态。"""
    code = str(getattr(role, "agent_code", "") or "").strip()
    name = str(getattr(role, "role_name", "") or "").strip() or code
    schedule = ""
    try:
        from evoflow.proactive.schedule import resolve_role_cron

        schedule = resolve_role_cron(role) or ""
    except Exception:
        schedule = str(getattr(role, "heartbeat_schedule", "") or "") or str(
            getattr(role, "heartbeat_rrule", "") or ""
        )
    engine_on = _engine_pref_enabled_for_log()
    badge, badge_tip = _role_ui_badge_zh(role, busy=busy_now, engine_on=engine_on)
    reason = str(trigger_reason or "").strip() or (
        "定时心跳到期（自动上班）" if scheduled else "未标明来源的值班触发"
    )
    source = str(trigger_source or "").strip()
    parts = [
        f"【值班触发】原因={reason}",
        f"谁在跑={name}({code})" if code else f"谁在跑={name}",
        f"界面状态={badge}（{badge_tip}）",
        f"全局自动上班={'开' if engine_on else '关'}",
        f"排班={schedule or '未设置'}",
        f"上次上班={getattr(role, 'last_heartbeat_at', None) or '—'}",
        f"下次排班={getattr(role, 'next_heartbeat_at', None) or '—'}",
    ]
    if source:
        parts.insert(1, f"来源={source}")
    if extra:
        parts.append(str(extra).strip())
    logger.info(" | ".join(parts))


_CONNECT_RETRY_SECONDS = max(
    30,
    int(os.getenv("EVOFLOW_PROACTIVE_CONNECT_RETRY_SECONDS", "90") or "90"),
)

_RRULE_INTERVAL_CACHE: dict[str, int] = {}
_LANGGRAPH_CLIENT_CACHE: Any | None = None


def _get_langgraph_client():
    """Module-level langgraph_sdk client cache to avoid connection pool fragmentation."""
    global _LANGGRAPH_CLIENT_CACHE
    if _LANGGRAPH_CLIENT_CACHE is None:
        from langgraph_sdk import get_client

        langgraph_url = os.getenv(
            "EVOFLOW_LANGGRAPH_URL",
            "http://127.0.0.1:8070/api/langgraph",
        ).strip()
        _LANGGRAPH_CLIENT_CACHE = get_client(url=langgraph_url)
    return _LANGGRAPH_CLIENT_CACHE


async def _close_langgraph_client():
    """Close the module-level langgraph client on shutdown."""
    global _LANGGRAPH_CLIENT_CACHE
    if _LANGGRAPH_CLIENT_CACHE is not None:
        try:
            await _LANGGRAPH_CLIENT_CACHE.aclose()
        except Exception:
            pass
        _LANGGRAPH_CLIENT_CACHE = None


from evoflow.proactive.schedule import (
    compute_backoff_duty_iso,
    compute_next_duty_iso,
    resolve_next_duty_display,
)


def _should_skip_xiaomi_idle_heartbeat(role: ProactiveRole) -> bool:
    """Scheduled 小V only: skip LLM patrol when there is no board work."""
    try:
        from evoflow.agents.xiaomi.duty import should_skip_xiaomi_idle_patrol
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
    except Exception:
        return False
    if not is_xiaomi_agent(role.agent_code):
        return False
    try:
        skip, snap = should_skip_xiaomi_idle_patrol()
    except Exception:
        logger.debug(
            "proactive.runner: xiaomi idle skip check failed code=%s",
            role.agent_code,
            exc_info=True,
        )
        return False
    if skip:
        logger.info(
            "proactive.runner: skip role=%s (xiaomi idle patrol: open_tasks=%s pending=%s busy=%s)",
            role.agent_code,
            snap.get("open_task_count"),
            snap.get("pending_approvals"),
            snap.get("busy_count"),
        )
    return skip


def _looks_like_internal_dispatch_note(text: str) -> bool:
    """True for machine/test tags that must not become board「要做什么」."""
    t = str(text or "").strip()
    if not t:
        return True
    low = t.lower()
    if low.startswith("organic handoff"):
        return True
    if low.startswith("dispatch:"):
        return True
    if "woken_by=" in low or "task_id=" in low:
        return True
    # ASCII-only short tags from scripts / wake plumbing
    if not any("\u4e00" <= ch <= "\u9fff" for ch in t) and len(t) < 220:
        if all(ch.isalnum() or ch in " _.:;|-/,()[]@#" for ch in t):
            return True
    return False


def _dispatch_title(goal: str, *, max_len: int = 80) -> str:
    line = str(goal or "").strip().splitlines()[0].strip() if goal else ""
    if not line:
        return "用户派发任务"
    if len(line) <= max_len:
        return line
    return line[: max_len - 1] + "…"


def _dispatch_skip_title_dedupe(
    source: str,
    description: str,
    goal: str,
    fresh_round: bool,
) -> bool:
    """Eval / forced-fresh dispatches must not collapse into each other."""
    if fresh_round:
        return True
    src = str(source or "").strip().lower()
    if src in {"eval", "live_eval", "eval_live"}:
        return True
    blob = f"{description}\n{goal}".lower()
    if "live_wake eval" in blob or "eval_live" in blob:
        return True
    return False


def validate_dispatch_org_relationship(
    *,
    from_agent: str,
    target_code: str,
    roster: list[Any],
) -> str | None:
    """Validate that an employee may dispatch a task to ``target_code``.

    Dispatch is **more permissive** than handlers handoff:

    - ``user`` / empty ``from_agent`` → always allowed (human dispatch).
    - ``xiaomi`` (系统前台/小V) → same privilege as human: may wake any active
      employee regardless of reporting line or workspace org (she acts for the user).
    - Same role → not allowed (can't dispatch to self).
    - Target must exist in the roster and be active.
    - Same org (workspace) required (ordinary employees only).
    - Allowed edges (loose dispatch rules):
        * direct superior → subordinate (逐级/直属下级),
        * **peer → peer** (同一上级的直属平级，即时唤醒协作),
        * any ancestor → descendant (沿汇报链向下的逐级派发).
    - Forbidden: subordinate → superior, cross-org / cross-department.
    """
    from evoflow.proactive.org import (
        filter_roster_same_org,
        find_role,
        is_descendant_in_tree,
        reports_to_code,
        role_org_key,
    )

    from_code = str(from_agent or "").strip()
    tgt_code = str(target_code or "").strip()
    if not tgt_code:
        return "缺少目标岗位 agent_code"

    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
    except Exception:
        def is_xiaomi_agent(_name: str | None) -> bool:  # type: ignore[misc]
            return False

    # Human + 小V may not target themselves; other self-dispatch still blocked.
    if from_code and from_code.lower() != "user" and from_code == tgt_code:
        return "不能给自己派发任务"
    if is_xiaomi_agent(from_code) and is_xiaomi_agent(tgt_code):
        return "不能给自己派发任务"

    target = find_role(roster, tgt_code)
    if target is None:
        if from_code.lower() in {"", "user"} or is_xiaomi_agent(from_code):
            return None
        return f"目标岗位 `{tgt_code}` 不在岗位花名册中"
    if str(target.status or "").strip().lower() == "archived":
        return f"目标岗位 `{tgt_code}` 已归档，无法派发"

    # Human user or 小V（系统前台）：代表用户全局派活，不受组织上下级/平级限制。
    if from_code.lower() in {"", "user"} or is_xiaomi_agent(from_code):
        return None

    dispatcher = find_role(roster, from_code)
    if dispatcher is None:
        return f"派发人 `{from_code}` 不在花名册，无法校验组织关系；请用用户身份派发"

    # Same org (workspace) boundary.
    a_key = role_org_key(dispatcher)
    t_key = role_org_key(target)
    if a_key and t_key and a_key != t_key:
        return (
            f"禁止跨组织派发：`{tgt_code}` 与 `{from_code}` 不在同一工作区组织"
            "（不同 workspace_path）。请先经共同上级或调整 workspace。"
        )
    if a_key and not t_key:
        return f"目标岗位 `{tgt_code}` 未绑定工作区，无法确认同组织，禁止派发"

    peers = filter_roster_same_org(dispatcher, roster)
    peer_codes = {str(r.agent_code or "").strip() for r in peers}
    if tgt_code not in peer_codes:
        return f"禁止跨组织派发：`{tgt_code}` 不在 `{from_code}` 的同组织名册内"

    # Allowed 1: direct reports (直属下级).
    direct_reports = {
        str(r.agent_code or "").strip()
        for r in peers
        if reports_to_code(r) == from_code
        and str(r.agent_code or "").strip() != from_code
    }
    if tgt_code in direct_reports:
        return None

    # Allowed 2: peer → peer (同一上级的直属平级). 平级协作即时唤醒。
    dispatcher_mgr = reports_to_code(dispatcher)
    target_mgr = reports_to_code(target)
    if (
        dispatcher_mgr
        and dispatcher_mgr == target_mgr
        and dispatcher_mgr != tgt_code
        and dispatcher_mgr != from_code
    ):
        return None

    # Allowed 3: ancestor → descendant along reporting chain (逐级向下派发).
    if is_descendant_in_tree(dispatcher, target, peers):
        return None

    # Forbidden: subordinate → superior / cross-level.
    if is_descendant_in_tree(target, dispatcher, peers):
        return (
            f"下级不能向上级派发：`{tgt_code}` 是 `{from_code}` 的上级（或更上层）。"
            "请由上级派发，或经平级协作通道（同一上级下的平级岗位）。"
        )
    return (
        f"无权向 `{tgt_code}` 派发：`{from_code}` 与目标既非直属上下级、"
        "也非同组织平级。跨岗请经共同上级逐级派发，或由用户派发。"
    )


def resolve_dispatch_round_id(
    *,
    round_id: str = "",
    related_task: dict[str, Any] | None = None,
    resume_round: bool = False,
    fresh_round: bool = False,
) -> tuple[str, bool]:
    """Pick duty ``round_id`` for a dispatch.

    Returns ``(round_id, resumed)``. Explicit ``round_id`` always wins.
    With ``resume_round`` (and not ``fresh_round``), reuse the related Task's
    ``round_id`` / ``source_ref`` so work trail continues in the same bucket.
    """
    explicit = str(round_id or "").strip()
    if explicit:
        return explicit, True
    if fresh_round:
        return f"dispatch:{utc_now_iso_z()}", False
    if resume_round and related_task:
        rid = str(
            related_task.get("round_id") or related_task.get("source_ref") or ""
        ).strip()
        if rid:
            return rid, True
    return f"dispatch:{utc_now_iso_z()}", False


class ProactiveRunner:
    """Background scheduler that wakes up proactive roles on their heartbeat."""

    def __init__(
        self,
        *,
        tick_interval: int = DEFAULT_TICK_INTERVAL,
        engine: ProactiveEngine | None = None,
        gate: DecisionGate | None = None,
    ) -> None:
        self._tick_interval = max(10, int(tick_interval or DEFAULT_TICK_INTERVAL))
        self._engine = engine or ProactiveEngine()
        self._gate = gate or DecisionGate()
        self._semaphore = asyncio.Semaphore(_MAX_CONCURRENT_THINK)
        self._loop_task: asyncio.Task | None = None
        self._running = False
        self._last_tick_info: dict[str, Any] = {}
        # Event loop that owns heartbeat + fire-and-forget wake (Gateway process).
        # Used by sync callers (platform/CLI) via run_coroutine_threadsafe so
        # asyncio.create_task is not orphaned when a nested asyncio.run() exits.
        self._asyncio_loop: asyncio.AbstractEventLoop | None = None
        # Per-role in-flight set (guarded): reject second patrol immediately (no wait).
        self._inflight_roles: set[str] = set()
        self._inflight_started_at: dict[str, str] = {}
        self._inflight_tasks: dict[str, asyncio.Task] = {}
        self._inflight_guard = asyncio.Lock()
        self._bg_tasks: set[asyncio.Task] = set()
        # Pending wakes when role is busy (L1: queue, do not mint duplicate Tasks).
        self._wake_queue: dict[str, list[dict[str, Any]]] = {}
        self._wake_queue_guard = asyncio.Lock()
        # Deduplicate Feishu budget alerts: "{agent_code}:{YYYY-MM-DD}"
        self._budget_notified_days: set[str] = set()
        # O4.2 ops alerts: "{kind}:{scope}:{YYYY-MM-DD}"
        self._ops_alert_notified: set[str] = set()
        # O1.3 recovery: initiative_ids currently being recovered (prevents double
        # approval creation when two ticks / manual triggers race on the same
        # orphaned pending_approval initiative).
        self._recovering_initiatives: set[str] = set()
        self._recovering_guard = asyncio.Lock()
        # Board zombie reclaim throttle (collab tasks, not initiatives).
        self._last_board_reclaim_mono: float = 0.0
        self._langgraph_warmup_done = False

    def _connect_retry_at_iso(self) -> str:
        from datetime import UTC, datetime, timedelta

        return (
            datetime.now(UTC) + timedelta(seconds=_CONNECT_RETRY_SECONDS)
        ).isoformat().replace("+00:00", "Z")

    async def _ensure_langgraph_ready_for_patrol(self) -> bool:
        if self._langgraph_warmup_done:
            return True
        self._langgraph_warmup_done = True
        try:
            from evoflow.langgraph_connectivity import wait_langgraph_ready

            ready = await wait_langgraph_ready()
        except Exception:
            logger.debug("proactive.runner: langgraph ready probe failed", exc_info=True)
            ready = False
        if not ready:
            logger.warning(
                "proactive.runner: LangGraph HTTP not ready; patrols will retry after connect failures"
            )
        return ready

    def _gateway_dispatch_overloaded(self) -> tuple[bool, float]:
        """Skip new patrol dispatch when Gateway event loop is severely lagging."""
        try:
            from app.gateway.hang_diagnostics import (
                get_event_loop_lag_seconds,
                is_listen_socket_broken,
            )
        except Exception:
            return False, 0.0
        if is_listen_socket_broken():
            return True, get_event_loop_lag_seconds()
        threshold = float(os.getenv("EVOFLOW_PROACTIVE_SKIP_LAG_SECONDS", "8") or "8")
        lag = get_event_loop_lag_seconds()
        return lag >= threshold, lag

    async def _reschedule_after_langgraph_connect_failure(self, role: ProactiveRole) -> str:
        retry_at = self._connect_retry_at_iso()
        try:
            ProactiveRepository.update_heartbeat(
                role.agent_code,
                last_heartbeat_at=utc_now_iso_z(),
                next_heartbeat_at=retry_at,
            )
        except Exception:
            logger.debug(
                "proactive.runner: connect retry reschedule failed role=%s",
                role.agent_code,
                exc_info=True,
            )
        return retry_at

    # ── Lifecycle ──────────────────────────────────────────────

    def start(self) -> None:
        """Start the background loop (idempotent)."""
        if self._running:
            try:
                if self._asyncio_loop is None:
                    self._asyncio_loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
            return
        if not self._engine_pref_enabled():
            logger.info("proactive.runner: skipped start (proactive.engine_enabled=false)")
            return
        if os.getenv("EVOFLOW_PROACTIVE_SCHEDULER", "1").strip().lower() in ("0", "false", "no", "off", "disabled"):
            logger.info("proactive.runner: disabled by EVOFLOW_PROACTIVE_SCHEDULER env")
            return
        self._running = True
        try:
            loop = asyncio.get_running_loop()
            self._asyncio_loop = loop
            self._loop_task = loop.create_task(self._run_loop())
            logger.info("proactive.runner: started (tick=%ds)", self._tick_interval)
        except RuntimeError:
            logger.warning("proactive.runner: no running loop; deferring start")

    def enable(self) -> None:
        """Enable via API, bypassing env-var check (for runtime control)."""
        self._persist_engine_enabled(True)
        if self._running:
            try:
                if self._asyncio_loop is None:
                    self._asyncio_loop = asyncio.get_running_loop()
            except RuntimeError:
                pass
            return
        self._running = True
        try:
            loop = asyncio.get_running_loop()
            self._asyncio_loop = loop
            self._loop_task = loop.create_task(self._run_loop())
            logger.info("proactive.runner: enabled via API")
        except RuntimeError:
            logger.warning("proactive.runner: no running loop; cannot enable")

    async def stop(self) -> None:
        """Stop the background loop and cancel in-flight auto patrols.

        Closing global auto-duty must not leave scheduled/in-flight work running:
        cancel every busy role, then stop the tick loop. Preference is persisted so
        Gateway restart does not silently re-enable auto patrol.
        """
        self._persist_engine_enabled(False)
        codes = [row.get("agent_code") or "" for row in self.busy_roles()]
        logger.info(
            "【关闭自动上班】将取消在途值班 %d 人：%s",
            len([c for c in codes if c]),
            "、".join(str(c) for c in codes if c) or "（当前无登记在途）",
        )
        for code in codes:
            c = str(code or "").strip()
            if not c:
                continue
            try:
                await self.cancel_role(c)
            except Exception:
                logger.exception(
                    "proactive.runner: cancel_role during stop failed role=%s",
                    c,
                )
        self._running = False
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        logger.info("proactive.runner: stopped (cancelled_inflight=%d)", len([c for c in codes if c]))

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def last_tick_info(self) -> dict[str, Any]:
        return self._last_tick_info

    @staticmethod
    def _engine_pref_enabled() -> bool:
        """User preference for global auto duty. Missing key = enabled (compat)."""
        try:
            from evoflow.persistence.config_repositories import get_app_setting

            raw = get_app_setting("proactive.engine_enabled")
        except Exception:
            return True
        if raw is None:
            return True
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() not in ("0", "false", "no", "off", "disabled")

    @staticmethod
    def _persist_engine_enabled(enabled: bool) -> None:
        try:
            from evoflow.persistence.config_repositories import set_app_setting

            set_app_setting("proactive.engine_enabled", "true" if enabled else "false")
        except Exception:
            logger.warning(
                "proactive.runner: failed to persist engine_enabled=%s",
                enabled,
                exc_info=True,
            )

    async def _notify_budget_exceeded(
        self,
        role: ProactiveRole,
        *,
        spent_today: float,
        budget_usd: float,
    ) -> None:
        """Push Feishu (and desktop) once per role per calendar day when budget trips."""
        from datetime import datetime

        day = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")
        key = f"{role.agent_code}:{day}"
        if key in self._budget_notified_days:
            return
        self._budget_notified_days.add(key)
        # Bound set size
        if len(self._budget_notified_days) > 200:
            self._budget_notified_days = {k for k in self._budget_notified_days if k.endswith(day)}

        text = (
            f"**预算熔断** · {role.role_name}（`{role.agent_code}`）\n\n"
            f"今日成本已达预算上限 **${budget_usd:.4f}**（已花费 ${spent_today:.4f}），"
            f"本角色巡检已暂停至次日。可在员工设置中提高日预算后重试。"
        )
        try:
            from evoflow.collab.ws_notify import broadcast_to_channels

            await broadcast_to_channels(
                ["proactive"],
                "proactive_budget_exceeded",
                {
                    "agent_code": role.agent_code,
                    "role_name": role.role_name,
                    "spent_today_usd": round(spent_today, 6),
                    "budget_usd": budget_usd,
                },
            )
        except Exception:
            logger.debug("proactive.budget.desktop notify failed", exc_info=True)

        try:
            from app.channels.service import get_channel_service
            from app.gateway.channel_result_push import resolve_push_target

            service = get_channel_service()
            if service is None:
                return
            resolved = resolve_push_target(
                push_enabled=True,
                push_channel="feishu",
                push_target_id="",
            )
            if not resolved:
                return
            _, target_id = resolved
            await service.feishu_push_markdown(target_id, text, receive_id_type="chat_id")
            logger.info(
                "proactive.budget.feishu notified role=%s spent=%.4f budget=%.4f",
                role.agent_code,
                spent_today,
                budget_usd,
            )
        except Exception:
            logger.debug("proactive.budget.feishu notify failed", exc_info=True)

    async def _check_anomaly_alerts(self) -> list[str]:
        """O4.2: emit Feishu/desktop alerts for unhealthy proactive signals."""
        from evoflow.proactive.repositories import ProactiveCostRepository, ProactiveMemoryRepository

        fired: list[str] = []
        from datetime import datetime

        day = datetime.now(BEIJING_TZ).strftime("%Y-%m-%d")

        async def _once(kind: str, scope: str, title: str, body: str) -> None:
            key = f"{kind}:{scope}:{day}"
            if key in self._ops_alert_notified:
                return
            self._ops_alert_notified.add(key)
            if len(self._ops_alert_notified) > 300:
                self._ops_alert_notified = {k for k in self._ops_alert_notified if k.endswith(day)}
            await self._push_ops_alert(title=title, body=body)
            fired.append(kind)

        # Global zombies
        try:
            stale = ProactiveRepository.list_stale_executing(max_age_minutes=45, limit=200)
            zombie_n = len(stale)
        except Exception:
            zombie_n = 0
        if zombie_n > 5:
            await _once(
                "zombie",
                "global",
                "智能体员工 · 执行卡住告警",
                f"当前有 **{zombie_n}** 条执行超过 45 分钟仍未结束，请检查「健康」页。",
            )

        try:
            roles = ProactiveRepository.list_roles(status="active")
        except Exception:
            roles = []

        for role in roles:
            code = role.agent_code
            # Approval timeout rate (sample of recent approvals)
            try:
                all_appr = ProactiveRepository.list_approvals(limit=200)
                role_appr = [a for a in all_appr if a.role_agent_code == code]
            except Exception:
                role_appr = []
            if len(role_appr) >= 5:
                timeout_n = sum(1 for a in role_appr if a.status.value == "timeout")
                rate = 100.0 * timeout_n / len(role_appr)
                if rate > 80:
                    await _once(
                        "timeout_rate",
                        code,
                        "智能体员工 · 审批超时率过高",
                        f"角色 **{role.role_name}**（`{code}`）近期审批超时率 **{rate:.0f}%**，"
                        "审批通道可能异常，请尽快处理待审批。",
                    )

            # Budget approaching 80%
            budget = float(getattr(role.config, "daily_budget_usd", 0) or 0)
            if budget > 0:
                try:
                    spent = ProactiveCostRepository.get_daily_cost(code)
                except Exception:
                    spent = 0.0
                if spent >= budget * 0.8 and spent < budget:
                    await _once(
                        "budget_warn",
                        code,
                        "智能体员工 · 成本接近预算",
                        f"角色 **{role.role_name}**（`{code}`）今日成本 "
                        f"${spent:.4f} / 预算 ${budget:.4f}（≥80%）。",
                    )

            # High fail rate among recent initiatives
            try:
                inits = ProactiveRepository.list_initiatives(role_agent_code=code, limit=30)
            except Exception:
                inits = []
            decided = [
                i
                for i in inits
                if i.status.value in ("completed", "failed", "timeout_rejected", "rejected")
            ]
            if len(decided) >= 5:
                fail_n = sum(1 for i in decided if i.status.value in ("failed", "timeout_rejected"))
                fail_rate = 100.0 * fail_n / len(decided)
                if fail_rate > 30:
                    await _once(
                        "fail_rate",
                        code,
                        "智能体员工 · 巡检失败率偏高",
                        f"角色 **{role.role_name}**（`{code}`）近期失败/超时占比 **{fail_rate:.0f}%**，请关注工作汇报与工作日志。",
                    )

            # consecutive noop — only track for dashboard; optional soft notify at 5+
            try:
                mem = ProactiveMemoryRepository.get(code)
                noop_n = int((mem.extra or {}).get("consecutive_noop_count", 0) or 0)
            except Exception:
                noop_n = 0
            if noop_n >= 5:
                await _once(
                    "idle",
                    code,
                    "智能体员工 · 疑似空转",
                    f"角色 **{role.role_name}**（`{code}`）已连续 **{noop_n}** 轮无实质产出，"
                    "系统已自动降频；可派发任务或检查职责配置。",
                )

        return fired

    def _run_kpi_probes_after_patrol(self, role: ProactiveRole) -> None:
        """O6.1: run allowlisted KPI probes and persist on memory.extra."""
        from evoflow.proactive.kpi_checker import run_role_kpi_probes, persist_kpi_probe_results

        if not (role.config.kpis or []):
            return
        assessments = run_role_kpi_probes(role)
        persist_kpi_probe_results(role, assessments)
        failed = sum(1 for a in assessments if a.status == "fail")
        if failed:
            logger.info(
                "proactive.runner: role=%s kpi probes fail=%d/%d",
                role.agent_code,
                failed,
                len(assessments),
            )

    async def _maybe_push_weekly_reports(self) -> int:
        """O6.2: push weekly duty digest once per 7 days per active role."""
        from datetime import datetime, timedelta, timezone

        from evoflow.proactive.kpi_checker import (
            build_performance_report,
            format_weekly_report_markdown,
        )
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        pushed = 0
        now = datetime.now(timezone.utc)
        roles = ProactiveRepository.list_roles(status="active")
        for role in roles:
            code = role.agent_code
            try:
                mem = ProactiveMemoryRepository.get(code)
            except Exception:
                continue
            extra = dict(mem.extra or {})
            last_raw = str(extra.get("last_weekly_report_at") or "")
            last_dt = None
            if last_raw:
                try:
                    s = last_raw[:-1] + "+00:00" if last_raw.endswith("Z") else last_raw
                    last_dt = datetime.fromisoformat(s)
                    if last_dt.tzinfo is None:
                        last_dt = last_dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    last_dt = None
            if last_dt and (now - last_dt.astimezone(timezone.utc)) < timedelta(days=7):
                continue
            # Dedup within process for the same UTC day
            day_key = f"weekly:{code}:{now.strftime('%Y-%m-%d')}"
            if day_key in self._ops_alert_notified:
                continue
            try:
                report = build_performance_report(role, days=7, run_probes=False)
                body = format_weekly_report_markdown(report)
                await self._push_ops_alert(
                    title=f"智能体员工 · {role.role_name} 履职周报",
                    body=body,
                )
                extra["last_weekly_report_at"] = utc_now_iso_z()
                mem.extra = extra
                ProactiveMemoryRepository.save(mem)
                self._ops_alert_notified.add(day_key)
                pushed += 1
            except Exception:
                logger.debug(
                    "proactive.weekly_report failed role=%s", code, exc_info=True
                )
        return pushed

    async def _push_ops_alert(self, *, title: str, body: str) -> None:
        """Fan-out ops alert to desktop SSE + Feishu markdown."""
        text = f"**{title}**\n\n{body}"
        try:
            from evoflow.collab.ws_notify import broadcast_to_channels

            await broadcast_to_channels(
                ["proactive"],
                "proactive_ops_alert",
                {"title": title, "body": body},
            )
        except Exception:
            logger.debug("proactive.ops.desktop notify failed", exc_info=True)
        try:
            from app.channels.service import get_channel_service
            from app.gateway.channel_result_push import resolve_push_target

            service = get_channel_service()
            if service is None:
                return
            resolved = resolve_push_target(
                push_enabled=True,
                push_channel="feishu",
                push_target_id="",
            )
            if not resolved:
                return
            _, target_id = resolved
            await service.feishu_push_markdown(target_id, text, receive_id_type="chat_id")
        except Exception:
            logger.debug("proactive.ops.feishu notify failed", exc_info=True)

    # ── Main loop ─────────────────────────────────────────────

    async def _run_loop(self) -> None:
        """Main tick loop."""
        while self._running:
            try:
                await self._tick()
            except Exception:
                logger.error("proactive.runner: tick error", exc_info=True)
            await asyncio.sleep(self._tick_interval)

    async def _tick(self) -> None:
        """Single heartbeat check cycle."""
        # 检测系统时间跳变（休眠/唤醒后重建 httpx 连接池）
        try:
            from evoflow.platform.asyncio_windows import check_clock_jump
            check_clock_jump()
        except Exception:
            pass

        await self._ensure_langgraph_ready_for_patrol()

        now = utc_now_iso_z()

        # 1. Find due roles
        due_roles = ProactiveRepository.list_due_roles(now)

        overloaded, lag = self._gateway_dispatch_overloaded()
        if overloaded:
            logger.warning(
                "【值班跳过】原因=网关过载暂缓派发 | 事件循环滞后=%.1fs | 本拍到期人数=%d",
                lag,
                len(due_roles),
            )
            due_roles = []

        # 2. Dispatch think cycles (skip in-flight / DND). Do not await — a long
        # patrol must not block the tick loop or busy-guards for other roles.
        queued: list[ProactiveRole] = []
        idle_skipped: list[str] = []
        for role in due_roles:
            code = str(role.agent_code or "").strip()
            if not code:
                logger.warning("proactive.runner: skip due role with empty agent_code")
                continue
            if self.is_role_busy(code):
                badge, tip = _role_ui_badge_zh(role, busy=True)
                logger.info(
                    "【值班跳过】原因=定时到期但该员工忙碌中 | 谁=%s(%s) | 界面状态=%s（%s） | 下次排班=%s",
                    str(role.role_name or "").strip() or code,
                    code,
                    badge,
                    tip,
                    role.next_heartbeat_at or "—",
                )
                continue
            if _should_skip_xiaomi_idle_heartbeat(role):
                idle_skipped.append(code)
                next_duty = compute_next_duty_iso(role)
                logger.info(
                    "【值班跳过】原因=小V看板空闲(定时心跳不拉会话) | 谁=%s(%s) | 改约下次=%s",
                    str(role.role_name or "").strip() or code,
                    code,
                    next_duty or "—",
                )
                try:
                    ProactiveRepository.update_heartbeat(
                        role.agent_code,
                        last_heartbeat_at=role.last_heartbeat_at or now,
                        next_heartbeat_at=next_duty,
                    )
                except Exception:
                    logger.debug(
                        "proactive.runner: reschedule idle xiaomi failed code=%s",
                        role.agent_code,
                        exc_info=True,
                    )
                continue
            queued.append(role)
            task = asyncio.create_task(
                self._process_role(
                    role,
                    scheduled=True,
                    trigger_reason=(
                        f"定时心跳到期（next_heartbeat_at={role.next_heartbeat_at or '已到期'}）"
                    ),
                    trigger_source="scheduler.tick",
                )
            )
            task.add_done_callback(self._on_scheduled_role_done)

        if queued:
            logger.info(
                "【值班调度】本拍派发 %d 人自动上班：%s",
                len(queued),
                "、".join(
                    f"{(r.role_name or r.agent_code)}({r.agent_code})" for r in queued
                ),
            )

        # 3. Recover initiatives stuck in pending_approval without an Approval row
        recovered = await self._recover_orphaned_pending_approvals()

        # 4. Reap stale executing initiatives (TTL cleanup for zombie records)
        stale_executing = await self._recover_stale_executing()

        # 4b. Board task zombies: executing@100 / stale awaiting_close (at most hourly)
        board_reclaimed = await self._maybe_reclaim_board_zombies()

        # 5. Check approval timeouts
        timed_out = await self._gate.check_timeouts()

        # 6. O4.2: anomaly alerts (Feishu + desktop)
        # (git HEAD poll removed — do not auto-steer every role into code review)
        alerts = await self._check_anomaly_alerts()

        # 7. O6.2: weekly duty digest (once / 7d / role)
        weekly_n = await self._maybe_push_weekly_reports()

        self._last_tick_info = {
            "timestamp": now,
            "due_roles": len(due_roles),
            "recovered_approvals": recovered,
            "stale_executing_reaped": stale_executing,
            "board_zombies_reclaimed": board_reclaimed,
            "approval_timeouts": len(timed_out),
            "git_events_emitted": 0,
            "anomaly_alerts": alerts,
            "weekly_reports": weekly_n,
            "idle_skipped": len(idle_skipped),
        }

        if (
            due_roles
            or timed_out
            or recovered
            or stale_executing
            or idle_skipped
            or alerts
            or weekly_n
        ):
            logger.info(
                "proactive.runner.tick: due=%d idle_skipped=%d recovered=%d stale_exec=%d "
                "timeouts=%d alerts=%d weekly=%d",
                len(due_roles),
                len(idle_skipped),
                recovered,
                stale_executing,
                len(timed_out),
                len(alerts),
                weekly_n,
            )

    def _on_scheduled_role_done(self, task: asyncio.Task) -> None:
        try:
            result = task.result()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            try:
                from evoflow.langgraph_connectivity import is_langgraph_connect_error

                if is_langgraph_connect_error(exc):
                    logger.error(
                        "proactive.runner: scheduled patrol failed (LangGraph HTTP unreachable; "
                        "Gateway may be overloaded or listen socket broken — check /health)",
                    )
                    return
            except Exception:
                pass
            logger.error("proactive.runner: scheduled patrol crashed", exc_info=True)
            return
        if isinstance(result, dict) and result.get("busy"):
            logger.info(
                "proactive.runner: role %s busy on schedule tick",
                result.get("agent_code") or "?",
            )

    async def _try_begin_role(self, agent_code: str) -> bool:
        """Mark role as in-flight. Returns False if already running."""
        code = str(agent_code or "").strip()
        if not code:
            return False
        async with self._inflight_guard:
            if code in self._inflight_roles:
                return False
            self._inflight_roles.add(code)
            self._inflight_started_at[code] = utc_now_iso_z()
            task = asyncio.current_task()
            if task is not None:
                self._inflight_tasks[code] = task
            return True

    async def _reserve_role(self, agent_code: str) -> bool:
        """Reserve busy slot without binding the current (HTTP) task.

        Used by fire-and-forget dispatch so concurrent callers see ``busy``
        immediately, before the background think cycle starts.
        """
        code = str(agent_code or "").strip()
        if not code:
            return False
        async with self._inflight_guard:
            if code in self._inflight_roles:
                return False
            self._inflight_roles.add(code)
            self._inflight_started_at[code] = utc_now_iso_z()
            return True

    async def _bind_role_task(self, agent_code: str) -> None:
        """Attach the current asyncio task to an already-reserved role lock."""
        code = str(agent_code or "").strip()
        if not code:
            return
        task = asyncio.current_task()
        if task is None:
            return
        async with self._inflight_guard:
            if code in self._inflight_roles:
                self._inflight_tasks[code] = task

    async def _end_role(
        self,
        agent_code: str,
        *,
        drain: bool = True,
        only_if_task: asyncio.Task | None = None,
    ) -> None:
        """Release busy slot.

        When ``only_if_task`` is set, only release if that task still owns the
        slot — prevents a timed-out cancelled round from clearing a newer
        interrupt/dispatch reservation.

        After a successful release, finalize sticky ``run_status=running/pending``
        on this employee's conversations **before** draining the wake queue.
        Evidence: no inflight asyncio task remains for this role. Must run
        before drain so a newly woken dispatch's ``prepare`` is not wiped.
        """
        code = str(agent_code or "").strip()
        released = False
        async with self._inflight_guard:
            if only_if_task is not None:
                owner = self._inflight_tasks.get(code)
                if owner is not None and owner is not only_if_task:
                    logger.info(
                        "proactive.runner: skip _end_role role=%s (slot owned by newer task)",
                        code,
                    )
                    return
            self._inflight_roles.discard(code)
            self._inflight_started_at.pop(code, None)
            self._inflight_tasks.pop(code, None)
            released = True
        if released:
            try:
                await self._finalize_role_running_sessions(
                    code,
                    reason="proactive_role_ended",
                )
            except Exception:
                logger.debug(
                    "proactive.runner: sticky session finalize after end_role failed role=%s",
                    code,
                    exc_info=True,
                )
        if not drain:
            return
        try:
            await self._drain_wake_queue(code)
        except Exception:
            logger.debug("proactive.runner: drain wake queue failed role=%s", code, exc_info=True)

    def is_role_busy(self, agent_code: str) -> bool:
        return str(agent_code or "").strip() in self._inflight_roles

    def busy_roles(self) -> list[dict[str, str]]:
        return [
            {
                "agent_code": code,
                "started_at": self._inflight_started_at.get(code) or "",
            }
            for code in sorted(self._inflight_roles)
        ]

    def _busy_payload(self, agent_code: str) -> dict[str, Any]:
        code = str(agent_code or "").strip()
        role = ProactiveRepository.get_role(code)
        name = (role.role_name if role else "") or code
        return {
            "ok": False,
            "busy": True,
            "dispatched": False,
            "agent_code": code,
            "role_name": name,
            "error": (
                f"「{name}」正在执行任务（巡检/派发中）。请稍候用**同一 task_id / related_task_id** 再派，"
                "打开该员工工作轨迹查看进度；**禁止**改文案新建同题任务。"
            ),
            "hint": "retry_same_task_id",
            "started_at": self._inflight_started_at.get(code) or "",
            "watch_path": f"/proactive/{code}?live=1",
        }

    async def _enqueue_pending_wake(
        self,
        agent_code: str,
        goal: str,
        *,
        description: str = "",
        priority: str = "normal",
        source: str = "manual",
        from_agent: str = "",
        related_task_id: str = "",
        round_id: str = "",
        resume_round: bool = False,
        fresh_round: bool = False,
        skip_done_guard: bool = False,
    ) -> dict[str, Any]:
        """Queue a wake for after the current in-flight round (no new Task minted here)."""
        code = str(agent_code or "").strip()
        related = str(related_task_id or "").strip()
        entry = {
            "agent_code": code,
            "goal": str(goal or "").strip(),
            "description": str(description or "").strip(),
            "priority": str(priority or "normal").strip() or "normal",
            "source": str(source or "manual").strip() or "manual",
            "from_agent": str(from_agent or "").strip(),
            "related_task_id": related,
            "round_id": str(round_id or "").strip(),
            "resume_round": bool(resume_round),
            "fresh_round": bool(fresh_round),
            "skip_done_guard": bool(skip_done_guard),
        }
        async with self._wake_queue_guard:
            q = self._wake_queue.setdefault(code, [])
            # Dedupe: same related_task_id replaces older pending wake for that task.
            if related:
                q[:] = [e for e in q if str(e.get("related_task_id") or "").strip() != related]
            else:
                # Same goal text — keep one.
                g = entry["goal"]
                q[:] = [
                    e
                    for e in q
                    if str(e.get("related_task_id") or "").strip()
                    or str(e.get("goal") or "").strip() != g
                ]
            q.append(entry)
            depth = len(q)
        role = ProactiveRepository.get_role(code)
        name = (role.role_name if role else "") or code
        logger.info(
            "proactive.wake_queue.enqueue role=%s related=%s depth=%s goal=%s",
            code,
            related or "-",
            depth,
            entry["goal"][:60],
        )
        return {
            "ok": True,
            "dispatched": False,
            "busy": True,
            "queued_behind_busy": True,
            "queue_depth": depth,
            "agent_code": code,
            "role_name": name,
            "related_task_id": related or None,
            "goal": entry["goal"],
            "message": (
                f"「{name}」正在执行中；本次叫醒已排队，"
                "当前轮结束后将自动续跑同一任务（未新建 Task）。"
            ),
            "hint": "queued_behind_busy",
            "started_at": self._inflight_started_at.get(code) or "",
            "watch_path": f"/proactive/{code}?live=1",
        }

    async def _drain_wake_queue(self, agent_code: str) -> None:
        code = str(agent_code or "").strip()
        if not code:
            return
        async with self._wake_queue_guard:
            q = self._wake_queue.get(code) or []
            if not q:
                return
            entry = q.pop(0)
            if not q:
                self._wake_queue.pop(code, None)
            else:
                self._wake_queue[code] = q
        logger.info(
            "proactive.wake_queue.drain role=%s related=%s goal=%s",
            code,
            entry.get("related_task_id") or "-",
            str(entry.get("goal") or "")[:60],
        )
        try:
            await self.dispatch_task_fire_and_forget(
                str(entry.get("agent_code") or code),
                str(entry.get("goal") or ""),
                description=str(entry.get("description") or ""),
                priority=str(entry.get("priority") or "normal"),
                source=str(entry.get("source") or "manual"),
                from_agent=str(entry.get("from_agent") or ""),
                related_task_id=str(entry.get("related_task_id") or ""),
                round_id=str(entry.get("round_id") or ""),
                resume_round=bool(entry.get("resume_round")),
                fresh_round=bool(entry.get("fresh_round")),
                skip_done_guard=bool(entry.get("skip_done_guard")),
            )
        except Exception:
            logger.exception("proactive.wake_queue.drain failed role=%s", code)

    async def _cancel_langgraph_for_role(self, agent_code: str) -> int:
        """Best-effort cancel of pending/running LangGraph runs on employee sessions."""
        code = str(agent_code or "").strip()
        if not code:
            return 0
        try:
            from evoflow.persistence import session_repositories as sess_repo
            from evoflow.proactive.chat_session import (
                list_employee_conversation_sessions,
                proactive_session_key,
            )

            keys: list[str] = []
            legacy = proactive_session_key(code)
            if legacy:
                keys.append(legacy)
            for row in list_employee_conversation_sessions(code, limit=30):
                sk = str(row.get("session_key") or "").strip()
                if sk and sk not in keys:
                    keys.append(sk)

            client = _get_langgraph_client()
            cancelled = 0
            _lg_op_timeout = 3.0
            for sk in keys:
                row = (sess_repo.load_session_map().get(sk) or {}) if sk else {}
                tid = str(row.get("threadId") or row.get("thread_id") or "").strip()
                if not tid:
                    continue
                try:
                    runs = await asyncio.wait_for(
                        client.runs.list(thread_id=tid, limit=20),
                        timeout=_lg_op_timeout,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "proactive.runner: langgraph list timed out thread=%s role=%s",
                        tid,
                        code,
                    )
                    continue
                except Exception:
                    logger.debug(
                        "proactive.runner: langgraph list failed thread=%s role=%s",
                        tid,
                        code,
                        exc_info=True,
                    )
                    continue
                for run in runs or []:
                    run_id = str(run.get("run_id") or run.get("id") or "").strip()
                    status = str(run.get("status") or "").strip().lower()
                    if not run_id or status not in ("pending", "running"):
                        continue
                    try:
                        await asyncio.wait_for(
                            client.runs.cancel(thread_id=tid, run_id=run_id),
                            timeout=_lg_op_timeout,
                        )
                        cancelled += 1
                        logger.info(
                            "proactive.runner: cancelled langgraph run=%s thread=%s role=%s session=%s",
                            run_id,
                            tid,
                            code,
                            sk,
                        )
                    except Exception:
                        logger.debug(
                            "proactive.runner: langgraph cancel failed run=%s role=%s",
                            run_id,
                            code,
                            exc_info=True,
                        )
            return cancelled
        except Exception:
            logger.warning(
                "proactive.runner: langgraph cancel for role=%s failed",
                code,
                exc_info=True,
            )
            return 0

    async def _finalize_role_running_sessions(
        self,
        agent_code: str,
        *,
        reason: str = "proactive_cancelled",
    ) -> int:
        """Clear sticky ``run_status=running/pending`` on employee conversations."""
        code = str(agent_code or "").strip()
        if not code:
            return 0
        n = 0
        try:
            from evoflow.proactive.chat_session import (
                finalize_proactive_chat_session,
                list_employee_conversation_sessions,
            )

            for row in list_employee_conversation_sessions(code, limit=40):
                st = str(row.get("run_status") or "").strip().lower()
                if st not in {"running", "pending"}:
                    continue
                sk = str(row.get("session_key") or "").strip()
                if not sk:
                    continue
                tid = str(row.get("thread_id") or "").strip() or None
                finalize_proactive_chat_session(
                    session_key=sk,
                    thread_id=tid,
                    reason=reason,
                )
                n += 1
        except Exception:
            logger.debug(
                "proactive.runner: finalize running sessions failed role=%s",
                code,
                exc_info=True,
            )
        return n

    async def cancel_role(self, agent_code: str, *, drain_queue: bool = True) -> dict[str, Any]:
        """Stop an in-flight patrol (if any): cancel LangGraph run + asyncio task.

        ``drain_queue=False`` is used by interrupt wakes so we do not immediately
        start a previously queued goal before the forced new dispatch.
        """
        code = str(agent_code or "").strip()
        was_busy = self.is_role_busy(code)
        lg_cancelled = await self._cancel_langgraph_for_role(code)

        task: asyncio.Task | None = None
        async with self._inflight_guard:
            task = self._inflight_tasks.get(code)

        task_cancelled = False
        if task is not None and not task.done():
            task.cancel()
            try:
                # Bound wait: a stuck chat/duty await must not block interrupt dispatch.
                await asyncio.wait_for(task, timeout=8.0)
            except asyncio.CancelledError:
                task_cancelled = True
            except asyncio.TimeoutError:
                task_cancelled = True
                logger.warning(
                    "proactive.runner: cancel_role timed out waiting for inflight task role=%s",
                    code,
                )
            except Exception:
                logger.debug(
                    "proactive.runner: inflight task ended with error after cancel role=%s",
                    code,
                    exc_info=True,
                )

        finalized = await self._finalize_role_running_sessions(
            code,
            reason="proactive_interrupted" if not drain_queue else "proactive_cancelled",
        )

        # Ensure busy clears even if task already finished / was not tracked
        await self._end_role(code, drain=drain_queue)
        logger.info(
            "proactive.runner: cancel_role=%s was_busy=%s task_cancelled=%s lg_runs=%d "
            "finalized_sessions=%d drain=%s",
            code,
            was_busy,
            task_cancelled,
            lg_cancelled,
            finalized,
            drain_queue,
        )
        return {
            "ok": True,
            "agent_code": code,
            "was_busy": was_busy,
            "task_cancelled": task_cancelled,
            "langgraph_runs_cancelled": lg_cancelled,
            "finalized_sessions": finalized,
        }

    # ── Per-role processing ───────────────────────────────────

    async def _process_role(
        self,
        role: ProactiveRole,
        *,
        extra_env_context: str = "",
        prepend_env_context: str = "",
        round_id: str | None = None,
        round_id_prefix: str = "round",
        role_lock_held: bool = False,
        scheduled: bool = False,
        trigger_reason: str = "",
        trigger_source: str = "",
    ) -> dict[str, Any]:
        """Think + act for a single role (within concurrency semaphore).

        ``extra_env_context`` is prepended to the gathered environment signals so
        callers (e.g. :meth:`dispatch_task`) can inject a user-specified goal that
        the employee must prioritise over its self-selected patrol scope.

        ``prepend_env_context`` keeps the normal patrol context and adds a soft
        focus block ahead of it (e.g.「立即开工」optional matter).

        ``round_id`` pins the duty / transcript stamp (human dispatch). When
        omitted, ``round_id_prefix`` only documents the default ``round:`` stamp
        created inside the engine (kept for call-site clarity).

        When ``role_lock_held`` is True the caller already reserved the busy slot
        (fire-and-forget dispatch); we only bind the current task.

        ``scheduled=True`` is the heartbeat tick: 小V with an empty board skips
        the LLM round (no duty session). Manual heartbeat / dispatch keep running.
        """
        code = str(role.agent_code or "").strip()
        if role_lock_held:
            await self._bind_role_task(code)
        elif not await self._try_begin_role(code):
            badge, tip = _role_ui_badge_zh(role, busy=True)
            logger.info(
                "【值班跳过】原因=该员工已有在途任务 | 谁=%s(%s) | 界面状态=%s（%s）",
                str(role.role_name or "").strip() or code,
                code,
                badge,
                tip,
            )
            return self._busy_payload(code)

        _log_duty_run_about_to_start(
            role=role,
            trigger_reason=trigger_reason
            or ("定时心跳到期（自动上班）" if scheduled else "手动/派发触发上班"),
            trigger_source=trigger_source
            or ("scheduler" if scheduled else "manual"),
            scheduled=scheduled,
            busy_now=True,
            extra=f"round_id={round_id or '（本轮将新建）'}",
        )

        # ── Budget circuit-breaker (O2.3) ──────────────────────
        # If the role's daily cost exceeds its budget, apply budget_exceed_policy.
        daily_budget = float(getattr(role.config, "daily_budget_usd", 0.0) or 0.0)
        budget_policy = str(getattr(role.config, "budget_exceed_policy", None) or "skip_patrol").strip().lower()
        if budget_policy not in ("skip_patrol", "pause_role", "notify_only"):
            budget_policy = "skip_patrol"
        if daily_budget > 0:
            try:
                from evoflow.proactive.repositories import ProactiveCostRepository

                spent_today = ProactiveCostRepository.get_daily_cost(code)
                if spent_today >= daily_budget:
                    logger.warning(
                        "proactive.runner: role=%s daily budget exceeded: $%.4f >= $%.4f policy=%s",
                        code,
                        spent_today,
                        daily_budget,
                        budget_policy,
                    )
                    await self._notify_budget_exceeded(
                        role,
                        spent_today=spent_today,
                        budget_usd=daily_budget,
                    )
                    if budget_policy == "notify_only":
                        # Allow the run but keep the notification above.
                        pass
                    else:
                        if budget_policy == "pause_role":
                            try:
                                role.status = "paused"
                                ProactiveRepository.save_role(role)
                            except Exception:
                                logger.debug(
                                    "proactive.runner: pause_role after budget failed",
                                    exc_info=True,
                                )
                        await self._end_role(code, only_if_task=asyncio.current_task())
                        return {
                            "ok": False,
                            "skipped": True,
                            "agent_code": code,
                            "reason": "daily_budget_exceeded",
                            "spent_today_usd": round(spent_today, 6),
                            "budget_usd": daily_budget,
                            "budget_exceed_policy": budget_policy,
                            "status": role.status,
                        }
            except Exception:
                logger.debug("proactive.runner: budget check failed (non-fatal)", exc_info=True)

        # Scheduled 小V: empty board → do not open a duty session / LLM round.
        if (
            scheduled
            and not str(extra_env_context or "").strip()
            and not str(prepend_env_context or "").strip()
            and _should_skip_xiaomi_idle_heartbeat(role)
        ):
            now = utc_now_iso_z()
            next_hb = compute_next_duty_iso(role)
            try:
                ProactiveRepository.update_heartbeat(
                    role.agent_code,
                    last_heartbeat_at=now,
                    next_heartbeat_at=next_hb,
                )
            except Exception:
                logger.debug(
                    "proactive.runner: reschedule idle xiaomi after begin failed code=%s",
                    code,
                    exc_info=True,
                )
            await self._end_role(code, only_if_task=asyncio.current_task())
            return {
                "ok": True,
                "skipped": True,
                "agent_code": code,
                "reason": "xiaomi_idle_board",
                "next_heartbeat_at": next_hb,
            }

        try:
            async with self._semaphore:
                now = utc_now_iso_z()

                # Push next heartbeat out so the scheduler won't re-queue mid-run
                next_hb = compute_next_duty_iso(role)
                ProactiveRepository.update_heartbeat(
                    role.agent_code,
                    last_heartbeat_at=now,
                    next_heartbeat_at=next_hb,
                )

                env_context = await self._gather_environment_context(role)
                if extra_env_context:
                    # User-pinned goal owns the briefing; system duty brief already
                    # has workspace / org / skills — don't re-dump them here.
                    env_context = extra_env_context.rstrip()
                elif prepend_env_context:
                    # Soft focus (立即开工事项): keep patrol context, lead with note.
                    env_context = (
                        f"{prepend_env_context.rstrip()}\n\n{env_context}"
                        if env_context
                        else prepend_env_context.rstrip()
                    )

                pinned_round = str(round_id or "").strip() or None
                if pinned_round is None and str(round_id_prefix or "").strip() not in ("", "round"):
                    # Legacy callers passed prefix only; keep stamp family aligned.
                    pinned_round = f"{str(round_id_prefix).strip()}:{utc_now_iso_z()}"

                result = await self._engine.think(
                    role,
                    environment_context=env_context,
                    round_id=pinned_round,
                )

                for task_id in getattr(result, "created_task_ids", None) or []:
                    if task_id:
                        await self._act_on_work_item(role, task_id)

                for init_id in result.created_initiative_ids:
                    await self._act_on_initiative(role, init_id)

                # O3.3: consecutive no-op backoff – adjust next heartbeat
                # dynamically if the last few rounds found nothing to do.
                next_hb = self._apply_noop_backoff(role, result, next_hb)
                if next_hb:
                    ProactiveRepository.update_heartbeat(
                        role.agent_code,
                        last_heartbeat_at=utc_now_iso_z(),
                        next_heartbeat_at=next_hb,
                    )

                # O6.1: allowlisted KPI probes after patrol (non-fatal)
                try:
                    self._run_kpi_probes_after_patrol(role)
                except Exception:
                    logger.debug(
                        "proactive.runner: kpi probes failed role=%s",
                        code,
                        exc_info=True,
                    )

                report = self._build_heartbeat_report(
                    role,
                    result,
                    last_heartbeat_at=now,
                    next_heartbeat_at=next_hb,
                )
                # Budget check BEFORE Feishu notification — if the role gets
                # paused due to budget overrun, the user should not receive a
                # "一切正常" card (Bug M5).
                budget_paused = False
                try:
                    await self._enforce_per_run_budget(role, result)
                    if role.status == "paused":
                        budget_paused = True
                except Exception:
                    logger.debug(
                        "proactive.runner: per_run budget check failed role=%s",
                        code,
                        exc_info=True,
                    )
                if budget_paused:
                    logger.info(
                        "proactive.runner: role=%s paused after per_run budget check; "
                        "skipping feishu card",
                        code,
                    )
                else:
                    try:
                        from evoflow.proactive.feishu_notify import push_wrap_digest_card

                        # Enrich for notify: created task ids from think result
                        created = list(getattr(result, "created_task_ids", None) or [])
                        if created:
                            report = {**report, "created_task_ids": created}
                        summary = str(
                            report.get("outcome")
                            or report.get("goal")
                            or report.get("reflection")
                            or ""
                        ).strip()
                        if not summary:
                            # Fall back to named work items so Feishu is not counters-only
                            for it in report.get("items") or []:
                                if not isinstance(it, dict) or it.get("is_journal"):
                                    continue
                                title = str(it.get("title") or "").strip()
                                preview = str(it.get("preview") or it.get("outcome") or "").strip()
                                st = str(it.get("status") or "").strip()
                                if title or preview:
                                    bit = title or preview[:80]
                                    summary = f"{bit}" + (f"（{st}）" if st else "")
                                    if preview and title and preview != title:
                                        summary = f"{title}：{preview[:200]}"
                                    break
                        if summary:
                            report = {**report, "think_summary": summary}
                        await push_wrap_digest_card(role, report)
                    except Exception:
                        logger.debug(
                            "proactive.runner: feishu wrap card skipped role=%s",
                            code,
                            exc_info=True,
                        )
                return report
        except asyncio.CancelledError:
            logger.info("proactive.runner: role=%s patrol cancelled (pause/stop)", code)
            raise
        except Exception as exc:
            try:
                from evoflow.langgraph_connectivity import is_langgraph_connect_error

                if is_langgraph_connect_error(exc):
                    retry_at = await self._reschedule_after_langgraph_connect_failure(role)
                    logger.warning(
                        "proactive.runner: role=%s patrol deferred (langgraph connect failed); retry_at=%s",
                        code,
                        retry_at,
                    )
                    return {
                        "ok": False,
                        "skipped": True,
                        "agent_code": code,
                        "reason": "langgraph_unreachable",
                        "next_heartbeat_at": retry_at,
                    }
            except Exception:
                pass
            raise
        finally:
            await self._end_role(code, only_if_task=asyncio.current_task())

    async def _enforce_per_run_budget(self, role: ProactiveRole, result: Any) -> None:
        """After a round finishes: if cost > per_run_budget, notify / optionally pause."""
        per_run = float(getattr(role.config, "per_run_budget_usd", 0.0) or 0.0)
        if per_run <= 0:
            return
        rid = str(getattr(result, "round_id", "") or "").strip()
        if not rid:
            return
        from evoflow.proactive.repositories import ProactiveCostRepository

        info = ProactiveCostRepository.get_round_cost(role.agent_code, rid)
        spent = float(info.get("cost_usd") or 0.0)
        if spent < per_run:
            return
        policy = str(getattr(role.config, "budget_exceed_policy", None) or "skip_patrol").strip().lower()
        if policy not in ("skip_patrol", "pause_role", "notify_only"):
            policy = "skip_patrol"
        logger.warning(
            "proactive.runner: role=%s per_run budget exceeded: $%.4f >= $%.4f policy=%s round=%s",
            role.agent_code,
            spent,
            per_run,
            policy,
            rid,
        )
        await self._notify_budget_exceeded(
            role,
            spent_today=spent,
            budget_usd=per_run,
        )
        if policy == "pause_role":
            try:
                role.status = "paused"
                ProactiveRepository.save_role(role)
            except Exception:
                logger.debug("proactive.runner: pause after per_run budget failed", exc_info=True)

    def _build_heartbeat_report(
        self,
        role: ProactiveRole,
        result: Any,
        *,
        last_heartbeat_at: str,
        next_heartbeat_at: str | None,
    ) -> dict[str, Any]:
        """UI-facing summary after a think (+ optional act) cycle."""
        round_id = str(getattr(result, "round_id", "") or "")
        ids = list(getattr(result, "round_initiative_ids", None) or [])
        if not ids:
            ids = list(getattr(result, "created_initiative_ids", None) or [])

        items_raw: list[Any] = []
        if round_id:
            items_raw = [
                i
                for i in ProactiveRepository.list_initiatives(
                    role_agent_code=role.agent_code,
                    limit=40,
                )
                if str(i.round_id or "") == round_id
            ]
        elif ids:
            for iid in ids:
                init = ProactiveRepository.get_initiative(iid)
                if init:
                    items_raw.append(init)

        # Also count collab tasks created in this round (source_ref == round_id)
        # These are the actual execution units when initiatives are delegated
        collab_tasks_raw: list[dict[str, Any]] = []
        if round_id:
            try:
                from evoflow.admin.tasks import list_tasks
                task_result = list_tasks(assignee=role.agent_code, include_subtasks=False)
                all_tasks = task_result.get("tasks") or []
                collab_tasks_raw = [
                    t for t in all_tasks
                    if str(t.get("source_ref") or "") == round_id
                    or str(t.get("round_id") or "") == round_id
                ]
            except Exception:
                logger.debug("heartbeat: collab task fetch failed (non-fatal)", exc_info=True)

        def _is_journal(init: Any) -> bool:
            plan = init.action_plan if isinstance(getattr(init, "action_plan", None), dict) else {}
            return str(plan.get("kind") or "") == "round_log"

        # Map collab task status to initiative-like status for counting
        def _task_status_category(task: dict[str, Any]) -> str:
            st = str(task.get("status") or "").strip().lower()
            if st in ("completed", "done"):
                return "completed"
            if st in ("failed",):
                return "failed"
            if st in ("in_progress", "executing", "running"):
                return "executing"
            if st in ("pending", "awaiting"):
                return "pending_approval"
            return "other"

        # Combined counts: initiatives + collab tasks
        task_counts = {"completed": 0, "failed": 0, "executing": 0, "pending_approval": 0, "other": 0}
        for t in collab_tasks_raw:
            cat = _task_status_category(t)
            task_counts[cat] += 1

        counts = {
            "total": len(items_raw) + len(collab_tasks_raw),
            "journal": 0,
            "pending_approval": 0 + task_counts["pending_approval"],
            "completed": 0 + task_counts["completed"],
            "failed": 0 + task_counts["failed"],
            "executing": 0 + task_counts["executing"],
            "proposed": 0,
            "other": 0 + task_counts["other"],
        }
        items: list[dict[str, Any]] = []
        for init in items_raw:
            st = init.status.value if hasattr(init.status, "value") else str(init.status or "")
            journal = _is_journal(init)
            if journal:
                counts["journal"] += 1
            elif st == InitiativeStatus.PENDING_APPROVAL.value:
                counts["pending_approval"] += 1
            elif st == InitiativeStatus.COMPLETED.value:
                counts["completed"] += 1
            elif st == InitiativeStatus.FAILED.value:
                counts["failed"] += 1
            elif st == InitiativeStatus.EXECUTING.value:
                counts["executing"] += 1
            elif st == InitiativeStatus.PROPOSED.value:
                counts["proposed"] += 1
            else:
                counts["other"] += 1
            items.append(
                {
                    "id": init.id,
                    "title": init.title,
                    "status": st,
                    "action_type": (
                        init.action_type.value
                        if hasattr(init.action_type, "value")
                        else str(init.action_type or "")
                    ),
                    "risk_level": (
                        init.risk_level.value
                        if hasattr(init.risk_level, "value")
                        else str(init.risk_level or "")
                    ),
                    "is_journal": journal,
                    "preview": str(init.description or init.outcome or "")[:160],
                    "goal": str(getattr(init, "goal", "") or ""),
                    "outcome": str(getattr(init, "outcome", "") or ""),
                    "action_plan": (
                        init.action_plan if isinstance(getattr(init, "action_plan", None), dict) else {}
                    ),
                }
            )

        # Add collab tasks to items list for display
        for t in collab_tasks_raw:
            cat = _task_status_category(t)
            items.append(
                {
                    "id": t.get("task_id") or t.get("id") or "",
                    "title": t.get("name") or t.get("title") or "",
                    "status": cat,
                    "action_type": t.get("action_type") or "task_delegation",
                    "risk_level": t.get("risk_level") or "",
                    "is_journal": False,
                    "preview": str(t.get("description") or "")[:160],
                    "goal": str(t.get("goal") or t.get("parent_task_id") or ""),
                    "outcome": str(t.get("summary") or ""),
                    "action_plan": {},
                    "source": "collab_task",
                }
            )

        journals = [i for i in items_raw if _is_journal(i)]
        wrap = next(
            (
                j
                for j in journals
                if str((j.action_plan or {}).get("phase") or "") == "wrap_up"
            ),
            journals[0] if journals else None,
        )
        incomplete = False
        journal_status = ""
        reflection = str(getattr(result, "reflection", "") or "")
        if wrap is not None:
            plan = wrap.action_plan if isinstance(wrap.action_plan, dict) else {}
            incomplete = bool(plan.get("incomplete")) or (
                wrap.status == InitiativeStatus.FAILED
                and str(plan.get("phase") or "") == "wrap_up"
            )
            journal_status = (
                wrap.status.value if hasattr(wrap.status, "value") else str(wrap.status or "")
            )
            if not reflection:
                reflection = str(plan.get("reflection") or "")
            if not getattr(result, "goal", None) and wrap.goal:
                # Prefer journal narrative for UI scorecard
                pass

        if incomplete:
            verdict = "incomplete"
            verdict_label = "未完整收尾"
        elif wrap is not None and journal_status == InitiativeStatus.COMPLETED.value:
            verdict = "completed"
            verdict_label = "已结束"
        elif wrap is not None and journal_status == InitiativeStatus.EXECUTING.value:
            verdict = "in_progress"
            verdict_label = "进行中"
        elif not items_raw:
            verdict = "empty"
            verdict_label = "无记录"
        else:
            verdict = "partial"
            verdict_label = "有记录"

        scorecard = {
            "verdict": verdict,
            "verdict_label": verdict_label,
            "incomplete": incomplete,
            "journal_status": journal_status,
            "goal": str(
                (wrap.goal if wrap is not None else "")
                or getattr(result, "goal", "")
                or ""
            ),
            "outcome": str(
                (wrap.outcome if wrap is not None else "")
                or getattr(result, "outcome", "")
                or ""
            ),
            "reflection": reflection,
            "actionable": max(0, counts["total"] - counts["journal"]),
            "pending_approval": counts["pending_approval"],
            "failed": counts["failed"],
            "completed": counts["completed"],
        }

        return {
            "ok": True,
            "agent_code": role.agent_code,
            "role_name": role.role_name,
            "workspace_path": str(role.config.workspace_path or ""),
            "think_mode": str(role.config.think_mode or "agent_loop"),
            "round_id": round_id,
            "goal": scorecard["goal"] or str(getattr(result, "goal", "") or ""),
            "outcome": scorecard["outcome"] or str(getattr(result, "outcome", "") or ""),
            "reflection": reflection or str(getattr(result, "reflection", "") or ""),
            "last_heartbeat_at": last_heartbeat_at,
            "next_heartbeat_at": next_heartbeat_at,
            "counts": counts,
            "items": items,
            "scorecard": scorecard,
        }

    async def _act_on_work_item(
        self,
        role: ProactiveRole,
        task_id: str,
    ) -> None:
        """Auto-execute a newly created role work-item Task (handoff approval is separate)."""
        from evoflow.proactive.work_items import (
            load_work_item_task,
            set_work_item_status,
        )

        tid = str(task_id or "").strip()
        task = load_work_item_task(tid)
        if not task:
            return
        status = str(task.get("status") or "").strip().lower()
        if status not in {"pending", "idle", "req_confirm", "waiting_user"}:
            return

        # Handoff model: human approval gates *next* agent after completed+handlers,
        # not the start of this work item. User dispatch / wake / child tasks run now.
        try:
            set_work_item_status(tid, "executing", progress=5)
            result = await self._engine.execute_work_item(tid)
            logger.info(
                "proactive.runner: auto-executed work_item=%s result=%s",
                tid,
                (result or "")[:200],
            )
        except Exception:
            logger.error(
                "proactive.runner: auto-execution failed work_item=%s",
                tid,
                exc_info=True,
            )
            set_work_item_status(tid, "failed")

    async def _act_on_initiative(
        self,
        role: ProactiveRole,
        initiative_id: str,
    ) -> None:
        """Decide and act on a single initiative the engine just persisted."""
        target = ProactiveRepository.get_initiative(initiative_id)
        if not target:
            return
        if target.status != InitiativeStatus.PROPOSED:
            return

        # Check if it needs approval
        if needs_approval(target.risk_level, role.config.autonomy_level):
            await self._gate.request_approval(role, target)
            return

        # Auto-execute
        target.status = InitiativeStatus.APPROVED
        target.approved_by = "auto"
        target.approved_at = utc_now_iso_z()
        ProactiveRepository.save_initiative(target)

        try:
            target.status = InitiativeStatus.EXECUTING
            ProactiveRepository.save_initiative(target)

            result = await self._engine.execute_initiative(target)
            logger.info(
                "proactive.runner: auto-executed initiative=%s result=%s",
                target.id,
                (result or "")[:200],
            )
        except Exception:
            logger.error(
                "proactive.runner: auto-execution failed initiative=%s",
                target.id,
                exc_info=True,
            )
            ProactiveRepository.update_initiative_status(
                target.id,
                InitiativeStatus.FAILED,
            )

    async def _recover_stale_executing(self, *, max_age_minutes: int = 45) -> int:
        """Reap initiatives stuck in 'executing' longer than ``max_age_minutes``.

        Without this, a ``check_in`` journal that never received a matching
        ``wrap_up`` stays EXECUTING forever, polluting the work log fed to
        subsequent think cycles and triggering a feedback loop (the AI keeps
        proposing "cleanup" initiatives that also get stuck).  We mark such
        zombies as FAILED with a clear explanation so they leave the open-items
        list and stop misleading the agent.
        """
        stale = ProactiveRepository.list_stale_executing(max_age_minutes=max_age_minutes)
        reaped = 0
        for init in stale:
            try:
                ProactiveRepository.update_initiative_status(
                    init.id,
                    InitiativeStatus.FAILED,
                    execution_result=(
                        f"执行超时（>{max_age_minutes}min 未收尾），已被 runner 自动标记为失败。"
                    ),
                )
                reaped += 1
                logger.info(
                    "proactive.runner: reaped stale executing initiative=%s "
                    "role=%s age>=%dmin",
                    init.id,
                    init.role_agent_code,
                    max_age_minutes,
                )
            except Exception:
                logger.error(
                    "proactive.runner: reap stale executing failed initiative=%s",
                    init.id,
                    exc_info=True,
                )
        if reaped:
            logger.info(
                "proactive.runner: reaped %d stale executing initiatives (>%dmin)",
                reaped,
                max_age_minutes,
            )
        return reaped

    async def _maybe_reclaim_board_zombies(self, *, min_interval_s: float = 3600.0) -> int:
        """Close stuck collab board zombies at most once per hour per runner."""
        import time

        now_m = time.monotonic()
        if (now_m - float(self._last_board_reclaim_mono or 0.0)) < float(min_interval_s):
            return 0
        self._last_board_reclaim_mono = now_m
        try:
            from evoflow.collab.task_reclaim import reclaim_zombie_tasks

            out = await asyncio.to_thread(
                lambda: reclaim_zombie_tasks(
                    dry_run=False,
                    stuck_days=3,
                    awaiting_close_days=3,
                )
            )
            n = len(out.get("reclaimed") or [])
            if n:
                logger.info(
                    "proactive.runner: reclaimed %d board zombie task(s)",
                    n,
                )
            return n
        except Exception:
            logger.debug(
                "proactive.runner: board zombie reclaim failed",
                exc_info=True,
            )
            return 0

    async def _recover_orphaned_pending_approvals(self) -> int:
        """Create Approval rows for initiatives left in pending_approval without one.

        Also reconcile initiatives still marked pending_approval whose Approval
        row was already decided (task-native approve used to skip this sync).

        Concurrency safety:
        - In-process dedup via ``_recovering_initiatives`` set prevents two
          concurrent ticks / manual triggers from racing on the same orphan
          and creating duplicate Approval rows.
        - The underlying ``request_approval`` also has its own DB-level check
          (saves approval + updates initiative atomically per call), but since
          each call generates a fresh approval id, two racing calls would both
          succeed and produce two rows — hence the per-initiative guard here.
        """
        orphans = ProactiveRepository.list_initiatives(
            status=InitiativeStatus.PENDING_APPROVAL.value,
            limit=50,
        )
        recovered = 0
        for init in orphans:
            init_id = str(init.id or "").strip()
            if not init_id:
                continue

            # Quick pre-check without lock (filter obvious non-orphans first)
            appr = ProactiveRepository.get_approval_by_initiative(init.id)
            if appr is None and str(init.id or "").startswith("task:"):
                tid = str(init.id)[5:].strip()
                if tid:
                    appr = ProactiveRepository.get_approval_by_task(tid)

            if appr is None:
                # In-process dedup: skip if another coroutine is already
                # recovering this initiative (prevents double approval creation).
                async with self._recovering_guard:
                    if init_id in self._recovering_initiatives:
                        continue
                    self._recovering_initiatives.add(init_id)

                try:
                    # Double-check after acquiring the recovery slot — another
                    # coroutine may have created the approval between our
                    # earlier read and us claiming the slot.
                    appr2 = ProactiveRepository.get_approval_by_initiative(init.id)
                    if appr2 is not None:
                        continue
                    role = ProactiveRepository.get_role(init.role_agent_code)
                    if not role:
                        continue
                    try:
                        await self._gate.request_approval(role, init)
                        recovered += 1
                    except Exception:
                        logger.error(
                            "proactive.runner: recover approval failed initiative=%s",
                            init.id,
                            exc_info=True,
                        )
                finally:
                    async with self._recovering_guard:
                        self._recovering_initiatives.discard(init_id)
                continue

            if appr.status == ApprovalStatus.PENDING:
                continue

            # Approval already decided — sync stuck mirror initiative.
            if appr.status == ApprovalStatus.APPROVED:
                init.status = InitiativeStatus.APPROVED
                init.approved_by = appr.decided_by or init.approved_by
                init.approved_at = appr.decided_at or init.approved_at
            elif appr.status == ApprovalStatus.TIMEOUT:
                init.status = InitiativeStatus.TIMEOUT_REJECTED
            else:
                init.status = InitiativeStatus.REJECTED
            init.approval_id = appr.id
            ProactiveRepository.save_initiative(init)
            recovered += 1
            logger.info(
                "proactive.runner: reconciled stuck pending_approval initiative=%s "
                "approval=%s → %s",
                init.id,
                appr.id,
                init.status.value,
            )
        return recovered

    # ── Environment context ───────────────────────────────────

    async def _gather_environment_context(self, role: ProactiveRole) -> str:
        """Dynamic external signals only.

        Workspace / domain / KPI live in the duty system brief. Recent
        initiatives already appear in the user-prompt work log — do **not**
        re-list them here (that tripled the same驳回/待办 in every patrol brief).
        Does **not** auto-inject git commits — that steered non-eng roles
        (e.g. 社媒) into code review. Roles that need git dig themselves.
        """
        _ = role
        return ""

    # ── O3.3: consecutive no-op backoff ───────────────────────

    _NOOP_KEYWORDS = ("无事", "无变化", "无新", "一致", "无异常", "健康", "无需", "一切正常")

    def _apply_noop_backoff(
        self,
        role: ProactiveRole,
        result: Any,
        next_hb: str,
    ) -> str:
        """Dynamically back off heartbeat when consecutive rounds are no-ops (O3.3).

        After 3 consecutive "nothing to do" rounds, double the interval (capped
        at 8×).  Any real work resets the counter to 0 and restores the original
        frequency.

        ``next_hb`` is the *already computed* next heartbeat; if backoff applies
        we recompute with a scaled interval.
        """
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        outcome = str(getattr(result, "outcome", "") or "")
        created_ids = list(getattr(result, "created_initiative_ids", None) or [])
        is_noop = not created_ids and any(
            kw in outcome for kw in self._NOOP_KEYWORDS
        )

        try:
            mem = ProactiveMemoryRepository.get(role.agent_code)
        except Exception:
            logger.debug("proactive.runner: memory get failed for noop backoff", exc_info=True)
            return next_hb

        extra = dict(mem.extra or {})
        count = int(extra.get("consecutive_noop_count", 0))

        if is_noop:
            count += 1
        else:
            count = 0
        extra["consecutive_noop_count"] = count

        try:
            mem.extra = extra
            ProactiveMemoryRepository.save(mem)
        except Exception:
            logger.debug("proactive.runner: memory save failed for noop backoff", exc_info=True)

        # Backoff: after 3+ consecutive no-ops, scale interval 2× / 4× / 8× (cap)
        if count >= 3 and is_noop:
            scale = min(1 << (count - 2), 8)  # count=3→2, 4→4, 5→8
            adjusted = compute_backoff_duty_iso(role, scale=scale)
            if adjusted:
                logger.info(
                    "proactive.runner: role=%s noop backoff count=%d scale=%dx -> next=%s",
                    role.agent_code,
                    count,
                    scale,
                    adjusted,
                )
                return adjusted

        return next_hb

    # ── Heartbeat scheduling ──────────────────────────────────

    def _compute_next_heartbeat(self, role: ProactiveRole) -> str:
        """Compute the next auto-duty time (rrule + work-hours clamp)."""
        return compute_next_duty_iso(role)

    # ── Manual trigger ────────────────────────────────────────

    async def trigger_heartbeat(
        self, agent_code: str, *, focus: str = ""
    ) -> dict[str, Any]:
        """Manually trigger a heartbeat for a specific role.

        ``focus`` (optional): user-written matter for this round — prepended into
        the duty environment so the employee prioritises it without requiring a
        full task dispatch.
        """
        role = ProactiveRepository.get_role(agent_code)
        if not role:
            return {"ok": False, "error": f"Role '{agent_code}' not found"}
        if role.status != "active":
            return {"ok": False, "error": f"Role status is '{role.status}', not 'active'"}

        focus_s = str(focus or "").strip()
        prepend = ""
        if focus_s:
            prepend = (
                "## 用户本轮交代（优先关注）\n"
                f"**事项：** {focus_s}\n"
                "→ 优先处理该事项；其余按岗位职责正常上班并写工作汇报。"
                "不要忽略工作汇报与 tasks 状态更新。\n"
            )

        report = await self._process_role(
            role,
            prepend_env_context=prepend,
            trigger_reason=(
                f"手动立即上班{'（带本轮事项）' if focus_s else ''}"
            ),
            trigger_source="api.heartbeat",
        )
        if report.get("busy"):
            return report
        report["triggered_at"] = utc_now_iso_z()
        if focus_s:
            report["focus"] = focus_s
        return report

    # ── Task dispatch ──────────────────────────────────────────

    async def dispatch_task(
        self,
        agent_code: str,
        goal: str,
        *,
        description: str = "",
        priority: str = "normal",
        source: str = "manual",
        from_agent: str = "",
        related_task_id: str = "",
        round_id: str = "",
        resume_round: bool = False,
        fresh_round: bool = False,
        role_lock_held: bool = False,
        skip_done_guard: bool = False,
    ) -> dict[str, Any]:
        """Dispatch a user-specified task to an employee.

        Unlike :meth:`trigger_heartbeat` (self-selected patrol), the caller pins
        the *goal* this duty round must pursue. A board Task is registered with
        that goal as「要做什么」, then a duty round runs with the goal injected
        into ``environment_context``.

        ``source`` is ``chat_mention`` (main chat ``@员工``) or
        ``employee_page`` (员工名册派发按钮) for audit/UI.

        ``from_agent`` (optional agent_code) is who woke/dispatched — persisted on
        the board Task as ``raised_by`` / ``woken_by`` so Panel reads DB, not chat.

        ``related_task_id`` (optional): reuse that existing DB Task instead of
        creating a wrapper duplicate (``employees wake --task-id``).

        ``round_id`` / ``resume_round``: continue the same work-trail stamp
        instead of minting a new ``dispatch:…`` (``fresh_round`` forces new).
        """
        code = str(agent_code or "").strip()
        role = ProactiveRepository.get_role(code)
        if not role:
            return {"ok": False, "error": f"Role '{code}' not found"}
        if role.status != "active":
            return {"ok": False, "error": f"Role status is '{role.status}', not 'active'"}

        goal_s = str(goal or "").strip()
        if not goal_s:
            return {"ok": False, "error": "dispatch goal is required"}

        desc_s = str(description or "").strip()
        priority_s = str(priority or "normal").strip() or "normal"
        source_s = str(source or "manual").strip() or "manual"
        from_agent_s = str(from_agent or "").strip()
        related_tid = str(related_task_id or "").strip()
        round_id_s = str(round_id or "").strip()
        # 提起人：跨岗叫醒写真实 agent_code；真人派发仍是 user
        raised_by_s = from_agent_s or "user"

        # Short-circuit: do not spawn another wrapper Task when goal only cites
        # already-finished work (xiaomi "reviewed but timeout, retry" loop).
        if not skip_done_guard:
            try:
                from evoflow.proactive.work_items import all_referenced_tasks_done

                done, done_ids = all_referenced_tasks_done(goal_s, desc_s, related_tid)
                if done and done_ids:
                    logger.info(
                        "proactive.dispatch.skip_already_done role=%s tasks=%s",
                        code,
                        done_ids[:8],
                    )
                    return {
                        "ok": True,
                        "skipped": True,
                        "reason": "already_done",
                        "agent_code": code,
                        "role_name": role.role_name,
                        "task_ids": done_ids,
                        "message": (
                            "目标引用的 Task 均已结案，跳过重复派发："
                            + ", ".join(done_ids[:8])
                        ),
                    }
            except Exception:
                logger.debug("proactive.dispatch already_done check failed", exc_info=True)

        # Register / bind a visible 岗位工作项 (board SSOT = evoflow_collab_tasks).
        # Prefer reusing ``related_task_id`` from DB — avoid wrapper duplicates.
        # 「要做什么」必须是用户 goal，勿把内部英文 description / source 码写进看板。
        # One id for Task source_ref + chat transcript (Panel「工作轨迹」 filter).
        dispatch_task_id = ""
        related_task_row: dict[str, Any] | None = None
        try:
            from evoflow.proactive.work_items import load_work_item_task

            if related_tid:
                related_task_row = load_work_item_task(related_tid)
        except Exception:
            related_task_row = None

        dispatch_round_id, resumed_round = resolve_dispatch_round_id(
            round_id=round_id_s,
            related_task=related_task_row,
            resume_round=bool(resume_round),
            fresh_round=bool(fresh_round),
        )
        try:
            from evoflow.collab.storage import (
                get_project_storage,
                patch_collab_main_task_in_project_storage,
            )
            from evoflow.proactive.work_items import (
                create_role_work_item,
                is_work_item_done,
                load_work_item_task,
            )

            task_source = (
                "employee_page"
                if source_s in {"employee_page", "manual"}
                else "proactive_dispatch"
            )
            wake_stamp = {
                "woken_by": from_agent_s or None,
                "last_dispatch_round_id": dispatch_round_id,
                "last_dispatch_source": source_s,
                "last_dispatch_at": utc_now_iso_z(),
                "last_dispatch_goal": goal_s[:500],
                "last_dispatch_resumed": bool(resumed_round),
            }

            reused = False
            related_exists = False
            if related_tid:
                existing = related_task_row or load_work_item_task(related_tid)
                related_exists = bool(existing)
                # Upstream receipts pass skip_done_guard + related=parent: always
                # reuse the parent board row (even if completed / awaiting_close),
                # never spawn a「【下游回执】」wrapper duplicate.
                force_reuse_related = bool(skip_done_guard) and related_exists
                open_related = bool(
                    existing
                    and not is_work_item_done(
                        str(existing.get("status") or ""),
                        progress=existing.get("progress"),
                    )
                )
                if existing and (open_related or force_reuse_related):
                    patch_fields: dict[str, Any] = {
                        **wake_stamp,
                        "raised_by": raised_by_s,
                        "rationale": _dispatch_source_line(
                            source_s, from_agent=from_agent_s
                        ),
                    }
                    # Continuations keep the Task's trail stamp; new wakes stamp freshly.
                    if not resumed_round:
                        patch_fields["source_ref"] = dispatch_round_id
                        patch_fields["round_id"] = dispatch_round_id
                    if force_reuse_related and desc_s == "下游回执（系统）":
                        patch_fields["last_upstream_receipt_at"] = utc_now_iso_z()
                    patch_collab_main_task_in_project_storage(
                        get_project_storage(),
                        related_tid,
                        patch_fields,
                    )
                    dispatch_task_id = related_tid
                    reused = True
                    logger.info(
                        "proactive.dispatch.reuse_task role=%s task=%s from=%s "
                        "resumed=%s round=%s force=%s",
                        code,
                        related_tid,
                        from_agent_s or "-",
                        resumed_round,
                        dispatch_round_id,
                        force_reuse_related,
                    )
                elif skip_done_guard and related_tid and not related_exists:
                    # Receipt path but parent row gone — wake without minting a board Task.
                    reused = True
                    dispatch_task_id = ""
                    logger.info(
                        "proactive.dispatch.skip_create_missing_related role=%s related=%s",
                        code,
                        related_tid,
                    )

            if not reused:
                # Title-level dedupe: same assignee + open board row with same/near title.
                dedupe_tid = ""
                if not _dispatch_skip_title_dedupe(source_s, desc_s, goal_s, fresh_round):
                    try:
                        from evoflow.proactive.work_items import (
                            find_open_work_item_by_title,
                        )

                        dedupe_tid = (
                            find_open_work_item_by_title(
                                code,
                                _dispatch_title(goal_s),
                            )
                            or ""
                        )
                    except Exception:
                        dedupe_tid = ""
                if dedupe_tid:
                    patch_collab_main_task_in_project_storage(
                        get_project_storage(),
                        dedupe_tid,
                        {
                            **wake_stamp,
                            "raised_by": raised_by_s,
                            "rationale": _dispatch_source_line(
                                source_s, from_agent=from_agent_s
                            ),
                            "source_ref": dispatch_round_id,
                            "round_id": dispatch_round_id,
                        },
                    )
                    dispatch_task_id = dedupe_tid
                    reused = True
                    logger.info(
                        "proactive.dispatch.reuse_by_title role=%s task=%s title=%s",
                        code,
                        dedupe_tid,
                        _dispatch_title(goal_s)[:60],
                    )

            if not reused:
                board_desc = goal_s
                if desc_s and desc_s != goal_s and not _looks_like_internal_dispatch_note(desc_s):
                    board_desc = f"{goal_s}\n\n补充说明：{desc_s}"
                channel_source = task_source
                if source_s in {"status_check", "xiaomi_assistant"} and "进度汇报" in _dispatch_title(
                    goal_s
                ):
                    channel_source = "status_check"
                created = create_role_work_item(
                    role,
                    {
                        "title": _dispatch_title(goal_s),
                        "description": board_desc,
                        "action_type": "analysis",
                        "risk_level": "low",
                        "rationale": _dispatch_source_line(
                            source_s, from_agent=from_agent_s
                        ),
                    },
                    round_id=dispatch_round_id,
                    goal=goal_s,
                    source=channel_source,
                    source_ref=dispatch_round_id,
                    raised_by=raised_by_s,
                    parent_task_id=related_tid if related_exists else None,
                )
                if created:
                    dispatch_task_id = str(created.get("task_id") or "")
                    if dispatch_task_id:
                        extras = {**wake_stamp}
                        if related_tid:
                            extras["related_task_id"] = related_tid
                        patch_collab_main_task_in_project_storage(
                            get_project_storage(),
                            dispatch_task_id,
                            extras,
                        )
        except Exception:
            logger.warning(
                "proactive.dispatch: failed to register work item role=%s",
                code,
                exc_info=True,
            )

        from evoflow.proactive.prompt import _DISPATCH_ENV_MARKER

        extra_env = (
            f"{_DISPATCH_ENV_MARKER}（优先执行，覆盖本轮自选战场）\n"
            f"**目标：** {goal_s}\n"
        )
        if desc_s and not _looks_like_internal_dispatch_note(desc_s):
            extra_env += f"**补充：** {desc_s}\n"
        if dispatch_task_id:
            extra_env += f"**Task：** `{dispatch_task_id}`\n"
            extra_env += f"related_task_id: {dispatch_task_id}\n"
        if related_tid and related_tid != dispatch_task_id:
            extra_env += f"**关联 Task：** `{related_tid}`\n"
            if not dispatch_task_id:
                extra_env += f"related_task_id: {related_tid}\n"
        if resumed_round:
            extra_env += (
                f"**续跑：** 沿用同一轮工作轨迹 `{dispatch_round_id}`。"
                "先查看本轮已有工具结果与未结 Task，补做卡住的步骤后结案；"
                "禁止无视轨迹从零重做已完成步骤。\n"
            )
        extra_env += (
            f"**优先级：** {priority_s} · **来源：** "
            f"{_dispatch_source_line(source_s, from_agent=from_agent_s)}\n"
            "→ 更新该 Task；需协作则 wake 同事；方案需批先 approvals request。\n"
        )

        report = await self._process_role(
            role,
            extra_env_context=extra_env,
            round_id=dispatch_round_id,
            round_id_prefix="dispatch",
            role_lock_held=role_lock_held,
            trigger_reason=(
                f"任务派发触发上班：{goal_s[:80]}"
                + (f"…（共{len(goal_s)}字）" if len(goal_s) > 80 else "")
            ),
            trigger_source=f"dispatch.{source_s}",
        )
        if report.get("busy"):
            return report

        # ── Dispatch guard (Task-only) ──────────────────────────
        # Prefer the pre-registered board Task. If create failed and the round
        # still has no work items, leave a failed Task marker (not an initiative).
        round_id = str(report.get("round_id") or "")
        if round_id and not dispatch_task_id:
            from evoflow.proactive.work_items import (
                create_role_work_item,
                list_pending_work_items_for_round,
                set_work_item_status,
            )

            round_tasks = list_pending_work_items_for_round(role, round_id)
            if not round_tasks:
                guard_result = (
                    f"用户派发了任务「{goal_s}」，但本轮未产出任何针对该目标的"
                    "工作项，已自动标记为失败。"
                )
                created = create_role_work_item(
                    role,
                    {
                        "title": f"派发任务未产出方案：{goal_s[:80]}",
                        "description": guard_result,
                        "action_type": "alert",
                        "risk_level": "medium",
                        "rationale": "dispatch guard: no work item created",
                        "action_plan": {"kind": "dispatch_guard", "reason": "no_work_item"},
                    },
                    round_id=round_id,
                    goal=goal_s,
                    outcome="AI 本轮未针对用户派发任务产出任何方案。",
                    source=(
                        "employee_page"
                        if source_s in {"employee_page", "manual"}
                        else "proactive_dispatch"
                    ),
                    source_ref=round_id,
                    raised_by="user",
                )
                guard_tid = str((created or {}).get("task_id") or "").strip()
                if guard_tid:
                    set_work_item_status(
                        guard_tid,
                        "failed",
                        result=guard_result,
                        progress=0,
                    )
                    report["dispatch_guard_task_id"] = guard_tid
                report["dispatch_guard_triggered"] = True
                logger.warning(
                    "proactive.dispatch.guard role=%s round=%s goal=%s - no work item",
                    code,
                    round_id,
                    goal_s[:80],
                )

        report["dispatched_at"] = utc_now_iso_z()
        report["dispatch_goal"] = goal_s
        report["dispatch_source"] = source_s
        report["dispatch_round_id"] = dispatch_round_id
        report["resumed_round"] = bool(resumed_round)
        if dispatch_task_id:
            report["dispatch_task_id"] = dispatch_task_id
        logger.info(
            "proactive.dispatch role=%s source=%s goal=%s task=%s round=%s resumed=%s",
            code,
            source_s,
            goal_s[:80],
            dispatch_task_id or "-",
            dispatch_round_id,
            resumed_round,
        )
        return report

    async def _dispatch_task_bg(
        self,
        code: str,
        goal_s: str,
        *,
        description: str = "",
        priority: str = "normal",
        source: str = "manual",
        from_agent: str = "",
        related_task_id: str = "",
        round_id: str = "",
        resume_round: bool = False,
        fresh_round: bool = False,
        role_lock_held: bool = False,
        skip_done_guard: bool = False,
    ) -> None:
        """Background wrapper for :meth:`dispatch_task` -- swallows exceptions so
        the fire-and-forget caller never sees a dangling task error."""
        # When the caller reserved the busy slot, ``_process_role`` releases it in
        # ``finally``. Early returns (skip / validation) never enter think — release here.
        # ``_end_role`` is idempotent, so a double-release on exception is safe.
        need_release = role_lock_held
        try:
            report = await self.dispatch_task(
                code,
                goal_s,
                description=description,
                priority=priority,
                source=source,
                from_agent=from_agent,
                related_task_id=related_task_id,
                round_id=round_id,
                resume_round=resume_round,
                fresh_round=fresh_round,
                role_lock_held=role_lock_held,
                skip_done_guard=skip_done_guard,
            )
            if isinstance(report, dict) and report.get("dispatched_at"):
                need_release = False
        except Exception as exc:
            logger.exception(
                "proactive.dispatch background task failed role=%s goal=%s",
                code,
                goal_s[:80],
            )
            # Safety net: if think raised before soft-fail path, still close the
            # board Task so it does not hang forever at executing.
            fail_tid = str(related_task_id or "").strip()
            if fail_tid:
                try:
                    from evoflow.proactive.work_items import set_work_item_status

                    set_work_item_status(
                        fail_tid,
                        "failed",
                        result=f"员工执行异常：{exc}",
                        progress=0,
                    )
                except Exception:
                    logger.debug(
                        "proactive.dispatch: mark related task failed skipped task=%s",
                        fail_tid,
                        exc_info=True,
                    )
        finally:
            if need_release:
                try:
                    await self._end_role(code, only_if_task=asyncio.current_task())
                except Exception:
                    logger.debug(
                        "proactive.dispatch: release reserved lock failed role=%s",
                        code,
                        exc_info=True,
                    )

    async def dispatch_task_fire_and_forget(
        self,
        agent_code: str,
        goal: str,
        *,
        description: str = "",
        priority: str = "normal",
        source: str = "manual",
        from_agent: str = "",
        related_task_id: str = "",
        round_id: str = "",
        resume_round: bool = False,
        fresh_round: bool = False,
        skip_done_guard: bool = False,
        interrupt: bool = False,
    ) -> dict[str, Any]:
        """Fire-and-forget dispatch: validate synchronously, run think in background.

        Returns immediately with ``{"ok": True, "dispatched": True}``.  The actual
        ``check_in -> work -> wrap_up`` cycle runs as a background task so the
        HTTP caller (main chat ``@员工``) doesn't block for tens of seconds.

        When the role is busy:
        - default: enqueue (L1 ``queued_behind_busy``)
        - ``interrupt=True``: cancel current round, clear wake queue, then dispatch
        """
        code = str(agent_code or "").strip()
        role = ProactiveRepository.get_role(code)
        if not role:
            return {"ok": False, "error": f"Role '{code}' not found"}
        if role.status != "active":
            return {"ok": False, "error": f"Role status is '{role.status}', not 'active'"}

        goal_s = str(goal or "").strip()
        if not goal_s:
            return {"ok": False, "error": "dispatch goal is required"}

        desc_s = str(description or "").strip()
        from_agent_s = str(from_agent or "").strip()
        related_tid = str(related_task_id or "").strip()
        round_id_s = str(round_id or "").strip()
        interrupted = False

        # HIGH-001: validate that ``from_agent`` (when an employee) is allowed to
        # dispatch to the target role. user / empty / xiaomi → always allowed;
        # ordinary employee → direct superior→subordinate / peer→peer /
        # ancestor→descendant, same org.
        if from_agent_s and from_agent_s.lower() != "user":
            try:
                roster = [
                    r
                    for r in ProactiveRepository.list_roles()
                    if str(r.status or "").strip().lower() != "archived"
                ]
                org_err = validate_dispatch_org_relationship(
                    from_agent=from_agent_s,
                    target_code=code,
                    roster=roster,
                )
                if org_err:
                    logger.info(
                        "proactive.dispatch.org_deny from=%s to=%s goal=%s: %s",
                        from_agent_s,
                        code,
                        goal_s[:60],
                        org_err,
                    )
                    return {
                        "ok": False,
                        "dispatched": False,
                        "error": f"派发被拒绝：{org_err}",
                        "agent_code": code,
                        "from_agent": from_agent_s,
                        "org_denied": True,
                    }
            except Exception:
                logger.debug(
                    "proactive.dispatch.org check failed (non-fatal) from=%s to=%s",
                    from_agent_s,
                    code,
                    exc_info=True,
                )

        if not skip_done_guard:
            try:
                from evoflow.proactive.work_items import all_referenced_tasks_done

                done, done_ids = all_referenced_tasks_done(goal_s, desc_s, related_tid)
                if done and done_ids:
                    logger.info(
                        "proactive.dispatch.fire_and_forget.skip_already_done role=%s tasks=%s",
                        code,
                        done_ids[:8],
                    )
                    return {
                        "ok": True,
                        "skipped": True,
                        "dispatched": False,
                        "reason": "already_done",
                        "agent_code": code,
                        "role_name": role.role_name,
                        "task_ids": done_ids,
                        "message": (
                            "目标引用的 Task 均已结案，跳过重复派发："
                            + ", ".join(done_ids[:8])
                        ),
                    }
            except Exception:
                logger.debug(
                    "proactive.dispatch.fire_and_forget already_done check failed",
                    exc_info=True,
                )

        # Reserve busy immediately so a second @派发 gets a clear conflict.
        # When busy: queue (L1) or interrupt current round (L2) then dispatch.
        if not await self._reserve_role(code):
            if interrupt:
                cancel_info = await self.cancel_role(code, drain_queue=False)
                async with self._wake_queue_guard:
                    self._wake_queue.pop(code, None)
                interrupted = bool(cancel_info.get("was_busy") or cancel_info.get("task_cancelled"))
                if not await self._reserve_role(code):
                    # Still busy (race) — fall back to queue.
                    return await self._enqueue_pending_wake(
                        code,
                        goal_s,
                        description=desc_s,
                        priority=priority,
                        source=source,
                        from_agent=from_agent_s,
                        related_task_id=related_tid,
                        round_id=round_id_s,
                        resume_round=bool(resume_round),
                        fresh_round=bool(fresh_round),
                        skip_done_guard=bool(skip_done_guard),
                    )
                logger.info(
                    "proactive.dispatch.interrupt role=%s related=%s goal=%s cancel=%s",
                    code,
                    related_tid or "-",
                    goal_s[:60],
                    cancel_info,
                )
            else:
                return await self._enqueue_pending_wake(
                    code,
                    goal_s,
                    description=desc_s,
                    priority=priority,
                    source=source,
                    from_agent=from_agent_s,
                    related_task_id=related_tid,
                    round_id=round_id_s,
                    resume_round=bool(resume_round),
                    fresh_round=bool(fresh_round),
                    skip_done_guard=bool(skip_done_guard),
                )

        # Spawn the full dispatch (think + guard) in the background.
        task = asyncio.create_task(
            self._dispatch_task_bg(
                code,
                goal_s,
                description=desc_s,
                priority=priority,
                source=source,
                from_agent=from_agent_s,
                related_task_id=related_tid,
                round_id=round_id_s,
                resume_round=bool(resume_round),
                fresh_round=bool(fresh_round),
                role_lock_held=True,
                skip_done_guard=bool(skip_done_guard),
            )
        )
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

        related_row = None
        if related_tid:
            try:
                from evoflow.proactive.work_items import load_work_item_task

                related_row = load_work_item_task(related_tid)
            except Exception:
                related_row = None
        preview_round, resumed = resolve_dispatch_round_id(
            round_id=round_id_s,
            related_task=related_row,
            resume_round=bool(resume_round),
            fresh_round=bool(fresh_round),
        )

        logger.info(
            "proactive.dispatch.fire_and_forget role=%s source=%s from=%s related=%s "
            "round=%s resumed=%s goal=%s",
            code,
            str(source or "manual").strip(),
            from_agent_s or "-",
            related_tid or "-",
            preview_round,
            resumed,
            goal_s[:80],
        )
        # Person Kernel Phase D: peer wake bond (skip formal handoff path —
        # that already opens commitments via dispatch_confirmed_handlers).
        src_s = str(source or "manual").strip().lower()
        if (
            from_agent_s
            and from_agent_s.lower() not in {"user", "system"}
            and not (src_s == "role" and related_tid)
        ):
            try:
                from evoflow.person_kernel import on_peer_wake

                on_peer_wake(
                    from_agent=from_agent_s,
                    to_agent=code,
                    source=src_s,
                )
            except Exception:
                logger.debug(
                    "person_kernel on_peer_wake skipped from=%s to=%s",
                    from_agent_s,
                    code,
                    exc_info=True,
                )
        out = {
            "ok": True,
            "dispatched": True,
            "agent_code": code,
            "role_name": role.role_name,
            "goal": goal_s,
            "source": str(source or "manual").strip(),
            "dispatched_at": utc_now_iso_z(),
            "watch_path": f"/proactive/{code}?live=1",
            "round_id": preview_round,
            "resumed_round": bool(resumed),
            "interrupted": bool(interrupted),
        }
        if interrupted:
            out["message"] = "已中断当前轮次并立即叫醒推进。"
        if from_agent_s:
            out["from_agent"] = from_agent_s
        if related_tid:
            out["related_task_id"] = related_tid
        return out

    def schedule_dispatch_fire_and_forget(
        self,
        agent_code: str,
        goal: str,
        *,
        description: str = "",
        priority: str = "normal",
        source: str = "manual",
        from_agent: str = "",
        related_task_id: str = "",
        round_id: str = "",
        resume_round: bool = False,
        fresh_round: bool = False,
        skip_done_guard: bool = False,
        interrupt: bool = False,
    ) -> dict[str, Any]:
        """Schedule wake onto the Gateway runner loop (safe for sync/platform callers).

        ``dispatch_task_fire_and_forget`` uses ``asyncio.create_task``. If the caller
        wrapped work in a short-lived ``asyncio.run()`` (CLI / platform tool sync
        bridge), that nested loop exits immediately and cancels the wake. Prefer
        this helper so the task is owned by the long-lived proactive loop.
        """
        loop = self._asyncio_loop
        if loop is None or not loop.is_running():
            try:
                loop = asyncio.get_running_loop()
                self._asyncio_loop = loop
            except RuntimeError:
                return {
                    "ok": False,
                    "dispatched": False,
                    "error": (
                        "proactive runner has no live event loop; "
                        "wake_now cannot schedule. Start Gateway / proactive runner."
                    ),
                    "hint": "事项已关联任务；员工下次心跳仍可领取。",
                }

        coro = self.dispatch_task_fire_and_forget(
            agent_code,
            goal,
            description=description,
            priority=priority,
            source=source,
            from_agent=from_agent,
            related_task_id=related_task_id,
            round_id=round_id,
            resume_round=resume_round,
            fresh_round=fresh_round,
            skip_done_guard=skip_done_guard,
            interrupt=interrupt,
        )
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None

        if running is loop:
            # Same loop: awaitable path is preferred by callers; here return a
            # Task handle via create_task so sync-ish code can still fire.
            task = loop.create_task(coro)
            self._bg_tasks.add(task)
            task.add_done_callback(self._bg_tasks.discard)

            def _consume(t: asyncio.Task) -> None:
                try:
                    t.result()
                except Exception:
                    logger.debug("proactive.schedule_dispatch bg failed", exc_info=True)

            task.add_done_callback(_consume)
            return {
                "ok": True,
                "dispatched": True,
                "scheduled": True,
                "agent_code": str(agent_code or "").strip(),
                "goal": str(goal or "").strip(),
                "related_task_id": str(related_task_id or "").strip() or None,
            }

        fut = asyncio.run_coroutine_threadsafe(coro, loop)
        try:
            # Only wait for reserve+spawn acknowledgment, not full duty round.
            return fut.result(timeout=15)
        except Exception as exc:
            logger.warning(
                "proactive.schedule_dispatch failed role=%s: %s",
                agent_code,
                exc,
            )
            return {
                "ok": False,
                "dispatched": False,
                "error": str(exc),
                "hint": "事项已关联任务，但立刻叫醒失败；员工下次值班仍可领取。",
            }

    # ── Status ────────────────────────────────────────────────

    def status(self) -> dict[str, Any]:
        """Return runner status for API."""
        roles = ProactiveRepository.list_roles(status="active")
        pending_approvals = ProactiveRepository.list_pending_approvals()
        return {
            "running": self._running,
            "tick_interval_seconds": self._tick_interval,
            "active_roles": len(roles),
            "pending_approvals": len(pending_approvals),
            "busy_roles": self.busy_roles(),
            "last_tick": self._last_tick_info,
        }


# ── Module-level singleton ──────────────────────────────────────

_runner: ProactiveRunner | None = None


def get_proactive_runner() -> ProactiveRunner:
    global _runner
    if _runner is None:
        _runner = ProactiveRunner()
    return _runner


def start_proactive_runner() -> None:
    """Start the proactive runner on the Gateway (called from app startup)."""
    get_proactive_runner().start()
