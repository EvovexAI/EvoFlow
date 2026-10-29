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
            raise ValidationError("workspace_path is not allowed: points to a sensitive system location")
    for suffix in _DENIED_WORKSPACE_SUFFIXES:
        if check.endswith(suffix) or suffix in check:
            raise ValidationError("workspace_path is not allowed: points to a sensitive system location")
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


def _role_memory_enabled_from_hire_data(data: dict) -> bool:
    from evoflow.agents.memory.runtime_overrides import role_memory_enabled_from_config

    return role_memory_enabled_from_config(data)


_HIRE_KEYS = frozenset(
    {
        "agent_code",
        "role_name",
        "agent_name",
        "position_code",
        "department",
        "responsibilities",
        "system_prompt",
        "description",
        "workspace_path",
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
        "thinking_enabled",
        "model_name",
        "max_turns",
        "timeout_seconds",
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
        # System prompt injection toggles
        "memory_enabled",
        "inject_user_profile",
        "inject_memory",
        "inject_assets",
        "inject_skills",
        "inject_kb",
        "inject_soul",
        # Applied on update (and hire where relevant)
        "description",
        "kb_injection",
    }
)

_UPDATE_KEYS = frozenset(_HIRE_KEYS - {"agent_code"}) | frozenset({"dnd_enabled", "dnd_start_hour", "dnd_end_hour"})


def _proactive_api_base() -> str:
    from evoflow.admin.proactive_http import resolve_proactive_api_base

    return resolve_proactive_api_base()


_GW_STATUS_CACHE: dict[str, Any] = {"at": 0.0, "data": None, "ok": False}
_GW_STATUS_TTL_S = 2.5


def _fetch_gateway_status(*, force: bool = False) -> dict[str, Any] | None:
    """Live runner status (busy_roles). None when Gateway unreachable.

    Short TTL cache so consecutive ``employees.list`` calls (e.g. with/without
    status filter) do not flap ``gateway_reachable`` (CORE-EMP-04).
    """
    import time

    now = time.monotonic()
    if (
        not force
        and _GW_STATUS_CACHE["ok"]
        and (now - float(_GW_STATUS_CACHE["at"] or 0)) < _GW_STATUS_TTL_S
    ):
        data = _GW_STATUS_CACHE["data"]
        return data if isinstance(data, dict) else None
    url = f"{_proactive_api_base()}/status"
    try:
        with httpx.Client(timeout=3.0) as client:
            r = client.get(url)
            if r.status_code == 200:
                data = r.json()
                payload = data if isinstance(data, dict) else None
                _GW_STATUS_CACHE["at"] = now
                _GW_STATUS_CACHE["data"] = payload
                _GW_STATUS_CACHE["ok"] = payload is not None
                return payload
    except Exception:
        # Keep last good snapshot briefly so a single blip does not flip reachable→false.
        if _GW_STATUS_CACHE["ok"] and (now - float(_GW_STATUS_CACHE["at"] or 0)) < _GW_STATUS_TTL_S * 2:
            data = _GW_STATUS_CACHE["data"]
            return data if isinstance(data, dict) else None
        _GW_STATUS_CACHE["at"] = now
        _GW_STATUS_CACHE["data"] = None
        _GW_STATUS_CACHE["ok"] = False
        return None
    _GW_STATUS_CACHE["at"] = now
    _GW_STATUS_CACHE["data"] = None
    _GW_STATUS_CACHE["ok"] = False
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
    # Keep a description mirror for observability (not a native role field).
    extra = dict(cfg.extra_context or {}) if isinstance(cfg.extra_context, dict) else {}
    extra["agent_description"] = str(agent_row.get("description") or "")
    extra["agent_tags"] = list(agent_row.get("tags") or [])
    extra["agent_tools"] = list(agent_row.get("tools") or [])
    cfg.extra_context = extra
    _mark_employee_override(cfg, override=False)

    role.config = cfg
    role.updated_at = utc_now_iso_z()
    # 名称单源 = agent_name：role_name 空/脏时同步写入，保持两边一致
    agent_display = str(agent_row.get("agent_name") or "").strip()
    current_name = str(role.role_name or "").strip()
    if not current_name or current_name == code or current_name.casefold() in {"none", "null", "undefined"}:
        role.role_name = agent_display or current_name or ""
    elif agent_display and current_name != agent_display:
        # Prefer agent_name as canonical display when both exist and diverge.
        role.role_name = agent_display
    ProactiveRepository.save_role(role)
    return {"synced": True, "agent_code": code}


