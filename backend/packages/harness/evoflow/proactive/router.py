"""Proactive AI API Router.

REST endpoints for managing embodied AI roles, viewing initiatives,
processing approval decisions, and querying engine status.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from evoflow.authz.http_guard import require_org_admin
from evoflow.proactive.models import (
    InitiativeRiskLevel,
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
    normalize_role_status,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/proactive", tags=["proactive"])


def _get_proactive_runner():
    """Lazy: runner pulls in the proactive engine; keep router import light for startup."""
    from evoflow.proactive.runner import get_proactive_runner

    return get_proactive_runner()


def _require_role_agent(request: Request, agent_code: str) -> None:
    """ACL gate: caller must be allowed to see the underlying agent for this duty role.

    Missing in 0.5.8 ACL wiring — call sites were added without this helper, so
    resume/pause/heartbeat raised NameError (surfaced to Panel as opaque HTTP errors).
    """
    from evoflow.authz.http_guard import require_agent_visible

    code = str(agent_code or "").strip()
    if not code:
        raise HTTPException(status_code=422, detail="agent_code required")
    require_agent_visible(request, code)


# ═══════════════════════════════════════════════════════════════════════
#  Request / Response models
# ═══════════════════════════════════════════════════════════════════════


class CreateRoleRequest(BaseModel):
    agent_code: str = Field(..., description="Unique agent code (links to evoflow_agents)")
    role_name: str = Field(..., description="Role display name")
    department: str = Field("", description="Department name")
    responsibilities: list[str] = Field(default_factory=list)
    workspace_path: str = Field("", description="Bound local workspace absolute path")
    domain_scope: list[str] = Field(default_factory=list)
    knowledge_vault_ids: list[str] = Field(
        default_factory=list,
        description="Bound Knowledge Vault ids (multi); injected into duty system prompt",
    )
    kpis: list[Any] = Field(
        default_factory=list,
        description="KPI 条目：字符串或 {name,target,probe}；probe=eslint_count|build_ok|file_exists",
    )
    autonomy_level: str = Field(
        "approval_for_all",
        description="full_auto|approval_for_risky|approval_for_all — default requires approval before execute",
    )
    max_initiatives_per_cycle: int = Field(3)
    risk_threshold: str = Field("medium", description="low|medium|high|critical")
    approval_channels: list[str] = Field(default_factory=lambda: ["desktop", "feishu"])
    approval_timeout_minutes: int = Field(30)
    heartbeat_rrule: str = Field(
        "",
        description="Legacy RRULE; prefer heartbeat_schedule (5-field cron)",
    )
    heartbeat_schedule: str = Field(
        "0 9-19/2 * * *",
        description="5-field cron — same semantics as automation tasks",
    )
    soul_md: str = Field("")
    think_mode: str = Field("agent_loop", description="agent_loop|prompt_only")
    model_name: str = Field("", description="Override model for this role; empty uses agent/app default")
    max_turns: int = Field(10, description="Agent loop max turns")
    timeout_seconds: int = Field(0, description="Single think timeout (s); 0/empty = unlimited")
    tool_groups: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    # 上班时间 — 默认 09:00~20:00，该时段外不自动上班
    work_schedule_enabled: bool = Field(True, description="是否启用上班时间限制")
    work_start_hour: int = Field(9, ge=0, le=23, description="上班开始时（本地小时，含）")
    work_end_hour: int = Field(20, ge=0, le=23, description="上班结束时（本地小时，不含）")
    approval_timeout_by_type: dict[str, int] = Field(
        default_factory=dict,
        description="按action_type设置审批超时(分钟)，如 {'code_change': 1440}；空=用approval_timeout_minutes",
    )
    daily_budget_usd: float = Field(0.0, description="每日成本预算(USD)，0=不限")
    per_run_budget_usd: float = Field(0.0, description="单次上班预算(USD)，0=不限")
    budget_exceed_policy: str = Field(
        "skip_patrol",
        description="超额策略: skip_patrol|pause_role|notify_only",
    )
    reports_to: str = Field(
        "",
        description="直属上级 agent_code；空=顶层/未设置",
    )
    status: str = Field(
        "active",
        description="active|paused|archived|draft — draft=未上岗（不巡检）",
    )


class UpdateRoleRequest(BaseModel):
    role_name: str | None = None
    department: str | None = None
    responsibilities: list[str] | None = None
    workspace_path: str | None = None
    domain_scope: list[str] | None = None
    knowledge_vault_ids: list[str] | None = None
    kpis: list[Any] | None = None
    autonomy_level: str | None = None
    max_initiatives_per_cycle: int | None = None
    risk_threshold: str | None = None
    approval_channels: list[str] | None = None
    approval_timeout_minutes: int | None = None
    heartbeat_rrule: str | None = None
    heartbeat_schedule: str | None = None
    soul_md: str | None = None
    think_mode: str | None = None
    model_name: str | None = None
    max_turns: int | None = None
    timeout_seconds: int | None = None
    tool_groups: list[str] | None = None
    skills: list[str] | None = None
    status: str | None = None
    dnd_enabled: bool | None = None
    dnd_start_hour: int | None = None
    dnd_end_hour: int | None = None
    work_schedule_enabled: bool | None = None
    work_start_hour: int | None = None
    work_end_hour: int | None = None
    approval_timeout_by_type: dict[str, int] | None = None
    daily_budget_usd: float | None = None
    per_run_budget_usd: float | None = None
    budget_exceed_policy: str | None = None
    reports_to: str | None = Field(
        None,
        description="直属上级 agent_code；传空字符串清除",
    )
    new_agent_code: str | None = Field(
        None,
        description="Rebind this duty role to another Agent (must exist and not already hired)",
    )


class ApprovalDecisionRequest(BaseModel):
    decision: str = Field(..., description="approved|rejected")
    decided_by: str = Field("user")
    comment: str = Field("")
    rejection_reason: str = Field("", description="用户拒绝时的理由，用于优化AI提案质量")


class HeartbeatRequest(BaseModel):
    """Optional body for「立即开工」."""

    focus: str = Field(
        "",
        description="本轮事项/关注点（可选）；空则按岗位职责正常上班",
    )


class DispatchTaskRequest(BaseModel):
    goal: str = Field(..., description="用户指定的任务目标（必填），员工本轮必须围绕它工作")
    description: str = Field("", description="补充说明（可选）")
    priority: str = Field("normal", description="low|normal|high|urgent")
    source: str = Field(
        "manual",
        description="chat_mention|employee_page|manual|role|xiaomi",
    )
    from_agent: str = Field(
        "",
        description="叫醒/派发方 agent_code（同事跨岗或小V）；写入 Task.raised_by / woken_by",
    )
    related_task_id: str = Field(
        "",
        description="已有看板 Task id；有则复用该行，不再新建包装单",
    )
    round_id: str = Field(
        "",
        description="沿用已有值班 round_id（续跑同一工作轨迹）；空则新开 dispatch:…",
    )
    resume_round: bool = Field(
        False,
        description="为 true 且未传 round_id 时，从 related_task 的 round_id/source_ref 续跑",
    )
    fresh_round: bool = Field(
        False,
        description="强制新开一轮（忽略 resume_round / 任务上旧 round_id）",
    )
    skip_done_guard: bool = Field(
        False,
        description="下游回执等系统叫醒：即使 goal 引用已结案 Task 也仍派发",
    )
    interrupt: bool = Field(
        False,
        description="为 true 时中断员工当前轮次再派发；默认忙碌则排队",
    )

    @field_validator("priority")
    @classmethod
    def _validate_priority(cls, v: str) -> str:
        valid = {"low", "normal", "high", "urgent"}
        s = str(v or "normal").strip().lower() or "normal"
        if s not in valid:
            raise ValueError(f"Invalid priority: {v!r} (expected one of: {', '.join(sorted(valid))})")
        return s


class EventEmitRequest(BaseModel):
    event_type: str = Field(
        ...,
        description="git_push|ci_failed|pr_created|pr_updated",
    )
    agent_code: str = Field(..., description="Target proactive role")
    goal: str = Field("", description="Override default event goal")
    description: str = Field("", description="Event detail for the duty brief")


class OverlapCheckRequest(BaseModel):
    agent_code: str = Field("", description="Candidate agent_code (excluded from compare when editing)")
    responsibilities: list[str] = Field(default_factory=list)
    domain_scope: list[str] = Field(default_factory=list)
    role_name: str = Field("")
    exclude_agent_code: str = Field("", description="Skip this role when editing self")


# ═══════════════════════════════════════════════════════════════════════
#  Role endpoints
# ═══════════════════════════════════════════════════════════════════════


@router.get("/roles")
async def list_roles(
    status: str | None = Query(
        None, description="Filter by status: active|paused|archived|draft"
    ),
) -> dict[str, Any]:
    if status is not None:
        try:
            status = normalize_role_status(status)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    roles = ProactiveRepository.list_roles(status=status)
    return {
        "roles": [_role_to_dict(r) for r in roles],
        "count": len(roles),
    }


@router.get("/org-tree")
async def get_org_tree(
    status: str | None = Query(
        None,
        description=(
            "Optional status filter. Default empty = fixed org chart "
            "(all non-archived roles). Pass active|paused|draft|archived to filter."
        ),
    ),
) -> dict[str, Any]:
    """Organization chart forest based on ``config.reports_to``.

    Default is the **fixed** reporting graph (active + paused + draft): 在岗/请假
    does not reshape the tree — status is metadata only. Archived roles are
    omitted unless ``status=archived`` is requested explicitly.

    When an explicit status filter is set, missing managers on the reporting
    path are kept as ``is_bridge`` nodes so the tree does not flatten.
    """
    from evoflow.proactive.org import (
        build_org_forest,
        reports_to_code,
        with_reporting_bridges,
    )

    st = str(status or "").strip() or None
    if st is not None:
        try:
            st = normalize_role_status(st)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    full = ProactiveRepository.list_roles(status=None)
    if st is None:
        # Fixed org: everyone still on the books (not archived).
        roles = [r for r in full if str(r.status or "").strip() != "archived"]
    else:
        visible = [r for r in full if str(r.status or "").strip() == st]
        roles = with_reporting_bridges(visible, full)
    forest = build_org_forest(roles)
    flat = [
        {
            "agent_code": r.agent_code,
            "role_name": r.role_name,
            "department": r.department or "",
            "reports_to": reports_to_code(r),
            "status": r.status,
            "is_bridge": bool(st) and str(r.status or "").strip() != st,
        }
        for r in roles
    ]
    primary_count = sum(1 for r in roles if not st or str(r.status or "").strip() == st)
    return {
        "forest": forest,
        "roles": flat,
        "count": primary_count,
        "filter_status": st,
    }


@router.get("/roles/{agent_code}")
async def get_role(agent_code: str) -> dict[str, Any]:
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    # Include recent initiatives
    initiatives = ProactiveRepository.list_initiatives(
        role_agent_code=agent_code, limit=10
    )
    result = _role_to_dict(role)
    result["recent_initiatives"] = [_initiative_to_dict(i) for i in initiatives]
    try:
        from evoflow.proactive.org import org_chart_for_role

        result["org"] = org_chart_for_role(
            role,
            # 组织关系固定：用未归档全员花名册，不因请假把上级/下级裁掉
            roster=[
                r
                for r in ProactiveRepository.list_roles(status=None)
                if str(r.status or "").strip() != "archived"
            ],
        )
    except Exception:
        result["org"] = None
    return result


@router.post("/roles")
async def create_role(request: Request, req: CreateRoleRequest) -> dict[str, Any]:
    agent_code = str(req.agent_code or "").strip()
    if agent_code:
        _require_role_agent(request, agent_code)
    if not agent_code:
        raise HTTPException(status_code=400, detail="agent_code is required")

    existing = ProactiveRepository.get_role(agent_code)
    if existing:
        raise HTTPException(status_code=409, detail=f"Role '{agent_code}' already exists")

    # Must bind to an existing Agent (智能体) — employee is a duty contract, not a new agent
    try:
        from evoflow.admin.agents import get_agent
        from evoflow.admin.errors import NotFoundError, ValidationError

        agent_row = get_agent(agent_code)
        agent_code = str(agent_row.get("agent_code") or agent_code).strip()
    except NotFoundError as e:
        raise HTTPException(
            status_code=400,
            detail=f"智能体「{agent_code}」不存在，请先到「智能体」页创建，再雇佣为员工",
        ) from e
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        autonomy = ProactiveAutonomyLevel(req.autonomy_level)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid autonomy_level: {req.autonomy_level}")
    try:
        risk = InitiativeRiskLevel(req.risk_threshold)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid risk_threshold: {req.risk_threshold}")

    role_name = str(req.role_name or "").strip()
    # 岗位名必须是职位标题；禁止默认成智能体名或英文 agent_code（空则前端显示「未命名岗位」）
    if role_name == agent_code:
        role_name = ""

    from evoflow.proactive.prompt import validate_knowledge_vault_ids

    try:
        vault_ids = validate_knowledge_vault_ids(list(req.knowledge_vault_ids or []))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    config = ProactiveRoleConfig(
        responsibilities=req.responsibilities,
        workspace_path=str(req.workspace_path or "").strip(),
        domain_scope=req.domain_scope,
        knowledge_vault_ids=vault_ids,
        kpis=req.kpis,
        autonomy_level=autonomy,
        max_initiatives_per_cycle=req.max_initiatives_per_cycle,
        risk_threshold=risk,
        approval_channels=req.approval_channels,
        approval_timeout_minutes=req.approval_timeout_minutes,
        soul_md=req.soul_md,
        think_mode=req.think_mode,
        model_name=str(req.model_name or "").strip(),
        max_turns=req.max_turns,
        timeout_seconds=req.timeout_seconds,
        tool_groups=req.tool_groups,
        skills=req.skills,
        work_schedule_enabled=req.work_schedule_enabled,
        work_start_hour=req.work_start_hour,
        work_end_hour=req.work_end_hour,
        approval_timeout_by_type=req.approval_timeout_by_type or {},
        daily_budget_usd=req.daily_budget_usd or 0.0,
        per_run_budget_usd=req.per_run_budget_usd or 0.0,
        budget_exceed_policy=str(req.budget_exceed_policy or "skip_patrol").strip() or "skip_patrol",
    )
    # Validate reports_to after config shell exists (needs roster lookup).
    reports_raw = str(req.reports_to or "").strip()
    if reports_raw:
        from evoflow.proactive.org import would_create_cycle

        if reports_raw == agent_code:
            raise HTTPException(status_code=400, detail="reports_to cannot be yourself")
        mgr = ProactiveRepository.get_role(reports_raw)
        if not mgr:
            raise HTTPException(status_code=400, detail=f"reports_to role '{reports_raw}' not found")
        roster = ProactiveRepository.list_roles()
        # Include the new role shell for cycle check once saved; for hire, only check mgr exists.
        if would_create_cycle(agent_code, reports_raw, roster):
            raise HTTPException(status_code=400, detail=f"reports_to '{reports_raw}' would create a cycle")
        config.reports_to = reports_raw
    try:
        initial_status = normalize_role_status(req.status or "active")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    now = utc_now_iso_z()
    from evoflow.proactive.schedule import apply_schedule_input, compute_next_duty_iso

    role = ProactiveRole(
        agent_code=agent_code,
        role_name=role_name,
        department=req.department,
        config=config,
        heartbeat_rrule="",
        heartbeat_schedule="",
        status=initial_status,
        next_heartbeat_at=(
            None  # set below after role exists
        ),
        created_at=now,
        updated_at=now,
    )
    apply_schedule_input(
        role,
        heartbeat_schedule=req.heartbeat_schedule,
        heartbeat_rrule=req.heartbeat_rrule or None,
    )
    if initial_status == "active":
        role.next_heartbeat_at = compute_next_duty_iso(role)
    ProactiveRepository.save_role(role)
    logger.info(
        "proactive.role.created agent_code=%s name=%s status=%s",
        agent_code,
        role_name,
        initial_status,
    )
    return _role_to_dict(role)


@router.put("/roles/{agent_code}")
async def update_role(request: Request, agent_code: str, req: UpdateRoleRequest) -> dict[str, Any]:
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")

    new_code = str(req.new_agent_code or "").strip()
    if new_code and new_code != agent_code:
        from evoflow.admin.agents import get_agent
        from evoflow.admin.errors import NotFoundError, ValidationError

        try:
            agent_row = get_agent(new_code)
            new_code = str(agent_row.get("agent_code") or new_code).strip()
        except NotFoundError as e:
            raise HTTPException(
                status_code=400,
                detail=f"智能体「{new_code}」不存在，请先到「智能体」页创建",
            ) from e
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        runner = _get_proactive_runner()
        await runner.cancel_role(agent_code)
        try:
            role = ProactiveRepository.rebind_role(agent_code, new_code)
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        agent_code = new_code

    if req.role_name is not None:
        next_name = str(req.role_name or "").strip()
        # Reject empty/"None" so a bad client cannot collapse the Chinese title to agent_code.
        if next_name and next_name.casefold() not in {"none", "null", "undefined"}:
            role.role_name = next_name
    if req.department is not None:
        role.department = req.department
    if req.status is not None:
        try:
            role.status = normalize_role_status(req.status)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    schedule_changed = False
    if req.heartbeat_schedule is not None or req.heartbeat_rrule is not None:
        from evoflow.proactive.schedule import apply_schedule_input

        schedule_changed = apply_schedule_input(
            role,
            heartbeat_schedule=req.heartbeat_schedule,
            heartbeat_rrule=req.heartbeat_rrule,
        )

    cfg = role.config
    if req.responsibilities is not None:
        cfg.responsibilities = req.responsibilities
    if req.workspace_path is not None:
        cfg.workspace_path = str(req.workspace_path or "").strip()
    if req.domain_scope is not None:
        cfg.domain_scope = req.domain_scope
    if req.knowledge_vault_ids is not None:
        from evoflow.proactive.prompt import validate_agent_knowledge_ids

        try:
            cfg.knowledge_vault_ids = validate_agent_knowledge_ids(list(req.knowledge_vault_ids or []))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    if req.kpis is not None:
        cfg.kpis = req.kpis
    if req.autonomy_level is not None:
        try:
            cfg.autonomy_level = ProactiveAutonomyLevel(req.autonomy_level)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid autonomy_level: {req.autonomy_level}")
    if req.max_initiatives_per_cycle is not None:
        cfg.max_initiatives_per_cycle = req.max_initiatives_per_cycle
    if req.risk_threshold is not None:
        try:
            cfg.risk_threshold = InitiativeRiskLevel(req.risk_threshold)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid risk_threshold: {req.risk_threshold}")
    if req.approval_channels is not None:
        cfg.approval_channels = req.approval_channels
    if req.approval_timeout_minutes is not None:
        cfg.approval_timeout_minutes = req.approval_timeout_minutes
    if req.soul_md is not None:
        cfg.soul_md = req.soul_md
    if req.think_mode is not None:
        cfg.think_mode = req.think_mode
    if req.model_name is not None:
        cfg.model_name = str(req.model_name or "").strip()
    if req.max_turns is not None:
        cfg.max_turns = req.max_turns
    if req.timeout_seconds is not None:
        cfg.timeout_seconds = req.timeout_seconds
    if req.tool_groups is not None:
        cfg.tool_groups = req.tool_groups
    if req.skills is not None:
        cfg.skills = req.skills
    if req.work_schedule_enabled is not None:
        cfg.work_schedule_enabled = req.work_schedule_enabled
    if req.work_start_hour is not None:
        cfg.work_start_hour = req.work_start_hour
    if req.work_end_hour is not None:
        cfg.work_end_hour = req.work_end_hour
    if req.approval_timeout_by_type is not None:
        cfg.approval_timeout_by_type = req.approval_timeout_by_type
    if req.daily_budget_usd is not None:
        cfg.daily_budget_usd = req.daily_budget_usd
    if req.per_run_budget_usd is not None:
        cfg.per_run_budget_usd = float(req.per_run_budget_usd or 0.0)
    if req.budget_exceed_policy is not None:
        pol = str(req.budget_exceed_policy or "skip_patrol").strip().lower() or "skip_patrol"
        if pol not in ("skip_patrol", "pause_role", "notify_only"):
            raise HTTPException(
                status_code=400,
                detail="budget_exceed_policy must be skip_patrol|pause_role|notify_only",
            )
        cfg.budget_exceed_policy = pol
    if req.reports_to is not None:
        from evoflow.proactive.org import would_create_cycle

        mgr = str(req.reports_to or "").strip()
        if mgr and mgr == agent_code:
            raise HTTPException(status_code=400, detail="reports_to cannot be yourself")
        if mgr:
            target = ProactiveRepository.get_role(mgr)
            if not target:
                raise HTTPException(status_code=400, detail=f"reports_to role '{mgr}' not found")
            roster = ProactiveRepository.list_roles()
            # Apply candidate on a copy of this role for cycle detection
            cfg.reports_to = mgr
            role.config = cfg
            if would_create_cycle(agent_code, mgr, roster):
                raise HTTPException(
                    status_code=400,
                    detail=f"reports_to '{mgr}' would create a reporting cycle",
                )
        else:
            cfg.reports_to = ""
    # Backward compat: old dnd_* fields map to work_schedule_*
    if req.dnd_enabled is not None:
        cfg.work_schedule_enabled = req.dnd_enabled
    if req.dnd_start_hour is not None:
        # dnd_start_hour=20 → work_end_hour=20 (inverted semantics)
        cfg.work_end_hour = req.dnd_start_hour
    if req.dnd_end_hour is not None:
        # dnd_end_hour=9 → work_start_hour=9 (inverted semantics)
        cfg.work_start_hour = req.dnd_end_hour

    role.config = cfg
    if schedule_changed:
        from evoflow.proactive.schedule import compute_next_duty_iso

        role.next_heartbeat_at = compute_next_duty_iso(role)
    ProactiveRepository.save_role(role)
    return _role_to_dict(role)


@router.delete("/roles/{agent_code}")
async def delete_role(request: Request, agent_code: str) -> dict[str, Any]:
    """Hard-delete an employee contract (duty role), not the underlying Agent."""
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    try:
        from evoflow.agents.xiaomi.identity import XIAOMI_PROTECTED_DETAIL_ZH, is_xiaomi_agent

        if is_xiaomi_agent(agent_code):
            raise HTTPException(status_code=400, detail=XIAOMI_PROTECTED_DETAIL_ZH)
    except HTTPException:
        raise
    except Exception:
        logger.debug("xiaomi protect check skipped", exc_info=True)
    runner = _get_proactive_runner()
    await runner.cancel_role(agent_code)
    try:
        from evoflow.proactive.feishu_binding import remove_role_account_from_channel

        remove_role_account_from_channel(agent_code)
    except Exception:
        logger.debug("proactive.role.delete feishu account cleanup skipped", exc_info=True)
    try:
        ProactiveRepository.delete_role(agent_code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.exception("proactive.role.delete failed agent_code=%s", agent_code)
        raise HTTPException(
            status_code=500,
            detail=f"删除岗位失败：{e}",
        ) from e
    logger.info("proactive.role.deleted agent_code=%s name=%s", agent_code, role.role_name)
    return {"ok": True, "agent_code": agent_code, "deleted": True}


@router.post("/roles/{agent_code}/feishu/registration/{session_id}/apply")
async def apply_role_feishu_registration(request: Request, agent_code: str, session_id: str) -> dict[str, Any]:
    """Apply a completed Feishu QR registration to this employee (PersonalAgent bot).

    Reuses ``/api/channels/feishu/registration/begin|poll``; credentials are stored
    on the role and synced to ``channels.feishu.accounts[<agent_code>]``.
    """
    _require_role_agent(request, agent_code)
    from app.channels.feishu_registration import get_registration_client
    from evoflow.proactive.feishu_binding import apply_registration_to_role

    client = get_registration_client()
    session = client.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Registration session not found")
    if session.status != "completed":
        msg = {
            "expired": "Registration session expired. Please start a new registration.",
            "failed": f"Registration failed: {session.error or 'unknown error'}",
        }.get(session.status, f"Registration is not complete (status={session.status})")
        raise HTTPException(status_code=400, detail=msg)
    if not session.app_id or not session.app_secret:
        raise HTTPException(status_code=500, detail="Registration completed but credentials are missing")

    try:
        return await apply_registration_to_role(
            agent_code,
            app_id=session.app_id,
            app_secret=session.app_secret,
            open_id=str(session.open_id or ""),
        )
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/roles/{agent_code}/feishu/binding")
async def unbind_role_feishu(request: Request, agent_code: str) -> dict[str, Any]:
    """Remove this employee's Feishu PersonalAgent binding."""
    _require_role_agent(request, agent_code)
    from evoflow.proactive.feishu_binding import unbind_role_feishu as _unbind

    try:
        return await _unbind(agent_code)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/roles/{agent_code}/feishu/binding")
