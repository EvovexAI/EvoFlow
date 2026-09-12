"""Tool error handling middleware and shared runtime middleware builders.

Structured outcomes: tools may return JSON (string) with ``_evoflow_tool`` metadata
(see :mod:`evoflow.agents.tool_response_envelope`); the middleware uses it before
falling back on plain-text heuristics (``Error:``, LangGraph validation messages).
"""

import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from evoflow.timeutil import instant_to_beijing_iso

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

from evoflow.agents.tool_response_envelope import envelope_status_kind, parse_tool_envelope
from evoflow.tools.arg_coerce import coerce_tool_call_args
from evoflow.tools.builtins.browser_screenshot_store import compact_legacy_screenshot_tool_content
from evoflow.tools.tool_result_shaper import shape_tool_result

logger = logging.getLogger(__name__)


def _is_proactive_tool_request(request: ToolCallRequest) -> bool:
    try:
        from evoflow.agents.automation_runtime import triggered_by_proactive
        from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

        ctx = runtime_context_mapping(getattr(request, "runtime", None))
        if triggered_by_proactive(ctx) or ctx.get("proactive_process"):
            return True
        return str(ctx.get("session_key") or "").startswith("proactive:")
    except Exception:
        return False

def _workspace_root_from_tool_request(request: ToolCallRequest) -> str | None:
    try:
        rt = getattr(request, "runtime", None)
        if rt is not None:
            ctx = getattr(rt, "context", None)
            if isinstance(ctx, dict):
                root = str(ctx.get("local_workspace_root") or "").strip()
                if root:
                    return root
            from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

            root = str(runtime_context_mapping(rt).get("local_workspace_root") or "").strip()
            if root:
                return root
    except Exception:
        pass
    return None


def _request_with_coerced_tool_args(request: ToolCallRequest) -> ToolCallRequest:
    """Rewrite ``tool_call['args']`` so JSON-string list params pass tool validation."""
    tc = request.tool_call
    if not isinstance(tc, dict):
        return request
    raw_args = tc.get("args")
    if not isinstance(raw_args, dict):
        return request
    tool_name = str(tc.get("name") or "")
    args = dict(raw_args)
    if tool_name == "search_content" and not str(args.get("path") or "").strip():
        root = _workspace_root_from_tool_request(request)
        if root:
            args["path"] = root
    try:
        from evoflow.config import get_app_config

        if tool_name == "search_content" and (get_app_config().tools_mode or "host_direct") == "host_direct":
            args.pop("path", None)
    except Exception:
        pass
    coerced = coerce_tool_call_args(tool_name, args)
    if coerced == args and args == raw_args:
        return request
    tc["args"] = coerced
    return request


_MISSING_TOOL_CALL_ID = "missing_tool_call_id"


def _infer_tool_error_type_from_output(text: str) -> str:
    """Best-effort label for tool-side failures (returned string, not thrown)."""
    s = (text or "").strip()
    low = s.lower()
    if "should be a valid" in low or "validation error" in low:
        return "ValidationError"
    if low.startswith("error invoking tool"):
        return "ToolInvocationError"

    if not s.startswith("Error:"):
        return "ToolReturnedError"
    rest = s[5:].strip()
    if not rest:
        return "ToolReturnedError"
    # "NotImplementedError (...)" or "Tool 'x' failed with Name: detail"
    if rest.lower().startswith("tool ") and " failed with " in rest:
        try:
            after = rest.split(" failed with ", 1)[1]
            name = after.split(":", 1)[0].strip()
            if name:
                return name[:120]
        except Exception:
            pass
    if "(" in rest:
        name = rest.split("(", 1)[0].strip()
        if name and " " not in name:
            return name[:120]
    head = rest.split(":", 1)[0].strip()
    if head and head.replace("_", "").isalnum():
        return head[:120]
    return "ToolReturnedError"


def _string_content_suggests_tool_error(text: str) -> bool:
    """Backward-compatible heuristic when tools return plain strings (no ``_evoflow_tool``)."""
    text = (text or "").strip()
    if not text:
        return False
    low = text.lower()
    return bool(
        text.startswith("Error:") or low.startswith("error invoking tool") or "please fix the error and try again" in low,
    )


