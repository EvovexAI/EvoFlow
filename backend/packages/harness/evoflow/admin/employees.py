"""Proactive AI employees (智能体员工) — hire/update roles; observe; dispatch via Gateway."""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections import Counter
from typing import Any

import httpx

from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError
from evoflow.proactive.models import (
    Initiative,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
    normalize_role_status,
)
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Workspace paths that must never be bound as an employee work root.
_DENIED_WORKSPACE_PREFIXES = (
    "c:/windows/",
    "c:/program files/",
    "c:/program files (x86)/",
    "c:/programdata/",
    "/windows/",
    "/etc/",
    "/proc/",
    "/sys/",
    "/dev/",
    "/root/",
    "/boot/",
    "/usr/bin/",
    "/usr/sbin/",
    "/bin/",
    "/sbin/",
)
_DENIED_WORKSPACE_SUFFIXES = (
    "/sam",
    "/system32/config/sam",
    "/etc/shadow",
    "/etc/passwd",
)


def _normalize_path_for_safety_check(path: str) -> str:
    s = str(path or "").strip().replace("\\", "/").lower()
    # Collapse duplicate slashes for prefix matching.
    while "//" in s:
        s = s.replace("//", "/")
    return s


def _validate_workspace_path(path: Any) -> str:
    raw = str(path or "").strip()
    if not raw:
        return ""
    if "\x00" in raw:
        raise ValidationError("workspace_path contains illegal characters")
    # Reject parent-directory traversal segments.
    parts = raw.replace("\\", "/").split("/")
    if any(p == ".." for p in parts):
        raise ValidationError("workspace_path must not contain '..' segments")
    check = _normalize_path_for_safety_check(raw)
    for prefix in _DENIED_WORKSPACE_PREFIXES:
        if check.startswith(prefix) or check == prefix.rstrip("/"):
            raise ValidationError(
                "workspace_path is not allowed: points to a sensitive system location"
            )
    for suffix in _DENIED_WORKSPACE_SUFFIXES:
        if check.endswith(suffix) or suffix in check:
            raise ValidationError(
                "workspace_path is not allowed: points to a sensitive system location"
            )
    return raw


def _parse_worklog_day(day: str | None) -> str:
    """Parse and calendar-validate ``YYYY-MM-DD`` (Asia/Shanghai when defaulting)."""
    from datetime import date, datetime

    from evoflow.timeutil import BEIJING_TZ

    day_s = str(day or "").strip()
    if not day_s:
        return datetime.now(BEIJING_TZ).date().isoformat()
    if not _DAY_RE.match(day_s):
        raise ValidationError("day must be YYYY-MM-DD")
    try:
        y, m, d = (int(p) for p in day_s.split("-"))
        date(y, m, d)
    except ValueError as e:
        raise ValidationError(f"day is not a valid calendar date: {day_s}") from e
    return day_s

_HIRE_KEYS = frozenset(
    {
        "agent_code",
        "role_name",
        "position_code",
        "department",
        "responsibilities",
        "workspace_path",
        "domain_scope",
        "knowledge_vault_ids",
        "kpis",
        "autonomy_level",
        "max_initiatives_per_cycle",
        "risk_threshold",
        "approval_channels",
        "approval_timeout_minutes",
        "heartbeat_rrule",
        "heartbeat_schedule",
        "soul_md",
        "think_mode",
        "model_name",
        "max_turns",
        "timeout_seconds",
        "tool_groups",
        "skills",
        "work_schedule_enabled",
        "work_start_hour",
        "work_end_hour",
        "approval_timeout_by_type",
        "daily_budget_usd",
        "per_run_budget_usd",
        "budget_exceed_policy",
        "status",
        "reports_to",
    }
)

_UPDATE_KEYS = frozenset(_HIRE_KEYS - {"agent_code"}) | frozenset(
    {"dnd_enabled", "dnd_start_hour", "dnd_end_hour"}
)


def _proactive_api_base() -> str:
    env = (os.getenv("EVOFLOW_PROACTIVE_URL") or "").strip()
    if env:
        return env.rstrip("/")
    lg = (os.getenv("EVOFLOW_LANGGRAPH_URL") or "http://127.0.0.1:8070/api/langgraph").rstrip("/")
    if lg.endswith("/api/langgraph"):
        return lg[: -len("/api/langgraph")] + "/api/proactive"
    if lg.endswith("/api/proactive"):
        return lg  # 已经是 proactive URL，直接返回
    # Derive /api/proactive from the custom base URL instead of falling back to
    # 127.0.0.1:8070 which silently breaks dispatch/pause/archive on non-default hosts.
    return lg.rstrip("/") + "/api/proactive"


def _fetch_gateway_status() -> dict[str, Any] | None:
    """Live runner status (busy_roles). None when Gateway unreachable."""
    url = f"{_proactive_api_base()}/status"
    try:
        with httpx.Client(timeout=3.0) as client:
            r = client.get(url)
            if r.status_code == 200:
                data = r.json()
                return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None


def _try_gateway_put(path: str) -> dict[str, Any] | None:
    """Best-effort Gateway PUT (e.g. cancel in-flight on pause/archive)."""
    url = f"{_proactive_api_base()}{path}"
    try:
        with httpx.Client(timeout=8.0) as client:
            r = client.put(url)
            if r.status_code < 400:
                data = r.json() if r.content else {}
                return data if isinstance(data, dict) else {"ok": True}
    except Exception:
        return None
    return None


def _try_gateway_post(path: str) -> dict[str, Any] | None:
    """Best-effort Gateway POST (e.g. stop in-flight without pause)."""
    url = f"{_proactive_api_base()}{path}"
    try:
        with httpx.Client(timeout=8.0) as client:
            r = client.post(url)
            if r.status_code < 400:
                data = r.json() if r.content else {}
                return data if isinstance(data, dict) else {"ok": True}
    except Exception:
        return None
    return None


def _initiative_result(status: InitiativeStatus) -> str | None:
    # Terminal success states
    if status in (InitiativeStatus.COMPLETED, InitiativeStatus.APPROVED):
        return "success"
    # Terminal failure states
    if status in (
        InitiativeStatus.FAILED,
        InitiativeStatus.REJECTED,
        InitiativeStatus.TIMEOUT_REJECTED,
        InitiativeStatus.SKIPPED,
    ):
        return "failure"
    # Non-terminal states (PROPOSED, PENDING_APPROVAL, EXECUTING) → None
    return None


def _normalize_reports_to(agent_code: str, raw: Any) -> str:
    """Validate and normalize manager agent_code (empty clears)."""
    from evoflow.proactive.org import would_create_cycle

    mgr = str(raw or "").strip()
    self_code = str(agent_code or "").strip()
    if not mgr:
        return ""
    if mgr == self_code:
        raise ValidationError("reports_to cannot be yourself")
    target = ProactiveRepository.get_role(mgr)
    if not target:
        raise ValidationError(f"reports_to role '{mgr}' not found")
    if str(target.status or "").strip().lower() == "archived":
        raise ValidationError(f"reports_to role '{mgr}' is archived")
    roster = ProactiveRepository.list_roles()
    if would_create_cycle(self_code, mgr, roster):
        raise ValidationError(f"reports_to '{mgr}' would create a reporting cycle")
    return mgr