async def get_role_feishu_binding(request: Request, agent_code: str) -> dict[str, Any]:
    """Return UI-safe Feishu binding status for an employee."""
    _require_role_agent(request, agent_code)
    from evoflow.proactive.feishu_binding import feishu_binding_public

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    return {"agent_code": agent_code, "binding": feishu_binding_public(role.config)}


@router.post("/roles/{agent_code}/heartbeat")
async def trigger_heartbeat(
    request: Request,
    agent_code: str,
    req: HeartbeatRequest | None = Body(None),
) -> dict[str, Any]:
    """Manually trigger a think cycle for a role.

    Optional JSON body: ``{ "focus": "本轮事项（可空）" }``.
    """
    _require_role_agent(request, agent_code)
    code = str(agent_code or "").strip()
    focus = str((req.focus if req else "") or "").strip()
    try:
        from evoflow.config.agents_config import load_agent_config, materialize_builtin_agent_if_missing

        try:
            load_agent_config(code)
        except FileNotFoundError:
            if not materialize_builtin_agent_if_missing(code):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"底层智能体「{code}」不存在。"
                        "请先到「智能体」页创建同编码智能体，或删除该员工后雇佣其他智能体。"
                    ),
                ) from None
            load_agent_config(code)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("proactive.heartbeat agent preflight failed code=%s: %s", code, e)
        raise HTTPException(
            status_code=400,
            detail=(
                f"底层智能体「{code}」配置不可用（{e}）。"
                "请到「智能体」页确认该编码存在、配置完整后重试。"
            ),
        ) from e

    runner = _get_proactive_runner()
    try:
        result = await runner.trigger_heartbeat(code, focus=focus)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        msg = str(e)
        if "Agent config not found" in msg or "FileNotFoundError" in msg:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"底层智能体「{code}」配置不可用：{msg}。"
                    "请到「智能体」页确认该编码存在后重试。"
                ),
            ) from e
        if "Recursion limit" in msg or "GraphRecursionError" in msg:
            raise HTTPException(
                status_code=400,
                detail=(
                    "本轮巡检工具步数已达上限，未能写完工作汇报。"
                    "请缩短巡检范围，或在员工设置中提高 max_turns / timeout 后重试。"
                ),
            ) from e
        raise
    if result.get("busy"):
        raise HTTPException(
            status_code=409,
            detail=result.get("error")
            or "该员工正在执行任务，请稍候或打开工作轨迹查看进度",
        )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Unknown error"))
    return result


