"""Inject intra-turn scenario policy after ``scenario(activate)`` succeeds.

Goal:
- Same user turn: append ``policy_excerpt`` from the tool JSON (and activated-tools reminder).
- Next user message: ``DynamicSystemPromptOnScenarioMiddleware`` runs full ``apply_prompt_template``.

Full system prompt is **not** rebuilt on intra-turn scenario-only changes (see dynamic middleware).
"""

from __future__ import annotations

import json
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime

from evoflow.agents.lead_agent.prompt_dynamic import get_prompt_dynamic
from evoflow.agents.lead_agent.scenario_policy_excerpt import build_scenario_policy_excerpt


def _extract_json(text: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(str(text or ""))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _msg_type(msg: Any) -> str:
    if isinstance(msg, dict):
        return str(msg.get("type") or msg.get("role") or "").strip().lower()
    return str(getattr(msg, "type", "") or "").strip().lower()


def _tool_call_id_of_message(msg: Any) -> str:
    if isinstance(msg, dict):
        return str(msg.get("tool_call_id", "") or "").strip()
    return str(getattr(msg, "tool_call_id", "") or "").strip()


def _message_content(msg: Any) -> Any:
    if isinstance(msg, dict):
        return msg.get("content", "")
    return getattr(msg, "content", "")


def _message_tool_calls(msg: Any) -> list[dict[str, Any]]:
    if isinstance(msg, dict):
        raw = msg.get("tool_calls") or []
        out: list[dict[str, Any]] = []
        for tc in raw:
            if not isinstance(tc, dict):
                continue
            # OpenAI payload shape fallback
            fn = tc.get("function")
            if isinstance(fn, dict):
                out.append(
                    {
                        "id": tc.get("id"),
                        "name": fn.get("name"),
                        "args": _extract_json(fn.get("arguments", "{}")),
                    }
                )
            else:
                out.append(tc)
        return out
    return list(getattr(msg, "tool_calls", None) or [])


def _latest_human_index(messages: list[Any]) -> int:
    for idx in range(len(messages) - 1, -1, -1):
        if _msg_type(messages[idx]) in {"human", "user"}:
            return idx
    return -1


def _find_scenario_result_in_current_turn(messages: list[Any]) -> tuple[bool, dict[str, Any]]:
    if not messages:
        return False, {}

    # Current turn window: after latest user message.
    # This keeps runtime hint active across multiple tool/model hops in the same turn.
    start_idx = _latest_human_index(messages)
    scan_range = range(len(messages) - 1, start_idx, -1)

    # Scan backwards and pick any successful scenario tool result in current turn,
    # not necessarily the latest tool result overall.
    for idx in scan_range:
        tool_msg = messages[idx]
        t = _msg_type(tool_msg)
        if t not in {"tool", "toolmessage"}:
            continue

        tool_call_id = _tool_call_id_of_message(tool_msg)
        if not tool_call_id:
            continue

        # Find nearest preceding assistant message and match tool call id/name.
        for m in reversed(messages[:idx]):
            mt = _msg_type(m)
            if mt not in {"ai", "assistant", "aimessage"}:
                continue
            tool_calls = _message_tool_calls(m)
            if not tool_calls:
                # This assistant message has no tool calls; keep scanning older messages.
                continue

            matched_scenario = False
            for tc in tool_calls:
                tc_id = str((tc or {}).get("id", "")).strip()
                tc_name = str((tc or {}).get("name", "")).strip()
                if tc_id == tool_call_id and tc_name == "scenario":
                    matched_scenario = True
                    break
            if not matched_scenario:
                # Reached the owning assistant turn for this tool result, but not scenario.
                # Continue outer loop and inspect earlier tool results.
                break

            payload = _extract_json(_message_content(tool_msg))
            if str(payload.get("status", "")).strip().lower() != "success":
                return False, {}
            action = str(payload.get("action", "")).strip().lower()
            if action not in {"activate", "deactivate"}:
                return False, {}
            return True, payload
    return False, {}


def _scenario_activated_tools_reminder(payload: dict[str, Any], *, prompt_language: str | None = None) -> str:
    """Tell the model that scenario(activate) already bound tools; do not tool_search those names again."""
    action = str(payload.get("action", "")).strip().lower()
    if action != "activate":
        return ""
    raw = payload.get("activated_tools")
    if not isinstance(raw, list) or not raw:
        return ""
    tools = sorted({str(x).strip() for x in raw if str(x).strip()})
    if not tools:
        return ""
    head = tools[:28]
    extra = len(tools) - len(head)
    deferred_raw = payload.get("deferred_tools")
    deferred: list[str] = []
    if isinstance(deferred_raw, list):
        deferred = sorted({str(x).strip() for x in deferred_raw if str(x).strip()})
    def_head = deferred[:12]
    def_extra = len(deferred) - len(def_head)
    dyn = get_prompt_dynamic(prompt_language)
    return dyn.format_scenario_activated_tools_reminder(
        ", ".join(head),
        extra,
        deferred_sample=", ".join(def_head),
        deferred_extra=def_extra,
    )


def _wrap_policy_excerpt(body: str) -> str:
    text = str(body or "").strip()
    if not text:
        return ""
    return f"<scenario_policy_excerpt>\n{text}\n</scenario_policy_excerpt>"


def _policy_excerpt_patch(
    payload: dict[str, Any],
    active_scenarios: list[str],
    *,
    prompt_language: str | None = None,
) -> str:
    """Prefer ``policy_excerpt`` from tool JSON; fall back to local builder for older traces."""
    action = str(payload.get("action", "")).strip().lower()
    if action != "activate":
        return ""
    raw = str(payload.get("policy_excerpt") or "").strip()
    if not raw:
        raw = build_scenario_policy_excerpt(active_scenarios, prompt_language=prompt_language)
    return _wrap_policy_excerpt(raw)


def _inject_hint_into_system_message(system_message: SystemMessage | None, hint_text: str) -> SystemMessage | None:
    if not hint_text.strip():
        return None
    base = str(getattr(system_message, "content", "") or "").strip() if system_message else ""
    patch = hint_text.strip()
    if "<scenario_policy_excerpt>" in base and "<scenario_policy_excerpt>" in patch:
        return None
    if "<scenario_runtime_hint>" in base and "<scenario_runtime_hint>" in patch:
        return None
    if "<scenario_activated_tools>" in base and "<scenario_activated_tools>" in patch:
        return None
    merged = (base.rstrip() + "\n\n" + patch).strip() if base else patch
    if system_message:
        return system_message.model_copy(update={"content": merged})
    return SystemMessage(content=merged)


class ScenarioRuntimeHintMiddleware(AgentMiddleware[AgentState]):
    """Inject immediate scenario hint after `scenario` tool success."""

    state_schema = AgentState

    def _maybe_patch_request(self, request: ModelRequest) -> ModelRequest:
        messages = list(request.messages or [])
        if not messages:
            return request
        # Avoid re-injecting if a legacy hint message exists at tail.
        last = messages[-1]
        if isinstance(last, HumanMessage) and getattr(last, "name", None) == "scenario_runtime_hint":
            return request

        ok, payload = _find_scenario_result_in_current_turn(messages)
        if not ok:
            return request

        active_from_payload = payload.get("all_active_scenarios")
        if isinstance(active_from_payload, list):
            active = [str(x).strip() for x in active_from_payload if str(x).strip()]
        else:
            active = []
        if not active:
            try:
                from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

                active = get_activated_scenarios()
            except Exception:
                active = []

        ctx = request.runtime.context if isinstance(request.runtime.context, dict) else {}
        meta = ctx.get("evf_dynamic_prompt_meta")
        pl = meta.get("prompt_language") if isinstance(meta, dict) else None
        if not pl:
            pl = ctx.get("prompt_language")
        excerpt_patch = _policy_excerpt_patch(payload, active, prompt_language=pl)
        reminder = _scenario_activated_tools_reminder(payload, prompt_language=pl)
        combined = excerpt_patch.strip()
        if reminder:
            combined = (combined + "\n\n" + reminder).strip() if combined else reminder
        if not combined:
            return request

        patched_system = _inject_hint_into_system_message(request.system_message, combined)
        if patched_system is None:
            return request

        return request.override(system_message=patched_system)

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._maybe_patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._maybe_patch_request(request))

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        # Keep state unchanged; system-message patching is done in wrap_model_call.
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return None
