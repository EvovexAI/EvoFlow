from __future__ import annotations

import hashlib
import threading
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langgraph.config import get_config

from evoflow.agents.lead_agent.intent_tool_profile import CORE_TOOL_NAMES
from evoflow.timeutil import beijing_now_iso


def _tool_binding_snapshot(
    request_tool_names: list[str],
    loaded_deferred: list[str] | None,
) -> dict[str, Any]:
    """Bound vs deferred catalog for round-trace / Agent Trace."""
    bound = sorted({str(x).strip() for x in (request_tool_names or []) if str(x).strip()})
    loaded = sorted({str(x).strip() for x in (loaded_deferred or []) if str(x).strip()})
    deferred_catalog: list[str] = []
    try:
        from evoflow.tools.builtins.tool_search import get_deferred_registry

        registry = get_deferred_registry()
        if registry:
            deferred_catalog = sorted({e.name for e in registry.entries if e.name})
    except Exception:
        deferred_catalog = []
    not_yet_loaded = sorted(set(deferred_catalog) - set(bound) - set(loaded))
    return {
        "model_bound_tools": bound,
        "model_bound_tools_count": len(bound),
        "deferred_catalog_tools": deferred_catalog,
        "deferred_catalog_count": len(deferred_catalog),
        "loaded_deferred_tools": loaded,
        "loaded_deferred_count": len(loaded),
        "deferred_not_yet_loaded": not_yet_loaded,
        "deferred_not_yet_loaded_count": len(not_yet_loaded),
    }