def _employee_inherits_agent(cfg: ProactiveRoleConfig) -> bool:
    """True when employee capabilities should follow the linked Agent."""
    extra = cfg.extra_context if isinstance(cfg.extra_context, dict) else {}
    # Default inherit=True; explicit override_capabilities=True opts out.
    return not bool(extra.get("override_capabilities"))


def _mark_employee_override(cfg: ProactiveRoleConfig, *, override: bool) -> None:
    extra = dict(cfg.extra_context or {}) if isinstance(cfg.extra_context, dict) else {}
    if override:
        extra["override_capabilities"] = True
    else:
        extra.pop("override_capabilities", None)
    cfg.extra_context = extra


def sync_employee_from_agent(agent_code: str) -> dict[str, Any]:
    """Push Agent skills/soul/tools/model onto the linked Employee when inheriting.

    Returns ``{"synced": bool, ...}``. No-op when no role or employee opted out.
    """
    code = str(agent_code or "").strip()
    if not code:
        return {"synced": False, "reason": "empty_code"}
    role = ProactiveRepository.get_role(code)
    if not role:
        return {"synced": False, "reason": "no_employee"}
    if not _employee_inherits_agent(role.config):
        return {"synced": False, "reason": "employee_override"}

    from evoflow.admin.agents import get_agent

    try:
        agent_row = get_agent(code)
    except Exception as exc:
        return {"synced": False, "reason": f"agent_load_failed: {exc}"}

    cfg = role.config
    cfg.skills = list(agent_row.get("skills") or [])
    cfg.soul_md = str(agent_row.get("soul") or "")
    # Prefer explicit tool_groups; fall back to tools list as group-like binding.
    tool_groups = list(agent_row.get("tool_groups") or [])
    if not tool_groups and agent_row.get("tools"):
        tool_groups = list(agent_row.get("tools") or [])
    cfg.tool_groups = tool_groups
    model = str(agent_row.get("model") or "").strip()
    if model:
        cfg.model_name = model
    # Keep a description mirror for observability (not a native role field).
    extra = dict(cfg.extra_context or {}) if isinstance(cfg.extra_context, dict) else {}
    extra["agent_description"] = str(agent_row.get("description") or "")
    extra["agent_tags"] = list(agent_row.get("tags") or [])
    extra["agent_tools"] = list(agent_row.get("tools") or [])
    cfg.extra_context = extra
    _mark_employee_override(cfg, override=False)

    role.config = cfg
    role.updated_at = utc_now_iso_z()
    # 岗位名与智能体名分离：仅在完全空/脏时保持为空，禁止用 agent_name 回填
    current_name = str(role.role_name or "").strip()
    if (
        not current_name
        or current_name == code
        or current_name.casefold() in {"none", "null", "undefined"}
    ):
        role.role_name = ""
    ProactiveRepository.save_role(role)
    return {"synced": True, "agent_code": code}


def _role_detail(role: ProactiveRole) -> dict[str, Any]:
    cfg = role.config
    from evoflow.proactive.schedule import (
        resolve_next_duty_display,
        resolve_role_cron,
        schedule_summary_for_role,
    )

    reports_to = str(getattr(cfg, "reports_to", "") or "").strip()
    skills = list(cfg.skills or [])
    soul_md = (cfg.soul_md or "")[:500]
    tool_groups = list(cfg.tool_groups or [])
    model_name = cfg.model_name or ""
    agent_description = ""
    agent_tags: list[str] = []
    agent_tools: list[str] = []
    inherits = _employee_inherits_agent(cfg)

    # Runtime prefer Agent when inheriting (effective view).
    if inherits:
        try:
            from evoflow.admin.agents import get_agent

            agent_row = get_agent(role.agent_code)
            skills = list(agent_row.get("skills") or skills)
            soul_full = str(agent_row.get("soul") or "")
            if soul_full:
                soul_md = soul_full[:500]
            tg = list(agent_row.get("tool_groups") or [])
            tools = list(agent_row.get("tools") or [])
            tool_groups = tg or tools or tool_groups
            if agent_row.get("model"):
                model_name = str(agent_row.get("model") or model_name)
            agent_description = str(agent_row.get("description") or "")
            agent_tags = list(agent_row.get("tags") or [])
            agent_tools = tools
        except Exception:
            pass

    return {
        "agent_code": role.agent_code,
        "role_name": role.role_name,
        "position_code": role.position_code or "",
        "department": role.department,
        "reports_to": reports_to,
        "inherits_agent": inherits,
        "description": agent_description,
        "tags": agent_tags,
        "config": {
            "responsibilities": list(cfg.responsibilities or []),
            "workspace_path": cfg.workspace_path or "",
            "domain_scope": list(cfg.domain_scope or []),
            "knowledge_vault_ids": list(getattr(cfg, "knowledge_vault_ids", None) or []),
            "kpis": list(cfg.kpis or []),
            "autonomy_level": cfg.autonomy_level.value,
            "max_initiatives_per_cycle": cfg.max_initiatives_per_cycle,
            "risk_threshold": cfg.risk_threshold.value,
            "approval_channels": list(cfg.approval_channels or []),
            "approval_timeout_minutes": cfg.approval_timeout_minutes,
            "soul_md": soul_md,
            "think_mode": cfg.think_mode,
            "model_name": model_name,
            "max_turns": cfg.max_turns,
            "timeout_seconds": cfg.timeout_seconds,
            "tool_groups": tool_groups,
            "tools": agent_tools,
            "skills": skills,
            "work_schedule_enabled": cfg.work_schedule_enabled,
            "work_start_hour": cfg.work_start_hour,
            "work_end_hour": cfg.work_end_hour,
            "approval_timeout_by_type": dict(cfg.approval_timeout_by_type or {}),
            "daily_budget_usd": cfg.daily_budget_usd,
            "per_run_budget_usd": float(getattr(cfg, "per_run_budget_usd", 0) or 0),
            "budget_exceed_policy": str(getattr(cfg, "budget_exceed_policy", None) or "skip_patrol"),
            "reports_to": reports_to,
        },
        "heartbeat_rrule": role.heartbeat_rrule,
        "heartbeat_schedule": resolve_role_cron(role),
        "schedule_summary": schedule_summary_for_role(role),
        "status": role.status,
        "last_heartbeat_at": role.last_heartbeat_at,
        "next_heartbeat_at": resolve_next_duty_display(role),
        "created_at": role.created_at,
        "updated_at": role.updated_at,
    }