@router.post("/debug/push-test-approval")
async def debug_push_test_approval(
    request: Request,
    agent_code: str = Query("project-debugger", description="Role to attribute the test card to"),
) -> dict[str, Any]:
    """Dev helper: create a pending approval and push the Feishu interactive card now.

    Use this to verify card buttons / deep link without waiting for a duty round.
    """
    _require_role_agent(request, agent_code)
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import (
        Initiative,
        InitiativeActionType,
        InitiativeRiskLevel,
        InitiativeStatus,
    )

    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{code}' not found")
    if role.status != "active":
        raise HTTPException(status_code=400, detail=f"Role '{code}' is not active")

    now = utc_now_iso_z()
    init = Initiative(
        id=ProactiveRepository.new_initiative_id(),
        role_agent_code=code,
        title="【验证】飞书审批卡片一键操作",
        description=(
            "这是一条用于验证飞书审批卡片的测试事项。"
            "请在飞书里点「同意」或「拒绝」，或点「在面板查看」打开待审批页。"
            "验证完可随意拒绝，不会影响真实业务。"
        ),
        action_type=InitiativeActionType.ANALYSIS,
        risk_level=InitiativeRiskLevel.MEDIUM,
        status=InitiativeStatus.PROPOSED,
        rationale="手动触发 debug/push-test-approval，用于验证卡片回调与深链。",
        expected_outcome="飞书卡片可一键同意/拒绝，并可选跳转面板高亮该条。",
        created_at=now,
        updated_at=now,
    )
    ProactiveRepository.save_initiative(init)

    gate = DecisionGate()
    approval = await gate.request_approval(role, init)
    return {
        "ok": True,
        "initiative_id": init.id,
        "approval_id": approval.id,
        "role_agent_code": code,
        "feishu_message_id": approval.feishu_message_id,
        "status": "pending_approval",
        "hint": "请到飞书默认推送群查看审批卡片；面板 #/proactive?tab=approvals",
    }