def _completed_tool_should_log_as_error(result: ToolMessage | Command, output_text: str) -> bool:
    """True when a non-throwing tool run should be recorded as ``status=error`` in observability."""
    if isinstance(result, Command):
        return False
    if isinstance(result, ToolMessage):
        if str(getattr(result, "status", None) or "").strip().lower() == "error":
            return True
        meta = parse_tool_envelope(getattr(result, "content", None))
        if meta is not None:
            kind = envelope_status_kind(meta)
            if kind == "error":
                return True
            if kind == "ok":
                return False
    return _string_content_suggests_tool_error(output_text)


def _log_fields_for_completed_tool_error(result: ToolMessage | Command, output_text: str) -> tuple[str, str, dict[str, Any]]:
    """``error_type``, ``error_message`` (truncated), ``error_detail`` for completed (non-throwing) failures."""
    if isinstance(result, ToolMessage):
        meta = parse_tool_envelope(getattr(result, "content", None))
        if meta is not None and envelope_status_kind(meta) == "error":
            et_raw = meta.get("error_type") or meta.get("type")
            et = str(et_raw).strip()[:120] if et_raw else _infer_tool_error_type_from_output(output_text)[:120]
            if not et:
                et = "ToolReturnedError"
            msg = meta.get("message")
            em = str(msg if msg is not None else output_text)[:4000]
            return et, em, {"source": "evoflow_tool_envelope"}
        if str(getattr(result, "status", None) or "").strip().lower() == "error":
            return (
                _infer_tool_error_type_from_output(output_text)[:120],
                output_text[:4000],
                {"source": "tool_message_status"},
            )
    et = _infer_tool_error_type_from_output(output_text)
    return (et[:120] if et else "ToolReturnedError"), output_text[:4000], {"source": "tool_returned_error_string"}


def _tool_completion_indicates_error(result: ToolMessage | Command) -> bool:
    """Prefer :func:`parse_tool_envelope`; see tests."""
    ot = "" if isinstance(result, Command) else _tool_result_text_for_io_log(result)
    return _completed_tool_should_log_as_error(result, ot)


def _tool_result_text_for_io_log(result: ToolMessage | Command) -> str:
    """Serialize tool handler results for JSONL logs (ToolMessage vs interrupt Command)."""
    if isinstance(result, Command):
        update = getattr(result, "update", None)
        if isinstance(update, dict):
            for msg in update.get("messages") or []:
                if isinstance(msg, ToolMessage):
                    content = getattr(msg, "content", None)
                    if content is not None and str(content).strip():
                        return str(content)
        goto = getattr(result, "goto", None)
        return json.dumps({"kind": "command", "goto": str(goto) if goto is not None else ""}, ensure_ascii=False)
    if hasattr(result, "content"):
        return str(getattr(result, "content", "") or "")
    return str(result)


def _current_thread_id_for_log() -> str:
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        return ""


def _thread_id_from_tool_request(request: Any) -> str:
    """Lead graph exposes thread_id via get_config(); subagent often only has runtime.context/config."""
    try:
        rt = getattr(request, "runtime", None)
        if rt is not None:
            ctx = getattr(rt, "context", None)
            if isinstance(ctx, dict):
                tid = str(ctx.get("thread_id") or "").strip()
                if tid:
                    return tid
            cfg = getattr(rt, "config", None)
            if isinstance(cfg, dict):
                conf = cfg.get("configurable")
                if isinstance(conf, dict):
                    tid = str(conf.get("thread_id") or "").strip()
                    if tid:
                        return tid
    except Exception:
        pass
    return _current_thread_id_for_log()