def _parse_autonomy(raw: Any) -> ProactiveAutonomyLevel:
    s = str(raw or "approval_for_all").strip()
    try:
        return ProactiveAutonomyLevel(s)
    except ValueError as e:
        raise ValidationError(f"Invalid autonomy_level: {s}") from e


def _parse_risk(raw: Any) -> InitiativeRiskLevel:
    s = str(raw or "medium").strip()
    try:
        return InitiativeRiskLevel(s)
    except ValueError as e:
        raise ValidationError(f"Invalid risk_threshold: {s}") from e


def get_role(agent_code: str, *, recent_limit: int = 10) -> dict[str, Any]:
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    result = _role_detail(role)
    lim = max(0, min(int(recent_limit), 50))
    if lim:
        inits = ProactiveRepository.list_initiatives(role_agent_code=code, limit=lim)
        result["recent_initiatives"] = [
            {
                "id": i.id,
                "title": i.title,
                "status": i.status.value,
                "result": _initiative_result(i.status),
                "action_type": i.action_type.value,
                "round_id": i.round_id,
                "created_at": i.created_at,
            }
            for i in inits
        ]
    return result


def hire(data: dict[str, Any]) -> dict[str, Any]:
    """Hire an existing Agent as a duty employee (岗位). Does not create the Agent."""
    if not isinstance(data, dict):
        raise ValidationError("Hire payload must be a JSON object")
    agent_code = str(data.get("agent_code") or "").strip()
    if not agent_code:
        raise ValidationError("agent_code is required")

    existing = ProactiveRepository.get_role(agent_code)
    if existing:
        raise ConflictError(f"Role '{agent_code}' already exists")

    from evoflow.admin.agents import get_agent

    try:
        agent_row = get_agent(agent_code)
        agent_code = str(agent_row.get("agent_code") or agent_code).strip()
    except NotFoundError as e:
        raise ValidationError(
            f"Agent '{agent_code}' not found; create it with agents.create before hiring"
        ) from e

    try:
        initial_status = normalize_role_status(data.get("status") or "active")
    except ValueError as e:
        raise ValidationError(str(e)) from e

    role_name = (
        str(data.get("role_name") or "").strip()
        or str(agent_row.get("agent_name") or agent_code)
    )
    position_code = str(data.get("position_code") or "").strip()
    heartbeat = str(data.get("heartbeat_rrule") or "FREQ=HOURLY;INTERVAL=2").strip()
    from evoflow.proactive.prompt import validate_knowledge_vault_ids

    try:
        vault_ids = validate_knowledge_vault_ids(list(data.get("knowledge_vault_ids") or []))
    except ValueError as e:
        raise ValidationError(str(e)) from e

    # Auto-populate from Agent config if not provided in hire payload
    agent_soul = str(agent_row.get("soul") or "").strip()
    agent_skills = list(agent_row.get("skills") or [])
    agent_tool_groups = list(agent_row.get("tool_groups") or [])
    agent_tools = list(agent_row.get("tools") or [])
    agent_model = str(agent_row.get("model") or "").strip()

    # soul_md: prefer payload, fallback to agent's soul
    soul_md_value = str(data.get("soul_md") or "").strip()
    if not soul_md_value and agent_soul:
        soul_md_value = agent_soul

    # skills: prefer payload, fallback to agent's skills (never invent defaults here)
    explicit_skills = "skills" in data and data.get("skills") is not None
    skills_value = list(data.get("skills") or []) if explicit_skills else list(agent_skills)

    explicit_tool_groups = "tool_groups" in data and data.get("tool_groups") is not None
    tool_groups_value = (
        list(data.get("tool_groups") or [])
        if explicit_tool_groups
        else (agent_tool_groups or agent_tools)
    )

    model_name_value = str(data.get("model_name") or "").strip() or agent_model

    # Inherit from Agent unless hire payload explicitly set capability fields.
    inherit = not (explicit_skills or explicit_tool_groups or bool(str(data.get("soul_md") or "").strip()))

    config = ProactiveRoleConfig(
        responsibilities=list(data.get("responsibilities") or []),
        workspace_path=_validate_workspace_path(data.get("workspace_path")),
        domain_scope=list(data.get("domain_scope") or []),
        knowledge_vault_ids=vault_ids,
        kpis=list(data.get("kpis") or []),
        autonomy_level=_parse_autonomy(data.get("autonomy_level")),
        max_initiatives_per_cycle=int(data.get("max_initiatives_per_cycle") or 3),
        risk_threshold=_parse_risk(data.get("risk_threshold")),
        approval_channels=list(
            data.get("approval_channels") or ["desktop", "feishu"]
        ),
        approval_timeout_minutes=int(data.get("approval_timeout_minutes") or 30),
        soul_md=soul_md_value,
        think_mode=str(data.get("think_mode") or "agent_loop").strip() or "agent_loop",
        model_name=model_name_value,
        max_turns=int(data.get("max_turns") or 10),
        timeout_seconds=int(data.get("timeout_seconds") or 300),
        tool_groups=tool_groups_value,
        skills=skills_value,
        work_schedule_enabled=bool(data.get("work_schedule_enabled", True)),
        work_start_hour=int(data.get("work_start_hour") if data.get("work_start_hour") is not None else 9),
        work_end_hour=int(data.get("work_end_hour") if data.get("work_end_hour") is not None else 20),
        approval_timeout_by_type=dict(data.get("approval_timeout_by_type") or {}),
        daily_budget_usd=float(data.get("daily_budget_usd") or 0.0),
        per_run_budget_usd=float(data.get("per_run_budget_usd") or 0.0),
        budget_exceed_policy=str(data.get("budget_exceed_policy") or "skip_patrol").strip() or "skip_patrol",
        reports_to=_normalize_reports_to(agent_code, data.get("reports_to")),
        extra_context={
            "agent_description": str(agent_row.get("description") or ""),
            "agent_tags": list(agent_row.get("tags") or []),
            "agent_tools": agent_tools,
            **({"override_capabilities": True} if not inherit else {}),
        },
    )

    now = utc_now_iso_z()
    role = ProactiveRole(
        agent_code=agent_code,
        role_name=role_name,
        position_code=position_code,
        department=str(data.get("department") or ""),
        config=config,
        heartbeat_rrule="",
        heartbeat_schedule="",
        status=initial_status,
        next_heartbeat_at=None,
        created_at=now,
        updated_at=now,
    )
    from evoflow.proactive.schedule import apply_schedule_input, compute_next_duty_iso

    apply_schedule_input(
        role,
        heartbeat_schedule=str(data.get("heartbeat_schedule") or "").strip() or None,
        heartbeat_rrule=heartbeat or None,
    )
    if initial_status == "active":
        role.next_heartbeat_at = compute_next_duty_iso(role)
    ProactiveRepository.save_role(role)
    return _role_detail(role)