def _org_notice_for_role(role: ProactiveRole) -> dict[str, Any]:
    """Hire/update org notice: wiring + same-dept similar posts (see org_hire_notice)."""
    try:
        from evoflow.admin.org_hire_notice import build_org_hire_notice

        return build_org_hire_notice(role)
    except Exception:
        return {
            "severity": "ok",
            "reports_to": str(getattr(getattr(role, "config", None), "reports_to", "") or "").strip(),
            "needs_reports_to_wiring": False,
            "same_department_similar": [],
            "warnings": [],
            "tips": [],
            "hint": "",
        }


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
    model_name = cfg.model_name or ""
    extra_ctx = cfg.extra_context if isinstance(cfg.extra_context, dict) else {}
    agent_description = str(extra_ctx.get("agent_description") or "")
    agent_tags: list[str] = list(extra_ctx.get("agent_tags") or []) if isinstance(extra_ctx.get("agent_tags"), list) else []
    agent_tools: list[str] = list(extra_ctx.get("agent_tools") or []) if isinstance(extra_ctx.get("agent_tools"), list) else []
    inherits = _employee_inherits_agent(cfg)
    agent_exists = True

    # Runtime prefer Agent when inheriting (effective view).
    if inherits:
        try:
            from evoflow.admin.agents import get_agent

            agent_row = get_agent(role.agent_code)
            skills = list(agent_row.get("skills") or skills)
            soul_full = str(agent_row.get("soul") or "")
            if soul_full:
                soul_md = soul_full[:500]
            tools = list(agent_row.get("tools") or [])
            if agent_row.get("model"):
                model_name = str(agent_row.get("model") or model_name)
            agent_description = str(agent_row.get("description") or "")
            agent_tags = list(agent_row.get("tags") or [])
            agent_tools = tools
        except Exception:
            # Linked Agent gone → stop advertising inherit (CORE-AGENT-04).
            inherits = False
            agent_exists = False

    # Heal contradictory schedule fields on read (CORE-EMP-02).
    try:
        from evoflow.proactive.schedule import ensure_role_schedule_fields

        if ensure_role_schedule_fields(role):
            ProactiveRepository.save_role(role)
    except Exception:
        pass

    return {
        "agent_code": role.agent_code,
        "role_name": role.role_name,
        "position_code": role.position_code or "",
        "department": role.department,
        "reports_to": reports_to,
        "inherits_agent": inherits,
        "agent_exists": agent_exists,
        "description": agent_description,
        "tags": agent_tags,
        "config": {
            "responsibilities": list(cfg.responsibilities or []),
            "workspace_path": cfg.workspace_path or "",
            "knowledge_vault_ids": list(getattr(cfg, "knowledge_vault_ids", None) or []),
            "kb_injection": dict(getattr(cfg, "kb_injection", None) or {}),
            "kpis": list(cfg.kpis or []),
            "autonomy_level": cfg.autonomy_level.value,
            "max_initiatives_per_cycle": cfg.max_initiatives_per_cycle,
            "risk_threshold": cfg.risk_threshold.value,
            "approval_channels": list(cfg.approval_channels or []),
            "approval_timeout_minutes": cfg.approval_timeout_minutes,
            "soul_md": soul_md,
            "think_mode": cfg.think_mode,
            "thinking_enabled": getattr(cfg, "thinking_enabled", None),
            "model_name": model_name,
            "max_turns": cfg.max_turns,
            "timeout_seconds": cfg.timeout_seconds,
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
            "memory_enabled": bool(getattr(cfg, "memory_enabled", True)),
            "inject_user_profile": getattr(cfg, "inject_user_profile", None),
            "inject_skills": getattr(cfg, "inject_skills", None),
            "inject_kb": getattr(cfg, "inject_kb", None),
            "inject_soul": getattr(cfg, "inject_soul", None),
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


def _effective_bindings_applied(
    agent_row: dict[str, Any] | None,
    role_detail: dict[str, Any] | None,
) -> dict[str, Any]:
    """Effective tools/skills/MCP/knowledge after create or hire (for verification)."""
    agent = agent_row if isinstance(agent_row, dict) else {}
    detail = role_detail if isinstance(role_detail, dict) else {}
    cfg = detail.get("config") if isinstance(detail.get("config"), dict) else {}

    # Prefer create_agent's summary when present; overlay role-effective fields.
    applied = dict(agent.get("bindings_applied") or {}) if isinstance(agent.get("bindings_applied"), dict) else {}

    tools = cfg.get("tools")
    if tools is None:
        tools = applied.get("tools", agent.get("tools"))
    skills = cfg.get("skills")
    if skills is None:
        skills = applied.get("skills", agent.get("skills"))
    mcp = applied.get("mcp_servers", agent.get("mcp_servers"))
    knowledge = cfg.get("knowledge_vault_ids")
    if knowledge is None:
        knowledge = applied.get("knowledge_vault_ids", agent.get("knowledge_vault_ids"))

    if "tools_mode" in applied:
        tools_mode = str(applied.get("tools_mode") or "empty")
    elif tools is None:
        tools_mode = "inherit_all"
    elif list(tools or []):
        tools_mode = "allowlist"
    else:
        tools_mode = "empty"

    pack = applied.get("capability_pack") or agent.get("capability_pack") or detail.get("capability_pack")
    summary: dict[str, Any] = {
        "tools_mode": tools_mode,
        "tools": tools,
        "skills": list(skills or []) if skills is not None else [],
        "mcp_servers": list(mcp or []) if mcp is not None else [],
        "knowledge_vault_ids": list(knowledge or []),
    }
    if pack:
        summary["capability_pack"] = pack
    # Keep semantics/hint from create when available.
    if applied.get("semantics"):
        summary["semantics"] = applied.get("semantics")
    if applied.get("hint"):
        summary["hint"] = applied.get("hint")
    return summary


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
        raise ValidationError(f"Agent '{agent_code}' not found; create it with agents.create before hiring") from e

    detail = _hire_existing_agent(agent_code, agent_row, data)
    detail["bindings_applied"] = _effective_bindings_applied(agent_row, detail)
    return detail


def _coerce_responsibilities(value: Any) -> list[str]:
    """Coerce ``responsibilities`` to a list[str] split by line / entry — never by char.

    A bare string like ``"写代码\\n做测试"`` must become ``["写代码", "做测试"]``;
    passing the raw string to ``list[str]`` would explode it into single characters.
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            if isinstance(item, str) and "\n" in item:
                out.extend(part.strip() for part in item.splitlines() if part.strip())
            else:
                s = str(item or "").strip()
                if s:
                    out.append(s)
        return out
    s = str(value).strip()
    return [s] if s else []


def _slug_employee_code(role_name: str, explicit: str = "") -> str:
    """Build a valid agent_code (letters/digits/hyphens) for a new employee."""
    import uuid as uuid_mod

    raw = str(explicit or "").strip().lower()
    if raw:
        cleaned = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
        cleaned = re.sub(r"-{2,}", "-", cleaned)
        if cleaned and re.match(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", cleaned):
            return cleaned[:64]
    # Prefer readable prefix from ascii letters in role_name; else emp-<hex>.
    letters = re.sub(r"[^a-z0-9]+", "-", str(role_name or "").lower()).strip("-")
    letters = re.sub(r"-{2,}", "-", letters)[:24].strip("-")
    suffix = uuid_mod.uuid4().hex[:8]
    if letters and re.match(r"^[a-z0-9]", letters):
        return f"{letters}-{suffix}"[:64]
    return f"emp-{suffix}"


def create_employee(data: dict[str, Any]) -> dict[str, Any]:
    """Create an employee in one step: ensure Agent capability pack, then hire.

    Product surface: 「加人」— callers should not require a prior Agents-page create.
    If ``agent_code`` already exists as an Agent and is not hired, only hire.
    If missing, create a custom Agent then hire.
    """
    import uuid as uuid_mod

    if not isinstance(data, dict):
        raise ValidationError("Create-employee payload must be a JSON object")

    role_name = str(data.get("role_name") or data.get("agent_name") or "").strip()
    if not role_name:
        raise ValidationError("role_name is required")

    from evoflow.admin.agents import create_agent, get_agent
    from evoflow.persistence import config_repositories as cfg_repo

    explicit_code = str(data.get("agent_code") or "").strip()
    agent_code = _slug_employee_code(role_name, explicit_code)

    # Resolve collisions for auto-generated codes.
    if not explicit_code:
        base = agent_code
        n = 0
        while cfg_repo.agent_exists(agent_code) or ProactiveRepository.get_role(agent_code):
            n += 1
            agent_code = f"{base}-{n}"[:64]
            if n > 50:
                agent_code = f"emp-{uuid_mod.uuid4().hex[:10]}"
                break
    elif ProactiveRepository.get_role(agent_code):
        raise ConflictError(f"员工「{agent_code}」已存在")

    from evoflow.proactive.employee_prompting.job import merge_duty_into_system_prompt

    # Name + prompt are agent-owned; merge legacy responsibilities into system_prompt.
    agent_display = str(data.get("agent_name") or role_name).strip() or role_name
    prompt_raw = str(data.get("system_prompt") or "").strip()
    legacy_resp = _coerce_responsibilities(data.get("responsibilities"))
    merged_prompt = merge_duty_into_system_prompt(prompt_raw, legacy_resp)

    created_agent = False
    try:
        agent_row = get_agent(agent_code)
    except NotFoundError:
        agent_payload = {
            "agent_code": agent_code,
            "agent_name": agent_display,
            "description": str(data.get("description") or "").strip() or f"员工：{agent_display}",
            "agent_type": "custom",
            "soul": str(data.get("soul") or data.get("soul_md") or "").strip(),
        }
        if merged_prompt:
            agent_payload["system_prompt"] = merged_prompt
        if data.get("model") is not None or data.get("model_name") is not None:
            agent_payload["model"] = str(data.get("model") or data.get("model_name") or "").strip()
        # Pass through binding keys (including explicit null) so agents.create
        # can distinguish omit vs tools:null (inherit-all).
        if "skills" in data:
            agent_payload["skills"] = data.get("skills")
        if "tools" in data:
            agent_payload["tools"] = data.get("tools")
        if "mcp_servers" in data:
            agent_payload["mcp_servers"] = data.get("mcp_servers")
        if "knowledge_vault_ids" in data:
            agent_payload["knowledge_vault_ids"] = data.get("knowledge_vault_ids")
        if data.get("tags") is not None:
            agent_payload["tags"] = data.get("tags")
        # Capability pack + create-time guards (consumed by create_agent).
        for key in (
            "capability_pack",
            "capabilityPack",
            "tools_extra",
            "toolsExtra",
            "confirm_inherit_all",
            "confirmInheritAll",
            "confirm_wide_tools",
            "confirmWideTools",
        ):
            if key in data:
                agent_payload[key] = data.get(key)
        # Employee path: forbid tools:null unless confirm_inherit_all=true.
        agent_row = create_agent(agent_payload, forbid_inherit_all=True)
        created_agent = True
        agent_code = str(agent_row.get("agent_code") or agent_code).strip()
    else:
        # 同 agent_code 的 agent 已存在：保留其已有 soul / description / tools / skills 等。
        # 仅在 agent 尚无 system_prompt 且本次带了合并提示词时补写，不覆盖已有正文。
        existing_sp = str(agent_row.get("system_prompt") or "").strip()
        if merged_prompt and not existing_sp:
            try:
                from evoflow.admin import agents as agents_admin

                agents_admin.update_agent(agent_code, {"system_prompt": merged_prompt})
                agent_row = {**agent_row, "system_prompt": merged_prompt}
            except Exception:
                logger.debug(
                    "employees.create: fill empty agent system_prompt skipped code=%s",
                    agent_code,
                    exc_info=True,
                )

    hire_payload = dict(data)
    hire_payload["agent_code"] = agent_code
    # Keep role_name in sync with agent display name (compat field).
    hire_payload["role_name"] = agent_display
    # Duties live on agent system_prompt now.
    hire_payload["responsibilities"] = []
    hire_payload.pop("system_prompt", None)
    # Create-time-only keys (pack / confirm) must not leak into hire config.
    for key in (
        "capability_pack",
        "capabilityPack",
        "tools_extra",
        "toolsExtra",
        "confirm_inherit_all",
        "confirmInheritAll",
        "confirm_wide_tools",
        "confirmWideTools",
        "agent_name",
        "description",
        "soul",
    ):
        hire_payload.pop(key, None)
    detail = _hire_existing_agent(agent_code, agent_row, hire_payload)
    detail["agent_created"] = created_agent
    if isinstance(agent_row, dict) and agent_row.get("capability_pack"):
        detail["capability_pack"] = agent_row.get("capability_pack")
    if isinstance(agent_row, dict) and agent_row.get("hint"):
        detail["hint"] = agent_row.get("hint")
    if isinstance(agent_row, dict) and agent_row.get("warning"):
        detail["warning"] = agent_row.get("warning")
    elif created_agent:
        detail["hint"] = (
            (detail.get("hint") or "")
            + " 能力包：platform agents.bindings → packs（research|writer|duty|coding|none）。"
        ).strip()
    # Always attach an effective bindings snapshot so callers can verify what landed.
    detail["bindings_applied"] = _effective_bindings_applied(agent_row, detail)
    return detail


def _safe_kb_injection(raw: Any) -> dict[str, Any]:
    """Validate kb_injection payload through KbInjectionConfig.from_dict.

    Returns an empty dict when input is missing/invalid (caller falls back to defaults).
    """
    if not raw:
        return {}
    try:
        from evoflow.config.agents_config import KbInjectionConfig

        return KbInjectionConfig.from_dict(raw if isinstance(raw, dict) else {}).to_dict()
    except Exception:
        return {}


def _persist_agent_kb_injection(agent_code: str, kb_injection: dict[str, Any]) -> None:
    """Mirror the kb_injection block into ``evoflow_agents.extra_json``.

    Read by ``KbInjectionMiddleware`` via ``KbInjectionConfig.from_dict``.
    """
    code = str(agent_code or "").strip().lower()
    if not code:
        return
    try:
        from evoflow.config.agents_config import KbInjectionConfig
        from evoflow.persistence import config_repositories as cfg_repo

        existing = cfg_repo.get_agent_extra_json(code) or {}
        merged = dict(existing)
        merged["kb_injection"] = KbInjectionConfig.from_dict(kb_injection or {}).to_dict()
        cfg_repo.upsert_agent_extra_json(code, merged)
    except Exception:
        logger.warning("persist agent kb_injection failed code=%s", code, exc_info=True)


def _persist_agent_kb_vault_ids(agent_code: str, vault_ids: list[str]) -> None:
    """Mirror role-bound vault IDs into agent ``extra_json`` **and** ``AgentConfig``.

    Role config and agent config are separate stores; hire/update lands on
    ProactiveRoleConfig first. KbInjectionMiddleware reads agent-side IDs, so we
    mirror both extra_json (authoritative for live reads) and AgentConfig so
    removals cannot linger via the old union fallback.
    """
    code = str(agent_code or "").strip().lower()
    if not code:
        return
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in list(vault_ids or []):
        v = str(raw or "").strip()
        if v and v not in seen:
            seen.add(v)
            cleaned.append(v)
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        existing = cfg_repo.get_agent_extra_json(code) or {}
        merged = dict(existing)
        merged["knowledge_vault_ids"] = cleaned
        cfg_repo.upsert_agent_extra_json(code, merged)
    except Exception:
        logger.warning("persist agent kb vault_ids failed code=%s", code, exc_info=True)
    try:
        from evoflow.config.agents_config import load_agent_config, save_agent_config

        cfg = load_agent_config(code)
        data = cfg.model_dump(mode="python", exclude={"name"})
        data["knowledge_vault_ids"] = cleaned
        save_agent_config(code, data)
    except Exception:
        logger.warning("persist agent kb vault_ids on AgentConfig failed code=%s", code, exc_info=True)


def backfill_agent_kb_vault_ids() -> dict[str, int]:
    """One-shot: mirror every existing ProactiveRole's knowledge_vault_ids into the agent extra_json.

    Idempotent and safe to call on every startup. Walks ProactiveRepository.list_roles(),
    copies ``config.knowledge_vault_ids`` into ``evoflow_agents.extra_json['knowledge_vault_ids']``
    so the live KbInjectionMiddleware sees them without requiring a role edit.

    Returns counts: ``{"synced": int, "skipped": int, "errors": int}``.
    """
    summary: dict[str, int] = {"synced": 0, "skipped": 0, "errors": 0}
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        roles = ProactiveRepository.list_roles() or []
    except Exception as exc:
        logger.warning("backfill_agent_kb_vault_ids: list_roles failed: %s", exc, exc_info=True)
        summary["errors"] += 1
        return summary

    for role in roles:
        try:
            code = str(getattr(role, "agent_code", "") or "").strip().lower()
            if not code:
                summary["skipped"] += 1
                continue
            cfg = getattr(role, "config", None)
            if cfg is None:
                summary["skipped"] += 1
                continue
            vault_ids = list(getattr(cfg, "knowledge_vault_ids", None) or [])
            _persist_agent_kb_vault_ids(code, vault_ids)
            summary["synced"] += 1
        except Exception:
            logger.warning(
                "backfill_agent_kb_vault_ids: role %s failed",
                getattr(role, "agent_code", "?"),
                exc_info=True,
            )
            summary["errors"] += 1
    return summary


def _hire_existing_agent(
    agent_code: str,
    agent_row: dict[str, Any],
    data: dict[str, Any],
) -> dict[str, Any]:
    try:
        initial_status = normalize_role_status(data.get("status") or "active")
    except ValueError as e:
        raise ValidationError(str(e)) from e

    role_name = str(data.get("role_name") or "").strip() or str(agent_row.get("agent_name") or agent_code)
    position_code = str(data.get("position_code") or "").strip()
    from evoflow.proactive.schedule import DEFAULT_HEARTBEAT_CRON

    heartbeat = str(
        data.get("heartbeat_schedule") or data.get("heartbeat_rrule") or DEFAULT_HEARTBEAT_CRON
    ).strip()
    from evoflow.proactive.prompt import validate_agent_knowledge_ids

    try:
        vault_ids = validate_agent_knowledge_ids(list(data.get("knowledge_vault_ids") or []))
    except ValueError as e:
        raise ValidationError(str(e)) from e

    # Auto-populate from Agent config if not provided in hire payload
    agent_soul = str(agent_row.get("soul") or "").strip()
    agent_skills = list(agent_row.get("skills") or [])
    agent_model = str(agent_row.get("model") or "").strip()

    # soul_md: prefer payload, fallback to agent's soul
    soul_md_value = str(data.get("soul_md") or "").strip()
    if not soul_md_value and agent_soul:
        soul_md_value = agent_soul

    # skills: prefer payload, fallback to agent's skills (never invent defaults here)
    explicit_skills = "skills" in data and data.get("skills") is not None
    skills_value = list(data.get("skills") or []) if explicit_skills else list(agent_skills)
    agent_tools = list(agent_row.get("tools") or [])

    model_name_value = str(data.get("model_name") or "").strip() or agent_model

    # Inherit from Agent unless hire payload explicitly set capability fields.
    inherit = not (explicit_skills or bool(str(data.get("soul_md") or "").strip()))

    # 0 = no wall-clock cap (engine treats falsy as unlimited). Never use ``or 300``:
    # that forced a 5min kill and also turned an explicit 0 into 300.
    _raw_timeout = data.get("timeout_seconds")
    timeout_seconds_value = (
        int(_raw_timeout) if _raw_timeout is not None and str(_raw_timeout).strip() != "" else 0
    )

    config = ProactiveRoleConfig(
        responsibilities=_coerce_responsibilities(data.get("responsibilities")),
        workspace_path=_validate_workspace_path(data.get("workspace_path")),
        knowledge_vault_ids=vault_ids,
        kpis=list(data.get("kpis") or []),
        autonomy_level=_parse_autonomy(data.get("autonomy_level")),
        max_initiatives_per_cycle=int(data.get("max_initiatives_per_cycle") or 3),
        risk_threshold=_parse_risk(data.get("risk_threshold")),
        approval_channels=list(data.get("approval_channels") or ["desktop"]),
        approval_timeout_minutes=int(data.get("approval_timeout_minutes") or 30),
        soul_md=soul_md_value,
        think_mode=str(data.get("think_mode") or "agent_loop").strip() or "agent_loop",
        thinking_enabled=None if data.get("thinking_enabled") is None else bool(data.get("thinking_enabled")),
        model_name=model_name_value,
        max_turns=int(data.get("max_turns") or 10),
        timeout_seconds=timeout_seconds_value,
        skills=skills_value,
        kb_injection=_safe_kb_injection(data.get("kb_injection")),
        work_schedule_enabled=bool(data.get("work_schedule_enabled", True)),
        work_start_hour=int(data.get("work_start_hour") if data.get("work_start_hour") is not None else 9),
        work_end_hour=int(data.get("work_end_hour") if data.get("work_end_hour") is not None else 20),
        approval_timeout_by_type=dict(data.get("approval_timeout_by_type") or {}),
        daily_budget_usd=float(data.get("daily_budget_usd") or 0.0),
        per_run_budget_usd=float(data.get("per_run_budget_usd") or 0.0),
        budget_exceed_policy=str(data.get("budget_exceed_policy") or "skip_patrol").strip() or "skip_patrol",
        reports_to=_normalize_reports_to(agent_code, data.get("reports_to")),
        memory_enabled=_role_memory_enabled_from_hire_data(data),
        inject_user_profile=None if data.get("inject_user_profile") is None else bool(data.get("inject_user_profile")),
        inject_skills=None if data.get("inject_skills") is None else bool(data.get("inject_skills")),
        inject_kb=None if data.get("inject_kb") is None else bool(data.get("inject_kb")),
        inject_soul=None if data.get("inject_soul") is None else bool(data.get("inject_soul")),
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

    # Read-after-write: never report create/hire success if the roster row is missing.
    # (Observed: agents.create-looking success with empty 花名册 until a later hire.)
    verified = ProactiveRepository.get_role(agent_code)
    if not verified:
        raise ValidationError(
            f"员工岗位「{agent_code}」写入后花名册读回失败；请重试 employees.hire "
            f"（confirm=true）或检查 evoflow.db / 进程是否指向同一数据库。"
        )

    # Best-effort: keep department catalog membership in sync.
    dept_name = str(data.get("department") or "").strip()
    if dept_name:
        try:
            from evoflow.proactive.departments import DepartmentRepository

            DepartmentRepository.ensure_from_roles()
            dept = DepartmentRepository.get_by_name(dept_name)
            if dept:
                listed = DepartmentRepository.list_departments(with_members=True)
                cur = next((d for d in listed if d.get("id") == dept.get("id")), None)
                codes = [str(m.get("agent_code") or "").strip() for m in (cur or {}).get("members") or [] if str(m.get("agent_code") or "").strip()]
                if agent_code not in codes:
                    codes.append(agent_code)
                    DepartmentRepository.set_members(str(dept["id"]), codes)
        except Exception:
            logger.debug("create_employee: dept sync skipped", exc_info=True)

    # Mirror kb_injection into agent's extra_json (per-employee toggle).
    if data.get("kb_injection") is not None or config.kb_injection:
        _persist_agent_kb_injection(
            role.agent_code, dict(data.get("kb_injection") or config.kb_injection or {}),
        )
    # Mirror knowledge_vault_ids into extra_json so the live middleware sees them.
    _persist_agent_kb_vault_ids(role.agent_code, list(config.knowledge_vault_ids or []))
    try:
        from evoflow.config.agents_config import invalidate_agent_config_cache

        invalidate_agent_config_cache(role.agent_code)
    except Exception:
        pass

    detail = _role_detail(verified)
    notice = _org_notice_for_role(verified)
    detail["org_notice"] = notice
    detail["org_wiring"] = notice  # compat alias for earlier clients / guides
    return detail


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
    if data.get("agent_name") is not None:
        # Canonical display name: sync role_name + agent.agent_name
        an = str(data.get("agent_name") or "").strip()
        if an:
            role.role_name = an
            try:
                from evoflow.admin import agents as agents_admin

                agents_admin.update_agent(code, {"agent_name": an})
            except Exception:
                logger.debug("employees.update: agent_name mirror skipped code=%s", code, exc_info=True)
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
            heartbeat_rrule=str(data.get("heartbeat_rrule") or "").strip() or None if data.get("heartbeat_rrule") is not None else None,
        )

    cfg = role.config
    # Persist description on role extra + linked Agent (CORE-EMP-03).
    if data.get("description") is not None:
        desc = str(data.get("description") or "").strip()
        extra = dict(cfg.extra_context or {}) if isinstance(cfg.extra_context, dict) else {}
        extra["agent_description"] = desc
        cfg.extra_context = extra
        try:
            from evoflow.admin import agents as agents_admin

            agents_admin.update_agent(code, {"description": desc})
        except Exception:
            logger.debug("employees.update: agent description mirror skipped code=%s", code, exc_info=True)

    # Prompt single-source: system_prompt on agent; merge leftover responsibilities then clear.
    from evoflow.proactive.employee_prompting.job import merge_duty_into_system_prompt

    incoming_prompt = None
    if data.get("system_prompt") is not None:
        incoming_prompt = str(data.get("system_prompt") or "").strip()
    incoming_resp = None
    if data.get("responsibilities") is not None:
        incoming_resp = _coerce_responsibilities(data.get("responsibilities"))

    if incoming_prompt is not None or incoming_resp is not None:
        try:
            from evoflow.admin import agents as agents_admin
            from evoflow.config.agents_config import load_agent_config

            existing_sp = ""
            try:
                agent_cfg = load_agent_config(code)
                if agent_cfg and agent_cfg.system_prompt:
                    existing_sp = str(agent_cfg.system_prompt).strip()
            except Exception:
                existing_sp = ""
            base_sp = incoming_prompt if incoming_prompt is not None else existing_sp
            legacy = incoming_resp if incoming_resp is not None else list(cfg.responsibilities or [])
            # Only merge legacy when client did not send an explicit new prompt.
            if incoming_prompt is not None:
                merged = incoming_prompt
            else:
                merged = merge_duty_into_system_prompt(base_sp, legacy)
            if merged != existing_sp:
                agents_admin.update_agent(code, {"system_prompt": merged or None})
        except Exception:
            logger.debug("employees.update: system_prompt merge skipped code=%s", code, exc_info=True)
        # Always clear role responsibilities after handling (duties live on agent).
        cfg.responsibilities = []
    if data.get("workspace_path") is not None:
        cfg.workspace_path = _validate_workspace_path(data.get("workspace_path"))
    if data.get("knowledge_vault_ids") is not None:
        from evoflow.proactive.prompt import validate_agent_knowledge_ids

        try:
            cfg.knowledge_vault_ids = validate_agent_knowledge_ids(list(data.get("knowledge_vault_ids") or []))
        except ValueError as e:
            raise ValidationError(str(e)) from e
    if data.get("kb_injection") is not None:
        from evoflow.config.agents_config import KbInjectionConfig

        cfg.kb_injection = KbInjectionConfig.from_dict(data.get("kb_injection") or {}).to_dict()
        _mark_employee_override(cfg, override=True)
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
    if "thinking_enabled" in data:
        val = data.get("thinking_enabled")
        cfg.thinking_enabled = None if val is None else bool(val)
    if data.get("model_name") is not None:
        cfg.model_name = str(data.get("model_name") or "").strip()
        _mark_employee_override(cfg, override=True)
    if data.get("max_turns") is not None:
        cfg.max_turns = int(data["max_turns"])
    if data.get("timeout_seconds") is not None:
        cfg.timeout_seconds = int(data["timeout_seconds"])
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

    if "memory_enabled" in data:
        cfg.memory_enabled = bool(data.get("memory_enabled"))
    elif "inject_memory" in data or "inject_assets" in data:
        if data.get("inject_memory") is False or data.get("inject_assets") is False:
            cfg.memory_enabled = False
        elif data.get("inject_memory") is True or data.get("inject_assets") is True:
            cfg.memory_enabled = True
    if "inject_user_profile" in data:
        val = data.get("inject_user_profile")
        cfg.inject_user_profile = None if val is None else bool(val)
    if "inject_skills" in data:
        val = data.get("inject_skills")
        cfg.inject_skills = None if val is None else bool(val)
    if "inject_kb" in data:
        val = data.get("inject_kb")
        cfg.inject_kb = None if val is None else bool(val)
    if "inject_soul" in data:
        val = data.get("inject_soul")
        cfg.inject_soul = None if val is None else bool(val)

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

    # Mirror kb_injection from role.config into agent's extra_json so the
    # KbInjectionMiddleware can read it on every model call.
    if data.get("kb_injection") is not None:
        _persist_agent_kb_injection(role.agent_code, dict(cfg.kb_injection or {}))
    # Mirror knowledge_vault_ids so the live middleware sees the role's bound vaults.
    if data.get("knowledge_vault_ids") is not None:
        _persist_agent_kb_vault_ids(role.agent_code, list(cfg.knowledge_vault_ids or []))
    # Mirror skills onto AgentConfig — skill allowlist reads Agent, not only ProactiveRoleConfig.
    if data.get("skills") is not None:
        try:
            from evoflow.admin import agents as agents_admin

            agents_admin.update_agent(role.agent_code, {"skills": list(cfg.skills or [])})
        except Exception:
            logger.exception(
                "Failed to mirror employee skills onto agent code=%s",
                role.agent_code,
            )
    try:
        from evoflow.admin.agents import refresh_agent_runtime_after_capability_change

        refresh_agent_runtime_after_capability_change(role.agent_code)
    except Exception:
        try:
            from evoflow.config.agents_config import invalidate_agent_config_cache

            invalidate_agent_config_cache(role.agent_code)
        except Exception:
            pass

    out = _role_detail(role)
    notice = _org_notice_for_role(role)
    out["org_notice"] = notice
    out["org_wiring"] = notice  # compat
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
    busy_codes = {str(row.get("agent_code") or "").strip() for row in (list(gw.get("busy_roles") or []) if gw else []) if isinstance(row, dict)}
    was_busy = code in busy_codes
    gw_resp = _try_gateway_post(f"/roles/{code}/stop")
    # Always suspend auto-patrol; ``stopped`` only means an in-flight round was interrupted (CORE-EMP-05).
    role.config.auto_patrol_suspended = True
    role.next_heartbeat_at = None
    role.updated_at = utc_now_iso_z()
    ProactiveRepository.save_role(role)
    return {
        "ok": True,
        "agent_code": code,
        "status": role.status,
        "stopped": was_busy,
        "was_busy": was_busy,
        "auto_patrol_suspended": True,
        "patrol_suspended": True,
        "gateway_notified": gw_resp is not None,
        **(gw_resp or {}),
    }


def delete_role(agent_code: str, *, delete_agent: bool = False) -> dict[str, Any]:
    """Remove a duty role (and optionally its Agent). Destructive (CORE-EMP-06)."""
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    try:
        ok = ProactiveRepository.delete_role(code)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    agent_deleted = False
    if delete_agent:
        try:
            from evoflow.admin import agents as agents_admin

            agents_admin.delete_agent(code, confirm_cascade=False, keep_employee=True)
            agent_deleted = True
        except Exception as exc:
            logger.warning("employees.delete: role removed but agent delete failed code=%s: %s", code, exc)
    return {
        "ok": True,
        "deleted": bool(ok),
        "agent_code": code,
        "role_name": role.role_name,
        "agent_deleted": agent_deleted,
    }


def resume_role(agent_code: str) -> dict[str, Any]:
    code = str(agent_code or "").strip()
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    prev = role.status
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


def _role_summary(role: ProactiveRole, *, busy_codes: set[str]) -> dict[str, Any]:
    from evoflow.proactive.org import role_org_key

    code = role.agent_code
    system_front_desk = False
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        system_front_desk = is_xiaomi_agent(code)
    except Exception:
        system_front_desk = False

    # Pull agent_name for display fallback when role_name is empty.
    agent_name = ""
    try:
        from evoflow.admin.agents import get_agent

        agent_row = get_agent(code)
        agent_name = str(agent_row.get("agent_name") or "")
    except Exception:
        agent_name = ""

    return {
        "agent_code": code,
        "agent_name": agent_name,
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


def list_roles(*, status: str | None = None) -> dict[str, Any]:
    """Roster + pending approvals + busy (when Gateway is up)."""
    st = (status or "").strip() or None
    if st is not None:
        try:
            st = normalize_role_status(st)
        except ValueError as e:
            raise ValidationError(str(e)) from e
    all_roles = ProactiveRepository.list_roles(status=None)
    roles = [r for r in all_roles if (st is None or str(r.status or "").strip().lower() == st)]

    gw = _fetch_gateway_status()
    busy_rows = list(gw.get("busy_roles") or []) if gw else []
    busy_codes = {str(row.get("agent_code") or "").strip() for row in busy_rows if isinstance(row, dict) and str(row.get("agent_code") or "").strip()}
    pending = ProactiveRepository.list_pending_approvals()
    pending_by_role: Counter[str] = Counter()
    for a in pending:
        pending_by_role[a.role_agent_code] += 1

    # Roster-wide counters stay stable under status filter (CORE-EMP-04).
    all_summaries = [_role_summary(r, busy_codes=busy_codes) for r in all_roles]
    active_count = sum(1 for r in all_summaries if r.get("status") == "active")
    busy_count = sum(1 for r in all_summaries if r.get("busy"))

    items = []
    for role in roles:
        row = _role_summary(role, busy_codes=busy_codes)
        row["pending_approvals"] = int(pending_by_role.get(role.agent_code, 0))
        items.append(row)

    return {
        "roles": items,
        "count": len(items),
        "total": len(all_roles),
        "status_filter": st or "all",
        "active_count": active_count,
        "busy_count": busy_count,
        "pending_approvals": len(pending),
        "gateway_reachable": gw is not None,
        "busy_roles": busy_rows if st is None else [b for b in busy_rows if str((b or {}).get("agent_code") or "").strip() in {r.agent_code for r in roles}],
        "hint": "active_count/busy_count/total 为全量花名册；count 为当前 status_filter 命中条数",
    }


def worklog(
    agent_code: str,
    *,
    day: str | None = None,
    days: int | None = None,
    limit: int = 80,
) -> dict[str, Any]:
    """Day work log: duty rounds (initiatives) ∪ board Tasks for the employee.

    ``day`` is interpreted in Asia/Shanghai. Initiative timestamps and Task
    created/updated/completed times are matched on the Beijing calendar day so
    UTC/Z vs ``+08:00`` storage does not empty the log.

    ``days`` (when set and ``day`` omitted) aggregates the last N Beijing calendar
    days inclusive of today (CORE-EMP-01).
    """
    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")

    from datetime import datetime, timedelta

    from evoflow.timeutil import BEIJING_TZ

    lim = max(1, min(int(limit), 200))
    lookback = int(days) if days is not None else None
    if lookback is not None and lookback <= 0:
        raise ValidationError("days must be >= 1")
    if lookback is not None:
        lookback = min(lookback, 30)

    if lookback and not day:
        end = datetime.now(BEIJING_TZ).date()
        day_list = [(end - timedelta(days=i)).isoformat() for i in range(lookback)]
        day_list.reverse()
    else:
        day_list = [_parse_worklog_day(day)]

    all_inits = ProactiveRepository.list_initiatives(role_agent_code=code, limit=max(lim * max(1, lookback or 1), 80))
    day_inits: list[Any] = []
    tasks: list[dict[str, Any]] = []
    seen_task: set[str] = set()
    for day_s in day_list:
        day_inits.extend(i for i in all_inits if _timestamp_on_beijing_day(getattr(i, "created_at", None), day_s))
        for t in _list_role_tasks_for_beijing_day(code, day_s, limit=lim):
            tid = str(t.get("task_id") or "")
            if tid and tid in seen_task:
                continue
            if tid:
                seen_task.add(tid)
            tasks.append(t)
            if len(tasks) >= lim:
                break
        if len(tasks) >= lim:
            break
    rounds = _group_rounds(day_inits)
    tasks = tasks[:lim]

    # Two sources by design — do NOT treat round_count==0 as "no work":
    # rounds  = duty-patrol initiatives (created when a proactive round runs)
    # tasks   = board Tasks assigned that day (items.dispatch / proactive dispatch)
    activity_count = len(rounds) + len(tasks)
    window = day_list[0] if len(day_list) == 1 else f"{day_list[0]}..{day_list[-1]}"
    if rounds and tasks:
        hint = f"{window} 有 {len(rounds)} 个值班轮次、{len(tasks)} 个台账任务；看「干了啥」请同时读 rounds 与 tasks，勿只看 round_count。"
    elif tasks and not rounds:
        hint = f"{window} 无值班巡检轮次（round_count=0 正常），但有 {len(tasks)} 个台账任务；派发/执行工作请看 tasks[]，不要据此判定 worklog 为空。"
    elif rounds and not tasks:
        hint = f"{window} 有 {len(rounds)} 个值班轮次，无台账任务记录。"
    else:
        hint = f"{window} 暂无值班轮次与台账任务。"

    return {
        "agent_code": code,
        "role_name": role.role_name,
        "day": day_list[-1],
        "days": lookback,
        "day_from": day_list[0],
        "day_to": day_list[-1],
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
            "days": "传整数 days=N 时汇总近 N 个北京日历日（含今天）；传 day=YYYY-MM-DD 时只查单日",
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
    from evoflow.proactive.chat_session import resolve_work_session_key
    from evoflow.proactive.duty_runs import get_duty_run_by_round, list_duty_runs

    # Prefer duty_runs index (session_key + round) over legacy proactive:{code}.
    session_key = f"proactive:{code}"
    duty_row = None
    if rid:
        duty_row = get_duty_run_by_round(code, rid)
    if not duty_row:
        recent_runs = list_duty_runs(code, limit=1)
        duty_row = recent_runs[0] if recent_runs else None
        if duty_row and not rid:
            rid = str(duty_row.get("round_id") or "").strip() or None
    if duty_row and str(duty_row.get("session_key") or "").strip():
        session_key = str(duty_row["session_key"]).strip()
    elif rid:
        session_key = resolve_work_session_key(
            agent_code=code,
            kind="duty",
            round_id=rid,
        )

    result = list_messages_for_display_all(session_key, max_rows=200, round_id=rid)
    messages = list(result.get("messages") or [])
    # Legacy contact session fallback when duty key is empty.
    if not messages and session_key != f"proactive:{code}":
        legacy = list_messages_for_display_all(f"proactive:{code}", max_rows=200, round_id=rid)
        messages = list(legacy.get("messages") or [])
        if messages:
            session_key = f"proactive:{code}"
    steps = _extract_tool_steps(messages, max_steps=ms)
    tool_counts = Counter(s["tool"] for s in steps)

    # Round scorecard: duty_run outcome first, then initiatives.
    scorecard: dict[str, Any] = {}
    if duty_row:
        scorecard = {
            "goal": "定时上班" if duty_row.get("scheduled") else "值班轮次",
            "outcome": str(duty_row.get("trigger_reason") or duty_row.get("skip_reason") or "").strip() or None,
            "verdict": str(duty_row.get("status") or "").strip() or None,
            "item_count": int(duty_row.get("tool_count") or 0),
        }
    if rid and not scorecard.get("outcome"):
        inits = [i for i in ProactiveRepository.list_initiatives(role_agent_code=code, limit=80) if str(i.round_id or "") == rid]
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
        "duty_run_id": str((duty_row or {}).get("run_id") or "") or None,
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
    matches = [r for r in ProactiveRepository.list_roles(status="active") if str(r.role_name or "").strip().casefold() == key_l or str(r.agent_code or "").strip().casefold() == key_l]
    if not matches:
        # Also allow paused lookup by exact code already failed; try any status by name
        matches = [r for r in ProactiveRepository.list_roles() if str(r.role_name or "").strip().casefold() == key_l]
    if not matches:
        raise NotFoundError(f"No employee matching '{key}'. Use agent_code or role_name (see `evoflow employees list`).")
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
                "message": ("目标中引用的 Task 均已结案，跳过重复派发：" + ", ".join(f"`{i}`" for i in done_ids[:8])),
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
                    logger.exception("employees.dispatch in-process failed agent=%s", code)

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
            f"Gateway timeout calling {url}. "
            "Is Gateway running? Check EVOFLOW_GATEWAY_URL / EVOFLOW_PROACTIVE_URL."
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
        raise ValidationError(f"Target '{target_role.agent_code}' status is '{target_role.status}', not 'active'")

    from_s = str(from_agent or "").strip()
    from_role: ProactiveRole | None = None
    # Platform identities (user / system / 小V) are not roster rows — pass through
    # to dispatch; do not resolve_role_ref (NotFoundError). Needed for
    # upstream_receipt soft-wake (from_agent=system).
    _platform_from = from_s.lower() in {"", "user", "system"}
    if not _platform_from and from_s:
        try:
            from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        except Exception:

            def is_xiaomi_agent(_name: str | None) -> bool:  # type: ignore[misc]
                return False

        _platform_from = bool(is_xiaomi_agent(from_s))
    if from_s and not _platform_from:
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
            codes = {str(h.get("agent_code") or "").strip().lower() for h in handlers if str(h.get("agent_code") or "").strip()}
            if target_role.agent_code.lower() in codes:
                pid = str(parent_row.get("id") or parent_row.get("task_id") or "").strip()
                raise ValidationError(f"上游 Task `{pid}` 交接待审批：批准前禁止 wake 下游 「{target_role.role_name}」。请等用户同意后由系统派发。")

        if tid:
            child = load_work_item_task(tid)
            if child:
                parent_id = str(child.get("parent_task_id") or child.get("parent_id") or "").strip()
                if parent_id:
                    found = find_main_task(get_project_storage(), parent_id, bypass_cache=True)
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
                "message": ("目标中引用的 Task 均已 reviewed/completed，跳过重复派发：" + ", ".join(f"`{i}`" for i in done_ids[:8])),
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


def _employee_owns_session_key(session_key: str, agent_code: str) -> bool:
    """True only for ``proactive:{agent_code}`` / ``proactive:{agent_code}:…``.

    Platform ``dispatch_platform_action`` injects the *caller* conversation
    ``session_key`` (often ``agent:main:…`` / Xiaomi). Those must never be
    treated as the employee chat target.
    """
    from evoflow.proactive.chat_session import is_proactive_session_key, parse_proactive_session_key

    sk = str(session_key or "").strip()
    code = str(agent_code or "").strip()
    if not sk or not code:
        return False
    if not is_proactive_session_key(sk):
        return False
    parsed = parse_proactive_session_key(sk)
    return str(parsed.get("agent_code") or "").strip() == code


def chat_send(
    agent_code: str,
    message: str,
    *,
    session_key: str = "",
    task_id: str = "",
    source: str = "xiaomi",
) -> dict[str, Any]:
    """Send a free-chat turn and **server-side wake** the employee.

    Historically this only returned ``client_effect=employee_chat_send`` and
    ``queued=true``, relying on the desktop Panel to run ``chatSend``. When
    Xiaomi/platform is invoked from the main chat (or mobile), that effect
    never hits the employee trail — no ``duty_run``, fake busy UI.

    Now: resolve session key for the right-stage UI, then ``wake`` with the
    message as goal so a real duty round starts. ``queued`` is true only when
    wake accepted (not skipped). Prefer ``dispatch`` / ``wake`` for explicit
    work items; use chat_send for short follow-ups.
    """
    from evoflow.proactive.chat_session import (
        list_employee_conversation_sessions,
        parse_proactive_session_key,
        proactive_chat_session_key,
        proactive_task_session_key,
    )
    from evoflow.timeutil import utc_now_iso_z

    code = str(agent_code or "").strip()
    text = str(message or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    if not text:
        raise ValidationError("message is required")

    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")
    if role.status != "active":
        raise ValidationError(f"Role status is '{role.status}', not 'active'")

    tid = str(task_id or "").strip()
    raw_sk = str(session_key or "").strip()
    ignored_caller_session = False
    sk = raw_sk
    if sk and not _employee_owns_session_key(sk, code):
        # Do not raise: platform always setdefaults the ambient chat key.
        ignored_caller_session = True
        sk = ""

    if sk:
        parsed = parse_proactive_session_key(sk)
        if not tid and parsed.get("kind") == "task":
            tid = str(parsed.get("task_id") or "").strip()
    elif tid:
        sk = proactive_task_session_key(code, tid)
    else:
        # Prefer a recent chat / running session; else mint a fresh chat episode.
        convs = list_employee_conversation_sessions(code, limit=40)
        running = next(
            (
                c
                for c in convs
                if str(c.get("run_status") or "").lower()
                in {"running", "busy", "active", "in_progress"}
                and _employee_owns_session_key(str(c.get("session_key") or ""), code)
            ),
            None,
        )
        chat_hit = next(
            (
                c
                for c in convs
                if str(c.get("kind") or "") == "chat"
                and _employee_owns_session_key(str(c.get("session_key") or ""), code)
            ),
            None,
        )
        hit = running or chat_hit
        if hit and hit.get("session_key"):
            sk = str(hit["session_key"]).strip()
            if not tid and str(hit.get("kind") or "") == "task":
                tid = str(hit.get("task_id") or "").strip()
        else:
            sk = proactive_chat_session_key(code, utc_now_iso_z())

    src = str(source or "xiaomi").strip() or "xiaomi"
    from_agent = "xiaomi" if src.casefold() in {"xiaomi", "user", "panel", "desktop"} else src

    wake_result: dict[str, Any] | None = None
    wake_error = ""
    try:
        wake_result = wake(
            code,
            goal=text[:800],
            from_agent=from_agent,
            task_id=tid,
            description=text[:2000],
            source="xiaomi" if from_agent == "xiaomi" else src,
            resume_round=bool(tid),
        )
    except Exception as exc:
        wake_error = str(exc).strip() or type(exc).__name__
        logger.warning("chat_send: wake failed agent=%s err=%s", code, wake_error)

    skipped = bool(isinstance(wake_result, dict) and wake_result.get("skipped"))
    woke = bool(wake_result is not None and not skipped and not wake_error)
    out: dict[str, Any] = {
        "ok": woke or skipped,
        "agent_code": code,
        "role_name": role.role_name,
        "session_key": sk,
        "task_id": (wake_result or {}).get("task_id") or tid or None,
        "message": text,
        "source": src,
        "client_effect": "employee_chat_send",
        # Only claim queued when a real wake was accepted (not client-effect theater).
        "queued": woke,
        "busy": woke,
        "wake": wake_result,
    }
    if skipped:
        out["skipped"] = True
        out["skip_reason"] = str((wake_result or {}).get("reason") or (wake_result or {}).get("message") or "")
    if wake_error:
        out["ok"] = False
        out["queued"] = False
        out["busy"] = False
        out["error"] = wake_error
        out["hint"] = (
            "chat_send 未能叫醒员工（服务端 wake 失败）。"
            "请改用 employees.dispatch / employees.wake，或检查对方是否 active / 上游交工是否待审。"
        )
    if ignored_caller_session:
        out["ignored_caller_session_key"] = raw_sk
    return out


def list_chat_messages(
    agent_code: str,
    *,
    session_key: str = "",
    task_id: str = "",
    limit: int = 20,
) -> dict[str, Any]:
    """Return recent transcript rows for Xiaomi / platform to inspect results."""
    from evoflow.persistence.chat_message_repositories import list_messages_for_display_all
    from evoflow.proactive.chat_session import (
        list_employee_conversation_sessions,
        proactive_session_key,
        proactive_task_session_key,
    )

    code = str(agent_code or "").strip()
    if not code:
        raise ValidationError("agent_code is required")
    role = ProactiveRepository.get_role(code)
    if not role:
        raise NotFoundError(f"Role '{code}' not found")

    lim = max(1, min(int(limit or 20), 100))
    tid = str(task_id or "").strip()
    sk = str(session_key or "").strip()
    # 同 chat_send：忽略注入进来的主聊 / 非本岗 session_key
    if sk and not _employee_owns_session_key(sk, code):
        sk = ""
    if not sk:
        if tid:
            sk = proactive_task_session_key(code, tid)
        else:
            convs = list_employee_conversation_sessions(code, limit=20)
            preferred = next(
                (
                    c
                    for c in convs
                    if str(c.get("kind") or "") in {"chat", "task", "duty"}
                    and _employee_owns_session_key(str(c.get("session_key") or ""), code)
                ),
                None,
            )
            sk = (
                str((preferred or {}).get("session_key") or "").strip()
                or proactive_session_key(code)
            )

    raw = list_messages_for_display_all(sk, max_rows=max(lim * 3, 60), include_hidden=False)
    rows = list(raw.get("messages") or []) if isinstance(raw, dict) else []
    if not isinstance(rows, list):
        rows = []

    def _extract_text(row: dict[str, Any]) -> str:
        direct = str(row.get("content") or row.get("text") or row.get("body") or "").strip()
        if direct:
            return direct
        payload = row.get("content_json")
        if isinstance(payload, str):
            return payload.strip()
        if isinstance(payload, dict):
            for key in ("text", "content", "body"):
                v = payload.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            parts = payload.get("parts") or payload.get("content")
            if isinstance(parts, list):
                bits: list[str] = []
                for p in parts:
                    if isinstance(p, str) and p.strip():
                        bits.append(p.strip())
                    elif isinstance(p, dict):
                        t = str(p.get("text") or p.get("content") or "").strip()
                        if t:
                            bits.append(t)
                return "\n".join(bits).strip()
        if isinstance(payload, list):
            bits = []
            for p in payload:
                if isinstance(p, str) and p.strip():
                    bits.append(p.strip())
                elif isinstance(p, dict):
                    t = str(p.get("text") or p.get("content") or "").strip()
                    if t:
                        bits.append(t)
            return "\n".join(bits).strip()
        return ""

    # Keep last N user/assistant only; slim for tool consumption
    slim: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        role_name = str(row.get("role") or "").strip().lower()
        if role_name not in {"user", "assistant", "human", "ai"}:
            continue
        content = _extract_text(row)
        if not content:
            continue
        slim.append(
            {
                "role": "user" if role_name in {"user", "human"} else "assistant",
                "content": content[:4000],
                "created_at": str(row.get("created_at") or row.get("createdAt") or "").strip() or None,
            }
        )
    slim = slim[-lim:]
    last_assistant = ""
    for row in reversed(slim):
        if str(row.get("role") or "") == "assistant":
            last_assistant = str(row.get("content") or "")
            break
    return {
        "ok": True,
        "agent_code": code,
        "role_name": role.role_name,
        "session_key": sk,
        "task_id": tid or None,
        "count": len(slim),
        "messages": slim,
        "last_assistant_text": last_assistant[:2000] if last_assistant else "",
    }
