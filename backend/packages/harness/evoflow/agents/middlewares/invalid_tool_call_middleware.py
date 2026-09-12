"""Convert model ``invalid_tool_calls`` into error ToolMessages before ToolNode runs."""

from __future__ import annotations

import logging
import uuid

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.tools.arg_coerce import coerce_plan_tool_call_args, parse_loose_json_object

logger = logging.getLogger(__name__)


def _parse_invalid_tool_args(raw: object) -> dict[str, object] | None:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        parsed = parse_loose_json_object(text)
        return parsed
    return None


def _invalid_call_raw_args(inv: object) -> object:
    if isinstance(inv, dict):
        return inv.get("args") if inv.get("args") is not None else inv.get("arguments")
    return getattr(inv, "args", None) if getattr(inv, "args", None) is not None else getattr(inv, "arguments", None)


def _tool_call_args_dict(tc: object) -> dict[str, object]:
    if isinstance(tc, dict):
        raw = tc.get("args")
        if raw is None:
            raw = tc.get("arguments")
        if isinstance(raw, dict):
            return dict(raw)
        if isinstance(raw, str):
            return _parse_invalid_tool_args(raw) or {}
        return {}
    raw = getattr(tc, "args", None)
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _tool_call_with_args(tc: object, args: dict[str, object]) -> dict[str, object]:
    if isinstance(tc, dict):
        out = dict(tc)
        out["args"] = args
        if "arguments" in out:
            out["arguments"] = args
        return out
    return {"id": getattr(tc, "id", None), "name": getattr(tc, "name", "plan"), "args": args, "type": "tool_call"}


def _coerce_plan_tool_calls_on_ai(last: AIMessage) -> tuple[AIMessage, bool]:
    """Normalize plan ``tool_calls`` args so ToolNode validation matches ``coerce_plan_tool_call_args``."""
    tool_calls = list(getattr(last, "tool_calls", None) or [])
    if not tool_calls:
        return last, False
    changed = False
    out_calls: list[object] = []
    for tc in tool_calls:
        name = (
            str(tc.get("name") or "").strip()
            if isinstance(tc, dict)
            else str(getattr(tc, "name", None) or "").strip()
        )
        if name != "plan":
            out_calls.append(tc)
            continue
        raw = _tool_call_args_dict(tc)
        if not raw:
            out_calls.append(tc)
            continue
        try:
            coerced = coerce_plan_tool_call_args(raw)
            out_calls.append(_tool_call_with_args(tc, coerced))
            changed = True
        except Exception:
            logger.debug("invalid_tool_call_middleware: coerce plan tool_call failed", exc_info=True)
            out_calls.append(tc)
    if not changed:
        return last, False
    return last.model_copy(update={"tool_calls": out_calls}), True


def _try_repair_invalid_plan_call(inv: object) -> dict[str, object] | None:
    tc_id, name, _err = _invalid_call_fields(inv)
    if name != "plan":
        return None
    raw_args = _invalid_call_raw_args(inv)
    parsed = _parse_invalid_tool_args(raw_args) if not isinstance(raw_args, dict) else dict(raw_args)
    if not parsed:
        return None
    try:
        coerced = coerce_plan_tool_call_args(parsed)
    except Exception:
        logger.debug("invalid_tool_call_middleware: repair plan failed", exc_info=True)
        return None
    if not tc_id:
        tc_id = f"repaired_{uuid.uuid4().hex[:12]}"
    return {"id": tc_id, "name": "plan", "args": coerced, "type": "tool_call"}


def _invalid_call_fields(inv: object) -> tuple[str, str, str]:
    if isinstance(inv, dict):
        tc_id = str(inv.get("id") or inv.get("tool_call_id") or "").strip()
        name = str(inv.get("name") or "unknown_tool").strip() or "unknown_tool"
        err = str(inv.get("error") or "Invalid tool call").strip() or "Invalid tool call"
        return tc_id, name, err
    tc_id = str(getattr(inv, "id", None) or getattr(inv, "tool_call_id", None) or "").strip()
    name = str(getattr(inv, "name", None) or "unknown_tool").strip() or "unknown_tool"
    err = str(getattr(inv, "error", None) or "Invalid tool call").strip() or "Invalid tool call"
    return tc_id, name, err


def _process_invalid_tool_calls(state: AgentState) -> dict | None:
    messages = list(state.get("messages") or [])
    if not messages:
        return None
    last = messages[-1]
    if not isinstance(last, AIMessage):
        return None
    last, coerced_valid = _coerce_plan_tool_calls_on_ai(last)
    if coerced_valid:
        messages = [*messages[:-1], last]
    invalid = list(getattr(last, "invalid_tool_calls", None) or [])
    if not invalid:
        return None

    tool_msgs: list[ToolMessage] = []
    repaired_calls: list[dict[str, object]] = []
    still_invalid: list[object] = []
    for inv in invalid:
        repaired = _try_repair_invalid_plan_call(inv)
        if repaired:
            repaired_calls.append(repaired)
            continue
        still_invalid.append(inv)

    existing_calls = list(getattr(last, "tool_calls", None) or [])
    update: dict[str, object] = {"invalid_tool_calls": still_invalid}
    if repaired_calls:
        update["tool_calls"] = [*existing_calls, *repaired_calls]
        logger.info(
            "invalid_tool_call_middleware: repaired %d plan tool call(s)",
            len(repaired_calls),
        )

    for inv in still_invalid:
        tc_id, name, err = _invalid_call_fields(inv)
        if not tc_id:
            tc_id = f"invalid_{uuid.uuid4().hex[:12]}"
        hint = err
        if name == "plan":
            raw_preview = ""
            raw_args = _invalid_call_raw_args(inv)
            if raw_args is not None:
                raw_preview = str(raw_args).strip().replace("\n", " ")[:240]
            if "assigned_agent" in err.lower():
                hint = (
                    f"{err}（提示：每步用 assigned_agent，depends_on 用 [\"1\"] 数组，"
                    "tools 用 [\"read_file\"] 数组）"
                )
            else:
                hint = (
                    f"{err}（提示：须传 goal + steps 数组；每步至少含 name、goal、assigned_agent；"
                    "depends_on/tools 用 JSON 数组，勿传字符串）"
                )
            if raw_preview:
                hint = f"{hint} 原始参数片段: {raw_preview}"
        else:
            try:
                from evoflow.exploration_graph.config import is_exploration_graph_enabled
                from evoflow.exploration_graph.mind_map_enforce import mind_map_misinvoked_tool_hint

                if is_exploration_graph_enabled():
                    mm_hint = mind_map_misinvoked_tool_hint(name)
                    if mm_hint:
                        hint = mm_hint
            except Exception:
                pass
        tool_msgs.append(
            ToolMessage(
                content=(f"Error: Tool '{name}' was not executed — {hint}. Fix the tool name or JSON arguments and call again."),
                tool_call_id=tc_id,
                name=name,
                status="error",
            )
        )

    updated_ai = last.model_copy(update=update)
    if tool_msgs:
        logger.info("invalid_tool_call_middleware: materialized %d invalid tool call(s)", len(tool_msgs))
    if not tool_msgs and not repaired_calls and not coerced_valid:
        return None
    if not tool_msgs:
        return {"messages": [*messages[:-1], updated_ai]}
    return {"messages": [*messages[:-1], updated_ai, *tool_msgs]}


class InvalidToolCallMiddleware(AgentMiddleware[AgentState]):
    """Materialize ``invalid_tool_calls`` as error ToolMessages (pre-ToolNode)."""

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return _process_invalid_tool_calls(state)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return _process_invalid_tool_calls(state)