def update_role(agent_code: str, data: dict[str, Any]) -> dict[str, Any]:
    """Partial update of duty role / 岗位配置."""
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    if not isinstance(data, dict):
        raise ValidationError("Update payload must be a JSON object")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")

    # Nested ``config`` object: flatten into top-level keys (top-level wins).
    data = dict(data)
    nested = data.pop("config", None)
    if isinstance(nested, dict):
        for k, v in nested.items():
            if k not in data:
                data[k] = v
    elif nested is not None:
        raise ValidationError("config must be an object when provided")

    unknown = [k for k in data if k not in _UPDATE_KEYS and k != "agent_code"]
    # Allow unknown keys to be ignored (forward compatible) — only warn via skip

    if data.get("role_name") is not None:
        role.role_name = str(data["role_name"] or "").strip() or role.role_name
    if data.get("position_code") is not None:
        role.position_code = str(data["position_code"] or "").strip()
    if data.get("department") is not None:
        role.department = str(data.get("department") or "")
    if data.get("status") is not None:
        try:
            role.status = normalize_role_status(data.get("status"))
        except ValueError as e:
            raise ValidationError(str(e)) from e

    schedule_changed = False
    if data.get("heartbeat_schedule") is not None or data.get("heartbeat_rrule") is not None:
        from evoflow.proactive.schedule import apply_schedule_input

        schedule_changed = apply_schedule_input(
            role,
            heartbeat_schedule=str(data.get("heartbeat_schedule") or "").strip() or None,
            heartbeat_rrule=str(data.get("heartbeat_rrule") or "").strip() or None
            if data.get("heartbeat_rrule") is not None
            else None,
        )

    cfg = role.config
    if data.get("responsibilities") is not None:
        cfg.responsibilities = list(data.get("responsibilities") or [])
    if data.get("workspace_path") is not None:
        cfg.workspace_path = _validate_workspace_path(data.get("workspace_path"))
    if data.get("domain_scope") is not None:
        cfg.domain_scope = list(data.get("domain_scope") or [])
    if data.get("knowledge_vault_ids") is not None:
        from evoflow.proactive.prompt import validate_knowledge_vault_ids

        try:
            cfg.knowledge_vault_ids = validate_knowledge_vault_ids(
                list(data.get("knowledge_vault_ids") or [])
            )
        except ValueError as e:
            raise ValidationError(str(e)) from e
    if data.get("kpis") is not None:
        cfg.kpis = list(data.get("kpis") or [])
    if data.get("autonomy_level") is not None:
        cfg.autonomy_level = _parse_autonomy(data.get("autonomy_level"))
    if data.get("max_initiatives_per_cycle") is not None:
        cfg.max_initiatives_per_cycle = int(data["max_initiatives_per_cycle"])
    if data.get("risk_threshold") is not None:
        cfg.risk_threshold = _parse_risk(data.get("risk_threshold"))
    if data.get("approval_channels") is not None:
        cfg.approval_channels = list(data.get("approval_channels") or [])
    if data.get("approval_timeout_minutes") is not None:
        cfg.approval_timeout_minutes = int(data["approval_timeout_minutes"])
    if data.get("soul_md") is not None:
        cfg.soul_md = str(data.get("soul_md") or "")
        _mark_employee_override(cfg, override=True)
    if data.get("think_mode") is not None:
        cfg.think_mode = str(data.get("think_mode") or "agent_loop").strip() or "agent_loop"
    if data.get("model_name") is not None:
        cfg.model_name = str(data.get("model_name") or "").strip()
        _mark_employee_override(cfg, override=True)
    if data.get("max_turns") is not None:
        cfg.max_turns = int(data["max_turns"])
    if data.get("timeout_seconds") is not None:
        cfg.timeout_seconds = int(data["timeout_seconds"])
    if data.get("tool_groups") is not None:
        cfg.tool_groups = list(data.get("tool_groups") or [])
        _mark_employee_override(cfg, override=True)
    if data.get("skills") is not None:
        cfg.skills = list(data.get("skills") or [])
        _mark_employee_override(cfg, override=True)
    if data.get("work_schedule_enabled") is not None:
        cfg.work_schedule_enabled = bool(data["work_schedule_enabled"])
    if data.get("work_start_hour") is not None:
        cfg.work_start_hour = int(data["work_start_hour"])
    if data.get("work_end_hour") is not None:
        cfg.work_end_hour = int(data["work_end_hour"])
    if data.get("approval_timeout_by_type") is not None:
        cfg.approval_timeout_by_type = dict(data.get("approval_timeout_by_type") or {})
    if data.get("daily_budget_usd") is not None:
        cfg.daily_budget_usd = float(data["daily_budget_usd"])
    if data.get("per_run_budget_usd") is not None:
        cfg.per_run_budget_usd = float(data["per_run_budget_usd"])
    if data.get("budget_exceed_policy") is not None:
        pol = str(data.get("budget_exceed_policy") or "skip_patrol").strip().lower() or "skip_patrol"
        if pol not in ("skip_patrol", "pause_role", "notify_only"):
            raise ValueError("budget_exceed_policy must be skip_patrol|pause_role|notify_only")
        cfg.budget_exceed_policy = pol
    if "reports_to" in data:
        cfg.reports_to = _normalize_reports_to(code, data.get("reports_to"))
    # Legacy dnd_* → work schedule (only as fallback when new field is not passed)
    if data.get("work_schedule_enabled") is None and data.get("dnd_enabled") is not None:
        cfg.work_schedule_enabled = bool(data["dnd_enabled"])
    if data.get("work_start_hour") is None and data.get("dnd_end_hour") is not None:
        cfg.work_start_hour = int(data["dnd_end_hour"])
    if data.get("work_end_hour") is None and data.get("dnd_start_hour") is not None:
        cfg.work_end_hour = int(data["dnd_start_hour"])

    role.config = cfg
    role.updated_at = utc_now_iso_z()
    if schedule_changed:
        from evoflow.proactive.schedule import compute_next_duty_iso

        role.next_heartbeat_at = compute_next_duty_iso(role)
    ProactiveRepository.save_role(role)
    out = _role_detail(role)
    if unknown:
        out["ignored_keys"] = unknown
    return out


def pause_role(agent_code: str) -> dict[str, Any]:
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    role.status = "paused"
    role.config.auto_patrol_suspended = True
    role.next_heartbeat_at = None
    role.updated_at = utc_now_iso_z()
    ProactiveRepository.save_role(role)
    gw = _try_gateway_put(f"/roles/{code}/pause")
    return {
        "ok": True,
        "agent_code": code,
        "status": "paused",
        "gateway_notified": gw is not None,
    }


