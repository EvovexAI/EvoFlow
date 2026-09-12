"""Structured tool for collab / duty Task CRUD (same backend as ``evoflow tasks`` CLI).

Prefer this over ``terminal`` + ``evoflow tasks state --handlers '…'`` so nested
``outputs`` / ``handlers`` never go through shell JSON quoting.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, Literal

from langchain.tools import tool
from pydantic import BaseModel, BeforeValidator, Field

logger = logging.getLogger(__name__)

_TASKS_TOOL_DESCRIPTION = """\
岗位 Task 主工具：有进展就立刻 progress 回写，干完必须 state=completed（可带 handlers），勿只 progress 后空等。

action: create | progress | state | delete | list | get。
- progress: task_id + progress 0–100
- state: task_id + status (completed/failed/cancelled) + summary；有下游 completed 时填 handlers
- delete: task_id + confirm=true
outputs: 文档路径 [{type,key,value}]；handlers: [{agent_code,content,read_outputs[]}]

任务 id 见 <proactive_live_tasks> 或看板。list 默认 20 条。
"""

tasks_ui_metadata = {
    "group": "builtin",
    "label": "岗位任务",
    "icon": "📋",
    "description": (
        "值班主工具：create / progress / state / delete。"
        "有进展就 progress；干完必须 state=completed（可带 handlers），禁止只 progress 后空等审批。"
    ),
}

_ACTIONS = frozenset({"list", "get", "create", "progress", "state", "delete"})


class TaskOutputItem(BaseModel):
    """One structured deliverable (file / url / text / other)."""

    type: str = Field("file", description="file|url|text|other")
    key: str = Field(..., description="Stable key")
    value: str = Field(..., description="Path, URL, or short text")
    label: str = Field("", description="Display label")


class TaskHandlerItem(BaseModel):
    """One downstream handoff target."""

    agent_code: str = Field(..., description="Downstream agent_code")
    content: str = Field(..., description="Handoff instructions")
    read_outputs: list[TaskOutputItem] = Field(
        default_factory=list,
        description="Parent deliverables for downstream to read",
    )
    outputs: list[TaskOutputItem] = Field(
        default_factory=list,
        description="Legacy alias of read_outputs",
    )
    role: str = Field("", description="Optional display name")


def _coerce_optional_json_list(v: Any) -> Any:
    """Accept real lists or JSON-encoded list strings (common model mistake)."""
    if v is None:
        return None
    if isinstance(v, str):
        text = v.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(
                "outputs/handlers must be a list or a JSON list string"
            ) from e
        return parsed
    return v


OutputsArg = Annotated[
    list[TaskOutputItem] | None,
    BeforeValidator(_coerce_optional_json_list),
]
HandlersArg = Annotated[
    list[TaskHandlerItem] | None,
    BeforeValidator(_coerce_optional_json_list),
]


def _dump_models(items: list[Any] | None) -> list[dict[str, Any]] | None:
    if items is None:
        return None
    out: list[dict[str, Any]] = []
    for item in items:
        if hasattr(item, "model_dump"):
            row = item.model_dump()
        elif isinstance(item, dict):
            row = dict(item)
        else:
            continue
        # Prefer read_outputs; fold legacy outputs.
        read = row.get("read_outputs")
        if not read:
            read = row.get("outputs") or []
        if isinstance(read, list):
            row["read_outputs"] = [
                o.model_dump() if hasattr(o, "model_dump") else o for o in read if o is not None
            ]
        row.pop("outputs", None)
        out.append(row)
    return out


def _ok(payload: dict[str, Any]) -> str:
    return json.dumps({"ok": True, **payload}, ensure_ascii=False)


def _err(action: str, error: str, **extra: Any) -> str:
    return json.dumps({"ok": False, "action": action, "error": error, **extra}, ensure_ascii=False)


def _resolve_employee_by_code(agent_code: str) -> tuple[str, str] | None:
    """Return (role_name, agent_code) for a hired employee."""
    from evoflow.proactive.repositories import ProactiveRepository

    code = str(agent_code or "").strip()
    if not code:
        return None
    role = ProactiveRepository.get_role(code)
    if role is None or str(role.status or "").strip().lower() == "archived":
        return None
    name = str(role.role_name or "").strip() or code
    return name, code


def _agent_from_duty_context() -> str:
    """Best-effort employee agent_code during proactive duty runs."""
    try:
        from evoflow.agents.middlewares.proactive_tool_middleware import (
            _resolve_proactive_agent_code,
        )

        return str(_resolve_proactive_agent_code(None) or "").strip()
    except Exception:
        return ""


def _session_key_from_context() -> str:
    """Current chat session_key from LangGraph config (if any)."""
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            return str(cfg.get("session_key") or "").strip()
    except Exception:
        pass
    return ""


def _infer_duty_create_defaults(
    *,
    name: str,
    assignee: str | None,
    role_name: str | None,
    source: str | None,
    raised_by: str,
    round_id: str | None,
) -> tuple[str | None, str | None, str, str]:
    """Fill assignee/role/source/raised_by for duty patrol creates."""
    from evoflow.collab.task_noise import is_duty_patrol_task
    from evoflow.collab.task_source import TASK_SOURCE_CHAT, TASK_SOURCE_ROLE

    assignee_norm = str(assignee or "").strip() or None
    role_nm = str(role_name or "").strip() or None
    duty_code = _agent_from_duty_context()

    if role_nm:
        canonical, code = _resolve_role_assignee(role_nm)
        role_nm = canonical
        assignee_norm = assignee_norm or code
    elif assignee_norm:
        resolved = _resolve_employee_by_code(assignee_norm)
        if resolved:
            role_nm, assignee_norm = resolved
    elif duty_code:
        resolved = _resolve_employee_by_code(duty_code)
        if resolved:
            role_nm, assignee_norm = resolved
        else:
            assignee_norm = duty_code

    patrol = is_duty_patrol_task({"name": name}) or str(round_id or "").startswith("round:")
    src = str(source or "").strip() or None
    if not src:
        if patrol:
            src = "proactive_patrol"
        elif role_nm or duty_code or assignee_norm:
            src = TASK_SOURCE_ROLE
        else:
            src = TASK_SOURCE_CHAT

    raised = str(raised_by or "").strip()
    if not raised or raised == "user":
        if duty_code:
            raised = duty_code
        elif assignee_norm:
            raised = assignee_norm
        else:
            raised = "user"
    return assignee_norm, role_nm, src, raised


def _resolve_role_assignee(role_name: str) -> tuple[str, str]:
    from evoflow.admin.errors import ValidationError
    from evoflow.proactive.repositories import ProactiveRepository

    want = str(role_name or "").strip().lower()
    if not want:
        raise ValidationError("role must be a non-empty role_name")
    matches = [
        r
        for r in ProactiveRepository.list_roles()
        if str(r.role_name or "").strip().lower() == want
        and str(r.status or "").strip().lower() != "archived"
    ]
    if not matches:
        raise ValidationError(
            f"no active role found with name '{role_name}'. "
            "Use employees list / roster to see role_name values."
        )
    role = matches[0]
    code = str(role.agent_code or "").strip()
    if not code:
        raise ValidationError(f"role '{role_name}' has empty agent_code")
    return str(role.role_name or "").strip() or role_name, code


@tool("tasks", description=_TASKS_TOOL_DESCRIPTION, parse_docstring=False)
def tasks_tool(
    action: Literal["list", "get", "create", "progress", "state", "delete"],
    *,
    task_id: str = "",
    subtask_id: str = "",
    status: str = "",
    summary: str = "",
    progress: int | None = None,
    outputs: OutputsArg = None,
    handlers: HandlersArg = None,
    name: str = "",
    description: str = "",
    assignee: str = "",
    role: str = "",
    main_task_id: str = "",
    parent_task_id: str = "",
    source: str = "",
    raised_by: str = "",
    source_ref: str = "",
    risk_level: str = "",
    action_type: str = "",
    round_id: str = "",
    confirm: bool = False,
    subtasks_only: bool = False,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """Manage duty Task board (policy in tool description)."""
    from evoflow.admin import tasks as tasks_admin
    from evoflow.admin.errors import NotFoundError, ValidationError

    act = str(action or "").strip().lower()
    if act not in _ACTIONS:
        return _err(act or "unknown", f"invalid action; allowed: {sorted(_ACTIONS)}")

    try:
        if act == "list":
            raw_limit = int(limit) if limit is not None else 20
            if raw_limit < 0:
                raw_limit = 20
            # Cap tool pages so a single call cannot dump the whole board into context.
            list_limit = min(raw_limit, 100) if raw_limit > 0 else 0
            list_offset = max(0, int(offset or 0))
            data = tasks_admin.list_tasks(
                assignee=str(assignee or "").strip() or None,
                role=str(role or "").strip() or None,
                status=str(status or "").strip() or None,
                source=str(source or "").strip() or None,
                main_task_id=str(main_task_id or "").strip() or None,
                include_subtasks=not subtasks_only,
                limit=list_limit if list_limit > 0 else None,
                offset=list_offset,
            )
            return _ok({"action": act, "result": data})

        if act == "get":
            tid = str(task_id or "").strip()
            if not tid:
                return _err(act, "task_id is required")
            data = tasks_admin.get_task(tid, subtask_id=str(subtask_id or "").strip() or None)
            return _ok({"action": act, "result": data})

        if act == "progress":
            tid = str(task_id or "").strip()
            if not tid:
                return _err(act, "task_id is required")
            if progress is None:
                return _err(act, "progress is required (0-100)")
            data = tasks_admin.update_progress(
                tid,
                int(progress),
                status=str(status or "").strip() or None,
                subtask_id=str(subtask_id or "").strip() or None,
            )
            return _ok({"action": act, "result": data})

        if act == "state":
            tid = str(task_id or "").strip()
            st = str(status or "").strip()
            if not tid:
                return _err(act, "task_id is required")
            if not st:
                return _err(act, "status is required")
            try:
                data = tasks_admin.set_task_state(
                    tid,
                    st,
                    subtask_id=str(subtask_id or "").strip() or None,
                    summary=str(summary or "").strip() or None,
                    outputs=_dump_models(outputs),
                    handlers=_dump_models(handlers),
                )
            except ValidationError as exc:
                # Agents often jump pending/planned → completed; machine requires executing.
                # Soft-bridge here (tool UX) without relaxing the admin transition table.
                msg = str(exc)
                st_norm = st.strip().lower().replace("-", "_")
                cur = ""
                if "illegal state transition:" in msg and "->" in msg:
                    try:
                        cur = (
                            msg.split("illegal state transition:", 1)[1]
                            .split("->", 1)[0]
                            .strip()
                            .lower()
                            .replace("-", "_")
                        )
                    except Exception:
                        cur = ""
                _bridge_from = {"pending", "planned", "planning", "waiting_user"}
                _bridge_to = {"completed", "failed", "awaiting_close", "reviewed"}
                if cur in _bridge_from and st_norm in _bridge_to:
                    logger.info(
                        "tasks tool: auto-bridge %s→executing→%s task_id=%s",
                        cur,
                        st_norm,
                        tid,
                    )
                    tasks_admin.set_task_state(
                        tid,
                        "executing",
                        subtask_id=str(subtask_id or "").strip() or None,
                    )
                    data = tasks_admin.set_task_state(
                        tid,
                        st,
                        subtask_id=str(subtask_id or "").strip() or None,
                        summary=str(summary or "").strip() or None,
                        outputs=_dump_models(outputs),
                        handlers=_dump_models(handlers),
                    )
                    if isinstance(data, dict):
                        data = {
                            **data,
                            "auto_bridged_from": cur,
                            "via": "executing",
                        }
                else:
                    raise
            return _ok({"action": act, "result": data})

        if act == "delete":
            tid = str(task_id or "").strip()
            if not tid:
                return _err(act, "task_id is required")
            if not confirm:
                return _err(act, "Refusing to delete without confirm=true (irreversible)")
            data = tasks_admin.delete_task(tid)
            return _ok({"action": act, "result": data})

        # create
        nm = str(name or "").strip()
        if not nm:
            return _err(act, "name is required")
        assignee_norm, role_name, src, raised = _infer_duty_create_defaults(
            name=nm,
            assignee=str(assignee or "").strip() or None,
            role_name=str(role or "").strip() or None,
            source=str(source or "").strip() or None,
            raised_by=str(raised_by or "").strip(),
            round_id=str(round_id or "").strip() or None,
        )
        source_ref_v = str(source_ref or "").strip() or None
        # Stamp session_key so one conversation can associate many independent tasks.
        if not source_ref_v:
            sk = _session_key_from_context()
            if sk.startswith("proactive:"):
                source_ref_v = sk
        round_v = str(round_id or "").strip() or None
        data = tasks_admin.create_task(
            name=nm,
            description=str(description or "").strip(),
            assignee=assignee_norm,
            assigned_role=role_name,
            main_task_id=str(main_task_id or "").strip() or None,
            initial_status=str(status or "").strip() or "pending",
            source=src,
            source_ref=source_ref_v,
            raised_by=raised,
            risk_level=str(risk_level or "").strip() or None,
            action_type=str(action_type or "").strip() or None,
            round_id=round_v,
            parent_task_id=str(parent_task_id or "").strip() or None,
        )
        return _ok({"action": act, "result": data})

    except (ValidationError, NotFoundError) as e:
        return _err(act, str(e))
    except Exception as e:
        logger.exception("tasks tool action=%s failed", act)
        return _err(act, f"{type(e).__name__}: {e}")