def _agent_codes_from_tool_request(request: Any) -> tuple[str | None, str | None]:
    """Extract (agent_code, position_code) from a ToolCallRequest's runtime context.

    Proactive runs stamp codes via ``context``; main-chat runs may set
    ``agent_id`` in ``configurable``. Falls back to ``get_config()`` when the
    request has no runtime (lead-graph tools).
    """
    agent_code: str | None = None
    position_code: str | None = None
    # 1) runtime.context (proactive / subagent)
    try:
        rt = getattr(request, "runtime", None)
        if rt is not None:
            ctx = getattr(rt, "context", None)
            if isinstance(ctx, dict):
                agent_code = str(ctx.get("agent_id") or ctx.get("proactive_agent_code") or "").strip() or None
                position_code = str(ctx.get("position_code") or "").strip() or None
    except Exception:
        pass
    # 2) get_config().configurable (lead-graph tools without runtime)
    if not agent_code or not position_code:
        try:
            from langgraph.config import get_config

            c = get_config().get("configurable") or {}
            if isinstance(c, dict):
                if not agent_code:
                    agent_code = str(c.get("agent_id") or c.get("agent_code") or "").strip() or None
                if not position_code:
                    position_code = str(c.get("position_code") or "").strip() or None
        except Exception:
            pass
    return agent_code, position_code


def _log_tool_call_io(
    tool_name: str,
    tool_call_id: str,
    tool_input: dict,
    tool_output: str,
    status: str,
    duration_ms: float | None = None,
    *,
    request: Any | None = None,
    error_type: str | None = None,
    error_message: str | None = None,
    error_detail: dict[str, Any] | None = None,
):
    """记录工具调用到 SQLite observability（不再写 thread JSONL 文件）。

    Args:
        tool_name: 工具名称
        tool_call_id: 工具调用 ID
        tool_input: 工具输入参数
        tool_output: 工具输出结果
        status: 状态 (success/error)
        duration_ms: 执行耗时（毫秒）
        request: 可选 ``ToolCallRequest``，用于子线程（SubThread_*）等 get_config 不可用时解析 thread_id
        error_type: 失败时异常类型名（写入 SQLite ``evoflow_obs_tool_invocations``）
        error_message: 失败时异常消息摘要
        error_detail: 可选结构化补充（JSON，如 truncated traceback 元数据）
    """
    try:
        tid_raw = _thread_id_from_tool_request(request) if request is not None else _current_thread_id_for_log()
        tid = str(tid_raw or "").strip() or None
        ended_ms = int(time.time() * 1000)
        started_ms = ended_ms - int(duration_ms) if duration_ms is not None else ended_ms
        started_at = instant_to_beijing_iso(started_ms)
        ended_at = instant_to_beijing_iso(ended_ms)
        log_entry: dict[str, Any] = {
            "timestamp": ended_at,
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "input": tool_input,
            "output": tool_output[:300000] if len(tool_output) > 300000 else tool_output,  # 限制单行 JSONL 体积
            "status": status,
        }
        if duration_ms is not None:
            log_entry["duration_ms"] = round(duration_ms, 2)
        if error_type:
            log_entry["error_type"] = error_type
        if error_message:
            log_entry["error_message"] = error_message[:4000]

        if tid:
            try:
                from evoflow.observability.recorder import get_observability_recorder

                run_id = None
                try:
                    from langgraph.config import get_config

                    cfg = get_config()
                    conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
                    if isinstance(conf, dict):
                        r = conf.get("run_id")
                        if isinstance(r, str) and r.strip():
                            run_id = r.strip()
                except Exception:
                    pass
                collab_phase = None
                try:
                    from evoflow.collab.thread_collab import load_merged_collab_phase
                    from evoflow.config.paths import get_paths

                    collab_phase = load_merged_collab_phase(get_paths(), tid, None)
                except Exception:
                    pass
                agent_code, position_code = _agent_codes_from_tool_request(request)
                get_observability_recorder().record_tool_invocation(
                    thread_id=tid,
                    run_id=run_id,
                    tool_call_id=tool_call_id,
                    tool_name=tool_name,
                    started_at=started_at,
                    ended_at=ended_at,
                    duration_ms=float(duration_ms or 0.0),
                    status=status,
                    input_obj=tool_input,
                    output_text=log_entry.get("output"),
                    collab_phase=collab_phase,
                    invocation_source="tool_middleware",
                    error_type=error_type,
                    error_message=error_message,
                    error_detail=error_detail,
                    agent_code=agent_code,
                    position_code=position_code,
                )
            except Exception:
                pass
    except Exception as e:
        logger.debug(f"Failed to write tool call log: {e}")


