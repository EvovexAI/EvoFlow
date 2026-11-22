"""Tool error handling middleware and shared runtime middleware builders.

Structured outcomes: tools may return JSON (string) with ``_evoflow_tool`` metadata
(see :mod:`evoflow.agents.tool_response_envelope`); the middleware uses it before
falling back on plain-text heuristics (``Error:``, LangGraph validation messages).
"""

import json
import logging
import os
import re
import threading
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
from evoflow.config.tool_results_config import get_tool_results_config
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
    # 【self-evolution-bot · 2026-11-19 · 第66轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：补一条「显式失败标记」判据 —— `[node_repl] call failed.`
    # 为什么：node_repl_tool.py:436 在宿主返回 is_error=True 时会把这句话拼到正文尾部，
    # 但**走的是普通字符串通道**（不是 error 信封，也不设 ToolMessage.status），
    # 于是本函数只看 "Error:" 前缀 / "error invoking tool" 两条，认不出来 → obs 记 success。
    # 现网实证（2026-11-19，本线程 74 次 mcp__node_repl__js 调用）：
    #   · obs 里 status=error 的只有 2 条，而输出里带 `[node_repl] call failed.` 的有 9 条；
    #   · 全岗位 7 天：468 次调用里 66 条带该标记，status=error 仍只有 2 条 → 64 条失败被吞。
    # 后果不是"难看的报表"：我每轮靠 obs 表做自我度量，电脑控制的失败在这张表里恒为 0，
    # 于是「点了没反应」「控件被禁用」「窗口失焦」这些真实卡点永远进不了复盘。
    # 判据选这个标记而不是散着匹配 refused/unavailable：实测两条命中数完全相等（66 vs 66），
    # 而散匹配会把**我自己的探测输出**也算进去（我拿 failedAt=boot 的 JSON 当证据时误报过 4 次），
    # 那是自我引用，不是工具失败。
    if "[node_repl] call failed." in low:
        return True
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


def _widen_json_envelope_fields(meta: dict[str, Any], et: str, em: str, output_text: str) -> tuple[str, str]:
    """把 JSON 错误信封里的 ``error`` / ``hint`` / ``path`` 补齐成注记可用的 (error_type, error_message)。

    只补空、不覆盖已有值：`error_type` 仍是泛型 ``ToolReturnedError``（或空）时才用 ``error`` 码替换，
    ``error_message`` 只在解析结果为空时才回落到「错误码 · hint · path」，仍拿不到就用原始 output_text 兜底
    —— 目的是让下游 :func:`_obs_fix_hint` 的正则至少有一句真报错可匹配，而不是拿到空串后静默不给线索。
    """
    # meta 是 parse_tool_envelope **规范化后**的字典，键名未必还是载荷里的 ``error``
    # （2026-11-15 实测：只读 meta["error"] 取不到 not_found）→ 取不到就回原文抓错误码。
    code = str(meta.get("error") or meta.get("error_code") or "").strip()
    if not code:
        found = re.search(r'"(?:error|error_code)"\s*:\s*"([A-Za-z0-9_.:-]{2,60})"', str(output_text or ""))
        code = found.group(1) if found else ""
    if code and et in ("", "ToolReturnedError"):
        et = code[:120]
    detail = str(em or "").strip()
    if not detail:
        bits = [code, str(meta.get("hint") or "").strip(), str(meta.get("path") or "").strip()]
        detail = " · ".join(b for b in bits if b) or str(output_text or "").strip()
    return et, detail[:4000]


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
            # 【fullstack-dev · 2026-11-15 · 第12轮】改：JSON 错误信封补读 error/hint/path 三个键。
            # 为什么：assets 这类工具的错误信封写的是 {"ok": false, "error": "not_found", "hint": …}，
            # 而本函数原来只认 error_type/type/message —— 于是 et 退化成泛型 ToolReturnedError、
            # em 被 meta["message"]（空串）覆盖成 0 长度（2026-11-15 纯函数实测 em_len=0）。
            # 下游 _obs_fix_hint 是按报错文本正则匹配的，拿不到 not_found 就永远不给修复线索：
            # 同一类错误我仍要自己再猜一轮，等于第3轮补的「失败分支注记」在 JSON 信封上没生效。
            et, em = _widen_json_envelope_fields(meta, et, em, output_text)
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


