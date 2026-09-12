"""Duty-run tool binding for smart-employee patrols.

**Duty tool model** (≠ chat progressive exposure):

    agent-bound tools only（flat catalog）

No ``scenario`` / ``mode_set`` / ``tool_search`` activation layer.
No ``proactive_submit_work`` / ``proactive_history`` — work state is Task + ``tasks`` tool
(structured args; CLI remains for humans / ops).

Also: clamp model-visible tools to agent catalog; hard-cap message payload.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:  # pragma: no cover
    from typing import override  # type: ignore
from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from evoflow.agents.automation_runtime import triggered_by_proactive
from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping
from evoflow.tools.tool_catalog import is_mode_set_tool

logger = logging.getLogger(__name__)

# Legacy names — stripped if present; never injected on duty runs.
# (``_TOOL_NAME`` / ``_HISTORY_TOOL_NAME`` aliases removed; use this set.)
_LEGACY_DUTY_TOOL_NAMES = frozenset({"proactive_submit_work", "proactive_history"})

# Chat progressive-activation / mode tools — never on duty runs.
_DUTY_STRIP_TOOL_NAMES = frozenset(
    {
        "mode_set",
        "scenario",
        "scenario_activation",
        "tool_search",
        *_LEGACY_DUTY_TOOL_NAMES,
    }
)

# Collab/plan/goal system tools must never appear on duty even if snapshot polluted.
_DUTY_BLOCK_ORCH_TOOLS = frozenset(
    {
        "plan",
        "supervisor",
        "propose_goal",
        "ask_clarification",
        "subtask_outcome_report",
        "subtask_progress_report",
        "subtask_work_checklist",
        "collab_peer_send",
        "collab_peer_read",
        "collab_peer_reply",
        "list_agents",
    }
)

# Stay under common gateway limit (6_291_456) with room for tools/system schemas.
_PROACTIVE_REQUEST_SOFT_BYTES = 4_000_000
_PROACTIVE_TOOL_MSG_MAX_CHARS = 12_000

_DUTY_FOOTER_TAG = "<proactive_duty_status>"
_LIVE_TASKS_MSG_NAME = "proactive_live_tasks"

# Markers kept only so ``analyze_proactive_duty_state`` can parse old transcripts.
_WRAP_UP_NUDGE_MARKER = "[值班提醒·请交班]"
_PROGRESS_NUDGE_MARKER = "[值班提醒·请汇报进度]"


def is_duty_strip_tool(name: str | None) -> bool:
    """True for chat activation / legacy duty tools that duty mode never exposes."""
    n = str(name or "").strip().lower()
    if not n:
        return False
    if n in _DUTY_STRIP_TOOL_NAMES:
        return True
    return is_mode_set_tool(n)


def _finalize_duty_allow(allow: set[str]) -> set[str]:
    allow -= _DUTY_STRIP_TOOL_NAMES
    allow -= _DUTY_BLOCK_ORCH_TOOLS
    allow -= _LEGACY_DUTY_TOOL_NAMES
    # Duty progress tracking uses the same mind_map tool as chat exploration.
    allow.add("mind_map")
    # Structured Task board (create/progress/state) — never rely on shell JSON alone.
    allow.add("tasks")
    return allow


def format_proactive_duty_status_footer(duty: dict[str, Any] | None) -> str:
    """Habit reminder; live Task board is a separate HumanMessage footer."""
    del duty
    return (
        f"{_DUTY_FOOTER_TAG}"
        "状态只认岗位工作项 Task。"
        "有进展立刻用 tasks 回写进度；干完用 tasks 结案并写清结果汇报（summary）与交付物；"
        "需要下游时在结案里指定处理人。"
        "看上下文末尾 <proactive_live_tasks>。"
        "</proactive_duty_status>"
    )


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", "") or "").strip()


def _tool_call_name(tool_call: Any) -> str:
    if isinstance(tool_call, dict):
        return str(tool_call.get("name") or "").strip()
    return str(getattr(tool_call, "name", "") or "").strip()


def _tool_call_id(tool_call: Any) -> str:
    if isinstance(tool_call, dict):
        return str(tool_call.get("id") or tool_call.get("tool_call_id") or "")
    return str(getattr(tool_call, "id", "") or getattr(tool_call, "tool_call_id", "") or "")


def _normalize_submit_phase(raw: Any) -> str:
    p = str(raw or "").strip().lower().replace("-", "_")
    if p in {"checkin", "check_in", "start"}:
        return "check_in"
    if p in {"wrapup", "wrap_up", "handoff", "done"}:
        return "wrap_up"
    if p in {"progress", "update", "mid"}:
        return "progress"
    return p


def _phase_from_tool_call_args(args: Any) -> str:
    if isinstance(args, dict):
        return _normalize_submit_phase(args.get("phase"))
    if isinstance(args, str) and args.strip():
        try:
            import json

            data = json.loads(args)
            if isinstance(data, dict):
                return _normalize_submit_phase(data.get("phase"))
        except Exception:
            pass
        low = args.lower()
        if "check_in" in low or "checkin" in low:
            return "check_in"
        if "wrap_up" in low or "wrapup" in low:
            return "wrap_up"
        if "progress" in low:
            return "progress"
    return ""


def _phase_from_submit_tool_result(content: Any) -> str:
    text = _content_as_str(content)
    if not text.strip():
        return ""
    try:
        import json

        data = json.loads(text)
        if isinstance(data, dict):
            return _normalize_submit_phase(data.get("phase"))
    except Exception:
        pass
    low = text.lower()
    if '"phase": "check_in"' in low or '"phase":"check_in"' in low:
        return "check_in"
    if '"phase": "wrap_up"' in low or '"phase":"wrap_up"' in low:
        return "wrap_up"
    if '"phase": "progress"' in low or '"phase":"progress"' in low:
        return "progress"
    return ""


def analyze_proactive_duty_state(messages: list[Any] | None) -> dict[str, Any]:
    """Inspect transcript for legacy check_in / progress / wrap_up coverage.

    Kept for old ``proactive_submit_work`` transcripts / debugging only —
    **not** used for duty enforcement (nudges disabled).

    Scoped to the **current duty turn**: a non-nudge ``HumanMessage`` (the
    patrol seed prompt) resets all counters so prior rounds hydrated into the
    fixed ``proactive:{code}`` session do not look like already wrapped_up.

    Returns keys: checked_in, wrapped_up, progress_count, tools_since_report,
    wrap_up_nudges, progress_nudges, last_report_phase.
    """
    msgs = list(messages or [])
    checked_in = False
    wrapped_up = False
    progress_count = 0
    last_report_phase = ""
    tools_since_report = 0
    wrap_up_nudges = 0
    progress_nudges = 0
    submit_name = "proactive_submit_work"
    history_name = "proactive_history"

    for m in msgs:
        if isinstance(m, HumanMessage):
            body = _content_as_str(getattr(m, "content", ""))
            if _WRAP_UP_NUDGE_MARKER in body:
                wrap_up_nudges += 1
                continue
            if _PROGRESS_NUDGE_MARKER in body:
                progress_nudges += 1
                continue
            # New duty seed / user turn — ignore prior hydrated rounds.
            checked_in = False
            wrapped_up = False
            progress_count = 0
            last_report_phase = ""
            tools_since_report = 0
            wrap_up_nudges = 0
            progress_nudges = 0
            continue

        if isinstance(m, AIMessage):
            for tc in list(getattr(m, "tool_calls", None) or []):
                if _tool_call_name(tc) != submit_name:
                    continue
                args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", None)
                phase = _phase_from_tool_call_args(args)
                if phase == "check_in":
                    checked_in = True
                    last_report_phase = phase
                    tools_since_report = 0
                elif phase == "progress":
                    checked_in = True
                    progress_count += 1
                    last_report_phase = phase
                    tools_since_report = 0
                elif phase == "wrap_up":
                    checked_in = True
                    wrapped_up = True
                    last_report_phase = phase
                    tools_since_report = 0
            continue

        if isinstance(m, ToolMessage):
            name = str(getattr(m, "name", "") or "").strip()
            if name == submit_name:
                phase = _phase_from_submit_tool_result(getattr(m, "content", ""))
                if not phase:
                    phase = "progress"
                if phase == "check_in":
                    checked_in = True
                elif phase == "progress":
                    checked_in = True
                    progress_count += 1
                elif phase == "wrap_up":
                    checked_in = True
                    wrapped_up = True
                last_report_phase = phase or last_report_phase
                tools_since_report = 0
            elif name and name != history_name:
                tools_since_report += 1

    return {
        "checked_in": checked_in,
        "wrapped_up": wrapped_up,
        "progress_count": progress_count,
        "tools_since_report": tools_since_report,
        "wrap_up_nudges": wrap_up_nudges,
        "progress_nudges": progress_nudges,
        "last_report_phase": last_report_phase,
    }


def _session_key_from_runtime(runtime: Any) -> str:
    ctx = runtime_context_mapping(runtime) if runtime is not None else {}
    sk = str(ctx.get("session_key") or "").strip()
    if sk:
        return sk
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            return str(cfg.get("session_key") or "").strip()
    except Exception:
        pass
    return ""


def is_proactive_session(runtime: Any) -> bool:
    """True when the thread is bound to ``proactive:{agent_code}`` (duty *or* user chat)."""
    return _session_key_from_runtime(runtime).startswith("proactive:")


def _duty_flags_from_mapping(ctx: dict[str, Any] | None) -> bool:
    if not isinstance(ctx, dict):
        return False
    if triggered_by_proactive(ctx):
        return True
    if ctx.get("proactive_process"):
        return True
    return False


def is_proactive_duty_run(runtime: Any) -> bool:
    """True only for unattended/engine duty loops — not user chat into an employee session.

    User opening ``proactive:{code}`` to talk must **not** get the duty handbook
    (巡检收工 / 必须留进展 / 不是陪聊). Those only apply when the proactive engine
    injects ``triggered_by=proactive_engine`` or ``proactive_process=True``.
    """
    ctx = runtime_context_mapping(runtime) if runtime is not None else {}
    if _duty_flags_from_mapping(ctx):
        return True
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if _duty_flags_from_mapping(cfg if isinstance(cfg, dict) else None):
            return True
    except Exception:
        pass
    return False


def is_proactive_run(runtime: Any) -> bool:
    """Duty-loop helper (tool strip / duty brief / live task board).

    Historically also returned True for any ``proactive:`` session_key, which forced
    the duty handbook onto user chat. Prefer ``is_proactive_duty_run`` / 
    ``is_proactive_session`` for new call sites; this alias keeps duty middleware
    behavior while fixing chat.
    """
    return is_proactive_duty_run(runtime)


def _resolve_proactive_agent_code(runtime: Any) -> str:
    """Resolve employee agent_code from runtime context / session_key."""
    ctx = runtime_context_mapping(runtime) if runtime is not None else {}
    code = str(
        ctx.get("proactive_agent_code")
        or ctx.get("agent_id")
        or ctx.get("agent_name")
        or ""
    ).strip()
    if code and code.lower() not in {"main", "lead_agent", "auto"}:
        return code
    sk = str(ctx.get("session_key") or "").strip()
    if sk.startswith("proactive:"):
        from_key = sk.split(":", 1)[1].strip()
        if from_key:
            return from_key
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            code = str(
                cfg.get("proactive_agent_code")
                or cfg.get("agent_id")
                or cfg.get("agent_name")
                or ""
            ).strip()
            if code and code.lower() not in {"main", "lead_agent", "auto"}:
                return code
            sk = str(cfg.get("session_key") or "").strip()
            if sk.startswith("proactive:"):
                from_key = sk.split(":", 1)[1].strip()
                if from_key:
                    return from_key
    except Exception:
        pass
    return ""


def _rebuild_proactive_duty_prompt_from_role(runtime: Any) -> str:
    """Lazy-build duty brief when engine did not inject ``proactive_system_prompt``.

    Only used on true duty loops (``is_proactive_duty_run``). User chat into
    ``proactive:{code}`` falls through to the normal chat system prompt instead.
    """
    code = _resolve_proactive_agent_code(runtime)
    if not code:
        return ""
    try:
        from evoflow.proactive.prompt import build_system_prompt
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
        if role is None:
            return ""
        return str(build_system_prompt(role) or "").strip()
    except Exception:
        logger.debug(
            "proactive: lazy rebuild duty prompt failed code=%s",
            code,
            exc_info=True,
        )
        return ""


def _proactive_duty_prompt(runtime: Any) -> str:
    ctx = runtime_context_mapping(runtime) if runtime is not None else {}
    duty = str(ctx.get("proactive_system_prompt") or "").strip()
    if duty:
        return duty
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            duty = str(cfg.get("proactive_system_prompt") or "").strip()
            if duty:
                return duty
    except Exception:
        pass
    return _rebuild_proactive_duty_prompt_from_role(runtime)


_is_proactive_run = is_proactive_run


def _content_as_str(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                parts.append(str(block.get("text") or block.get("content") or ""))
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(content)


def _utf8_len(text: str) -> int:
    return len(text.encode("utf-8", errors="ignore"))


def _truncate_tool_body(text: str, *, max_chars: int) -> str:
    s = str(text or "")
    if len(s) <= max_chars:
        return s
    keep = max(200, max_chars // 2)
    head = s[:keep]
    tail = s[-keep:]
    omitted = len(s) - 2 * keep
    return (
        f"{head}\n\n…[proactive: tool output truncated, omitted ~{omitted} chars]…\n\n{tail}"
    )


def _with_tool_content(msg: ToolMessage, content: str) -> ToolMessage:
    try:
        return msg.model_copy(update={"content": content})
    except Exception:
        return ToolMessage(
            content=content,
            tool_call_id=getattr(msg, "tool_call_id", "") or "",
            name=getattr(msg, "name", None),
            status=getattr(msg, "status", None),
        )


def _estimate_messages_bytes(messages: list[Any]) -> int:
    total = 0
    for m in messages:
        total += _utf8_len(_content_as_str(getattr(m, "content", "")))
    return total


def _trim_proactive_messages(messages: list[Any]) -> tuple[list[Any], bool]:
    """Cap ToolMessage bodies, then stub oldest tools until under soft byte budget."""
    if not messages:
        return messages, False
    changed = False
    out: list[Any] = []
    for m in messages:
        if isinstance(m, ToolMessage):
            body = _content_as_str(m.content)
            trimmed = _truncate_tool_body(body, max_chars=_PROACTIVE_TOOL_MSG_MAX_CHARS)
            if trimmed != body:
                m = _with_tool_content(m, trimmed)
                changed = True
        out.append(m)

    budget = _PROACTIVE_REQUEST_SOFT_BYTES
    if _estimate_messages_bytes(out) <= budget:
        return out, changed

    tool_idxs = [i for i, m in enumerate(out) if isinstance(m, ToolMessage)]
    for i in tool_idxs:
        if _estimate_messages_bytes(out) <= budget:
            break
        m = out[i]
        stub = (
            "[proactive: earlier tool output removed to fit provider request-body limit; "
            "rely on newer reads / work log]"
        )
        if _content_as_str(m.content) != stub:
            out[i] = _with_tool_content(m, stub)
            changed = True

    if _estimate_messages_bytes(out) > budget:
        for i, m in enumerate(out):
            if isinstance(m, ToolMessage):
                continue
            body = _content_as_str(getattr(m, "content", ""))
            if len(body) <= 20_000:
                continue
            clipped = body[:12_000] + "\n…[proactive: message truncated]…"
            try:
                out[i] = m.model_copy(update={"content": clipped})
            except Exception:
                continue
            changed = True
            if _estimate_messages_bytes(out) <= budget:
                break

    return out, changed


def hard_cap_proactive_tool_content(content: str) -> str:
    """Write-time cap used by ToolErrorHandlingMiddleware for employee runs."""
    return _truncate_tool_body(content, max_chars=_PROACTIVE_TOOL_MSG_MAX_CHARS)


def patch_proactive_tools(
    tools: list[Any],
    *,
    submit_tool: Any | None = None,
    history_tool: Any | None = None,
    allow_names: set[str] | frozenset[str] | None = None,
) -> list[Any]:
    """Strip chat-activation / legacy duty tools; optionally clamp to allowlist.

    ``submit_tool`` / ``history_tool`` are ignored (call-site compat only) —
    they are never appended. Duty always force-injects ``tasks`` when allowlisted.
    """
    del submit_tool, history_tool
    out = [t for t in (tools or []) if not is_duty_strip_tool(_tool_name(t))]
    if allow_names is not None:
        allow = _finalize_duty_allow(
            {str(n).strip().lower() for n in allow_names if str(n or "").strip()}
        )
        out = [t for t in out if (n := _tool_name(t).lower()) and n in allow]
        present = {_tool_name(t).lower() for t in out}
        if "tasks" in allow and "tasks" not in present:
            try:
                from evoflow.tools.builtins.tasks_tool import tasks_tool

                out.append(tasks_tool)
            except Exception:
                logger.debug("proactive: failed to inject tasks tool", exc_info=True)
    return out


def _mode_agent_full_catalog(session_key: str, mode: str) -> set[str]:
    """Flat agent tool catalog for duty: mode bound ∪ deferred ∩ agent allowlist.

    Unlike chat, deferred names are included up front — no tool_search round-trip.
    """
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES
        from evoflow.session_tool_binding.agent_tools import resolve_session_agent_id

        if is_xiaomi_agent(resolve_session_agent_id(session_key)):
            return set(XIAOMI_SYSTEM_TOOL_NAMES)
    except Exception:
        logger.debug("proactive: xiaomi catalog check failed", exc_info=True)

    names: set[str] = set()
    try:
        from evoflow.session_tool_binding.agent_tools import (
            bound_tools_for_session_agent,
            deferred_catalog_for_session_agent,
        )

        names.update(
            str(n).strip().lower()
            for n in bound_tools_for_session_agent(session_key, mode)
            if str(n or "").strip()
        )
        names.update(
            str(n).strip().lower()
            for n in deferred_catalog_for_session_agent(session_key, mode)
            if str(n or "").strip()
        )
    except Exception:
        logger.debug("proactive: agent full catalog via session failed", exc_info=True)

    if names:
        return names

    try:
        from evoflow.agents.lead_agent.intent_tool_profile import (
            bound_tools_for_session_mode,
            deferred_catalog_for_session_mode,
        )

        names.update(
            str(n).strip().lower()
            for n in bound_tools_for_session_mode(mode)
            if str(n or "").strip()
        )
        names.update(
            str(n).strip().lower()
            for n in deferred_catalog_for_session_mode(mode)
            if str(n or "").strip()
        )
    except Exception:
        logger.debug("proactive: mode full catalog failed", exc_info=True)
    return names


def resolve_proactive_session_allow_names(runtime: Any) -> set[str] | None:
    """Duty allowlist: agent catalog (bound∪deferred); no activation / legacy tools.

    Chat ``active_tools`` progressive snapshots are ignored for widening — duty is
    flat. Polluted orch tools are always stripped.
    """
    ctx = runtime_context_mapping(runtime) if runtime is not None else {}
    sk = str(ctx.get("session_key") or "").strip()
    if not sk:
        try:
            from langgraph.config import get_config

            conf = get_config()
            cfg = conf.get("configurable") if isinstance(conf, dict) else None
            if isinstance(cfg, dict):
                sk = str(cfg.get("session_key") or "").strip()
        except Exception:
            sk = ""
    if not sk:
        code = str(ctx.get("proactive_agent_code") or ctx.get("agent_name") or "").strip()
        if code:
            sk = f"proactive:{code}"
    if not sk:
        return None

    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES

        code = str(ctx.get("proactive_agent_code") or ctx.get("agent_name") or "").strip()
        if is_xiaomi_agent(code) or sk.lower().startswith("proactive:xiaomi"):
            return _finalize_duty_allow(set(XIAOMI_SYSTEM_TOOL_NAMES))
    except Exception:
        logger.debug("proactive: xiaomi allowlist check failed", exc_info=True)

    mode = str(ctx.get("session_mode") or "agent").strip() or "agent"
    try:
        from evoflow.persistence.session_tool_binding_repositories import (
            get_chat_session_tool_snapshot,
        )

        snap = get_chat_session_tool_snapshot(sk)
        if isinstance(snap, dict):
            mode = str(snap.get("session_mode") or snap.get("current_mode") or mode).strip() or mode
    except Exception:
        logger.debug("proactive: session tool snapshot read failed", exc_info=True)

    allow = _mode_agent_full_catalog(sk, mode)
    if not allow:
        return None
    return _finalize_duty_allow(allow)


class ProactiveToolMiddleware(AgentMiddleware[AgentState]):
    """Duty: strip scenario/mode_set/tool_search/legacy; flat agent catalog; Task tool footer."""

    def __init__(self) -> None:
        super().__init__()
        # LangChain validates ModelRequest.tools ⊆ create_agent tools ∪ middleware.tools.
        # Duty may inject ``tasks`` via patch_proactive_tools even when the role whitelist
        # omitted it — register here so runs do not crash with unknown tool names.
        try:
            from evoflow.tools.builtins.tasks_tool import tasks_tool

            self.tools = [tasks_tool]
        except Exception:
            logger.debug("proactive: tasks_tool unavailable for middleware.tools", exc_info=True)
            self.tools = []

    def _patch_tools(self, request: ModelRequest, runtime: Any) -> ModelRequest:
        original = list(request.tools or [])
        proactive = is_proactive_run(runtime)

        if proactive:
            allow = resolve_proactive_session_allow_names(runtime)
            if allow is None:
                try:
                    from evoflow.agents.lead_agent.intent_tool_profile import (
                        bound_tools_for_session_mode,
                        deferred_catalog_for_session_mode,
                    )

                    allow = _finalize_duty_allow(
                        {
                            str(n).strip().lower()
                            for n in (
                                *bound_tools_for_session_mode("agent"),
                                *deferred_catalog_for_session_mode("agent"),
                            )
                            if str(n or "").strip()
                        }
                    )
                except Exception:
                    allow = {"read", "rg", "terminal", "write", "replace", "delete"}
            tools = patch_proactive_tools(original, allow_names=allow)
            before_names = {_tool_name(t) for t in original if _tool_name(t)}
            after_names = {_tool_name(t) for t in tools if _tool_name(t)}
            if after_names != before_names:
                logger.info(
                    "proactive: tools patched count=%d->%d allow=%d names=%s",
                    len(original),
                    len(tools),
                    len(allow or ()),
                    sorted(after_names)[:24],
                )
        else:
            tools = [t for t in original if not is_duty_strip_tool(_tool_name(t))]

        before_names = {_tool_name(t) for t in original if _tool_name(t)}
        after_names = {_tool_name(t) for t in tools if _tool_name(t)}
        if after_names == before_names and len(tools) == len(original):
            return request
        return request.override(tools=tools)

    def _patch_messages(self, request: ModelRequest, runtime: Any) -> ModelRequest:
        if not is_proactive_run(runtime):
            return request
        messages = list(getattr(request, "messages", None) or [])
        trimmed, changed = _trim_proactive_messages(messages)
        if not changed:
            return request
        before = _estimate_messages_bytes(messages)
        after = _estimate_messages_bytes(trimmed)
        logger.info(
            "proactive: trimmed model messages bytes %d->%d (soft_cap=%d)",
            before,
            after,
            _PROACTIVE_REQUEST_SOFT_BYTES,
        )
        return request.override(messages=trimmed)

    def _patch_system_prompt(self, request: ModelRequest, runtime: Any) -> ModelRequest:
        """Replace chat lead-agent system prompt with the duty brief (not append)."""
        if not is_proactive_run(runtime):
            return request
        try:
            from langchain_core.messages import SystemMessage

            from evoflow.proactive.prompt import (
                DUTY_CONTRACT_MARKER,
                compose_proactive_system_message,
            )

            duty = _proactive_duty_prompt(runtime)
            brief = compose_proactive_system_message(duty)
            sm = getattr(request, "system_message", None)
            content = ""
            if sm is not None:
                raw = getattr(sm, "content", "") or ""
                content = raw if isinstance(raw, str) else _content_as_str(raw)
            if DUTY_CONTRACT_MARKER in content or "<proactive_duty_contract>" in content:
                return request
            return request.override(system_message=SystemMessage(content=brief))
        except Exception:
            logger.debug("proactive: system prompt inject failed", exc_info=True)
            return request

    def _patch_duty_status_footer(self, request: ModelRequest, runtime: Any) -> ModelRequest:
        if not is_proactive_run(runtime):
            return request
        line = format_proactive_duty_status_footer(None)
        if not line:
            return request
        try:
            from langchain_core.messages import SystemMessage

            sm = getattr(request, "system_message", None)
            content = ""
            if sm is not None:
                raw = getattr(sm, "content", "") or ""
                content = raw if isinstance(raw, str) else _content_as_str(raw)
            if _DUTY_FOOTER_TAG in content:
                start = content.find(_DUTY_FOOTER_TAG)
                end = content.find("</proactive_duty_status>", start)
                if end >= 0:
                    content = (
                        content[:start] + content[end + len("</proactive_duty_status>") :]
                    ).rstrip()
            new_text = f"{content.rstrip()}\n\n{line}" if content.strip() else line
            return request.override(system_message=SystemMessage(content=new_text))
        except Exception:
            logger.debug("proactive: duty status footer failed", exc_info=True)
            return request

    def _resolve_duty_role(self, runtime: Any):
        code = _resolve_proactive_agent_code(runtime)
        if not code:
            return None
        try:
            from evoflow.agents.xiaomi.identity import is_xiaomi_agent
            from evoflow.proactive.repositories import ProactiveRepository

            if is_xiaomi_agent(code):
                return None
            return ProactiveRepository.get_role(code)
        except Exception:
            logger.debug("proactive: resolve duty role failed", exc_info=True)
            return None

    def _patch_live_task_board(self, request: ModelRequest, runtime: Any) -> ModelRequest:
        """Append fresh ``<proactive_live_tasks>`` HumanMessage (like session_mind_map)."""
        if not is_proactive_run(runtime):
            return request
        role = self._resolve_duty_role(runtime)
        if role is None:
            return request
        try:
            from evoflow.proactive.work_items import format_live_duty_tasks_section

            section = format_live_duty_tasks_section(role).strip()
        except Exception:
            logger.debug("proactive: build live tasks section failed", exc_info=True)
            return request
        if not section:
            return request

        messages = list(getattr(request, "messages", None) or [])
        messages = [
            m
            for m in messages
            if not (
                isinstance(m, HumanMessage)
                and str(getattr(m, "name", "") or "").strip() == _LIVE_TASKS_MSG_NAME
            )
        ]
        # Keep after any existing session_mind_map so both sit at the tail.
        hint = HumanMessage(content=section, name=_LIVE_TASKS_MSG_NAME)
        return request.override(messages=[*messages, hint])

    def _patch(self, request: ModelRequest) -> ModelRequest:
        runtime = getattr(request, "runtime", None)
        request = self._patch_tools(request, runtime)
        request = self._patch_messages(request, runtime)
        request = self._patch_system_prompt(request, runtime)
        request = self._patch_duty_status_footer(request, runtime)
        return self._patch_live_task_board(request, runtime)

    def _refuse_mode_set(self, request: Any) -> ToolMessage:
        tc = getattr(request, "tool_call", None) or {}
        name = _tool_call_name(tc) or "mode_set"
        return ToolMessage(
            content=(
                "Error: 值班模式工具面=智能体绑定工具（flat catalog）；"
                "不支持 scenario / mode_set / tool_search / proactive_submit_work。"
                "请直接用表内工具巡检；有待办用 tasks 建单 / 回写进度 / 结案。"
            ),
            tool_call_id=_tool_call_id(tc),
            name=name,
            status="error",
        )

    def _refuse_unbound_tool(self, request: Any, name: str) -> ToolMessage:
        tc = getattr(request, "tool_call", None) or {}
        return ToolMessage(
            content=(
                f"Error: 工具「{name}」不在本值班工具表中。"
                "值班无 deferred 激活；请只使用当前 tools 表内工具，"
                "或用 tasks 回写进度 / 结案后结束。"
            ),
            tool_call_id=_tool_call_id(tc),
            name=name or "tool",
            status="error",
        )

    def _is_allowed_proactive_tool(self, runtime: Any, name: str) -> bool:
        n = str(name or "").strip().lower()
        if not n:
            return False
        if is_duty_strip_tool(n) or n in _DUTY_BLOCK_ORCH_TOOLS:
            return False
        allow = resolve_proactive_session_allow_names(runtime)
        if allow is None:
            try:
                from evoflow.tools.tool_catalog import resolve_tool_tier

                return resolve_tool_tier(n) in ("workspace", "optional", "runtime", "core")
            except Exception:
                return True
        return n in allow

    @override
    def before_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return None

    @override
    def after_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return None

    @override
    async def aafter_model(self, state: AgentState, runtime) -> dict[str, Any] | None:
        return None

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        return handler(self._patch(request))

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        return await handler(self._patch(request))

    @override
    def wrap_tool_call(
        self,
        request: Any,
        handler: Callable[[Any], ToolMessage | Command],
    ) -> ToolMessage | Command:
        runtime = getattr(request, "runtime", None)
        name = _tool_call_name(getattr(request, "tool_call", None))
        if is_proactive_run(runtime):
            if is_duty_strip_tool(name):
                return self._refuse_mode_set(request)
            if not self._is_allowed_proactive_tool(runtime, name):
                return self._refuse_unbound_tool(request, name)
        return handler(request)

    @override
    async def awrap_tool_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        runtime = getattr(request, "runtime", None)
        name = _tool_call_name(getattr(request, "tool_call", None))
        if is_proactive_run(runtime):
            if is_duty_strip_tool(name):
                return self._refuse_mode_set(request)
            if not self._is_allowed_proactive_tool(runtime, name):
                return self._refuse_unbound_tool(request, name)
        return await handler(request)