class ToolErrorHandlingMiddleware(AgentMiddleware[AgentState]):
    """Convert tool exceptions into error ToolMessages so the run can continue."""

    def _apply_tool_result_shaping(self, result: ToolMessage | Command, request: ToolCallRequest) -> ToolMessage | Command:
        if not isinstance(result, ToolMessage) or not hasattr(result, "content"):
            return result
        tool_name = str(request.tool_call.get("name") or "unknown_tool")
        tool_call_id = str(request.tool_call.get("id") or _MISSING_TOOL_CALL_ID)
        raw_content = compact_legacy_screenshot_tool_content(str(result.content or ""), tool_name)
        if raw_content != result.content:
            result = ToolMessage(
                content=raw_content,
                tool_call_id=result.tool_call_id,
                status=getattr(result, "status", None),
            )
        tid = str((getattr(request.runtime, "context", None) or {}).get("thread_id") or "")
        args = request.tool_call.get("args") or {}
        partial_read = False
        if isinstance(args, dict):
            partial_read = args.get("offset") is not None or args.get("limit") is not None
        shaped = shape_tool_result(
            str(result.content or ""),
            tool_name,
            tool_call_id,
            thread_id=tid or None,
            partial_read=partial_read,
        )
        # Employee patrols: global tool compression may be off; still hard-cap
        # so we never accumulate multi-MB file dumps into the next model call.
        if _is_proactive_tool_request(request):
            from evoflow.agents.middlewares.proactive_tool_middleware import (
                hard_cap_proactive_tool_content,
            )

            capped = hard_cap_proactive_tool_content(shaped)
            if capped != shaped:
                logger.debug(
                    "proactive: hard-capped tool=%s chars %d→%d",
                    tool_name,
                    len(shaped),
                    len(capped),
                )
                shaped = capped
        # Fill empty tool results with a placeholder to prevent model empty responses.
        # Some tools (Set-Content, Add-Content, Remove-Item, etc.) legitimately return
        # empty output; without a placeholder the model may return finish_reason=stop
        # with output_tokens=0, especially under long context + multi-tool-call conditions.
        if not shaped or not shaped.strip():
            shaped = "[Tool completed — no output]"
        if shaped != result.content:
            result = ToolMessage(content=shaped, tool_call_id=result.tool_call_id, status=getattr(result, "status", None))
        self._maybe_register_working_memory(result, request, tool_name, args)
        return result

    def _maybe_register_working_memory(
        self,
        result: ToolMessage | Command,
        request: ToolCallRequest,
        tool_name: str,
        args: dict | Any,
    ) -> None:
        if not isinstance(result, ToolMessage):
            return
        output_text = str(result.content or "")
        if output_text.strip().startswith("Error:"):
            return
        tid = _thread_id_from_tool_request(request)
        if not tid:
            return
        try:
            from evoflow.context.working_memory import register_tool_result

            register_tool_result(
                tid,
                tool_name=tool_name,
                tool_input=args if isinstance(args, dict) else {},
                output_text=output_text,
            )
        except Exception:
            logger.debug("working_memory register skipped for %s", tool_name, exc_info=True)

    def _build_error_message(self, request: ToolCallRequest, exc: Exception) -> ToolMessage:
        tool_name = str(request.tool_call.get("name") or "unknown_tool")
        tool_call_id = str(request.tool_call.get("id") or _MISSING_TOOL_CALL_ID)
        detail = str(exc).strip() or exc.__class__.__name__
        if len(detail) > 500:
            detail = detail[:497] + "..."

        content = f"Error: Tool '{tool_name}' failed with {exc.__class__.__name__}: {detail}. Continue with available context, or choose an alternative tool."
        return ToolMessage(
            content=content,
            tool_call_id=tool_call_id,
            name=tool_name,
            status="error",
        )

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        tool_name = str(request.tool_call.get("name") or "unknown_tool")
        tool_call_id = str(request.tool_call.get("id") or _MISSING_TOOL_CALL_ID)
        request = _request_with_coerced_tool_args(request)
        tool_input = request.tool_call.get("args", {})

        import time

        start_time = time.time()
        try:
            result = handler(request)
            result = self._apply_tool_result_shaping(result, request)

            duration_ms = (time.time() - start_time) * 1000
            output_text = _tool_result_text_for_io_log(result)
            if _completed_tool_should_log_as_error(result, output_text):
                et, em, ed = _log_fields_for_completed_tool_error(result, output_text)
                _log_tool_call_io(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_input=tool_input,
                    tool_output=output_text,
                    status="error",
                    duration_ms=duration_ms,
                    request=request,
                    error_type=et,
                    error_message=em,
                    error_detail=ed,
                )
            else:
                _log_tool_call_io(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_input=tool_input,
                    tool_output=output_text,
                    status="success",
                    duration_ms=duration_ms,
                    request=request,
                )

            return result
        except GraphBubbleUp:
            # Preserve LangGraph control-flow signals (interrupt/pause/resume).
            raise
        except Exception as exc:
            duration_ms = (time.time() - start_time) * 1000
            logger.exception("Tool execution failed (sync): name=%s id=%s", tool_name, tool_call_id)

            # 记录错误日志
            error_output = f"Error: Tool '{tool_name}' failed with {exc.__class__.__name__}: {str(exc)[:500]}"
            _log_tool_call_io(
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                tool_input=tool_input,
                tool_output=error_output,
                status="error",
                duration_ms=duration_ms,
                request=request,
                error_type=exc.__class__.__name__,
                error_message=str(exc)[:4000],
                error_detail={"exception_module": getattr(exc.__class__, "__module__", "")},
            )

            return self._build_error_message(request, exc)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        tool_name = str(request.tool_call.get("name") or "unknown_tool")
        tool_call_id = str(request.tool_call.get("id") or _MISSING_TOOL_CALL_ID)
        request = _request_with_coerced_tool_args(request)
        tool_input = request.tool_call.get("args", {})

        import time

        start_time = time.time()
        try:
            result = await handler(request)
            result = self._apply_tool_result_shaping(result, request)

            duration_ms = (time.time() - start_time) * 1000
            output_text = _tool_result_text_for_io_log(result)
            if _completed_tool_should_log_as_error(result, output_text):
                et, em, ed = _log_fields_for_completed_tool_error(result, output_text)
                _log_tool_call_io(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_input=tool_input,
                    tool_output=output_text,
                    status="error",
                    duration_ms=duration_ms,
                    request=request,
                    error_type=et,
                    error_message=em,
                    error_detail=ed,
                )
            else:
                _log_tool_call_io(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_input=tool_input,
                    tool_output=output_text,
                    status="success",
                    duration_ms=duration_ms,
                    request=request,
                )

            return result
        except GraphBubbleUp:
            # Preserve LangGraph control-flow signals (interrupt/pause/resume).
            raise
        except Exception as exc:
            duration_ms = (time.time() - start_time) * 1000
            logger.exception("Tool execution failed (async): name=%s id=%s", tool_name, tool_call_id)

            # 记录错误日志
            error_output = f"Error: Tool '{tool_name}' failed with {exc.__class__.__name__}: {str(exc)[:500]}"
            _log_tool_call_io(
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                tool_input=tool_input,
                tool_output=error_output,
                status="error",
                duration_ms=duration_ms,
                request=request,
                error_type=exc.__class__.__name__,
                error_message=str(exc)[:4000],
                error_detail={"exception_module": getattr(exc.__class__, "__module__", "")},
            )

            return self._build_error_message(request, exc)


