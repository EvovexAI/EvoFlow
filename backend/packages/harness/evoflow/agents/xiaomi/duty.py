"""小V常驻值班：ensure 岗 + 催办 brief（不亲自一线工程）。"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.agents.xiaomi.identity import XIAOMI_AGENT_CODE, XIAOMI_DISPLAY_NAME_ZH, is_xiaomi_agent
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Hourly cron — same stack as automation / proactive heartbeat_schedule.
XIAOMI_HEARTBEAT_SCHEDULE = "0 * * * *"

XIAOMI_RESPONSIBILITIES = [
    "作为用户全局助手与平台常驻管家：汇总各岗未结 Task，催办卡住的交接",
    "把阻塞事项派给对口智能体员工（wake / dispatch），自己不写业务代码",
    "向用户用白话汇报：谁在忙、卡在哪、下一步找谁",
    "无未结、无人在岗、无待批则跳过本轮心跳，禁止空建单或自己下场改仓库",
]

XIAOMI_KPIS = [
    "有未结阻塞时本轮至少 wake/dispatch 一次或给出明确待用户确认项",
    "不亲自提交业务代码改动、不跑破坏性终端操作",
    "汇报含岗位名 + Task id，便于用户点进员工页",
]

XIAOMI_SOUL = (
    "你是小V：用户的全局助手与平台常驻管家。只传讯、分诊、催办；"
    "具体实现永远交给对应岗位员工，也不扮演 main（EvoFlow）。"
    "对用户用口语短句汇报，禁止 Markdown。"
)


def _migrate_legacy_main_front_desk() -> None:
    """One-shot: move old 小V duty row from ``main`` → ``xiaomi`` if needed.

    Earlier builds parked the system front desk on ``agent_code=main``.
    ``main`` is reserved for the general lead agent; 小V lives on ``xiaomi``.
    """
    from evoflow.proactive.repositories import ProactiveRepository

    code = XIAOMI_AGENT_CODE
    if ProactiveRepository.get_role(code) is not None:
        return
    legacy = ProactiveRepository.get_role("main")
    if legacy is None:
        return
    name = str(legacy.role_name or "").strip()
    # Only rebind when the main slot still looks like the old front-desk install.
    if name not in {XIAOMI_DISPLAY_NAME_ZH, "小蜜", "Xiaomi", "系统前台"} and "前台" not in name:
        soul = ""
        try:
            soul = str((legacy.config and legacy.config.soul_md) or "")
        except Exception:
            soul = ""
        if "小V" not in soul and "小蜜" not in soul and "前台" not in soul:
            return
    try:
        ProactiveRepository.rebind_role("main", code)
        logger.info("xiaomi: migrated proactive role main → %s", code)
    except Exception:
        logger.warning("xiaomi: migrate main→%s failed", code, exc_info=True)


def ensure_xiaomi_proactive_role() -> dict[str, Any]:
    """Idempotent: hire/update proactive role ``xiaomi`` as 小V常驻岗."""
    from evoflow.proactive.models import (
        InitiativeRiskLevel,
        ProactiveAutonomyLevel,
        ProactiveRole,
        ProactiveRoleConfig,
    )
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.schedule import compute_next_duty_iso, sync_role_schedule_fields

    _migrate_legacy_main_front_desk()

    code = XIAOMI_AGENT_CODE
    now = utc_now_iso_z()
    existing = ProactiveRepository.get_role(code)
    cfg = ProactiveRoleConfig(
        responsibilities=list(XIAOMI_RESPONSIBILITIES),
        domain_scope=[],
        kpis=list(XIAOMI_KPIS),
        autonomy_level=ProactiveAutonomyLevel.FULL_AUTO,
        max_initiatives_per_cycle=3,
        risk_threshold=InitiativeRiskLevel.LOW,
        approval_channels=["desktop"],
        approval_timeout_minutes=60,
        soul_md=XIAOMI_SOUL,
        think_mode="agent_loop",
        max_turns=10,
        timeout_seconds=360,
        work_schedule_enabled=True,
        work_start_hour=8,
        work_end_hour=23,
        reports_to="",
    )

    if existing is None:
        role = ProactiveRole(
            agent_code=code,
            role_name=XIAOMI_DISPLAY_NAME_ZH,
            department="用户办公室",
            config=cfg,
            heartbeat_rrule="",
            heartbeat_schedule="",
            status="active",
            created_at=now,
            updated_at=now,
        )
        sync_role_schedule_fields(role, XIAOMI_HEARTBEAT_SCHEDULE)
        role.next_heartbeat_at = compute_next_duty_iso(role)
        ProactiveRepository.save_role(role)
        logger.info("xiaomi: hired proactive role agent_code=%s", code)
        return {"ok": True, "created": True, "agent_code": code, "role_name": role.role_name}

    # Refresh display + duty contract (keep status / next_heartbeat if already scheduled).
    existing.role_name = XIAOMI_DISPLAY_NAME_ZH
    existing.department = existing.department or "用户办公室"
    # Preserve workspace / reporting line if user set them.
    if existing.config and existing.config.workspace_path:
        cfg.workspace_path = existing.config.workspace_path
    if existing.config:
        prev_mgr = str(getattr(existing.config, "reports_to", "") or "").strip()
        if prev_mgr:
            cfg.reports_to = prev_mgr
    existing.config = cfg
    sync_role_schedule_fields(existing, XIAOMI_HEARTBEAT_SCHEDULE)
    if existing.status == "archived":
        existing.status = "active"
    existing.updated_at = now
    if not str(existing.next_heartbeat_at or "").strip():
        existing.next_heartbeat_at = compute_next_duty_iso(existing)
    ProactiveRepository.save_role(existing)
    logger.info("xiaomi: refreshed proactive role agent_code=%s status=%s", code, existing.status)
    return {
        "ok": True,
        "created": False,
        "agent_code": code,
        "role_name": existing.role_name,
        "status": existing.status,
    }


_CLOSED_TASK_STATUSES = frozenset(
    {"completed", "reviewed", "cancelled", "canceled", "rejected"}
)


def _task_progress(task: dict[str, Any]) -> int:
    try:
        return int(task.get("progress") or 0)
    except (TypeError, ValueError):
        return 0


def _is_open_task(task: dict[str, Any]) -> bool:
    st = str(task.get("status") or "").lower()
    if st in _CLOSED_TASK_STATUSES:
        return False
    return _task_progress(task) < 100


def _list_open_tasks_for_role(role_name: str) -> list[dict[str, Any]]:
    from evoflow.admin import tasks as admin_tasks

    try:
        listed = admin_tasks.list_tasks(role=role_name, include_subtasks=False)
        tasks = list(listed.get("tasks") or [])
    except Exception:
        return []
    return [t for t in tasks if isinstance(t, dict) and _is_open_task(t)]


def summarize_xiaomi_duty_load() -> dict[str, Any]:
    """Cheap platform load for scheduled 小V skip-idle.

    Fail-open: ``ok=False`` means the caller should still run the round.
    """
    try:
        from evoflow.admin import employees as emp

        data = emp.list_roles(status="active")
        roles = data.get("roles") if isinstance(data, dict) else []
    except Exception:
        logger.debug("xiaomi duty load: list_roles failed", exc_info=True)
        return {
            "ok": False,
            "open_task_count": -1,
            "busy_count": -1,
            "pending_approvals": -1,
            "employee_count": -1,
        }

    open_n = 0
    busy_n = 0
    pending_n = 0
    employee_n = 0
    for r in roles or []:
        if not isinstance(r, dict):
            continue
        code = str(r.get("agent_code") or "").strip()
        if is_xiaomi_agent(code):
            continue
        employee_n += 1
        if r.get("busy"):
            busy_n += 1
        try:
            pending_n += int(r.get("pending_approvals") or 0)
        except (TypeError, ValueError):
            pass
        name = str(r.get("role_name") or code).strip()
        open_n += len(_list_open_tasks_for_role(name))

    return {
        "ok": True,
        "open_task_count": open_n,
        "busy_count": busy_n,
        "pending_approvals": pending_n,
        "employee_count": employee_n,
    }


def should_skip_xiaomi_idle_patrol() -> tuple[bool, dict[str, Any]]:
    """Skip scheduled 小V heartbeat when there is nothing to process.

    Gate on the board: no open tasks and no pending approvals. Employees marked
    busy without an open Task is not a reason to burn an LLM round.
    Manual「立即值班」and dispatch still run.
    """
    snap = summarize_xiaomi_duty_load()
    if not snap.get("ok"):
        return False, snap
    skip = (
        int(snap.get("open_task_count") or 0) == 0
        and int(snap.get("pending_approvals") or 0) == 0
    )
    return skip, snap


def format_global_boards_for_duty(*, limit_per_role: int = 6) -> str:
    """All-role open Task digest for 小V duty brief."""
    lim = max(1, min(20, int(limit_per_role or 6)))
    try:
        from evoflow.admin import employees as emp

        data = emp.list_roles(status="active")
        roles = data.get("roles") if isinstance(data, dict) else []
    except Exception:
        logger.debug("xiaomi global board: list_roles failed", exc_info=True)
        return "（无法读取名册）"

    lines = ["## 全局未结 Task（催办用；勿把 id=`task:…` 当 CLI task_id）\n"]
    any_open = False
    for r in roles or []:
        if not isinstance(r, dict):
            continue
        code = str(r.get("agent_code") or "").strip()
        if is_xiaomi_agent(code):
            continue
        name = str(r.get("role_name") or code).strip()
        busy = " · 工作中" if r.get("busy") else ""
        open_tasks = _list_open_tasks_for_role(name)
        if not open_tasks:
            lines.append(f"- `{code}` {name}{busy}：无未结")
            continue
        any_open = True
        lines.append(f"- `{code}` {name}{busy}：未结 {len(open_tasks)} 条")
        for t in open_tasks[:lim]:
            tid = str(t.get("task_id") or t.get("id") or "").strip()
            title = str(t.get("name") or tid).strip()
            st = str(t.get("status") or "?").strip()
            prog = _task_progress(t)
            lines.append(f"  - `{tid}` [{st}] {prog}% · {title}")
    if not any_open:
        lines.append("\n（各岗暂无未结 Task — 可快速结束本轮）")
    return "\n".join(lines)


def build_xiaomi_duty_system_prompt(role) -> str:
    """Duty system brief for 小V常驻催办（替换通用员工 Task 自建协议）。"""
    from evoflow.proactive.org import reports_to_code
    from evoflow.proactive.prompt import DUTY_BRIEF_CLOSE, DUTY_BRIEF_OPEN
    from evoflow.proactive.repositories import ProactiveRepository

    del role  # identity is fixed to 小V; roster is global
    try:
        roster = [
            r
            for r in ProactiveRepository.list_roles()
            if str(r.status or "").strip().lower() != "archived"
        ]
    except Exception:
        roster = []

    lines = [
        "",
        "## 全局名册（你可管理任何人）",
        "你是系统前台：代表用户，可向**任意在岗员工**派活、催办、指派下游；",
        "不受组织上下级、平级或 workspace 限制。不要按「只能派直属下级」那套员工规则自我设限。",
        "唯一例外：不要给自己（xiaomi）派实现类活。",
        "",
        "| agent_code | 岗位 | 上级 | 部门 |",
        "|---|---|---|---|",
    ]
    if not roster:
        lines.append("| （空） | — | — | — |")
    else:
        any_row = False
        for peer in sorted(
            roster,
            key=lambda r: (str(r.role_name or ""), str(r.agent_code or "")),
        ):
            code = str(peer.agent_code or "").strip()
            if not code or is_xiaomi_agent(code):
                continue
            any_row = True
            mgr = reports_to_code(peer) or "—"
            lines.append(
                f"| `{code}` | {peer.role_name} | `{mgr}` | {peer.department or '—'} |"
            )
        if not any_row:
            lines.append("| （空） | — | — | — |")
    roster_block = "\n".join(lines)

    return f"""{DUTY_BRIEF_OPEN}