def stop_role(agent_code: str) -> dict[str, Any]:
    """Cancel in-flight work and suspend scheduled auto-patrol until resume."""
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    gw = _fetch_gateway_status()
    busy_codes = {
        str(row.get("agent_code") or "").strip()
        for row in (list(gw.get("busy_roles") or []) if gw else [])
        if isinstance(row, dict)
    }
    gw_resp = _try_gateway_post(f"/roles/{code}/stop")
    if code not in busy_codes:
        role.config.auto_patrol_suspended = True
        role.next_heartbeat_at = None
        role.updated_at = utc_now_iso_z()
        ProactiveRepository.save_role(role)
    return {
        "ok": True,
        "agent_code": code,
        "status": role.status,
        "stopped": code in busy_codes,
        "auto_patrol_suspended": True,
        "gateway_notified": gw_resp is not None,
        **(gw_resp or {}),
    }


def resume_role(agent_code: str) -> dict[str, Any]:
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    prev = role.status
    if prev == "archived":
        raise ValidationError(
            "Cannot resume an archived employee; re-hire or create a new role instead"
        )
    if prev == "active":
        return {
            "ok": True,
            "agent_code": code,
            "status": "active",
            "from_status": prev,
            "noop": True,
            "message": "Role is already active",
        }
    role.status = "active"
    role.config.auto_patrol_suspended = False
    role.updated_at = utc_now_iso_z()
    if not role.next_heartbeat_at:
        from evoflow.proactive.runner import compute_next_duty_iso

        role.next_heartbeat_at = compute_next_duty_iso(role)
    ProactiveRepository.save_role(role)
    return {
        "ok": True,
        "agent_code": code,
        "status": "active",
        "from_status": prev,
    }


def archive_role(agent_code: str) -> dict[str, Any]:
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    try:
        from evoflow.agents.xiaomi.identity import XIAOMI_PROTECTED_DETAIL_ZH, is_xiaomi_agent

        if is_xiaomi_agent(code):
            raise ValidationError(XIAOMI_PROTECTED_DETAIL_ZH)
    except ValidationError:
        raise
    except Exception:
        pass
    role.status = "archived"
    role.updated_at = utc_now_iso_z()
    ProactiveRepository.save_role(role)
    gw = _try_gateway_put(f"/roles/{code}/archive")
    return {
        "ok": True,
        "agent_code": code,
        "status": "archived",
        "gateway_notified": gw is not None,
    }


def _role_summary(role: ProactiveRole, *, busy_codes: set[str]) -> dict[str, Any]:
    from evoflow.proactive.org import role_org_key

    code = role.agent_code
    system_front_desk = False
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        system_front_desk = is_xiaomi_agent(code)
    except Exception:
        system_front_desk = False
    return {
        "agent_code": code,
        "role_name": role.role_name,
        "department": role.department,
        "status": role.status,
        "busy": code in busy_codes,
        "last_heartbeat_at": role.last_heartbeat_at,
        "next_heartbeat_at": role.next_heartbeat_at,
        "workspace_path": role.config.workspace_path or "",
        "org_key": role_org_key(role),
        "responsibilities": list(role.config.responsibilities or [])[:8],
        "kpis": list(role.config.kpis or [])[:6],
        "system_front_desk": system_front_desk,
    }


def _initiative_brief(init: Initiative) -> dict[str, Any]:
    plan = init.action_plan if isinstance(init.action_plan, dict) else {}
    is_journal = str(plan.get("kind") or "") == "round_log"
    result = None
    if init.status == InitiativeStatus.COMPLETED:
        result = "success"
    elif init.status == InitiativeStatus.FAILED:
        result = "failure"
    return {
        "id": init.id,
        "title": init.title,
        "status": init.status.value,
        "result": result,
        "action_type": init.action_type.value,
        "is_journal": is_journal,
        "phase": str(plan.get("phase") or "") if is_journal else "",
        "incomplete": bool(plan.get("incomplete")) if is_journal else False,
        "round_id": init.round_id,
        "goal": (init.goal or "")[:200],
        "outcome": (init.outcome or "")[:300],
        "created_at": init.created_at,
    }


def _is_journal(init: Initiative) -> bool:
    plan = init.action_plan if isinstance(init.action_plan, dict) else {}
    return str(plan.get("kind") or "") == "round_log"