def _build_runtime_middlewares(
    *,
    include_uploads: bool,
    include_dangling_tool_call_patch: bool,
    lazy_init: bool = True,
) -> list[AgentMiddleware]:
    """Build shared base middlewares for agent execution."""
    from evoflow.agents.middlewares.thread_data_middleware import ThreadDataMiddleware
    from evoflow.sandbox.middleware import SandboxMiddleware

    middlewares: list[AgentMiddleware] = [
        ThreadDataMiddleware(lazy_init=lazy_init),
        SandboxMiddleware(lazy_init=lazy_init),
    ]

    if include_uploads:
        pass  # UploadsMiddleware registered after SessionTranscriptHydration in lead_agent

    if include_dangling_tool_call_patch:
        from evoflow.agents.middlewares.dangling_tool_call_middleware import DanglingToolCallMiddleware

        middlewares.append(DanglingToolCallMiddleware())

    # Guardrail middleware (if configured)
    from evoflow.config.guardrails_config import get_guardrails_config

    guardrails_config = get_guardrails_config()
    if guardrails_config.enabled and guardrails_config.provider:
        import inspect

        from evoflow.guardrails.middleware import GuardrailMiddleware
        from evoflow.reflection import resolve_variable

        provider_cls = resolve_variable(guardrails_config.provider.use)
        provider_kwargs = dict(guardrails_config.provider.config) if guardrails_config.provider.config else {}
        # Pass framework hint if the provider accepts it (e.g. for config discovery).
        # Built-in providers like AllowlistProvider don't need it, so only inject
        # when the constructor accepts 'framework' or '**kwargs'.
        if "framework" not in provider_kwargs:
            try:
                sig = inspect.signature(provider_cls.__init__)
                if "framework" in sig.parameters or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                    provider_kwargs["framework"] = "evoflow"
            except (ValueError, TypeError):
                pass
        provider = provider_cls(**provider_kwargs)
        middlewares.append(GuardrailMiddleware(provider, fail_closed=guardrails_config.fail_closed, passport=guardrails_config.passport))

    middlewares.append(ToolErrorHandlingMiddleware())
    from evoflow.agents.middlewares.invalid_tool_call_middleware import InvalidToolCallMiddleware
    from evoflow.agents.middlewares.large_content_offload_middleware import LargeContentOffloadMiddleware
    from evoflow.agents.middlewares.pre_call_guardrail_agent_middleware import PreCallGuardrailAgentMiddleware
    from evoflow.agents.middlewares.session_run_lifecycle_middleware import SessionRunLifecycleMiddleware

    middlewares.append(InvalidToolCallMiddleware())
    middlewares.append(LargeContentOffloadMiddleware())
    middlewares.append(PreCallGuardrailAgentMiddleware())
    # Inside-graph terminal run_status (after_agent); Gateway middle_layer remains a safety net.
    middlewares.append(SessionRunLifecycleMiddleware())
    return middlewares