@router.post("/approvals/{approval_id}/push-feishu")
async def push_feishu_for_approval(request: Request, approval_id: str) -> dict[str, Any]:
    """Re-push Feishu interactive card for an existing pending approval."""
    try:
        _ap = ProactiveRepository.get_approval(approval_id)
        _code = str(getattr(_ap, "role_agent_code", None) or getattr(_ap, "agent_code", None) or "").strip() if _ap else ""
        if _code:
            _require_role_agent(request, _code)
        else:
            require_org_admin(request)
    except HTTPException:
        raise
    except Exception:
        require_org_admin(request)
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.work_items import load_work_item_task, task_to_bridge_initiative

    aid = str(approval_id or "").strip()
    approval = ProactiveRepository.get_approval(aid)
    if not approval:
        raise HTTPException(status_code=404, detail=f"Approval '{approval_id}' not found")
    if str(getattr(approval.status, "value", approval.status) or "").lower() != "pending":
        raise HTTPException(status_code=400, detail="Only pending approvals can be re-pushed")

    role = ProactiveRepository.get_role(approval.role_agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{approval.role_agent_code}' not found")

    initiative = None
    if approval.initiative_id:
        initiative = ProactiveRepository.get_initiative(approval.initiative_id)
    if initiative is None and approval.task_id:
        task = load_work_item_task(approval.task_id)
        if task:
            initiative = task_to_bridge_initiative(task)
    if initiative is None:
        raise HTTPException(status_code=404, detail="No initiative/task bridge for this approval")

    gate = DecisionGate()
    await gate._push_feishu(role, initiative, approval, triggered_by="manual_repush")
    refreshed = ProactiveRepository.get_approval(aid) or approval
    push_log: list[dict] = []
    try:
        from evoflow.persistence.channel_push_repositories import list_by_approval

        push_log = list_by_approval(aid, limit=20)
    except Exception:
        push_log = []
    return {
        "ok": True,
        "approval_id": aid,
        "feishu_message_id": refreshed.feishu_message_id,
        "push_log": push_log,
        "hint": "若仍为空，看 Gateway 日志里 Feishu interactive create / 230002；或查 push_log",
    }


@router.post("/roles/check-overlap")
async def check_role_overlap(req: OverlapCheckRequest) -> dict[str, Any]:
    """O5.3: detect duty/domain overlap with existing employees."""
    from evoflow.proactive.overlap import find_overlaps

    roles = ProactiveRepository.list_roles()
    overlaps = find_overlaps(
        {
            "agent_code": req.agent_code,
            "responsibilities": req.responsibilities,
            "domain_scope": req.domain_scope,
            "role_name": req.role_name,
        },
        roles,
        exclude_agent_code=req.exclude_agent_code or req.agent_code,
        min_overlap=0.5,
    )
    return {
        "ok": True,
        "has_overlap": bool(overlaps),
        "overlaps": overlaps,
        "warning": overlaps[0]["message"] if overlaps else "",
    }


# Demo / legacy seed codes from scripts/seed_proactive_roles.py
_LEGACY_SEED_CODES = ("frontend_architect", "backend_engineer", "devops_lead")


@router.put("/roles/{agent_code}/archive")
async def archive_role(request: Request, agent_code: str) -> dict[str, Any]:
    """O5.2: soft-archive a role (hidden from roster, keeps history)."""
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    try:
        from evoflow.agents.xiaomi.identity import XIAOMI_PROTECTED_DETAIL_ZH, is_xiaomi_agent

        if is_xiaomi_agent(agent_code):
            raise HTTPException(status_code=400, detail=XIAOMI_PROTECTED_DETAIL_ZH)
    except HTTPException:
        raise
    except Exception:
        logger.debug("xiaomi protect check skipped", exc_info=True)
    role.status = "archived"
    role.updated_at = utc_now_iso_z()
    ProactiveRepository.save_role(role)
    # Stop further heartbeats
    try:
        runner = _get_proactive_runner()
        if hasattr(runner, "cancel_role"):
            await runner.cancel_role(agent_code)  # type: ignore[attr-defined]
    except Exception:
        logger.debug("proactive.archive cancel_role failed", exc_info=True)
    logger.info("proactive.role.archived agent_code=%s", agent_code)
    return {"ok": True, "agent_code": agent_code, "status": "archived"}


@router.post("/roles/archive-legacy")
async def archive_legacy_seed_roles(
    request: Request,
    ) -> dict[str, Any]:
    """O5.2: archive known demo seed roles so they leave the active roster."""
    require_org_admin(request)
    archived: list[str] = []
    skipped: list[str] = []
    for code in _LEGACY_SEED_CODES:
        role = ProactiveRepository.get_role(code)
        if not role:
            skipped.append(code)
            continue
        if role.status == "archived":
            skipped.append(code)
            continue
        role.status = "archived"
        role.updated_at = utc_now_iso_z()
        ProactiveRepository.save_role(role)
        try:
            runner = _get_proactive_runner()
            if hasattr(runner, "cancel_role"):
                await runner.cancel_role(code)  # type: ignore[attr-defined]
        except Exception:
            logger.debug("proactive.archive_legacy cancel failed code=%s", code, exc_info=True)
        archived.append(code)
    logger.info("proactive.roles.archive_legacy archived=%s skipped=%s", archived, skipped)
    return {
        "ok": True,
        "archived": archived,
        "skipped": skipped,
        "legacy_codes": list(_LEGACY_SEED_CODES),
    }


@router.get("/roles/{agent_code}/performance")
async def get_role_performance(
    request: Request,
    agent_code: str,
    days: int = Query(7, ge=1, le=90),
    run_probes: bool = Query(
        False,
        description="True=立即跑内置 KPI 探针（eslint_count/build_ok/file_exists）",
    ),
) -> dict[str, Any]:
    """O6.2: duty performance snapshot + KPI probes (builtin allowlist)."""
    _require_role_agent(request, agent_code)
    from evoflow.proactive.kpi_checker import build_performance_report

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    report = build_performance_report(role, days=days, run_probes=run_probes)
    return {"ok": True, **report.to_dict()}


@router.get("/roles/{agent_code}/growth")
async def get_role_growth(
    request: Request,
    agent_code: str,
    limit: int = Query(30, ge=1, le=100),
) -> dict[str, Any]:
    """Person Kernel: identity + lessons + person_memory + proposals + craft."""
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    from evoflow.person_kernel import get_growth_snapshot

    snap = get_growth_snapshot(role.agent_code, changelog_limit=limit)
    return {"ok": True, "role_name": role.role_name, **snap}


@router.post("/roles/{agent_code}/proposals/{proposal_id}/approve")
async def approve_role_proposal(request: Request, agent_code: str, proposal_id: str) -> dict[str, Any]:
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    from evoflow.person_kernel import approve_evolution_proposal
    from evoflow.persistence.person_metabolism_repositories import get_evolution_proposal

    prop = get_evolution_proposal(proposal_id)
    if not prop or str(prop.get("agent_code") or "").lower() != role.agent_code.lower():
        raise HTTPException(status_code=404, detail="proposal not found for role")
    result = approve_evolution_proposal(proposal_id, resolved_by="user")
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "approve failed")
    return result


@router.post("/roles/{agent_code}/proposals/{proposal_id}/reject")
async def reject_role_proposal(request: Request, agent_code: str, proposal_id: str) -> dict[str, Any]:
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    from evoflow.person_kernel import reject_evolution_proposal
    from evoflow.persistence.person_metabolism_repositories import get_evolution_proposal

    prop = get_evolution_proposal(proposal_id)
    if not prop or str(prop.get("agent_code") or "").lower() != role.agent_code.lower():
        raise HTTPException(status_code=404, detail="proposal not found for role")
    result = reject_evolution_proposal(proposal_id, resolved_by="user")
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "reject failed")
    return result


@router.post("/events")
async def emit_proactive_event(request: Request, req: EventEmitRequest) -> dict[str, Any]:
    """O3.1: emit an external event that may trigger a debounced duty round.

    Intended for git hooks / CI webhooks / internal automation.
    """
    code = str(getattr(req, "agent_code", None) or "").strip()
    if code:
        _require_role_agent(request, code)
    from evoflow.proactive.triggers import _DEBOUNCE_DELAYS, get_event_bus

    event_type = str(req.event_type or "").strip().lower()
    code = str(req.agent_code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="agent_code is required")
    if event_type not in _DEBOUNCE_DELAYS:
        raise HTTPException(
            status_code=400,
            detail=f"event_type must be one of: {', '.join(sorted(_DEBOUNCE_DELAYS))}",
        )
    role = ProactiveRepository.get_role(code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{code}' not found")
    if role.status != "active":
        raise HTTPException(status_code=400, detail=f"Role '{code}' is not active")

    bus = get_event_bus()
    await bus.emit(
        event_type,
        code,
        goal=str(req.goal or "").strip(),
        description=str(req.description or "").strip(),
    )
    return {
        "ok": True,
        "event_type": event_type,
        "agent_code": code,
        "debounce_seconds": _DEBOUNCE_DELAYS.get(event_type, 60),
        "pending_triggers": bus.pending_count,
    }


@router.post("/roles/{agent_code}/dispatch")
async def dispatch_task(request: Request, agent_code: str, req: DispatchTaskRequest) -> dict[str, Any]:
    """Dispatch a user-specified task to an employee.

    Unlike ``heartbeat`` (self-selected patrol), the caller pins the *goal* the
    employee must pursue this round. Triggered by main-chat ``@员工`` or the
    employee roster「派发任务」button.
    """
    _require_role_agent(request, agent_code)
    code = str(agent_code or "").strip()
    goal = str(req.goal or "").strip()
    if not goal:
        raise HTTPException(status_code=400, detail="goal is required")

    # Reuse the same agent-config preflight as heartbeat so a stale employee
    # (underlying agent removed) gives a friendly message instead of 500.
    # Bug M6: Do NOT swallow preflight exceptions — raise HTTP 400 immediately
    # so the caller gets a clear error instead of a cryptic failure mid-execution.
    try:
        from evoflow.config.agents_config import load_agent_config, materialize_builtin_agent_if_missing

        try:
            load_agent_config(code)
        except FileNotFoundError:
            if not materialize_builtin_agent_if_missing(code):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"底层智能体「{code}」不存在。"
                        "请先到「智能体」页创建同编码智能体，或删除该员工后雇佣其他智能体。"
                    ),
                ) from None
            load_agent_config(code)
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("proactive.dispatch agent preflight failed code=%s: %s", code, e)
        raise HTTPException(
            status_code=400,
            detail=(
                f"底层智能体「{code}」配置不可用（{e}）。"
                "请到「智能体」页确认该编码存在、配置完整后重试。"
            ),
        ) from e

    runner = _get_proactive_runner()
    try:
        result = await runner.dispatch_task_fire_and_forget(
            code,
            goal,
            description=str(req.description or "").strip(),
            priority=str(req.priority or "normal").strip(),
            source=str(req.source or "manual").strip(),
            from_agent=str(req.from_agent or "").strip(),
            related_task_id=str(req.related_task_id or "").strip(),
            round_id=str(req.round_id or "").strip(),
            resume_round=bool(getattr(req, "resume_round", False)),
            fresh_round=bool(getattr(req, "fresh_round", False)),
            skip_done_guard=bool(getattr(req, "skip_done_guard", False)),
            interrupt=bool(getattr(req, "interrupt", False)),
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        msg = str(e)
        if "Agent config not found" in msg or "FileNotFoundError" in msg:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"底层智能体「{code}」配置不可用：{msg}。"
                    "请到「智能体」页确认该编码存在后重试。"
                ),
            ) from e
        if "Recursion limit" in msg or "GraphRecursionError" in msg:
            raise HTTPException(
                status_code=400,
                detail=(
                    "本轮派发任务工具步数已达上限，未能写完工作汇报。"
                    "请缩短任务范围，或在员工设置中提高 max_turns / timeout 后重试。"
                ),
            ) from e
        raise
    if result.get("busy"):
        raise HTTPException(
            status_code=409,
            detail=result.get("error")
            or "该员工正在执行任务，请稍候或打开工作轨迹查看进度",
        )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "Unknown error"))
    return result


@router.get("/roles/{agent_code}/busy")
async def role_busy(request: Request, agent_code: str) -> dict[str, Any]:
    """Whether this employee currently has an in-flight patrol."""
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    runner = _get_proactive_runner()
    busy = runner.is_role_busy(agent_code)
    started = ""
    for row in runner.busy_roles():
        if row.get("agent_code") == agent_code:
            started = str(row.get("started_at") or "")
            break
    current_round_id = ""
    current_session_key = None
    # Only surface a "live" conversation when the runner actually holds the
    # busy slot. Sticky SQLite run_status without inflight work must not look
    # like the employee is still running (zombie sweeper clears these; this
    # keeps /busy honest in the meantime).
    if busy:
        try:
            from evoflow.proactive.chat_session import list_employee_conversation_sessions

            convs = list_employee_conversation_sessions(agent_code, limit=20)
            running = [
                c
                for c in convs
                if str(c.get("run_status") or "").strip().lower() in {"running", "pending"}
            ]
            # Prefer task/duty over legacy when reporting the live conversation.
            def _rank(c: dict[str, Any]) -> tuple[int, str]:
                kind = str(c.get("kind") or "").strip().lower()
                order = {"task": 0, "duty": 1, "chat": 2, "legacy": 3}.get(kind, 4)
                return (order, str(c.get("updated_at") or ""))

            pick = sorted(running, key=_rank)[0] if running else None
            # Do NOT fall back to an idle legacy session — that made busy look stuck
            # on old chat: round ids after interrupt.
            if pick:
                current_session_key = str(pick.get("session_key") or "").strip() or None
                try:
                    from evoflow.persistence import session_repositories as sess_repo

                    row = sess_repo.load_session_map().get(current_session_key or "") or {}
                    ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
                    current_round_id = str(ctx.get("proactive_round_id") or "").strip()
                except Exception:
                    current_round_id = ""
        except Exception:
            current_round_id = ""
            current_session_key = None
    return {
        "agent_code": agent_code,
        "role_name": role.role_name,
        "busy": busy,
        "started_at": started,
        "current_round_id": current_round_id or None,
        "current_session_key": current_session_key,
        "watch_path": f"/proactive/{agent_code}?live=1",
    }

