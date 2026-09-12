"""LangGraph run ``context`` schema for the lead agent graph.

LangGraph Agent Server passes session/run fields via ``execution_runtime.context``.
Without ``context_schema``, ``create_agent`` defaults ``ContextT`` to ``None`` and Pydantic
warns when serializing ``ToolRuntime.context`` dicts at the tools node.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field, fields
from typing import Any

from langgraph.runtime import Runtime


@dataclass
class LeadAgentRuntimeContext:
    """Per-run context from EvoPanel / Gateway (``runs.stream`` ``context``)."""

    agent_id: str | None = None
    agent_name: str | None = None
    position_code: str | None = None
    thread_id: str | None = None
    parent_thread_id: str | None = None
    local_workspace_root: str | None = None
    use_virtual_paths: bool | None = None
    model_name: str | None = None
    primary_model_name: str | None = None
    session_mode: str | None = None
    thinking_enabled: bool | None = None
    reasoning_effort: str | None = None
    is_plan_mode: bool | None = None
    subagent_enabled: bool | None = None
    max_concurrent_subagents: int | None = None
    include_search: bool | None = None
    memory_enabled: bool | None = None
    use_claude_code_chat: bool | None = None
    collab_phase: str | None = None
    collab_task_id: str | None = None
    collab_subtask_id: str | None = None
    prompt_language: str | None = None
    evf_trace_id: str | None = None
    evf_user_input_ts_ms: int | None = None
    evf_dynamic_prompt_meta: dict[str, Any] | None = None
    evf_user_question: str | None = None
    evf_prompt_source: str | None = None
    session_key: str | None = None
    # Human identity (injected from request / session owner / resource owner)
    principal_id: str | None = None
    created_by: str | None = None
    owner_scope_id: str | None = None
    org_id: str | None = None
    # 小V 侧栏：本轮发送时的页面快照（优先于 SQLite session context）
    xiaomi_page_context: dict[str, Any] | None = None
    goal_mode: bool | None = None
    goal_automated: bool | None = None
    prompt_source: str | None = None
    intent_hint: str | None = None
    mission_state: dict[str, Any] | None = None
    tools_mode: str | None = None
    triggered_by: str | None = None
    automation_task_id: str | None = None
    automation_name: str | None = None
    claude_session_id: str | None = None
    claude_session_reuse_session_id: str | None = None
    sandbox_id: str | None = None
    preferred_skills: list[str] | None = None
    preferred_skill: str | None = None
    # Smart-employee (proactive) patrol / execute
    proactive_process: bool | None = None
    proactive_agent_code: str | None = None
    proactive_system_prompt: str | None = None
    proactive_initiative_id: str | None = None
    round_id: str | None = None
    is_plan_mode: bool | None = None

    _EXTRA: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        """Dict-like access when LangGraph injects a dataclass instance into tools/middleware."""
        if not key:
            return default
        if key in {f.name for f in fields(self)}:
            val = getattr(self, key)
            return default if val is None else val
        return self._EXTRA.get(key, default)

    def __setitem__(self, key: str, value: Any) -> None:
        """Allow dict-style assignment (e.g. ``runtime.context["sandbox_id"] = ...``)."""
        if key in {f.name for f in fields(self)}:
            object.__setattr__(self, key, value)
        else:
            self._EXTRA[key] = value

    def __contains__(self, key: str) -> bool:
        if key in {f.name for f in fields(self)}:
            return getattr(self, key) is not None
        return key in self._EXTRA

    @classmethod
    def from_mapping(cls, data: dict[str, Any] | None) -> LeadAgentRuntimeContext:
        if not isinstance(data, dict):
            return cls()
        try:
            from evoflow.authz.runtime_identity import enrich_run_context_identity

            data = enrich_run_context_identity(data)
        except Exception:
            pass
        known = {f.name for f in fields(cls) if f.name != "_EXTRA"}
        inst = cls(**{k: data[k] for k in data if k in known})
        extra = {k: v for k, v in data.items() if k not in known}
        if extra:
            inst._EXTRA.update(extra)
        return inst


def context_to_dict(ctx: Any) -> dict[str, Any]:
    """Normalize Agent Server execution context (dict or dataclass) to a plain dict."""
    if isinstance(ctx, dict):
        return dict(ctx)
    if ctx is None:
        return {}

    class _CtxCarrier:
        context: Any

    carrier = _CtxCarrier()
    carrier.context = ctx
    return runtime_context_mapping(carrier)  # type: ignore[arg-type]


MODEL_REQUEST_CONTEXT_KEYS: tuple[str, ...] = (
    "thread_id",
    "session_key",
    "principal_id",
    "created_by",
    "owner_scope_id",
    "org_id",
    "xiaomi_page_context",
    "session_mode",
    "goal_mode",
    "goal_automated",
    "prompt_source",
    "collab_phase",
    "evf_user_question",
    "evf_prompt_source",
    "prompt_language",
    "thinking_enabled",
    "preferred_skills",
    "preferred_skill",
    "triggered_by",
    "proactive_process",
    "proactive_agent_code",
    "proactive_system_prompt",
    "proactive_initiative_id",
    "round_id",
    "agent_name",
    "local_workspace_root",
    "use_virtual_paths",
    "model_name",
)


def merge_model_request_runtime_context(request: Any) -> dict[str, Any]:
    """Merge LangGraph ``runtime.context`` with per-run ``configurable`` keys."""
    ctx: dict[str, Any] = {}
    runtime = getattr(request, "runtime", None)
    raw = getattr(runtime, "context", None) if runtime is not None else None
    if isinstance(raw, dict):
        ctx.update(raw)
    else:
        ctx.update(runtime_context_mapping(runtime))
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            for key in MODEL_REQUEST_CONTEXT_KEYS:
                if key in cfg and cfg.get(key) not in (None, ""):
                    ctx[key] = cfg[key]
            meta = cfg.get("evf_dynamic_prompt_meta")
            if isinstance(meta, dict) and meta:
                ctx["evf_dynamic_prompt_meta"] = meta
    except Exception:
        pass
    return ctx


def resolve_preferred_skills_for_turn(ctx: dict[str, Any] | None) -> list[str]:
    """Composer / mention skills, with session-sticky fallback from SQLite."""
    from evoflow.config.agents_config import parse_preferred_skills_from_context

    preferred = parse_preferred_skills_from_context(ctx)
    if preferred:
        return preferred
    sk = str((ctx or {}).get("session_key") or "").strip()
    if not sk:
        return []
    try:
        from evoflow.persistence.session_repositories import get_session_context_for_run_config

        sess = get_session_context_for_run_config(sk)
        return parse_preferred_skills_from_context(sess)
    except Exception:
        return []


def runtime_context_mapping(runtime: Runtime | None) -> dict[str, Any]:
    """Normalize ``Runtime.context`` (dict or dataclass) to a plain dict."""
    if runtime is None:
        return {}
    ctx = getattr(runtime, "context", None)
    if ctx is None:
        return {}
    if isinstance(ctx, dict):
        return dict(ctx)
    if isinstance(ctx, LeadAgentRuntimeContext):
        out: dict[str, Any] = {
            f.name: getattr(ctx, f.name) for f in fields(ctx) if f.name != "_EXTRA" and getattr(ctx, f.name) is not None
        }
        extra = getattr(ctx, "_EXTRA", None)
        if isinstance(extra, dict):
            out.update({k: v for k, v in extra.items() if v is not None})
        return out
    if hasattr(ctx, "model_dump"):
        try:
            dumped = ctx.model_dump(mode="python")
            return dict(dumped) if isinstance(dumped, dict) else {}
        except Exception:
            return {}
    if hasattr(ctx, "__dataclass_fields__"):
        from dataclasses import asdict

        return {k: v for k, v in asdict(ctx).items() if v is not None}
    return {}


def _session_model_from_mapping(data: dict[str, Any] | None) -> str | None:
    """User-selected chat model only (not global ``primary_model_name``)."""
    if not isinstance(data, dict):
        return None
    name = str(data.get("model_name") or "").strip()
    if name and name != "default":
        return name
    return None


def _model_name_from_mapping(data: dict[str, Any] | None) -> str | None:
    if not isinstance(data, dict):
        return None
    for key in ("model_name", "primary_model_name"):
        name = str(data.get(key) or "").strip()
        if name and name != "default":
            return name
    return None


def resolve_session_model_name_from_runtime(
    runtime: Runtime | None,
    *,
    lead_thread_id: str | None = None,
    session_key: str | None = None,
    pinned_model_name: str | None = None,
) -> str | None:
    """Resolve the chat session model for subagent / collab delegation.

    Priority: pinned main-task model → runtime context (user selection) →
    configurable → session_key DB → lead thread DB → run metadata (last).
    """
    pinned = str(pinned_model_name or "").strip()
    if pinned and pinned != "default":
        return pinned

    ctx_map: dict[str, Any] = {}
    conf: dict[str, Any] = {}
    meta: dict[str, Any] = {}
    if runtime is not None:
        cfg = getattr(runtime, "config", None) or {}
        if not isinstance(cfg, dict):
            cfg = {}
        ctx_map = runtime_context_mapping(runtime)
        raw_conf = cfg.get("configurable")
        conf = dict(raw_conf) if isinstance(raw_conf, dict) else {}
        raw_meta = cfg.get("metadata")
        meta = dict(raw_meta) if isinstance(raw_meta, dict) else {}

        # Per-run user selection lives in context; metadata may reflect graph compile primary.
        for bag in (ctx_map, conf):
            name = _session_model_from_mapping(bag)
            if name:
                return name

    sk = str(session_key or "").strip() or None
    if not sk and runtime is not None:
        for bag in (ctx_map, conf):
            candidate = str(bag.get("session_key") or "").strip()
            if candidate:
                sk = candidate
                break

    if sk:
        try:
            from evoflow.persistence.session_repositories import get_model_name_for_session_key

            db_name = get_model_name_for_session_key(sk)
            if db_name:
                return str(db_name).strip() or None
        except Exception:
            pass

    from evoflow.collab.thread_ids import lead_thread_from_executor_thread, normalize_lead_thread_id

    lookup_tid = str(lead_thread_id or "").strip() or None
    if runtime is not None and not lookup_tid:
        for bag in (ctx_map, conf):
            tid = str(bag.get("parent_thread_id") or bag.get("thread_id") or "").strip() or None
            if tid:
                lookup_tid = normalize_lead_thread_id(lead_thread_from_executor_thread(tid) or tid)
                break

    if lookup_tid:
        try:
            from evoflow.persistence.session_repositories import get_model_name_for_thread

            db_name = get_model_name_for_thread(lookup_tid)
            if db_name:
                return str(db_name).strip() or None
        except Exception:
            pass

    if runtime is not None:
        name = _session_model_from_mapping(meta) or _model_name_from_mapping(meta)
        if name:
            return name

    return None


def _suppress_tool_runtime_context_pydantic_warning() -> None:
    """ToolNode still serializes un-parameterized ``ToolRuntime`` in some LangGraph builds."""
    for pattern in (
        r".*Pydantic serializer warnings.*",
        r".*PydanticSerializationUnexpectedValue.*field_name='context'.*",
        r".*PydanticSerializationUnexpectedValue.*field_name=\"context\".*",
    ):
        warnings.filterwarnings("ignore", message=pattern, category=UserWarning)
    warnings.filterwarnings("ignore", category=UserWarning, module=r"pydantic\.main")


_suppress_tool_runtime_context_pydantic_warning()