# 【fullstack-dev · 2026-11-14 · 第1轮】改：本函数原只落库不返回耗时；现 return {duration_ms, queue_wait_ms, timing}，供 [obs] 尾注使用。
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
) -> dict[str, Any]:
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

    Returns:
        本次实际采集到的观测值 ``{duration_ms, queue_wait_ms, timing}``（缺项为 None）。
        ``queue_wait_ms`` / ``timing`` 在本函数内被 pop（只能取一次），故必须在此回传，
        调用方据此把耗时/排队信息追加到工具结果尾部（见 :func:`_format_obs_note`）。
    """
    # 排队耗时 / 路径拆解由工具自己上报（如 bash 的执行通道锁 + warm/cold），
    # keyed by tool_call_id；duration_ms 仍是 handler 全程墙钟（排队+执行）。
    queue_wait_ms: float | None = None
    timing: dict[str, Any] | None = None
    if tool_call_id:
        try:
            from evoflow.observability.tool_timing import pop_tool_exec_detail, pop_tool_queue_wait

            queue_wait_ms = pop_tool_queue_wait(tool_call_id)
            timing = pop_tool_exec_detail(tool_call_id)
        except Exception:
            queue_wait_ms = None
            timing = None
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
        if queue_wait_ms is not None:
            log_entry["queue_wait_ms"] = round(queue_wait_ms, 2)
        if timing:
            log_entry["timing"] = timing
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
                    queue_wait_ms=queue_wait_ms,
                    timing=timing,
                )
            except Exception:
                pass
    except Exception as e:
        logger.debug(f"Failed to write tool call log: {e}")
    return {
        "duration_ms": duration_ms,
        "queue_wait_ms": queue_wait_ms,
        "timing": timing,
        # 2026-11-14 真因修正（fullstack-dev 定位 · release-engineer 落地）：tid 此前只用于落库、没有回传，导致 _format_obs_note
        # 的六个调用点全都拿不到 thread_id（它们作用域内也没有 tid 变量），
        # ambient get_config() 在子 Agent / proactive 线程里取不到 → 「模型侧:」静默缺席。
        # 在此回传，让尾注走同一个已解析好的 tid，六调用点零改动。
        "thread_id": tid_raw or None,
    }


# ---------------------------------------------------------------------------
# 观测回显：把「耗时 / 排队 / 失败原因 + 修复线索」追加到工具结果尾部。
# 数据本来就采了（evoflow_obs_tool_invocations），但模型侧看不到，只能凭体感判断慢不慢。
# 只在「值得看一眼」时追加，避免每轮给上下文添噪声；阈值可用环境变量调。
# ---------------------------------------------------------------------------

_OBS_NOTE_ENV = "EVOFLOW_TOOL_OBS_NOTE"
_OBS_SLOW_MS_ENV = "EVOFLOW_TOOL_OBS_SLOW_MS"
_OBS_DEFAULT_SLOW_MS = 3000.0

# 这些工具的返回体由前端/别处按格式解析（快照 DOM、任务卡），尾部追加会破坏解析，
# 永不注记。纯 JSON 信封另有 :func:`_looks_like_json_payload` 兜底。
_OBS_NOTE_SKIP_TOOLS = frozenset(
    {
        "todo_write",
        "browser_snapshot",
        "browser_screenshot",
        "browser_navigate",
        "browser_click",
        "browser_type",
    }
)

# 【fullstack-dev · 2026-11-14 · 第1轮】新增：工具报错 → 一句可执行修复线索（正则表），用户点名要的「如何修复」功能。
# 常见失败 → 一句可执行的修复线索（按顺序首个命中生效）。
_OBS_FIX_HINTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"timeout|timed out", re.I), "超时：把命令拆小或加 run_in_background，别用 sleep 等"),
    (re.compile(r"permission denied|access is denied|eacces", re.I), "权限不足：确认路径可写/是否需管理员，或换工作区内路径"),
    (re.compile(r"unknown tool|no such tool|tool is not available", re.I), "工具不可用：本岗无此权限，换用绑定的工具或转派"),
    (re.compile(r"not[_\s-]?found|notfound|no such file|errno 2", re.I), "路径/对象不存在：先 list/grep 确认实际路径（read 用工作区全路径；assets 用 craft/ 或 memory/journal/ 前缀）"),
    (re.compile(r"econnrefused|connection.*(refused|reset|failed)|all connection attempts", re.I), "连接失败：先确认服务/端口在跑，别先改采集或重试逻辑"),
    (re.compile(r"validationerror|should be a valid|missing.*argument|unexpected argument", re.I), "入参不合契约：对照工具 schema 补齐必填项后再调"),
    (re.compile(r"multiple matches|ambiguous", re.I), "命中多条：把 path 写到全路径"),
    (re.compile(r"database is locked|sqlite", re.I), "库锁/占用：避免并发写同一 db，等下一轮或改只读查询"),
)


def _obs_note_mode() -> str:
    """``off`` 完全不注记 / ``all`` 每次调用都注记 / ``observed`` 默认（慢或失败）。"""
    raw = str(os.getenv(_OBS_NOTE_ENV) or "").strip().lower()
    if raw in {"0", "off", "false", "no"}:
        return "off"
    if raw in {"1", "on", "true", "yes", "force", "all"}:
        return "all"
    return "observed"


def _obs_slow_threshold_ms(mode: str) -> float:
    if mode == "all":
        return 0.0
    try:
        return max(0.0, float(os.getenv(_OBS_SLOW_MS_ENV) or _OBS_DEFAULT_SLOW_MS))
    except (TypeError, ValueError):
        return _OBS_DEFAULT_SLOW_MS


def _obs_ms(value: Any) -> float | None:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v >= 0 else None


def _obs_fix_hint(text: str) -> str:
    s = str(text or "")
    for pattern, hint in _OBS_FIX_HINTS:
        if pattern.search(s):
            return hint
    return ""


# 【fullstack-dev · 2026-11-14 · 第4轮】新增：把模型侧耗时（TTFT/墙钟）并入工具 [obs]，让「系统慢 vs 模型慢」同屏可判。
_MODEL_NOTE_ENV = "EVOFLOW_TOOL_OBS_MODEL_NOTE"
_MODEL_NOTE_TTL_S = 5.0
# 取本 thread 最近几次「主模型」调用（而不是 1 次）：最新一行可能耗时字段全 NULL。
_MODEL_NOTE_SCAN_ROWS = 3
_MODEL_NOTE_LOCK = threading.Lock()
_MODEL_NOTE_CACHE: dict[str, tuple[float, str]] = {}


def _last_model_note(thread_id: str | None) -> str:
    """Describe the model call that produced *this* round, so system-vs-model is visible.

    工具侧有 `[obs]` 了，但模型侧耗时从不进上下文（没人推给我），于是我只能瞎猜
    「这轮慢是不是模型的锅」。这里回查本 thread 最近一次模型调用的 TTFT / 墙钟 / 模型名。
    每轮最多查一次（按 thread_id 缓存 5s），失败一律返回空串 —— 绝不拖垮工具结果。

    2026-11-14 复核更正两处（现网 evoflow_obs_model_invocations 实测）：
    - 必须限定 ``invocation_kind="main"``。同 thread 会混进 subagent/title/compress/memory
      的模型行，近 200 个 thread 里 20%（40 个）的最新一行不是本轮主模型调用 ——
      不限定的话，子 Agent 正在跑时我会把它的耗时读成自己的，直接得出错误结论。
    - 最新行 ``first_token_latency_ms`` 与 ``latency_ms`` 可能同时为 NULL
      （6/60；非流式 ``_agenerate`` 成功路径压根不传 TTFT）。只取一行的话，
      尾注会退化成只剩模型名，看着像数字丢了。故向后多看两行主模型调用再兜底。
    """
    if str(os.getenv(_MODEL_NOTE_ENV) or "").strip().lower() in {"0", "off", "false", "no"}:
        return ""
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    now = time.time()
    with _MODEL_NOTE_LOCK:
        hit = _MODEL_NOTE_CACHE.get(tid)
        if hit and now - hit[0] < _MODEL_NOTE_TTL_S:
            return hit[1]
    note = ""
    try:
        from evoflow.observability import queries as obs_queries

        page = obs_queries.list_model_invocations(
            thread_id=tid, invocation_kind="main", page=1, page_size=_MODEL_NOTE_SCAN_ROWS
        )
        items = page.get("items") if isinstance(page, dict) else None
        rows = [r for r in (items or []) if isinstance(r, dict)]
        # 默认按 requested_at DESC：最新一行才是本轮那次调用。但最新一行可能两个耗时字段
        # 都是 NULL（非流式路径不记 TTFT，且个别行连墙钟都没落），向后找第一行有数的。
        row: dict | None = None
        for cand in rows:
            if _obs_ms(cand.get("first_token_latency_ms")) is not None or _obs_ms(cand.get("latency_ms")) is not None:
                row = cand
                break
        if row is None:
            # 三行全无数 = 这轮拿不到任何可比较的耗时。与其输出「模型侧: qwen3.8-flash」
            # 让人以为数字被吞了，不如整段不出 —— 宁缺毋滥。
            row = {}
        ttft = _obs_ms(row.get("first_token_latency_ms"))
        wall = _obs_ms(row.get("latency_ms"))
        model = str(row.get("model") or "").strip()
        bits: list[str] = []
        if ttft is not None:
            bits.append(f"TTFT {ttft / 1000:.1f}s")
        elif wall is not None:
            # 非流式路径（``_agenerate``）压根不传首 token 时延，实测占 main 行 48%
            # （2026-11-14：956/1967）。占住 TTFT 槽位明说，否则「只有 model 没有 TTFT」
            # 会被读成数字丢了，进而误判成埋点故障 —— 这是语义缺失不是采集故障。
            # 【fullstack-dev · 2026-11-14 · 第5轮】新增此占位分支。
            bits.append("TTFT 无(非流式轮)")
        if wall is not None:
            bits.append(f"model {wall / 1000:.1f}s")
        if model and bits:
            bits.append(model)
        if bits:
            note = " · ".join(bits)
    except Exception:
        logger.debug("model note lookup skipped for thread %s", tid, exc_info=True)
        note = ""
    with _MODEL_NOTE_LOCK:
        if len(_MODEL_NOTE_CACHE) > 512:
            _MODEL_NOTE_CACHE.clear()
        _MODEL_NOTE_CACHE[tid] = (now, note)
    return note


# 【fullstack-dev · 2026-11-14 · 第1轮】新增：组装一行 [obs] 尾注（R4 在此并入模型侧；R6 补 thread_id 三级取值）。
def _format_obs_note(
    *,
    tool_name: str,
    status: str,
    obs: dict[str, Any] | None,
    error_type: str | None = None,
    error_message: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Return a one-line ``[obs] …`` suffix, or ``""`` when nothing is worth surfacing.

    失败一定注记（带 error_type + 修复线索）；成功只在墙钟超阈值时注记，
    并把 ``queue_wait_ms`` 与真实执行分开显示 —— 2026-11-07 线上那条 `git show`
    记了 237s 而实际跑 0.3s，光看总耗时完全看不出是排队。
    """
    mode = _obs_note_mode()
    if mode == "off":
        return ""
    if tool_name in _OBS_NOTE_SKIP_TOOLS:
        return ""
    data = obs if isinstance(obs, dict) else {}
    duration = _obs_ms(data.get("duration_ms"))
    queue_wait = _obs_ms(data.get("queue_wait_ms"))
    failed = str(status or "").lower() == "error"

    parts: list[str] = []
    if duration is not None:
        parts.append(f"{round(duration)}ms")
        if queue_wait is not None and queue_wait >= 200 and queue_wait <= max(duration, queue_wait):
            parts.append(f"queue {round(queue_wait)}ms")
        timing = data.get("timing")
        if isinstance(timing, dict):
            exec_ms = _obs_ms(timing.get("exec_ms"))
            if exec_ms is not None and (duration is None or abs(exec_ms - duration) > 200):
                parts.append(f"exec {round(exec_ms)}ms")
            path = str(timing.get("path") or "").strip()
            if path in {"cold", "warm"}:
                parts.append(path)

    slow = duration is not None and duration >= _obs_slow_threshold_ms(mode)
    if not failed and not slow and mode != "all":
        return ""

    if slow and not failed and mode != "all":
        parts.append("慢调用")
    if queue_wait is not None and queue_wait >= 1000:
        parts.append("瓶颈在排队而非执行，可拆小/后台跑")
    # 慢的时候把「上一轮模型耗时」并排放进来：只有两侧同屏，才分得清是系统慢还是模型慢。
    if slow or mode == "all":
        # thread_id 优先取调用方显式传入，其次取 _log_tool_call_io 已解析好的 tid
        # （见上方 return dict 新增的 "thread_id"），最后才用 ambient 兜底。
        # 此前只靠 ambient：六个调用点都没传、作用域内也没有 tid，子 Agent/proactive
        # 线程里 get_config() 取不到 → 「模型侧:」永远不出现（2026-11-14 现网复现确认）。
        # 「模型侧:」的数据口径见 _last_model_note docstring（kind=main 限定 + 宁缺毋滥）。
        # 【fullstack-dev · 2026-11-14 · 第6轮】真因修正：六个调用点都没传 thread_id，ambient 在子 Agent/proactive 线程取不到 → 「模型侧:」线上从未出现。改为优先用 _log_tool_call_io 回传的 tid。
        model_note = _last_model_note(thread_id or data.get("thread_id") or _current_thread_id_for_log())
        if model_note:
            # 措辞保守：模型行在整轮响应结束后才落库（stage=final_payload），
            # 本轮第一个工具读到的可能是上一轮的调用，故不写「本轮」。
            parts.append(f"模型侧: {model_note}")
    if failed:
        label = str(error_type or "Error").strip() or "Error"
        detail = str(error_message or "").strip().replace("\n", " ")
        if len(detail) > 160:
            detail = detail[:157] + "..."
        parts.append(f"error={label}")
        if detail:
            parts.append(detail)
        hint = _obs_fix_hint(f"{label} {detail}")
        if hint:
            parts.append(hint)

    if not parts:
        return ""
    return "\n[obs] " + " · ".join(parts)