def build_lead_runtime_middlewares(*, lazy_init: bool = True) -> list[AgentMiddleware]:
    """Middlewares shared by lead agent runtime before lead-only middlewares."""
    return _build_runtime_middlewares(
        include_uploads=True,
        include_dangling_tool_call_patch=True,
        lazy_init=lazy_init,
    )


def build_subagent_runtime_middlewares(*, lazy_init: bool = True) -> list[AgentMiddleware]:
    """Middlewares shared by subagent runtime before subagent-only middlewares."""
    from evoflow.agents.middlewares.transcript_middleware import TranscriptMiddleware

    middlewares = _build_runtime_middlewares(
        include_uploads=False,
        include_dangling_tool_call_patch=False,
        lazy_init=lazy_init,
    )
    # Collab worker threads ({lead}__sub__{id}) must persist AI/tool turns like the lead chat.
    middlewares.append(TranscriptMiddleware())
    # Normalize LLM usage_metadata onto AIMessage *before* TranscriptMiddleware persists it.
    # after_model runs in reverse list order, so TokenUsageMiddleware (appended last) runs first.
    from evoflow.config import get_app_config

    if get_app_config().token_usage.enabled:
        from evoflow.agents.middlewares.token_usage_middleware import TokenUsageMiddleware

        middlewares.append(TokenUsageMiddleware())
    return middlewares