# 小V · 平台管家 · 常驻催办

你是用户的全局助手与平台常驻管家「{XIAOMI_DISPLAY_NAME_ZH}」（agent_code=`{XIAOMI_AGENT_CODE}`）。
你不是工程师，也不是 `main`（EvoFlow）——你管名册、全局 Task、跨岗催办与向用户汇报。
**权限**：你可管理平台上任何人（任意员工），与真人用户同权派活/催办。

## 怎么工作

看清各岗未结任务与谁在忙；卡住的事项派给或叫醒对口员工，写清目标与验收。
有事才用白话告诉用户（谁、什么事、下一步）；没事就安静收工，不要空建单。
禁止空班次写「【巡检完成】/系统健康/无阻塞待办」交差腔——那不是给用户看的汇报。

不要自己改业务代码或大范围动仓库；不要给自己挂实现类任务再亲自做。
已结案的任务不要再当未完成去催；结果含「等待超时」但状态已结 ≠ 未完成。
同主题多张待办只推进一张。若需落文字纪要，只写到 ``docs/roles/xiaomi/<YYYYMMDD-HH>/``。

先查后动；高风险改仓库只分诊，不亲自动手。
值班轮次不要用 platform 做写操作（建库/改模型/跑工作流）；那些留给用户对话触发。
{DUTY_BRIEF_CLOSE}

{roster_block}
"""


def build_xiaomi_duty_user_prompt(
    role,
    *,
    environment_context: str = "",
    task_board: str = "",
    work_log: str = "",
) -> str:
    env = str(environment_context or "").strip()
    board = str(task_board or "").strip() or format_global_boards_for_duty()
    parts = [
        f"# 值班 · 「{XIAOMI_DISPLAY_NAME_ZH}」常驻催办",
        "",
        board,
        "",
        "## 本轮行动",
        "先看员工忙闲与上方全局未结；有卡住就催办对口岗（带上任务）。",
        "新事项派给合适岗位；对方忙碌可换岗。无未结或无需催办则直接结束。",
        "不要空转询问；不要自己改仓库。",
        "结案用白话说明催了谁、结果如何；不要复述工具语法。",
    ]
    if env:
        parts.extend(["", "## 环境信号", env])
    log = str(work_log or "").strip()
    if log and "暂无" not in log:
        parts.extend(["", "## 近况参考", log[:1200]])
    return "\n".join(parts).strip() + "\n"