def _looks_like_json_payload(content: str) -> bool:
    """纯 JSON 文档不追加尾注 —— 前端/下游可能直接 ``JSON.parse`` 整段 content。"""
    s = content.strip()
    if not s or s[0] not in "[{" or s[-1] not in "]}":
        return False
    try:
        json.loads(s)
    except (ValueError, TypeError):
        return False
    return True


# 【fullstack-dev · 2026-11-14 · 第1轮】新增：把 [obs] 写回工具结果（纯文本追加；JSON 信封注入 _obs 字段，不破坏消费方）。
def _append_obs_note(result: ToolMessage | Command, note: str) -> ToolMessage | Command:
    """Surface *note* on a ToolMessage body without breaking its consumers.

    纯文本 → 追加到末尾；JSON 信封（assets 一类）→ 注入 ``_obs`` 字段，
    这样既不给机器解析的载荷拼裸文本，也不让"最该带修复线索"的那类返回空手而归。
    """
    if not note or not isinstance(result, ToolMessage) or not hasattr(result, "content"):
        return result
    content = result.content
    if not isinstance(content, str) or not content.strip():
        return result
    if _looks_like_json_payload(content):
        try:
            parsed = json.loads(content)
        except (ValueError, TypeError):
            return result
        if not isinstance(parsed, dict):
            return result  # 数组型载荷没有可塞的字段位，放弃
        parsed = dict(parsed)
        parsed["_obs"] = note.strip()
        try:
            new_content = json.dumps(parsed, ensure_ascii=False)
        except (TypeError, ValueError):
            return result
    else:
        new_content = content + note
    # model_copy 而非重建：保留 additional_kwargs / artifact 等原有字段。
    try:
        return result.model_copy(update={"content": new_content})
    except Exception:
        logger.debug("obs note skipped (model_copy failed)", exc_info=True)
        return result


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
        is_error_result = str(getattr(result, "status", None) or "").strip().lower() == "error"
        # 【self-evolution-bot · 2026-11-22 · 第124轮 · 模型:deepseek-v4.1-flash】
        # 改了什么：工具**返回**（而非抛出）一句 "Error: ..." 时，把 ToolMessage.status
        # 同步成 "error"，不再让「obs 记 error、消息本身仍是 ok」两套口径并存。
        # 为什么（现网实证，2026-11-22 17:58~18:01，agent=case-fullstack-dev）：
        #   · search_code_index 返回纯字符串
        #     "Error: search_code_index failed: database disk image is malformed"；
        #   · obs 表 6 条同工具记录全是 status=error（`_completed_tool_should_log_as_error` 认了）；
        #   · 但右侧面板那张卡显示的是「代码索引 / 查找 RightStagePanel / **已执行**」
        #     —— 因为 v4 行状态来自 wire 的 tool_result.status，而 wire 状态取的是
        #     ToolMessage.status（这里始终是 None → 归一化成 success），
        #     于是 UI 说成功、obs 说失败、模型看到的是错误正文。三方各说一套。
        #   · 这不是「文案难看」：失败卡长得跟成功卡一样，用户与模型都没有视觉信号
        #     去重试或换工具，本轮的员工就是连调 6 次才被我自己发现库坏了。
        # 边界：只在本函数（结果整形阶段）补 status，判定复用既有的
        # `_completed_tool_should_log_as_error`（JSON 信封 / "Error:" 前缀 / 显式失败标记），
        # 不新增任何字符串启发式；已经 error 的不重复构造；Command（非 ToolMessage）不动。
        # 注意：**不在这里递归整形、也不提前 return**——换好 status 后继续走下面
        # 既有的 `if is_error_result:` 分支（头部保留的错误截断 + 末尾 working memory
        # 注册都在那里），否则等于把后两步动作绕过去（本岗栽过多次的「改中间层漏接线」）。
        if not is_error_result and _completed_tool_should_log_as_error(result, raw_content):
            is_error_result = True
            result = ToolMessage(
                content=raw_content,
                tool_call_id=result.tool_call_id,
                name=getattr(result, "name", None),
                status="error",
            )
        if is_error_result:
            # 错误结果的诊断价值集中在开头（失败原因/参数回显/栈帧头部）——
            # 中段截断会恰好截掉修复线索。改为保留头部的硬顶（与 partial_read
            # 切片同款公式），其余 error 处理照常。
            shaped = str(result.content or "")
            error_cap = max(get_tool_results_config().threshold_chars // 2, 32_000)
            if len(shaped) > error_cap:
                shaped = shaped[:error_cap] + (
                    f"\n\n… [error output truncated, total {len(shaped):,} chars]"
                )
        else:
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
        # 错误结果的空体用失败文案——"[Tool completed — no output]" 与 error
        # status 并存会让模型误判成功。
        if not shaped or not shaped.strip():
            shaped = "[Tool failed with no output]" if is_error_result else "[Tool completed — no output]"
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
        # 失败的调用不进 working memory——否则 read 失败也会把文件记成“已读”，
        # 模型下次重读会被“文件未变更”短路误导。
        if str(getattr(result, "status", None) or "").strip().lower() == "error":
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
                obs = _log_tool_call_io(
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
                # 失败也回显：修复线索是这条链路的主要价值。注记追加在原文之后，
                # 不影响 `_infer_tool_error_type_from_output` 等 startswith 判定；
                # JSON 信封（如 assets 的 {"ok": false…}）由 _looks_like_json_payload 跳过。
                result = _append_obs_note(
                    result,
                    _format_obs_note(
                        tool_name=tool_name,
                        status="error",
                        obs=obs,
                        error_type=et,
                        error_message=em,
                    ),
                )
            else:
                obs = _log_tool_call_io(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_input=tool_input,
                    tool_output=output_text,
                    status="success",
                    duration_ms=duration_ms,
                    request=request,
                )
                # 失败路径不追加：错误消息本身已带异常类+文本，再拼一段以句点结尾的
                # 纯文本会干扰下游对 "Error:" 的启发式解析。
                result = _append_obs_note(
                    result,
                    _format_obs_note(tool_name=tool_name, status="success", obs=obs),
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
            obs = _log_tool_call_io(
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

            return _append_obs_note(
                self._build_error_message(request, exc),
                _format_obs_note(
                    tool_name=tool_name,
                    status="error",
                    obs=obs,
                    error_type=exc.__class__.__name__,
                    error_message=str(exc),
                ),
            )

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
                obs = _log_tool_call_io(
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
                # 失败也回显：修复线索是这条链路的主要价值。追加在原文之后，不影响
                # `startswith("Error:")` 一类判定；JSON 信封由 _looks_like_json_payload 跳过。
                result = _append_obs_note(
                    result,
                    _format_obs_note(
                        tool_name=tool_name,
                        status="error",
                        obs=obs,
                        error_type=et,
                        error_message=em,
                    ),
                )
            else:
                obs = _log_tool_call_io(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    tool_input=tool_input,
                    tool_output=output_text,
                    status="success",
                    duration_ms=duration_ms,
                    request=request,
                )
                result = _append_obs_note(
                    result,
                    _format_obs_note(tool_name=tool_name, status="success", obs=obs),
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
            obs = _log_tool_call_io(
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

            return _append_obs_note(
                self._build_error_message(request, exc),
                _format_obs_note(
                    tool_name=tool_name,
                    status="error",
                    obs=obs,
                    error_type=exc.__class__.__name__,
                    error_message=str(exc),
                ),
            )


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