def _group_rounds(inits: list[Initiative]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for init in inits:
        key = str(init.round_id or "").strip() or f"item:{init.id}"
        if key not in groups:
            groups[key] = {
                "round_id": init.round_id,
                "at": init.created_at,
                "goal": "",
                "outcome": "",
                "verdict": "in_progress",
                "items": [],
            }
            order.append(key)
        g = groups[key]
        g["items"].append(_initiative_brief(init))
        if init.created_at and (not g["at"] or init.created_at > g["at"]):
            g["at"] = init.created_at

    rounds: list[dict[str, Any]] = []
    for key in order:
        g = groups[key]
        briefs = g["items"]
        journals = [i for i in briefs if i.get("is_journal")]
        wrap = next((j for j in journals if j.get("phase") == "wrap_up"), None)
        if wrap is None and journals:
            wrap = journals[0]
        if wrap:
            g["goal"] = wrap.get("goal") or ""
            g["outcome"] = wrap.get("outcome") or ""
            if wrap.get("incomplete") or wrap.get("result") == "failure":
                g["verdict"] = "incomplete"
            elif wrap.get("phase") == "wrap_up":
                g["verdict"] = "done"
            else:
                g["verdict"] = "in_progress"
        actionable = [i for i in briefs if not i.get("is_journal")]
        g["item_count"] = len(actionable)
        g["pending_approval"] = sum(1 for i in actionable if i.get("status") == "pending_approval")
        g["journal_count"] = len(journals)
        # Drop full item payloads from default list — keep compact scorecard
        g["items"] = briefs[:12]
        rounds.append(g)

    rounds.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
    return rounds


def list_roles(*, status: str | None = None, include_archived: bool = False) -> dict[str, Any]:
    """Roster + pending approvals + busy (when Gateway is up)."""
    st = (status or "").strip() or None
    if st is not None:
        try:
            st = normalize_role_status(st)
        except ValueError as e:
            raise ValidationError(str(e)) from e
    roles = ProactiveRepository.list_roles(status=st)
    if not include_archived and st is None:
        roles = [r for r in roles if r.status != "archived"]

    gw = _fetch_gateway_status()
    busy_rows = list(gw.get("busy_roles") or []) if gw else []
    busy_codes = {
        str(row.get("agent_code") or "").strip()
        for row in busy_rows
        if isinstance(row, dict) and str(row.get("agent_code") or "").strip()
    }
    pending = ProactiveRepository.list_pending_approvals()
    pending_by_role: Counter[str] = Counter()
    for a in pending:
        pending_by_role[a.role_agent_code] += 1

    items = []
    for role in roles:
        row = _role_summary(role, busy_codes=busy_codes)
        row["pending_approvals"] = int(pending_by_role.get(role.agent_code, 0))
        items.append(row)

    return {
        "roles": items,
        "count": len(items),
        "active_count": sum(1 for r in items if r.get("status") == "active"),
        "busy_count": sum(1 for r in items if r.get("busy")),
        "pending_approvals": len(pending),
        "gateway_reachable": gw is not None,
        "busy_roles": busy_rows,
    }


def worklog(
    agent_code: str,
    *,
    day: str | None = None,
    limit: int = 80,
) -> dict[str, Any]:
    """Day work log: duty rounds (initiatives) ∪ board Tasks for the employee.

    ``day`` is interpreted in Asia/Shanghai. Initiative timestamps and Task
    created/updated/completed times are matched on the Beijing calendar day so
    UTC/Z vs ``+08:00`` storage does not empty the log.
    """
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")

    day_s = _parse_worklog_day(day)

    lim = max(1, min(int(limit), 200))
    all_inits = ProactiveRepository.list_initiatives(role_agent_code=code, limit=max(lim, 80))
    day_inits = [i for i in all_inits if _timestamp_on_beijing_day(getattr(i, "created_at", None), day_s)]
    rounds = _group_rounds(day_inits)
    tasks = _list_role_tasks_for_beijing_day(code, day_s, limit=lim)

    # Two sources by design — do NOT treat round_count==0 as "no work":
    # rounds  = duty-patrol initiatives (created when a proactive round runs)
    # tasks   = board Tasks assigned that day (items.dispatch / proactive dispatch)
    activity_count = len(rounds) + len(tasks)
    if rounds and tasks:
        hint = (
            f"当日有 {len(rounds)} 个值班轮次、{len(tasks)} 个台账任务；"
            "看「干了啥」请同时读 rounds 与 tasks，勿只看 round_count。"
        )
    elif tasks and not rounds:
        hint = (
            f"当日无值班巡检轮次（round_count=0 正常），但有 {len(tasks)} 个台账任务；"
            "派发/执行工作请看 tasks[]，不要据此判定 worklog 为空。"
        )
    elif rounds and not tasks:
        hint = f"当日有 {len(rounds)} 个值班轮次，无台账任务记录。"
    else:
        hint = "当日暂无值班轮次与台账任务。"

    return {
        "agent_code": code,
        "role_name": role.role_name,
        "day": day_s,
        "timezone": "Asia/Shanghai",
        "round_count": len(rounds),
        "initiative_count": len(day_inits),
        "rounds": rounds,
        "task_count": len(tasks),
        "tasks": tasks,
        "activity_count": activity_count,
        "has_duty_rounds": bool(rounds),
        "has_board_tasks": bool(tasks),
        "hint": hint,
        "semantics": {
            "rounds": "值班巡检轮次（initiatives 聚合）；仅当员工跑过 proactive 轮次才有",
            "tasks": "当日指派给该员工的台账 Task（含 items.dispatch）",
            "note": "dispatch 不会写入 initiatives；round_count=0 且 task_count>0 表示有派发工作、无巡检轮次，不是 bug",
        },
        "watch_path": f"/proactive/{code}",
    }


def _timestamp_on_beijing_day(ts: Any, day_s: str) -> bool:
    """True if ``ts`` falls on Beijing calendar day ``YYYY-MM-DD``."""
    from datetime import datetime

    from evoflow.timeutil import BEIJING_TZ

    raw = str(ts or "").strip()
    if not raw:
        return False
    # Fast path: already Beijing / local date prefix
    if raw.startswith(day_s):
        return True
    try:
        # Normalize Z → +00:00 for fromisoformat
        norm = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(norm)
        if dt.tzinfo is None:
            # Naive timestamps in this product are typically Beijing-written
            return dt.date().isoformat() == day_s
        return dt.astimezone(BEIJING_TZ).date().isoformat() == day_s
    except Exception:
        return False


def _list_role_tasks_for_beijing_day(agent_code: str, day_s: str, *, limit: int = 80) -> list[dict[str, Any]]:
    """Board Tasks assigned to ``agent_code`` touched on Beijing day ``day_s``."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return []
    try:
        from evoflow.collab.storage import get_project_storage
    except Exception:
        return []

    out: list[dict[str, Any]] = []
    storage = get_project_storage()
    for summary in storage.list_projects() or []:
        proj = storage.load_project(str(summary.get("id") or ""))
        if not proj:
            continue
        for task in proj.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            assigned = str(task.get("assigned_to") or "").strip().lower()
            if assigned != code:
                continue
            stamps = (
                task.get("completed_at"),
                task.get("updated_at"),
                task.get("created_at"),
                task.get("started_at"),
            )
            if not any(_timestamp_on_beijing_day(s, day_s) for s in stamps):
                continue
            out.append(
                {
                    "task_id": str(task.get("id") or "").strip(),
                    "name": task.get("name"),
                    "status": task.get("status"),
                    "progress": int(task.get("progress") or 0),
                    "source": task.get("source"),
                    "source_ref": task.get("source_ref"),
                    "created_at": task.get("created_at"),
                    "updated_at": task.get("updated_at"),
                    "completed_at": task.get("completed_at"),
                    "summary": (str(task.get("summary") or task.get("result") or "").strip() or None),
                }
            )
    out.sort(
        key=lambda r: str(r.get("updated_at") or r.get("completed_at") or r.get("created_at") or ""),
        reverse=True,
    )
    return out[: max(1, min(int(limit), 200))]


def _extract_tool_steps(messages: list[dict[str, Any]], *, max_steps: int = 40) -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    for msg in messages:
        role = str(msg.get("role") or msg.get("type") or "")
        if role in ("tool",) or msg.get("type") == "tool":
            name = str(msg.get("name") or msg.get("tool_name") or "tool").strip()
            steps.append(
                {
                    "tool": name,
                    "at": msg.get("timestamp") or "",
                    "kind": "result",
                }
            )
            continue
        payload = msg.get("content_json")
        if not isinstance(payload, dict):
            payload = {}
        tcs = payload.get("tool_calls")
        if not isinstance(tcs, list):
            tcs = msg.get("tool_calls") if isinstance(msg.get("tool_calls"), list) else []
        for tc in tcs or []:
            if not isinstance(tc, dict):
                continue
            name = str(tc.get("name") or (tc.get("function") or {}).get("name") or "tool").strip()
            steps.append(
                {
                    "tool": name,
                    "at": msg.get("timestamp") or "",
                    "kind": "call",
                    "id": str(tc.get("id") or "")[:24],
                }
            )
        if len(steps) >= max_steps:
            break
    return steps[:max_steps]


def round_trail(
    agent_code: str,
    *,
    round_id: str | None = None,
    max_steps: int = 40,
) -> dict[str, Any]:
    """Summarize tool trail for one duty round (or latest messages if round omitted)."""
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")

    rid = str(round_id or "").strip() or None
    try:
        ms = int(max_steps)
    except (TypeError, ValueError) as e:
        raise ValidationError("max_steps must be a positive integer") from e
    if ms <= 0:
        raise ValidationError("max_steps must be a positive integer")
    ms = min(ms, 200)

    if not rid:
        # Prefer most recent initiative round for this role
        recent = ProactiveRepository.list_initiatives(role_agent_code=code, limit=20)
        for init in recent:
            if str(init.round_id or "").strip():
                rid = str(init.round_id).strip()
                break

    from evoflow.persistence.chat_message_repositories import list_messages_for_display_all

    session_key = f"proactive:{code}"
    result = list_messages_for_display_all(session_key, max_rows=200, round_id=rid)
    messages = list(result.get("messages") or [])
    steps = _extract_tool_steps(messages, max_steps=ms)
    tool_counts = Counter(s["tool"] for s in steps)

    # Round scorecard from initiatives
    scorecard: dict[str, Any] = {}
    if rid:
        inits = [
            i
            for i in ProactiveRepository.list_initiatives(role_agent_code=code, limit=80)
            if str(i.round_id or "") == rid
        ]
        rounds = _group_rounds(inits)
        if rounds:
            scorecard = {
                "goal": rounds[0].get("goal"),
                "outcome": rounds[0].get("outcome"),
                "verdict": rounds[0].get("verdict"),
                "item_count": rounds[0].get("item_count"),
            }

    return {
        "agent_code": code,
        "role_name": role.role_name,
        "session_key": session_key,
        "round_id": rid,
        "message_count": len(messages),
        "tool_step_count": len(steps),
        "tool_counts": dict(tool_counts.most_common(20)),
        "steps": steps,
        "scorecard": scorecard,
        "watch_path": f"/proactive/{code}?live=1" + (f"&round={rid}" if rid else ""),
    }


def resolve_role_ref(ref: str) -> ProactiveRole:
    """Resolve ``agent_code`` or ``role_name`` (case-insensitive) to an active role."""
    key = str(ref or "").strip()
    if not key:
        raise ValidationError("target is required (agent_code or role_name)")
    by_code = ProactiveRepository.get_role(key)
    if by_code:
        return by_code
    key_l = key.casefold()
    matches = [
        r
        for r in ProactiveRepository.list_roles(status="active")
        if str(r.role_name or "").strip().casefold() == key_l
        or str(r.agent_code or "").strip().casefold() == key_l
    ]
    if not matches:
        # Also allow paused lookup by exact code already failed; try any status by name
        matches = [
            r
            for r in ProactiveRepository.list_roles()
            if str(r.role_name or "").strip().casefold() == key_l
        ]
    if not matches:
        raise NotFoundError(
            f"No employee matching '{key}'. Use agent_code or role_name "
            "(see `evoflow employees list`)."
        )
    if len(matches) > 1:
        codes = ", ".join(r.agent_code for r in matches)
        raise ValidationError(f"Ambiguous role_name '{key}' matches: {codes}")
    return matches[0]


def dispatch(
    agent_code: str,
    goal: str,
    *,
    description: str = "",
    priority: str = "normal",
    source: str = "role",
    from_agent: str = "",
    related_task_id: str = "",
    round_id: str = "",
    resume_round: bool = False,
    fresh_round: bool = False,
    skip_done_guard: bool = False,
) -> dict[str, Any]:
    """Fire-and-forget dispatch via Gateway HTTP (requires running Gateway)."""
    code = str(agent_code or "").strip()
    goal_s = str(goal or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    if not goal_s:
        raise ValidationError("goal is required")

    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    if role.status != "active":
        raise ValidationError(f"Role status is '{role.status}', not 'active'")

    # Same already-done short-circuit as wake (xiaomi_dispatch goes through here).
    from evoflow.proactive.work_items import all_referenced_tasks_done

    desc_s = str(description or "").strip()
    from_agent_s = str(from_agent or "").strip()
    related_tid = str(related_task_id or "").strip()
    round_id_s = str(round_id or "").strip()
    if not skip_done_guard:
        done, done_ids = all_referenced_tasks_done(goal_s, desc_s, related_tid)
        if done and done_ids:
            return {
                "ok": True,
                "skipped": True,
                "reason": "already_done",
                "task_ids": done_ids,
                "agent_code": code,
                "role_name": role.role_name,
                "message": (
                    "目标中引用的 Task 均已结案，跳过重复派发："
                    + ", ".join(f"`{i}`" for i in done_ids[:8])
                ),
            }

    url = f"{_proactive_api_base()}/roles/{code}/dispatch"
    payload: dict[str, Any] = {
        "goal": goal_s,
        "description": desc_s,
        "priority": str(priority or "normal").strip() or "normal",
        "source": str(source or "role").strip() or "role",
    }
    if from_agent_s:
        payload["from_agent"] = from_agent_s
    if related_tid:
        payload["related_task_id"] = related_tid
    if round_id_s:
        payload["round_id"] = round_id_s
    if resume_round:
        payload["resume_round"] = True
    if fresh_round:
        payload["fresh_round"] = True
    if skip_done_guard:
        payload["skip_done_guard"] = True

    # Prefer in-process ProactiveRunner when we are already inside Gateway's
    # event loop. Sync httpx → same-process /dispatch deadlocks the loop
    # (approval callback waits for dispatch while dispatch waits for the loop).
    try:
        from evoflow.proactive.runner import get_proactive_runner

        runner = get_proactive_runner()
    except Exception:
        runner = None
    if runner is not None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None and loop.is_running():

            async def _inproc() -> dict[str, Any]:
                return await runner.dispatch_task_fire_and_forget(
                    code,
                    goal_s,
                    description=desc_s,
                    priority=str(payload["priority"]),
                    source=str(payload["source"]),
                    from_agent=from_agent_s,
                    related_task_id=related_tid,
                    round_id=round_id_s,
                    resume_round=bool(resume_round),
                    fresh_round=bool(fresh_round),
                    skip_done_guard=skip_done_guard,
                )

            fut = loop.create_task(_inproc())

            def _log_done(t: asyncio.Task[Any]) -> None:
                try:
                    t.result()
                except Exception:
                    logger.exception(
                        "employees.dispatch in-process failed agent=%s", code
                    )

            fut.add_done_callback(_log_done)
            return {
                "ok": True,
                "dispatched": True,
                "scheduled": True,
                "agent_code": code,
                "role_name": role.role_name,
                "goal": goal_s,
                "source": payload["source"],
                "dispatched_at": utc_now_iso_z(),
                "watch_path": f"/proactive/{code}?live=1",
                "from_agent": from_agent_s or None,
                "related_task_id": related_tid or None,
                "round_id": round_id_s or None,
                "resume_round": bool(resume_round) or None,
            }

    try:
        with httpx.Client(timeout=15.0) as client:
            r = client.post(url, json=payload)
    except httpx.TimeoutException as e:
        raise ValidationError(
            f"Gateway timeout calling {url}. Is Gateway running on EVOFLOW_LANGGRAPH_URL host?"
        ) from e
    except httpx.HTTPError as e:
        raise ValidationError(f"Gateway unreachable at {url}: {e}") from e

    try:
        data = r.json() if r.content else {}
    except Exception:
        data = {"detail": r.text[:300]}

    if r.status_code == 409:
        detail = data.get("detail") if isinstance(data, dict) else None
        raise ConflictError(str(detail or "employee is busy"))
    if r.status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else None
        raise ValidationError(str(detail or f"dispatch failed HTTP {r.status_code}"))

    if isinstance(data, dict):
        data.setdefault("watch_path", f"/proactive/{code}?live=1")
        return data
    return {"ok": True, "agent_code": code, "goal": goal_s, "raw": data}


def wake(
    target: str,
    goal: str = "",
    *,
    from_agent: str = "",
    task_id: str = "",
    description: str = "",
    priority: str = "normal",
    source: str = "role",
    round_id: str = "",
    resume_round: bool = False,
    fresh_round: bool = False,
    skip_done_guard: bool = False,
) -> dict[str, Any]:
    """Wake a teammate (``@``) — resolve by agent_code or role_name, then dispatch.

    Preferred cross-role CLI for duty collab. ``employees dispatch`` remains as
    the lower-level alias that requires an exact agent_code.

    ``skip_done_guard``: for system upstream receipts — still wake even when
    cited Task ids are already completed (parent/child handoff trees).

    ``round_id`` / ``resume_round``: continue the same work trail (see dispatch).
    """
    target_role = resolve_role_ref(target)
    if target_role.status != "active":
        raise ValidationError(
            f"Target '{target_role.agent_code}' status is '{target_role.status}', not 'active'"
        )

    from_s = str(from_agent or "").strip()
    from_role: ProactiveRole | None = None
    if from_s:
        from_role = resolve_role_ref(from_s)
        if from_role.agent_code == target_role.agent_code:
            raise ValidationError("Cannot wake yourself")

    tid = str(task_id or "").strip()
    goal_s = str(goal or "").strip()
    desc = str(description or "").strip()
    round_id_s = str(round_id or "").strip()
    # --resume-round with --task-id: pull stamp from the Task when round_id omitted.
    if (resume_round or round_id_s) and not round_id_s and tid:
        try:
            from evoflow.proactive.work_items import load_work_item_task

            row = load_work_item_task(tid)
            if row:
                round_id_s = str(row.get("round_id") or row.get("source_ref") or "").strip()
        except Exception:
            pass

    # Block waking a child (or handler target) while parent handoff awaits approval.
    try:
        from evoflow.admin.tasks import task_has_pending_handoff_approval
        from evoflow.collab.storage import find_main_task, get_project_storage
        from evoflow.collab.task_handlers import task_handlers_of
        from evoflow.proactive.work_items import load_work_item_task

        def _block_if_pending_parent(parent_row: dict) -> None:
            if not task_has_pending_handoff_approval(parent_row):
                return
            handlers = task_handlers_of(parent_row)
            codes = {
                str(h.get("agent_code") or "").strip().lower()
                for h in handlers
                if str(h.get("agent_code") or "").strip()
            }
            if target_role.agent_code.lower() in codes:
                pid = str(parent_row.get("id") or parent_row.get("task_id") or "").strip()
                raise ValidationError(
                    f"上游 Task `{pid}` 交接待审批：批准前禁止 wake 下游 "
                    f"「{target_role.role_name}」。请等用户同意后由系统派发。"
                )

        if tid:
            child = load_work_item_task(tid)
            if child:
                parent_id = str(
                    child.get("parent_task_id") or child.get("parent_id") or ""
                ).strip()
                if parent_id:
                    found = find_main_task(
                        get_project_storage(), parent_id, bypass_cache=True
                    )
                    if found:
                        _block_if_pending_parent(found[1])
        if from_role:
            from evoflow.admin.tasks import list_tasks

            listed = list_tasks(assignee=from_role.agent_code, include_subtasks=False)
            for row in listed.get("tasks") or []:
                if str(row.get("status") or "").strip().lower() not in {
                    "completed",
                    "reviewed",
                }:
                    continue
                full = load_work_item_task(str(row.get("task_id") or row.get("id") or ""))
                if full:
                    _block_if_pending_parent(full)
    except ValidationError:
        raise
    except Exception:
        pass

    # Skip re-dispatch when the cited Task(s) are already done (reviewed/completed).
    # Prevents「均为 reviewed 但执行超时，请重试」loops.
    from evoflow.proactive.work_items import (
        all_referenced_tasks_done,
        is_work_item_done,
        load_work_item_task,
    )

    if tid and not skip_done_guard:
        task = load_work_item_task(tid)
        if task and is_work_item_done(
            str(task.get("status") or ""),
            progress=task.get("progress"),
        ):
            return {
                "ok": True,
                "skipped": True,
                "reason": "already_done",
                "task_id": tid,
                "status": str(task.get("status") or ""),
                "agent_code": target_role.agent_code,
                "role_name": target_role.role_name,
                "message": f"Task `{tid}` 已结（{task.get('status')}），无需再催办。",
            }

    if not skip_done_guard:
        done, done_ids = all_referenced_tasks_done(goal_s, desc, tid)
        if done and done_ids:
            return {
                "ok": True,
                "skipped": True,
                "reason": "already_done",
                "task_ids": done_ids,
                "agent_code": target_role.agent_code,
                "role_name": target_role.role_name,
                "message": (
                    "目标中引用的 Task 均已 reviewed/completed，跳过重复派发："
                    + ", ".join(f"`{i}`" for i in done_ids[:8])
                ),
            }

    if not goal_s and tid:
        goal_s = f"处理岗位工作项 {tid}"
        if from_role:
            goal_s += f"（唤醒来源 · {from_role.role_name}）"
    if not goal_s:
        raise ValidationError("goal is required (or pass --task-id to auto-build one)")

    if from_role and from_role.agent_code not in goal_s and f"@{from_role.agent_code}" not in goal_s:
        # Soft stamp for trail readability; do not rewrite if caller already mentioned from.
        goal_s += f"（唤醒来源 · {from_role.role_name}）"

    # Do not stuff woken_by=/task_id= into description — those pollute board「要做什么」.
    # Human notes (if any) pass through; wake metadata lives in goal / result fields.

    result = dispatch(
        target_role.agent_code,
        goal_s,
        description=desc,
        priority=priority,
        source=source or "role",
        from_agent=from_role.agent_code if from_role else from_s,
        related_task_id=tid,
        round_id=round_id_s,
        resume_round=bool(resume_round),
        fresh_round=bool(fresh_round),
        skip_done_guard=skip_done_guard,
    )
    if isinstance(result, dict):
        result.setdefault("woken", True)
        result.setdefault("target_role_name", target_role.role_name)
        if from_role:
            result.setdefault("from_agent_code", from_role.agent_code)
            result.setdefault("from_role_name", from_role.role_name)
        if tid:
            result.setdefault("task_id", tid)
        if round_id_s:
            result.setdefault("round_id", round_id_s)
        if skip_done_guard:
            result.setdefault("skip_done_guard", True)
    return result