# ═══════════════════════════════════════════════════════════════════════
#  Initiative endpoints
# ═══════════════════════════════════════════════════════════════════════


@router.get("/initiatives")
async def list_initiatives(
    role_agent_code: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict[str, Any]:
    inits = ProactiveRepository.list_initiatives(
        role_agent_code=role_agent_code,
        status=status,
        limit=limit,
        offset=offset,
    )
    return {
        "initiatives": [_initiative_to_dict(i) for i in inits],
        "count": len(inits),
    }


@router.get("/roles/{agent_code}/work-board")
async def get_role_work_board(
    request: Request,
    agent_code: str,
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """Employee page aggregate: 岗位工作项 Tasks + chat duty-round meta.

    「工作记录」SSOT is the Task board. Initiative journals / legacy rows are no
    longer returned for the Panel work log (approvals still use the initiatives
    table for ``task:`` bridge rows elsewhere).
    """
    _require_role_agent(request, agent_code)
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{code}' not found")

    tasks: list[dict[str, Any]] = []
    try:
        from evoflow.admin import tasks as admin_tasks

        listed = admin_tasks.list_tasks(role=role.role_name, include_subtasks=True)
        tasks = list(listed.get("tasks") or [])
    except Exception:
        # Fall back to raw storage scan (list_tasks validates role name strictly)
        try:
            from evoflow.collab.storage import get_project_storage

            rn = str(role.role_name or "").strip().lower()
            storage = get_project_storage()
            for p in storage.list_projects():
                proj = storage.load_project(p["id"])
                if not proj:
                    continue
                for t in proj.get("tasks") or []:
                    if str(t.get("assigned_role") or "").strip().lower() != rn:
                        continue
                    tid = str(t.get("id") or "")
                    tasks.append(
                        {
                            "task_id": tid,
                            "id": tid,
                            "name": t.get("name"),
                            "description": t.get("description"),
                            "status": t.get("status"),
                            "assigned_to": t.get("assigned_to"),
                            "assigned_role": t.get("assigned_role"),
                            "source": t.get("source"),
                            "source_ref": t.get("source_ref"),
                            "raised_by": t.get("raised_by"),
                            "parent_task_id": t.get("parent_task_id"),
                            "risk_level": t.get("risk_level"),
                            "action_type": t.get("action_type"),
                            "round_id": t.get("round_id"),
                            "progress": t.get("progress"),
                            "created_at": t.get("created_at"),
                            "updated_at": t.get("updated_at"),
                            "result": t.get("result"),
                        }
                    )
                    for st in t.get("subtasks") or []:
                        if str(st.get("assigned_role") or "").strip().lower() != rn:
                            continue
                        tasks.append(
                            {
                                "task_id": tid,
                                "subtask_id": st.get("id"),
                                "id": st.get("id"),
                                "name": st.get("name"),
                                "description": st.get("description"),
                                "status": st.get("status"),
                                "assigned_to": st.get("assigned_to"),
                                "assigned_role": st.get("assigned_role"),
                                "source": st.get("source"),
                                "source_ref": st.get("source_ref"),
                                "is_subtask": True,
                                "progress": st.get("progress"),
                                "created_at": st.get("created_at"),
                                "updated_at": st.get("updated_at"),
                            }
                        )
        except Exception:
            tasks = []

    # Chat-only round meta for grouping / trail links (not initiative journals).
    rounds = _synthesize_round_journals_from_chat(code, limit=min(limit, 40))

    pending_approvals = [
        _approval_to_dict(a, enrich=True)
        for a in ProactiveRepository.list_pending_approvals()
        if a.role_agent_code == code
    ]

    return {
        "agent_code": code,
        "role_name": role.role_name,
        "rounds": rounds,
        "tasks": tasks,
        # Panel work log is Task-only; keep empty for older clients.
        "legacy_initiatives": [],
        "initiatives": [],
        "pending_approvals": pending_approvals,
        "counts": {
            "rounds": len(rounds),
            "tasks": len(tasks),
            "legacy": 0,
            "pending_approvals": len(pending_approvals),
        },
    }


@router.post("/migrate-work-items")
async def migrate_work_items(
    request: Request,
    dry_run: bool = Query(False),
    role_agent_code: str | None = Query(None),
) -> dict[str, Any]:
    """Migrate actionable initiatives → Tasks (idempotent)."""
    require_org_admin(request)
    from evoflow.proactive.migrate_initiatives import migrate_actionable_initiatives_to_tasks

    return migrate_actionable_initiatives_to_tasks(
        dry_run=dry_run,
        role_agent_code=role_agent_code,
    )


@router.get("/initiatives/{initiative_id}")
async def get_initiative(initiative_id: str) -> dict[str, Any]:
    init = ProactiveRepository.get_initiative(initiative_id)
    if not init:
        raise HTTPException(status_code=404, detail=f"Initiative '{initiative_id}' not found")
    result = _initiative_to_dict(init)
    # Include approval if exists
    approval = ProactiveRepository.get_approval_by_initiative(initiative_id)
    if approval:
        result["approval"] = _approval_to_dict(approval)
    return result


# ═══════════════════════════════════════════════════════════════════════
#  Approval endpoints
# ═══════════════════════════════════════════════════════════════════════


@router.get("/approvals")
async def list_approvals(
    status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
) -> dict[str, Any]:
    approvals = ProactiveRepository.list_approvals(status=status, limit=limit)
    return {
        "approvals": [_approval_to_dict(a, enrich=True) for a in approvals],
        "count": len(approvals),
    }


# ── Safe background execution helpers ──────────────────────────────


def _log_create_task_result(fut: asyncio.Future) -> None:
    """Done callback for background asyncio tasks — log exceptions."""
    try:
        exc = fut.exception()
        if exc:
            logger.error("Background execution task failed: %s", exc, exc_info=exc)
    except asyncio.CancelledError:
        logger.warning("Background execution task was cancelled")
    except Exception as e:
        logger.error("Unexpected error in background task callback: %s", e)


async def _safe_execute_approved_work_item(
    tid: str, role_agent_code: str
) -> str:
    """Execute an approved work-item with status tracking and error handling.

    Sets the task to ``executing``, runs the engine, and on failure marks
    the task as ``failed`` with the error reason.
    """
    from evoflow.proactive.engine import ProactiveEngine
    from evoflow.proactive.work_items import set_work_item_status

    try:
        set_work_item_status(tid, "executing", progress=5)
        engine = ProactiveEngine()
        result = await engine.execute_work_item(tid)
        logger.info(
            "Approved work item %s completed (role=%s): %s",
            tid, role_agent_code, result,
        )
        return result
    except asyncio.CancelledError:
        logger.warning("Execution of work item %s was cancelled", tid)
        set_work_item_status(tid, "failed", result="任务执行被取消")
        raise
    except Exception as exc:
        logger.error(
            "Execution of approved work item %s failed (role=%s): %s",
            tid, role_agent_code, exc, exc_info=exc,
        )
        set_work_item_status(
            tid, "failed",
            result=f"执行失败: {exc!s}"[:500],
        )
        return f"error: {exc}"


async def _safe_execute_approved_initiative(
    engine: Any, initiative: Any
) -> str:
    """Execute an approved initiative with error handling.

    On failure, sets the initiative status to ``failed``.
    """
    from evoflow.proactive.models import InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository

    try:
        result = await engine.execute_initiative(initiative)
        logger.info(
            "Approved initiative %s completed (role=%s)",
            initiative.id, initiative.role_agent_code,
        )
        return result
    except asyncio.CancelledError:
        logger.warning("Execution of initiative %s was cancelled", initiative.id)
        try:
            initiative.status = InitiativeStatus.FAILED
            ProactiveRepository.save_initiative(initiative)
        except Exception:
            pass
        raise
    except Exception as exc:
        logger.error(
            "Execution of approved initiative %s failed (role=%s): %s",
            initiative.id, initiative.role_agent_code, exc, exc_info=exc,
        )
        try:
            initiative.status = InitiativeStatus.FAILED
            ProactiveRepository.save_initiative(initiative)
        except Exception:
            pass
        return f"error: {exc}"


@router.post("/approval/{item_id}")
async def process_approval(
    request: Request,
    item_id: str,
    req: ApprovalDecisionRequest,
) -> dict[str, Any]:
    """Process a human decision on an initiative or work-item Task.

    ``item_id`` may be an initiative id or a collab task id (岗位工作项).
    """
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import InitiativeStatus
    from evoflow.proactive.work_items import load_work_item_task

    _code = ""
    try:
        _ap = (
            ProactiveRepository.get_approval(item_id)
            or ProactiveRepository.get_approval_by_initiative(item_id)
            or ProactiveRepository.get_approval_by_task(item_id)
        )
        if _ap:
            _code = str(getattr(_ap, "role_agent_code", None) or "").strip()
        if not _code:
            _init = ProactiveRepository.get_initiative(item_id)
            if _init:
                _code = str(getattr(_init, "role_agent_code", None) or "").strip()
        if not _code:
            _task = load_work_item_task(item_id)
            if _task:
                _code = str(_task.get("assigned_to") or "").strip()
    except Exception:
        _code = ""
    if _code:
        _require_role_agent(request, _code)
    else:
        require_org_admin(request)

    if req.decision not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="decision must be approved|rejected")

    reject_reason = (req.rejection_reason or req.comment or "").strip()
    if req.decision == "rejected" and not reject_reason:
        # Feishu card reject often has no free-text field — allow a default.
        if str(req.decided_by or "").lower().startswith("feishu"):
            reject_reason = "飞书驳回（未填写原因）"
        else:
            raise HTTPException(
                status_code=400,
                detail="驳回须填写原因（rejection_reason），便于员工下一轮改进",
            )

    raw_id = str(item_id or "").strip()
    if raw_id.startswith("task:"):
        raw_id = raw_id[5:]

    init = ProactiveRepository.get_initiative(raw_id)
    task = None if init else load_work_item_task(raw_id)

    if not init and not task:
        raise HTTPException(status_code=404, detail=f"Work item '{item_id}' not found")

    from evoflow.proactive.models import Approval, ApprovalStatus

    gate = DecisionGate()

    if task:
        tid = str(task.get("id") or raw_id).strip()
        approval = ProactiveRepository.get_approval_by_task(tid)
        if not approval:
            role = ProactiveRepository.get_role(str(task.get("assigned_to") or "").strip())
            if not role:
                role = ProactiveRepository.get_role(
                    next(
                        (
                            r.agent_code
                            for r in ProactiveRepository.list_roles()
                            if str(r.role_name or "").strip().lower()
                            == str(task.get("assigned_role") or "").strip().lower()
                        ),
                        "",
                    )
                )
            if not role:
                raise HTTPException(status_code=404, detail="Role for work item not found")
            approval = await gate.request_approval_for_task(role, task)

        # Snapshot before decision: handoff parents are already done and only
        # need downstream dispatch (handled inside process_decision).
        pre_status = str(task.get("status") or "").strip().lower()
        is_handoff_gate = pre_status in {"completed", "reviewed", "awaiting_close"} or bool(
            task.get("handlers_pending_approval")
        )

        updated = await gate.process_decision(
            approval.id,
            decision=req.decision,
            decided_by=req.decided_by,
            comment=req.comment,
            rejection_reason=reject_reason if req.decision == "rejected" else "",
        )

        if updated and req.decision == "approved" and not is_handoff_gate:
            # Start-of-work approval: parent still needs to run.
            role_agent_code = str(approval.role_agent_code or "").strip()
            if not role_agent_code:
                # Fallback: derive from the task's assigned_to role.
                try:
                    role = ProactiveRepository.get_role(
                        str(task.get("assigned_to") or "").strip()
                    )
                    if role:
                        role_agent_code = role.agent_code
                except Exception:
                    pass

            if role_agent_code and _get_proactive_runner().is_role_busy(role_agent_code):
                logger.info(
                    "Role %s is busy on patrol; deferring approved work item %s to pending",
                    role_agent_code,
                    tid,
                )
                from evoflow.proactive.work_items import set_work_item_status
                set_work_item_status(tid, "pending", result="角色忙，暂缓执行")
            else:
                import asyncio
                safe_task = asyncio.create_task(
                    _safe_execute_approved_work_item(tid, role_agent_code or "")
                )
                safe_task.add_done_callback(_log_create_task_result)

        if req.decision != "approved":
            new_status = "cancelled" if not is_handoff_gate else pre_status or "completed"
        elif is_handoff_gate:
            # Parent stays completed; children were woken by dispatch.
            new_status = "dispatched"
        else:
            new_status = "executing"

        return {
            "ok": True,
            "task_id": tid,
            "initiative_id": None,
            "approval_id": approval.id,
            "decision": req.decision,
            "new_status": new_status,
            "handoff": is_handoff_gate,
        }

    # ── Legacy initiative path ──
    if init.status not in (InitiativeStatus.PENDING_APPROVAL, InitiativeStatus.PROPOSED):
        raise HTTPException(
            status_code=400,
            detail=f"Initiative is in status '{init.status.value}', not pending approval",
        )

    approval = ProactiveRepository.get_approval_by_initiative(raw_id)
    if not approval:
        # Orphaned pending_approval (pre-fix) or early approve of PROPOSED:
        # create the Approval row silently so the decision can proceed.
        role = ProactiveRepository.get_role(init.role_agent_code)
        if not role:
            raise HTTPException(status_code=404, detail="Role for initiative not found")
        if init.status == InitiativeStatus.PROPOSED:
            approval = await gate.request_approval(role, init)
        else:
            approval = Approval(
                id=ProactiveRepository.new_approval_id(),
                initiative_id=init.id,
                role_agent_code=init.role_agent_code,
                channel="desktop",
                status=ApprovalStatus.PENDING,
                created_at=utc_now_iso_z(),
                updated_at=utc_now_iso_z(),
            )
            ProactiveRepository.save_approval(approval)
            init.approval_id = approval.id
            ProactiveRepository.save_initiative(init)

    updated_init = await gate.process_decision(
        approval.id,
        decision=req.decision,
        decided_by=req.decided_by,
        comment=req.comment,
        rejection_reason=reject_reason if req.decision == "rejected" else "",
    )

    # If approved, trigger execution
    if updated_init and req.decision == "approved":
        role_agent_code = str(updated_init.role_agent_code or "").strip()
        if role_agent_code and _get_proactive_runner().is_role_busy(role_agent_code):
            logger.info(
                "Role %s is busy on patrol; deferring approved initiative %s to pending",
                role_agent_code,
                raw_id,
            )
            updated_init.status = InitiativeStatus.PENDING
            ProactiveRepository.save_initiative(updated_init)
        else:
            from evoflow.proactive.engine import ProactiveEngine

            engine = ProactiveEngine()
            updated_init.status = InitiativeStatus.EXECUTING
            ProactiveRepository.save_initiative(updated_init)
            # Execute in background (non-blocking)
            import asyncio
            task = asyncio.create_task(
                _safe_execute_approved_initiative(engine, updated_init)
            )
            task.add_done_callback(_log_create_task_result)

    return {
        "ok": True,
        "initiative_id": raw_id,
        "approval_id": approval.id,
        "decision": req.decision,
        "new_status": updated_init.status.value if updated_init else None,
    }


@router.get("/push-log")
async def list_channel_push_log(
    approval_id: str | None = Query(None),
    task_id: str | None = Query(None),
    channel: str | None = Query(None),
    direction: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """Audit trail for Feishu/desktop proactive pushes and user callbacks."""
    from evoflow.persistence.channel_push_repositories import list_by_approval, list_recent

    aid = str(approval_id or "").strip()
    if aid:
        items = list_by_approval(aid, limit=limit)
    else:
        items = list_recent(
            limit=limit,
            channel=channel,
            task_id=str(task_id or "").strip(),
            direction=str(direction or "").strip(),
        )
    return {"items": items, "count": len(items)}


@router.post("/approval/callback")
async def feishu_approval_callback(body: dict = Body(...)) -> dict[str, Any]:
    """Feishu interactive card callback endpoint (HTTP / legacy webhook).

    Preferred path is Feishu WS ``card.action.trigger`` → ``FeishuChannel._on_card_action``.
    Card button ``value`` uses ``action`` (approved|rejected); ``decision`` is also accepted.
    """
    # Formats:
    # - {"action": {"value": {"initiative_id": "...", "action": "approved"}}}
    # - {"value": {"initiative_id": "...", "decision": "approved"}}
    action = body.get("action") or body.get("event") or {}
    if not isinstance(action, dict):
        action = {}
    value = action.get("value") or body.get("value") or {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except Exception:
            value = {}
    if not isinstance(value, dict):
        value = {}

    initiative_id = str(value.get("initiative_id") or "").strip()
    decision = str(value.get("decision") or value.get("action") or "").strip()
    rejection_reason = str(
        value.get("rejection_reason") or value.get("comment") or body.get("rejection_reason") or ""
    ).strip()

    if not initiative_id or not decision:
        raise HTTPException(
            status_code=400,
            detail="Missing initiative_id or decision/action in callback",
        )
    if decision not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="decision/action must be approved|rejected")

    return await process_approval(
        initiative_id,
        ApprovalDecisionRequest(
            decision=decision,
            decided_by="feishu",
            rejection_reason=rejection_reason,
        ),
    )


# ═══════════════════════════════════════════════════════════════════════
#  Memory endpoints
# ═══════════════════════════════════════════════════════════════════════


@router.get("/memory/{agent_code}")
async def get_memory(request: Request, agent_code: str) -> dict[str, Any]:
    _require_role_agent(request, agent_code)
    from evoflow.proactive.repositories import ProactiveMemoryRepository

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")

    mem = ProactiveMemoryRepository.get(agent_code)
    return {
        "role_agent_code": agent_code,
        "observations": mem.observations,
        "strategies": mem.strategies,
        "focus_areas": mem.focus_areas,
        "completed_initiatives": mem.completed_initiatives,
        "failed_initiatives": mem.failed_initiatives,
        "last_think_at": mem.last_think_at,
        "last_think_summary": mem.last_think_summary,
    }


@router.get("/sessions/{agent_code}/conversations")
async def list_role_conversations(
    request: Request,
    agent_code: str,
    kind: str | None = Query(
        None,
        description="Filter: duty|task|chat|legacy (comma-separated ok)",
    ),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """List conversation sessions under an employee workspace."""
    _require_role_agent(request, agent_code)
    from evoflow.proactive.chat_session import list_employee_conversation_sessions

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    kinds = [k.strip() for k in str(kind or "").split(",") if k.strip()] or None
    rows = list_employee_conversation_sessions(
        agent_code, limit=limit, kinds=kinds
    )
    return {
        "agent_code": agent_code,
        "role_name": role.role_name,
        "conversations": rows,
        "count": len(rows),
    }


@router.get("/sessions/{agent_code}/messages")
async def get_role_messages(
    request: Request,
    agent_code: str,
    round_id: str | None = Query(None, description="Filter transcript to one duty round"),
    session_key: str | None = Query(
        None,
        description="Explicit conversation session_key (duty/task/chat); default legacy contact",
    ),
    include_hidden: bool = Query(
        False,
        description="Include hidden duty briefs / context user rows (debug)",
    ),
) -> dict[str, Any]:
    """Return the conversation transcript for a proactive role session.

    When ``session_key`` is omitted, uses legacy ``proactive:{code}`` (back-compat).
    Prefer passing the workspace conversation key from ``/conversations``.
    When ``round_id`` is set, only that duty round's messages are returned
    (aligned with work-log grouping).
    """
    _require_role_agent(request, agent_code)
    from evoflow.persistence.chat_message_repositories import list_messages_for_display_all
    from evoflow.proactive.chat_session import (
        parse_proactive_session_key,
        proactive_session_key,
        resolve_transcript_round_id,
    )

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")

    sk = str(session_key or "").strip() or proactive_session_key(agent_code)
    parsed = parse_proactive_session_key(sk)
    if parsed.get("agent_code") and parsed["agent_code"] != str(agent_code).strip():
        raise HTTPException(status_code=400, detail="session_key does not belong to this agent")
    requested = str(round_id or "").strip() or None
    rid = resolve_transcript_round_id(sk, requested) if requested else None
    result = list_messages_for_display_all(
        sk,
        max_rows=200,
        round_id=rid,
        include_hidden=bool(include_hidden),
    )
    cost_info: dict[str, Any] = {}
    try:
        from evoflow.proactive.repositories import ProactiveCostRepository

        if rid:
            cost_info = ProactiveCostRepository.get_round_cost(agent_code, rid)
        else:
            today = ProactiveCostRepository.get_daily_cost(agent_code)
            today_tokens = ProactiveCostRepository.get_daily_tokens(agent_code)
            cost_info = {
                "role_agent_code": agent_code,
                "round_id": "",
                "cost_usd": round(float(today), 6),
                "total_tokens": int(today_tokens or 0),
                "scope": "today",
            }
    except Exception:
        logger.debug("proactive.messages: cost lookup failed", exc_info=True)
        cost_info = {}
    return {
        "role_agent_code": agent_code,
        "session_key": sk,
        "workspace_kind": parsed.get("kind"),
        "round_id": rid,
        "requested_round_id": requested,
        "messages": result.get("messages") or [],
        "has_more": result.get("has_more", False),
        "oldest_seq": result.get("oldest_seq"),
        "cost": cost_info,
    }


# ═══════════════════════════════════════════════════════════════════════
#  Status endpoint
# ═══════════════════════════════════════════════════════════════════════


@router.get("/status")
async def get_status() -> dict[str, Any]:
    runner = _get_proactive_runner()
    return runner.status()


@router.get("/roles/{agent_code}/cost")
async def get_role_cost(request: Request, agent_code: str, days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """Cost summary for a role over the last N days (O2.2)."""
    _require_role_agent(request, agent_code)
    from evoflow.proactive.repositories import ProactiveCostRepository

    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")

    summary = ProactiveCostRepository.get_cost_summary(agent_code, days=days)
    today_cost = ProactiveCostRepository.get_daily_cost(agent_code)
    today_tokens = ProactiveCostRepository.get_daily_tokens(agent_code)
    return {
        "ok": True,
        "agent_code": agent_code,
        "role_name": role.role_name,
        "today_cost_usd": round(today_cost, 6),
        "today_tokens": today_tokens,
        "daily_budget_usd": role.config.daily_budget_usd,
        "budget_remaining_usd": round(
            max(0, role.config.daily_budget_usd - today_cost)
            if role.config.daily_budget_usd > 0
            else -1,
            6,
        ),
        **summary,
    }


@router.get("/dashboard")
async def get_dashboard(request: Request) -> dict[str, Any]:
    """Proactive health dashboard - aggregated metrics for all roles (O4.1).

    Returns per-role: today cost, 7-day trend, approval stats, zombie count,
    and recent initiative outcome distribution.
    """
    from evoflow.proactive.repositories import (
        ProactiveCostRepository,
        ProactiveMemoryRepository,
        ProactiveRepository,
    )

    roles = _filter_roles_for_request(request, ProactiveRepository.list_roles())
    role_summaries: list[dict[str, Any]] = []
    alerts: list[dict[str, Any]] = []

    for role in roles:
        code = role.agent_code
        today_cost = ProactiveCostRepository.get_daily_cost(code)
        today_tokens = ProactiveCostRepository.get_daily_tokens(code)
        cost_7d = ProactiveCostRepository.get_cost_summary(code, days=7)

        # Initiative stats (last 50)
        inits = ProactiveRepository.list_initiatives(role_agent_code=code, limit=50)
        status_counts: dict[str, int] = {}
        no_op_count = 0
        for init in inits:
            st = init.status.value
            status_counts[st] = status_counts.get(st, 0) + 1
            if init.status.value == "completed":
                outcome = (init.outcome or "")
                if any(
                    kw in outcome
                    for kw in ("无事", "无变化", "无新", "一致", "无异常", "健康")
                ):
                    no_op_count += 1

        completed = status_counts.get("completed", 0)
        no_op_pct = round(100 * no_op_count / completed, 1) if completed else 0.0

        # Stale executing (zombie) count
        stale = ProactiveRepository.list_stale_executing(max_age_minutes=45, limit=200)
        zombie_count = sum(1 for s in stale if s.role_agent_code == code)

        # Approval stats
        all_approvals = ProactiveRepository.list_approvals(limit=200)
        role_approvals = [a for a in all_approvals if a.role_agent_code == code]
        appr_total = len(role_approvals)
        appr_approved = sum(1 for a in role_approvals if a.status.value == "approved")
        appr_timeout = sum(1 for a in role_approvals if a.status.value == "timeout")
        appr_rejected = sum(1 for a in role_approvals if a.status.value == "rejected")
        timeout_rate = round(100 * appr_timeout / appr_total, 1) if appr_total else 0.0

        consecutive_noop = 0
        try:
            mem = ProactiveMemoryRepository.get(code)
            consecutive_noop = int((mem.extra or {}).get("consecutive_noop_count", 0) or 0)
        except Exception:
            consecutive_noop = 0

        idle_suspected = consecutive_noop >= 3
        budget = float(role.config.daily_budget_usd or 0)
        budget_warn = budget > 0 and today_cost >= budget * 0.8

        if zombie_count > 0:
            alerts.append(
                {
                    "level": "error" if zombie_count > 5 else "warn",
                    "kind": "zombie",
                    "agent_code": code,
                    "message": f"{role.role_name} 有 {zombie_count} 条卡住执行（超过 45 分钟仍未结束）",
                }
            )
        if timeout_rate > 80 and appr_total >= 5:
            alerts.append(
                {
                    "level": "error",
                    "kind": "timeout_rate",
                    "agent_code": code,
                    "message": f"{role.role_name} 审批超时率 {timeout_rate}%",
                }
            )
        if idle_suspected:
            alerts.append(
                {
                    "level": "warn",
                    "kind": "idle",
                    "agent_code": code,
                    "message": f"{role.role_name} 连续 {consecutive_noop} 轮疑似空转",
                }
            )
        if budget_warn:
            alerts.append(
                {
                    "level": "warn",
                    "kind": "budget",
                    "agent_code": code,
                    "message": f"{role.role_name} 今日成本接近/超过预算",
                }
            )

        role_summaries.append({
            "agent_code": code,
            "role_name": role.role_name,
            "status": role.status,
            "today_cost_usd": round(today_cost, 6),
            "today_tokens": today_tokens,
            "cost_7d_total_usd": cost_7d.get("total_cost_usd", 0),
            "cost_7d_total_tokens": cost_7d.get("total_tokens", 0),
            "cost_7d_days": cost_7d.get("days", []),
            "daily_budget_usd": role.config.daily_budget_usd,
            "initiative_status_counts": status_counts,
            "no_op_pct": no_op_pct,
            "zombie_executing_count": zombie_count,
            "consecutive_noop_count": consecutive_noop,
            "idle_suspected": idle_suspected,
            "budget_warn": budget_warn,
            "approval_stats": {
                "total": appr_total,
                "approved": appr_approved,
                "rejected": appr_rejected,
                "timeout": appr_timeout,
                "approval_rate": round(100 * appr_approved / appr_total, 1) if appr_total else 0.0,
                "timeout_rate": timeout_rate,
            },
        })

    # Global aggregates
    total_today_cost = sum(r["today_cost_usd"] for r in role_summaries)
    total_zombies = sum(r["zombie_executing_count"] for r in role_summaries)

    return {
        "ok": True,
        "timestamp": utc_now_iso_z(),
        "roles": role_summaries,
        "alerts": alerts,
        "global": {
            "total_today_cost_usd": round(total_today_cost, 6),
            "total_zombie_executing": total_zombies,
            "active_roles": sum(1 for r in role_summaries if r["status"] == "active"),
            "paused_roles": sum(1 for r in role_summaries if r["status"] == "paused"),
            "alert_count": len(alerts),
        },
    }


@router.post("/enable")
async def enable_runner(request: Request) -> dict[str, Any]:
    """Enable the proactive engine globally (runtime, bypasses env var)."""
    require_org_admin(request)
    runner = _get_proactive_runner()
    if runner.is_running:
        return {"ok": True, "already_running": True, **runner.status()}
    runner.enable()
    return {"ok": True, "running": runner.is_running, **runner.status()}


@router.post("/disable")
async def disable_runner(request: Request) -> dict[str, Any]:
    """Disable global auto duty: stop the tick loop and cancel in-flight patrols.

    After this, due heartbeats must not fire until ``/enable``. Preference is
    persisted across Gateway restart.
    """
    require_org_admin(request)
    runner = _get_proactive_runner()
    if not runner.is_running and not runner.busy_roles():
        # Still persist off in case restart preference drifted
        try:
            runner._persist_engine_enabled(False)
        except Exception:
            pass
        return {"ok": True, "already_stopped": True, **runner.status()}
    await runner.stop()
    return {"ok": True, "running": runner.is_running, **runner.status()}


@router.put("/roles/{agent_code}/pause")
async def pause_role(request: Request, agent_code: str) -> dict[str, Any]:
    """Pause a specific role (stops heartbeat + cancels in-flight patrol)."""
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    runner = _get_proactive_runner()
    was_busy = runner.is_role_busy(agent_code)
    role.status = "paused"
    role.config.auto_patrol_suspended = True
    role.next_heartbeat_at = None
    ProactiveRepository.save_role(role)

    async def _cancel_in_background() -> None:
        try:
            await runner.cancel_role(agent_code)
        except Exception:
            logger.exception(
                "proactive.role.pause cancel_role failed agent_code=%s",
                agent_code,
            )

    asyncio.create_task(_cancel_in_background())
    logger.info(
        "proactive.role.paused agent_code=%s was_busy=%s (cancel scheduled)",
        agent_code,
        was_busy,
    )
    return {
        "ok": True,
        "agent_code": agent_code,
        "status": "paused",
        "was_busy": was_busy,
    }


@router.post("/roles/{agent_code}/stop")
async def stop_role_work(request: Request, agent_code: str) -> dict[str, Any]:
    """Stop in-flight work and suspend auto patrol until resume.

    Keeps ``status`` (often still ``active``) but sets ``auto_patrol_suspended``
    so due heartbeats will not fire.
    """
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    runner = _get_proactive_runner()
    cancel_info = await runner.cancel_role(agent_code)
    role.config.auto_patrol_suspended = True
    role.next_heartbeat_at = None
    ProactiveRepository.save_role(role)
    logger.info(
        "proactive.role.stop agent_code=%s was_busy=%s status=%s auto_patrol_suspended=true",
        agent_code,
        cancel_info.get("was_busy"),
        role.status,
    )
    return {
        "ok": True,
        "agent_code": agent_code,
        "status": role.status,
        "stopped": True,
        "auto_patrol_suspended": True,
        **cancel_info,
    }


@router.put("/roles/{agent_code}/resume")
async def resume_role(request: Request, agent_code: str) -> dict[str, Any]:
    """Resume a paused / draft / archived role back to active (上岗)."""
    _require_role_agent(request, agent_code)
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        raise HTTPException(status_code=404, detail=f"Role '{agent_code}' not found")
    prev = role.status
    role.status = "active"
    role.config.auto_patrol_suspended = False
    role.updated_at = utc_now_iso_z()
    if not role.next_heartbeat_at:
        from evoflow.proactive.schedule import compute_next_duty_iso

        role.next_heartbeat_at = compute_next_duty_iso(role)
    ProactiveRepository.save_role(role)
    logger.info("proactive.role.resumed agent_code=%s from=%s", agent_code, prev)
    return {"ok": True, "agent_code": agent_code, "status": "active", "from_status": prev}


# ═══════════════════════════════════════════════════════════════════════
#  Helpers
# ═══════════════════════════════════════════════════════════════════════


def _feishu_binding_for_role(role: ProactiveRole) -> dict[str, Any]:
    from evoflow.proactive.feishu_binding import feishu_binding_public

    return feishu_binding_public(role.config)


def _role_to_dict(role: ProactiveRole) -> dict[str, Any]:
    from evoflow.proactive.schedule import (
        resolve_next_duty_display,
        resolve_role_cron,
        schedule_summary_for_role,
    )

    next_duty = resolve_next_duty_display(role)
    within_work_hours = True
    try:
        from evoflow.proactive.schedule import cron_matches_role_now

        if role.config.work_schedule_enabled:
            within_work_hours = cron_matches_role_now(role)
    except Exception:
        within_work_hours = True
    system_front_desk = False
    agent_name = ""
    agent_description = ""
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        system_front_desk = is_xiaomi_agent(role.agent_code)
    except Exception:
        system_front_desk = False
    try:
        from evoflow.admin.agents import get_agent

        agent_row = get_agent(str(role.agent_code or "").strip())
        agent_name = str(agent_row.get("agent_name") or "").strip()
        agent_description = str(agent_row.get("description") or "").strip()
    except Exception:
        pass
    # 岗位名只返回雇佣合同上的 role_name；空/脏/塌成 agent_code 时置空。
    # 禁止用 agent_name 或英文 agent_code 冒充岗位名。
    code = str(role.agent_code or "").strip()
    display_name = str(role.role_name or "").strip()
    if (
        not display_name
        or display_name.casefold() in {"none", "null", "undefined"}
        or (code and display_name == code)
    ):
        display_name = ""
    return {
        "agent_code": role.agent_code,
        "role_name": display_name,
        "agent_name": agent_name,
        "agent_description": agent_description,
        "department": role.department,
        "system_front_desk": system_front_desk,
        "config": {
            "responsibilities": role.config.responsibilities,
            "workspace_path": role.config.workspace_path,
            "domain_scope": role.config.domain_scope,
            "knowledge_vault_ids": list(getattr(role.config, "knowledge_vault_ids", None) or []),
            "kpis": role.config.kpis,
            "autonomy_level": role.config.autonomy_level.value,
            "max_initiatives_per_cycle": role.config.max_initiatives_per_cycle,
            "risk_threshold": role.config.risk_threshold.value,
            "approval_channels": role.config.approval_channels,
            "approval_timeout_minutes": role.config.approval_timeout_minutes,
            "soul_md": role.config.soul_md[:200] if role.config.soul_md else "",
            "think_mode": role.config.think_mode,
            "model_name": role.config.model_name or "",
            "max_turns": role.config.max_turns,
            "timeout_seconds": role.config.timeout_seconds,
            "tool_groups": role.config.tool_groups,
            "skills": role.config.skills,
            "work_schedule_enabled": role.config.work_schedule_enabled,
            "work_start_hour": role.config.work_start_hour,
            "work_end_hour": role.config.work_end_hour,
            "approval_timeout_by_type": role.config.approval_timeout_by_type,
            "daily_budget_usd": role.config.daily_budget_usd,
            "per_run_budget_usd": float(getattr(role.config, "per_run_budget_usd", 0) or 0),
            "budget_exceed_policy": str(
                getattr(role.config, "budget_exceed_policy", None) or "skip_patrol"
            ),
            "auto_patrol_suspended": bool(getattr(role.config, "auto_patrol_suspended", False)),
            "reports_to": str(getattr(role.config, "reports_to", "") or "").strip(),
            "feishu_binding": _feishu_binding_for_role(role),
        },
        "reports_to": str(getattr(role.config, "reports_to", "") or "").strip(),
        "feishu_binding": _feishu_binding_for_role(role),
        "heartbeat_rrule": role.heartbeat_rrule,
        "heartbeat_schedule": resolve_role_cron(role),
        "schedule_summary": schedule_summary_for_role(role),
        "status": role.status,
        "auto_patrol_suspended": bool(getattr(role.config, "auto_patrol_suspended", False)),
        "within_work_hours": within_work_hours,
        "last_heartbeat_at": role.last_heartbeat_at,
        "next_heartbeat_at": next_duty,
        "created_at": role.created_at,
        "updated_at": role.updated_at,
    }


def _initiative_result(status) -> str | None:
    """Terminal execution outcome — distinct from lifecycle ``status``.

    ``completed`` / ``failed`` are both "done", but result tells success vs failure.
    """
    from evoflow.proactive.models import InitiativeStatus

    if status == InitiativeStatus.COMPLETED:
        return "success"
    if status == InitiativeStatus.FAILED:
        return "failure"
    return None


def _initiative_to_dict(init) -> dict[str, Any]:
    return {
        "id": init.id,
        "role_agent_code": init.role_agent_code,
        "title": init.title,
        "description": init.description,
        "rationale": init.rationale,
        "action_type": init.action_type.value,
        "risk_level": init.risk_level.value,
        "action_plan": init.action_plan,
        "expected_outcome": init.expected_outcome,
        "status": init.status.value,
        # success | failure | null — 失败≠成功，勿与「流程已结束」混读 status
        "result": _initiative_result(init.status),
        "approval_id": init.approval_id,
        "approved_by": init.approved_by,
        "approved_at": init.approved_at,
        "approval_timeout_minutes": init.approval_timeout_minutes,
        "execution_thread_id": init.execution_thread_id,
        "execution_result": init.execution_result,
        "round_id": init.round_id,
        "goal": init.goal,
        "outcome": init.outcome,
        "created_at": init.created_at,
        "updated_at": init.updated_at,
    }


def _synthesize_round_journals_from_chat(
    agent_code: str,
    *,
    limit: int = 40,
) -> list[dict[str, Any]]:
    """Build synthetic round_log rows from proactive chat rounds (Task-only path)."""
    code = str(agent_code or "").strip()
    if not code:
        return []
    sk = f"proactive:{code}"
    try:
        from evoflow.persistence.db import get_db

        rows = (
            get_db()
            .execute(
                """
                SELECT round_id,
                       MIN(created_at) AS first_at,
                       MAX(created_at) AS last_at,
                       COUNT(*) AS msg_n,
                       SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_n
                FROM evoflow_chat_messages
                WHERE session_key = ?
                  AND round_id IS NOT NULL
                  AND TRIM(round_id) != ''
                GROUP BY round_id
                ORDER BY last_at DESC
                LIMIT ?
                """,
                (sk, max(1, min(int(limit), 80))),
            )
            .fetchall()
        )
    except Exception:
        logger.debug(
            "proactive.work_board: synth rounds from chat failed role=%s",
            code,
            exc_info=True,
        )
        return []

    out: list[dict[str, Any]] = []
    for row in rows:
        rid = str(row["round_id"] or "").strip()
        if not rid:
            continue
        first_at = str(row["first_at"] or "").strip()
        last_at = str(row["last_at"] or "").strip() or first_at
        msg_n = int(row["msg_n"] or 0)
        tool_n = int(row["tool_n"] or 0)
        kind = "派发" if rid.startswith("dispatch:") else "值班"
        out.append(
            {
                "id": f"chat-round:{rid}",
                "role_agent_code": code,
                "title": f"{kind}轮次",
                "description": f"轨迹 {msg_n} 条 · 工具 {tool_n} 次",
                "rationale": "",
                "action_type": "report",
                "risk_level": "low",
                "action_plan": {
                    "kind": "round_log",
                    "phase": "wrap_up",
                    "synthetic": True,
                    "source": "chat",
                    "msg_count": msg_n,
                    "tool_count": tool_n,
                },
                "expected_outcome": "",
                "status": "completed",
                "result": "success",
                "approval_id": None,
                "approved_by": None,
                "approved_at": None,
                "approval_timeout_minutes": 0,
                "execution_thread_id": None,
                "execution_result": "",
                "round_id": rid,
                "goal": "",
                "outcome": f"本轮轨迹 {msg_n} 条（工具 {tool_n} 次）；细节见「工作轨迹」",
                "created_at": first_at,
                "updated_at": last_at,
            }
        )
    return out


def _approval_to_dict(appr, *, enrich: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": appr.id,
        "initiative_id": appr.initiative_id,
        "task_id": getattr(appr, "task_id", "") or "",
        "role_agent_code": appr.role_agent_code,
        "channel": appr.channel,
        "feishu_message_id": appr.feishu_message_id,
        "status": appr.status.value,
        "decided_by": appr.decided_by,
        "decided_at": appr.decided_at,
        "decision_comment": appr.decision_comment,
        "rejection_reason": appr.rejection_reason,
        "escalation_level": appr.escalation_level,
        "created_at": appr.created_at,
        "updated_at": appr.updated_at,
        "kind": "initiative",
        "orphan": False,
        "summary": "",
        "outputs": [],
        "handlers": [],
        "push_log": [],
    }
    if not enrich:
        return out
    try:
        from evoflow.persistence.channel_push_repositories import list_by_approval

        out["push_log"] = list_by_approval(str(appr.id or ""), limit=30)
    except Exception:
        out["push_log"] = []
    role = ProactiveRepository.get_role(appr.role_agent_code)
    init = ProactiveRepository.get_initiative(appr.initiative_id)
    out["role_name"] = (role.role_name if role else "") or appr.role_agent_code
    if init:
        risk = init.risk_level
        out["initiative_title"] = init.title
        out["initiative_description"] = (init.description or "")[:400]
        out["risk_level"] = risk.value if hasattr(risk, "value") else str(risk or "")
        out["action_type"] = (
            init.action_type.value if hasattr(init.action_type, "value") else str(init.action_type or "")
        )
        out["approval_timeout_minutes"] = int(init.approval_timeout_minutes or 30)
        out["goal"] = init.goal or ""
    else:
        out["initiative_title"] = ""
        out["initiative_description"] = ""
        out["risk_level"] = ""
        out["action_type"] = ""
        out["approval_timeout_minutes"] = 30
        out["goal"] = ""

    tid = str(out.get("task_id") or "").strip()
    if not tid and str(appr.initiative_id or "").startswith("task:"):
        tid = str(appr.initiative_id)[5:].strip()
        out["task_id"] = tid
    if tid:
        try:
            from evoflow.admin.tasks import task_summary_of
            from evoflow.collab.task_handlers import task_handlers_of
            from evoflow.collab.task_outputs import task_outputs_of
            from evoflow.proactive.work_items import load_work_item_task

            task = load_work_item_task(tid)
            if not task:
                out["orphan"] = True
                out["kind"] = "orphan"
                if not out.get("initiative_title"):
                    out["initiative_title"] = f"任务已删除 · {tid}"
            else:
                handlers = task_handlers_of(task)
                pending_handoff = task.get("handlers_pending_approval") in (
                    True,
                    "true",
                    "1",
                    1,
                )
                out["kind"] = "handoff" if (pending_handoff or handlers) else "task"
                name = str(task.get("name") or task.get("title") or "").strip()
                if name:
                    out["initiative_title"] = name
                summary = task_summary_of(task)
                out["summary"] = summary
                desc = str(task.get("description") or "").strip()
                # Prefer deliverable summary for the approval body.
                body = summary or desc
                if body:
                    out["initiative_description"] = body[:800]
                out["outputs"] = task_outputs_of(task)
                # Panel / Feishu approval cards: docs & media only (never source code).
                try:
                    from evoflow.collab.task_outputs import shareable_approval_outputs

                    out["outputs"] = shareable_approval_outputs(out["outputs"])
                except Exception:
                    pass
                out["handlers"] = handlers
                if not out.get("risk_level"):
                    out["risk_level"] = str(task.get("risk_level") or "").strip()
                if not out.get("action_type"):
                    out["action_type"] = str(task.get("action_type") or "").strip()
        except Exception:
            logger.debug(
                "proactive.approval enrich task failed task=%s",
                tid,
                exc_info=True,
            )
    return out