def _extract_latest_user_text(messages: list[Any]) -> str:
    for m in reversed(messages):
        if getattr(m, "type", None) != "human":
            continue
        content = getattr(m, "content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for x in content:
                if isinstance(x, str):
                    parts.append(x)
                elif isinstance(x, dict):
                    t = x.get("text")
                    if isinstance(t, str):
                        parts.append(t)
            return " ".join(parts).strip()
        return str(content).strip()
    return ""


def _extract_latest_user_key(messages: list[Any]) -> str:
    for m in reversed(messages):
        if getattr(m, "type", None) != "human":
            continue
        mid = str(getattr(m, "id", "") or "").strip()
        if mid:
            return f"id:{mid}"
        text = _extract_latest_user_text(messages)
        if text:
            return f"text:{text}"
        break
    return ""


class RoundTraceMiddleware(AgentMiddleware[AgentState]):
    """Log one entry per user turn: time, input, scenarios, and model-request tools.

    Also records per-turn message snapshots for turn-trace forensic replay
    (adapted from the legacy voice module turn-trace.js).
    """

    _lock = threading.Lock()
    _last_logged_key_by_thread: dict[str, str] = {}
    _last_prefix_sig_by_thread: dict[str, str] = {}

    # Per-thread turn-trace state
    _turn_traces: dict[str, Any] = {}  # thread_id -> TurnTrace
    _round_counters: dict[str, int] = {}  # thread_id -> round_num

    def _thread_id(self) -> str:
        try:
            cfg = get_config()
            return str(cfg.get("configurable", {}).get("thread_id", "") or "")
        except Exception:
            return ""

    def _write_log(self, payload: dict[str, Any]) -> None:
        try:
            tid = str(payload.get("thread_id") or "").strip() or None
            try:
                from evoflow.observability.recorder import get_observability_recorder

                occurred = str(payload.get("timestamp") or payload.get("ts") or "")
                if not occurred:
                    occurred = beijing_now_iso()
                get_observability_recorder().record_trace_event(
                    thread_id=tid,
                    run_id=str(payload["run_id"]).strip() if isinstance(payload.get("run_id"), str) else None,
                    lane="lead_agent_round",
                    occurred_at=occurred,
                    event=str(payload.get("event") or "unknown"),
                    payload=payload,
                )
            except Exception:
                pass
        except Exception:
            # Best-effort trace logging only; never interrupt agent execution.
            pass

    def _collect_request_context(self, request: ModelRequest) -> dict[str, Any] | None:
        state = request.state if isinstance(request.state, dict) else {}
        messages = state.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return None

        user_key = _extract_latest_user_key(messages)
        if not user_key:
            return None

        thread_id = self._thread_id() or "unknown"

        # Tools actually sent in this model request (ground truth for "how many tools model sees").
        request_tool_names = sorted({str(getattr(t, "name", "") or "").strip() for t in (request.tools or []) if str(getattr(t, "name", "") or "").strip()})
        # 注意：本中间件在 ``agent._build_middlewares`` 中须排在 ``PlanGuardMiddleware`` **之后**，
        # 否则此处统计到的是过滤前的 tools，会与真实模型请求不一致（例如 planning 下误含 supervisor）。
        try:
            from evoflow.agents.lead_agent.intent_tool_profile import ordered_scenario_keys_for_display
            from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys

            keys = effective_activated_scenario_keys(request.runtime, messages)
            activated_scenarios = ordered_scenario_keys_for_display(keys) if keys else ["ask"]
        except Exception:
            activated_scenarios = ["ask"]
        loaded_deferred = state.get("loaded_deferred_tools") or []
        binding = _tool_binding_snapshot(request_tool_names, loaded_deferred if isinstance(loaded_deferred, list) else [])

        system_text = ""
        try:
            sm = request.system_message
            if sm is not None:
                system_text = str(getattr(sm, "content", "") or "")
        except Exception:
            system_text = ""

        system_prompt_sha256 = hashlib.sha256(system_text.encode("utf-8", errors="ignore")).hexdigest()[:16] if system_text else ""
        tools_sig = "|".join(request_tool_names)
        prefix_sig = hashlib.sha256(f"{system_prompt_sha256}\n{tools_sig}".encode("utf-8")).hexdigest()[:16]

        prev_prefix = ""
        with self._lock:
            prev_prefix = str(self._last_prefix_sig_by_thread.get(thread_id) or "")
            self._last_prefix_sig_by_thread[thread_id] = prefix_sig

        return {
            "thread_id": thread_id,
            "user_key": user_key,
            "user_input": _extract_latest_user_text(messages),
            "activated_scenarios": activated_scenarios,
            "request_tool_names": request_tool_names,
            "loaded_deferred_tools": loaded_deferred if isinstance(loaded_deferred, list) else [],
            "system_prompt_sha256": system_prompt_sha256,
            "prefix_sig": prefix_sig,
            "prefix_sig_unchanged": bool(prev_prefix) and prev_prefix == prefix_sig,
            **binding,
        }

    def _log_once_per_user_turn(self, ctx: dict[str, Any]) -> None:
        thread_id = str(ctx.get("thread_id") or "unknown")
        user_key = str(ctx.get("user_key") or "")
        if not user_key:
            return
        dedupe_key = f"{thread_id}::{user_key}"
        with self._lock:
            prev = self._last_logged_key_by_thread.get(thread_id)
            if prev == dedupe_key:
                return

            # New user message → finalize previous turn
            self._end_turn_if_active(thread_id)
            self._last_logged_key_by_thread[thread_id] = dedupe_key

        payload = {
            "event": "turn_snapshot",
            "timestamp": beijing_now_iso(),
            "thread_id": thread_id,
            "user_input": ctx.get("user_input", ""),
            "activated_scenarios": ctx.get("activated_scenarios", ["ask"]),
            # Kept for backward compatibility with existing log consumers.
            "active_tools": ctx.get("request_tool_names", []),
            # Explicit fields for request-time model tool visibility.
            "model_request_tools_count": len(ctx.get("request_tool_names", [])),
            "model_request_tools": ctx.get("request_tool_names", []),
            "model_bound_tools": ctx.get("model_bound_tools", []),
            "model_bound_tools_count": ctx.get("model_bound_tools_count", 0),
            "deferred_catalog_tools": ctx.get("deferred_catalog_tools", []),
            "deferred_catalog_count": ctx.get("deferred_catalog_count", 0),
            "deferred_not_yet_loaded": ctx.get("deferred_not_yet_loaded", []),
            "deferred_not_yet_loaded_count": ctx.get("deferred_not_yet_loaded_count", 0),
            "base_tools": list(CORE_TOOL_NAMES),
            "loaded_deferred_tools": ctx.get("loaded_deferred_tools", []),
            "loaded_deferred_count": ctx.get("loaded_deferred_count", 0),
        }
        self._write_log(payload)

    def _log_each_model_call(self, ctx: dict[str, Any]) -> None:
        thread_id = str(ctx.get("thread_id") or "unknown")
        from evoflow.observability.run_latency_trace import current_model_call_seq

        seq = current_model_call_seq() or 0

        payload = {
            "event": "model_call_tools",
            "timestamp": beijing_now_iso(),
            "thread_id": thread_id,
            "model_call_seq": seq,
            "user_input": ctx.get("user_input", ""),
            "activated_scenarios": ctx.get("activated_scenarios", ["ask"]),
            "model_request_tools_count": len(ctx.get("request_tool_names", [])),
            "model_request_tools": ctx.get("request_tool_names", []),
            "model_bound_tools": ctx.get("model_bound_tools", []),
            "model_bound_tools_count": ctx.get("model_bound_tools_count", 0),
            "deferred_catalog_tools": ctx.get("deferred_catalog_tools", []),
            "deferred_catalog_count": ctx.get("deferred_catalog_count", 0),
            "deferred_not_yet_loaded": ctx.get("deferred_not_yet_loaded", []),
            "deferred_not_yet_loaded_count": ctx.get("deferred_not_yet_loaded_count", 0),
            "loaded_deferred_tools": ctx.get("loaded_deferred_tools", []),
            "loaded_deferred_count": ctx.get("loaded_deferred_count", 0),
            "system_prompt_sha256": ctx.get("system_prompt_sha256", ""),
            "prefix_sig": ctx.get("prefix_sig", ""),
            "prefix_sig_unchanged": bool(ctx.get("prefix_sig_unchanged")),
        }
        self._write_log(payload)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler,
    ) -> ModelCallResult:
        ctx = self._collect_request_context(request)
        if ctx:
            self._log_once_per_user_turn(ctx)
            self._log_each_model_call(ctx)

        # ── Turn message trace: record input offset + model output ──
        state = request.state if isinstance(request.state, dict) else {}
        messages = state.get("messages") or []
        input_offset = len(messages) if isinstance(messages, list) else 0
        tid = str(ctx.get("thread_id") or self._thread_id() or "unknown") if ctx else self._thread_id() or "unknown"

        try:
            result = handler(request)
        except Exception:
            raise

        # Extract model output from result
        content = ""
        reasoning = ""
        tool_calls: list[dict[str, Any]] = []
        if hasattr(result, "content"):
            content = str(result.content or "")
        if hasattr(result, "reasoning_content") and result.reasoning_content:
            reasoning = str(result.reasoning_content)
        if hasattr(result, "tool_calls") and result.tool_calls:
            tool_calls = [{"name": tc.get("name", ""), "args": tc.get("args", {})} for tc in result.tool_calls]

        self._record_turn_round(tid, input_offset, content, reasoning, tool_calls)
        return result

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler,
    ) -> ModelCallResult:
        ctx = self._collect_request_context(request)
        if ctx:
            self._log_once_per_user_turn(ctx)
            self._log_each_model_call(ctx)

        state = request.state if isinstance(request.state, dict) else {}
        messages = state.get("messages") or []
        input_offset = len(messages) if isinstance(messages, list) else 0
        tid = str(ctx.get("thread_id") or self._thread_id() or "unknown") if ctx else self._thread_id() or "unknown"

        try:
            result = await handler(request)
        except Exception:
            raise

        content = ""
        reasoning = ""
        tool_calls: list[dict[str, Any]] = []
        if hasattr(result, "content"):
            content = str(result.content or "")
        if hasattr(result, "reasoning_content") and result.reasoning_content:
            reasoning = str(result.reasoning_content)
        if hasattr(result, "tool_calls") and result.tool_calls:
            tool_calls = [{"name": tc.get("name", ""), "args": tc.get("args", {})} for tc in result.tool_calls]

        self._record_turn_round(tid, input_offset, content, reasoning, tool_calls)
        return result

    def _record_turn_round(
        self,
        thread_id: str,
        input_offset: int,
        content: str,
        reasoning: str,
        tool_calls: list[dict[str, Any]],
    ):
        """Record one model call round in the turn message trace."""
        try:
            from evoflow.debug.turn_message_trace import get_turn_tracer

            tracer = get_turn_tracer()
            tid = str(thread_id or "").strip()
            if not tid:
                return

            # Begin new turn on first round, or reuse existing
            with self._lock:
                turn = self._turn_traces.get(tid)
                if turn is None:
                    turn = tracer.begin_turn(tid)
                    self._turn_traces[tid] = turn
                    self._round_counters[tid] = 0

            self._round_counters[tid] += 1
            tracer.record_round(
                turn,
                round_num=self._round_counters[tid],
                input_offset=input_offset,
                content=content,
                reasoning_content=reasoning,
                tool_calls=tool_calls,
            )
        except Exception:
            pass  # Never interrupt agent execution

    def _end_turn_if_active(self, thread_id: str):
        """Finalize the current turn trace with a message snapshot."""
        tid = str(thread_id or "").strip()
        if not tid:
            return
        try:
            from evoflow.debug.turn_message_trace import get_turn_tracer

            with self._lock:
                turn = self._turn_traces.pop(tid, None)
            if turn is None:
                return

            tracer = get_turn_tracer()
            tracer.end_turn(turn, messages=[])

            # Also clean up round counter
            self._round_counters.pop(tid, None)
        except Exception:
            pass
