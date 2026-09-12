"""上下文压缩专用追踪日志：写入独立文件，便于排查超窗 / 空返回 / 压缩失效。

环境变量：

- ``EVOFLOW_COMPACTION_TRACE_LOG``：``0`` / ``false`` / ``off`` 关闭文件日志。
- ``EVOFLOW_COMPACTION_TRACE_LOG_FILE``：完整路径（优先）。
- ``EVOFLOW_COMPACTION_TRACE_LOG_DIR`` 或 ``EVOFLOW_LOGS_DIR``：目录，默认 ``context-compaction.log``。
- ``EVOFLOW_COMPACTION_TRACE_CONSOLE``：``1`` / ``true`` 时同时输出到 root console（默认关闭）。

默认路径：``<repo>/logs/context-compaction.log``（与 ``goal-trace.log`` 同目录）。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Sequence
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

_COMPACTION_LOGGER_NAME = "evoflow.context_compaction_trace"
_CONFIGURED = False
_FILE_LOCK = threading.Lock()

_FIELD_LABELS: dict[str, str] = {
    "thread_id": "thread",
    "session_key": "session",
    "model_name": "模型",
    "model_context": "模型上下文",
    "context_length": "模型窗口",
    "gate_tokens": "gate_tokens",
    "history_tokens": "history_tokens",
    "overhead_tokens": "overhead_tokens",
    "system_tokens": "system_tokens",
    "tools_tokens": "tools_tokens",
    "tool_count": "工具数",
    "occupancy_pct": "占窗口%",
    "need_compress": "是否需要压缩",
    "threshold": "压缩阈值",
    "threshold_ratio": "阈值比例",
    "aggressive_ratio": "激进阈值比例",
    "pct_of_context": "占窗口%",
    "message_count": "消息数",
    "model_round": "模型轮次",
    "human_turns": "用户轮次",
    "tool_results": "工具结果数",
    "phase": "阶段",
    "should_trigger": "应触发压缩",
    "should_refold_cached": "冷却复用摘要",
    "block_reason": "阻塞原因",
    "cooldown_active": "冷却中",
    "pass_label": "压缩轮次",
    "passes": "压缩 passes",
    "note": "备注",
    "reason": "原因",
    "before": "压缩前",
    "after": "压缩后",
    "saved_tokens": "节省 tokens",
    "saved_pct": "节省%",
    "effect": "效果",
    "force": "强制",
    "background_llm": "后台 LLM",
    "job_middle_msgs": "待压缩中间段",
    "error": "错误",
    "usage": "usage",
    "response_metadata": "response_metadata",
    "trace_id": "trace_id",
    "compression_attempt": "紧急压缩尝试",
    "token_over_threshold": "超阈值",
    "count_ok": "消息数满足",
    "diagnosis": "判定",
    "output_tokens": "output_tokens",
    "input_tokens": "input_tokens",
    "finish_reason": "finish_reason",
    "empty_retry_attempt": "空返回重试轮次",
    "compaction_folded": "本轮已压缩",
    "compaction_skipped": "跳过压缩",
    "allow_compress": "允许压缩",
    "trigger_reason": "触发原因",
    "turn_run_id": "用户轮run_id",
    "langgraph_run_id": "LangGraph_run_id",
    "snap_run_id": "缓存run_id",
    "same_turn": "同用户轮",
    "after_gate_tokens": "压缩后gate",
    "refill_floor": "refill阈值",
    "same_turn_refill_floor": "同轮refill阈值",
    "cooldown_remaining_s": "冷却剩余秒",
    "cooldown_seconds": "冷却配置秒",
    "compress_in_flight": "压缩进行中锁",
    "diagnostic_only": "仅诊断无策略",
    "aggressive_pass": "激进放行",
    "msgs_before_fold": "压缩前消息数",
    "msgs_after_fold": "压缩后消息数",
    "fallback_injected": "已注入fallback",
    "stream_emitted": "流式已推送",
    "plan_guard_reason": "plan_guard原因",
    "tool_calls_before": "原工具调用数",
    "tool_calls_after": "过滤后工具调用数",
    "content_len": "正文长度",
    "ui_activity": "UI活动提示",
    "summary_seq": "摘要seq",
    "summary_updated": "原地更新",
    "summary_skipped": "跳过写入",
    "persist_mode": "落库方式",
    "summary_chars": "摘要字符数",
    "compress_streaming": "压缩流式",
    "anchor_seq": "bridge锚点seq",
    "pre_bridge_rows": "bridge行数",
    "post_tail_rows": "marker后tail行数",
    "has_summary_row": "含summary行",
    "hydrated_rows": "hydration总行数",
    "compaction_seq": "summary_marker_seq",
}


def compaction_trace_now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def _file_logging_disabled() -> bool:
    return os.environ.get("EVOFLOW_COMPACTION_TRACE_LOG", "").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    )


def _console_mirror_enabled() -> bool:
    return os.environ.get("EVOFLOW_COMPACTION_TRACE_CONSOLE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _resolve_logs_dir() -> str:
    from pathlib import Path

    for env in ("EVOFLOW_COMPACTION_TRACE_LOG_DIR", "EVOFLOW_LOGS_DIR"):
        raw = os.environ.get(env, "").strip()
        if raw:
            return str(Path(raw).expanduser().resolve())
    try:
        from evoflow.config.paths import get_paths

        return str((get_paths().base_dir / "logs").resolve())
    except Exception:
        pass
    for base in (Path.cwd(), Path.cwd().parent, Path.cwd().parent.parent):
        if (base / "logs").is_dir():
            return str((base / "logs").resolve())
        if (base / "Makefile").is_file() and (base / "backend").is_dir():
            return str((base / "logs").resolve())
    return str((Path.cwd() / "logs").resolve())


def compaction_trace_log_path() -> str:
    explicit = os.environ.get("EVOFLOW_COMPACTION_TRACE_LOG_FILE", "").strip()
    if explicit:
        from pathlib import Path

        return str(Path(explicit).expanduser().resolve())
    from pathlib import Path

    return str(Path(_resolve_logs_dir()) / "context-compaction.log")


def ensure_compaction_trace_file_logging() -> None:
    """幂等：为 ``evoflow.context_compaction_trace`` 挂 FileHandler，默认不向 root 传播。"""
    global _CONFIGURED
    if _CONFIGURED or _file_logging_disabled():
        return
    from pathlib import Path

    path = Path(compaction_trace_log_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(message)s"))
    audit = logging.getLogger(_COMPACTION_LOGGER_NAME)
    audit.addHandler(fh)
    audit.setLevel(logging.DEBUG)
    audit.propagate = _console_mirror_enabled()
    _CONFIGURED = True
    audit.info(
        "%s | 上下文压缩 | 日志启动 | path=%s",
        compaction_trace_now_str(),
        str(path.resolve()),
    )


def _compaction_logger() -> logging.Logger:
    if not _file_logging_disabled():
        ensure_compaction_trace_file_logging()
    return logging.getLogger(_COMPACTION_LOGGER_NAME)


def count_message_rounds(messages: Sequence[BaseMessage]) -> dict[str, int]:
    """Rough turn counters for the current checkpoint transcript."""
    ai = 0
    human = 0
    tools = 0
    for msg in messages:
        if isinstance(msg, AIMessage):
            ai += 1
        elif isinstance(msg, HumanMessage):
            human += 1
        elif isinstance(msg, ToolMessage):
            tools += 1
    return {
        "model_round": ai,
        "human_turns": human,
        "tool_results": tools,
        "message_count": len(messages),
    }


def format_compaction_snapshot_brief(snap: dict[str, Any]) -> str:
    return (
        f"{snap.get('gate_tokens', '?')} tok "
        f"({snap.get('pct_of_context', '?')}%/{snap.get('context_k', '?')}k) "
        f"{snap.get('message_count', '?')} msgs"
    )


def _format_field(label: str, val: Any) -> str:
    if isinstance(val, bool):
        text = "是" if val else "否"
    elif val is None:
        return ""
    elif isinstance(val, (list, tuple)):
        text = ",".join(str(x) for x in val) if val else "（空）"
    else:
        text = str(val).strip()
        if not text:
            return ""
    return f"  {label}: {text}"


def log_compaction_trace(
    event: str,
    *,
    thread_id: str = "",
    session_key: str = "",
    model_name: str = "",
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    """写入 ``logs/context-compaction.log``（结构化中文，便于排查压缩 / 超窗 / 空返回）。"""
    if _file_logging_disabled():
        return

    head_parts: list[str] = [compaction_trace_now_str(), "上下文压缩", event]

    tid = str(thread_id or fields.pop("thread_id", "") or "").strip()
    if tid:
        head_parts.append(f"thread={tid[:32]}")

    sk = str(session_key or fields.pop("session_key", "") or "").strip()
    if sk:
        head_parts.append(f"session={sk}")

    model = str(model_name or fields.pop("model_name", "") or "").strip()
    if model:
        head_parts.append(f"model={model}")

    lines = [" | ".join(head_parts)]

    ordered_keys = (
        "phase",
        "model_round",
        "human_turns",
        "tool_results",
        "message_count",
        "gate_tokens",
        "history_tokens",
        "overhead_tokens",
        "system_tokens",
        "tools_tokens",
        "tool_count",
        "context_length",
        "model_context",
        "pct_of_context",
        "threshold",
        "threshold_ratio",
        "aggressive_ratio",
        "should_trigger",
        "should_refold_cached",
        "token_over_threshold",
        "cooldown_active",
        "block_reason",
        "count_ok",
        "force",
        "before",
        "after",
        "saved_tokens",
        "saved_pct",
        "effect",
        "pass_label",
        "passes",
        "note",
        "reason",
        "background_llm",
        "job_middle_msgs",
        "compression_attempt",
        "trace_id",
        "diagnosis",
        "output_tokens",
        "input_tokens",
        "finish_reason",
        "empty_retry_attempt",
        "compaction_folded",
        "compaction_skipped",
        "msgs_before_fold",
        "msgs_after_fold",
        "fallback_injected",
        "stream_emitted",
        "plan_guard_reason",
        "tool_calls_before",
        "tool_calls_after",
        "content_len",
        "ui_activity",
        "usage",
        "response_metadata",
        "error",
    )
    for key in ordered_keys:
        if key not in fields:
            continue
        label = _FIELD_LABELS.get(key, key)
        line = _format_field(label, fields.pop(key))
        if line:
            lines.append(line)

    for key, val in fields.items():
        if val is None or val == "":
            continue
        label = _FIELD_LABELS.get(key, key)
        line = _format_field(label, val)
        if line:
            lines.append(line)

    lines.append("---")
    message = "\n".join(lines)
    with _FILE_LOCK:
        _compaction_logger().log(level, message, exc_info=level >= logging.ERROR)


def log_summary_db_persist(
    *,
    session_key: str,
    thread_id: str | None = None,
    row: dict[str, Any] | None = None,
    summary_chars: int = 0,
    note: str = "",
) -> None:
    """Trace compaction summary append to ``evoflow_chat_messages``."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if row is None:
        log_compaction_trace(
            "摘要落库失败",
            session_key=sk,
            thread_id=tid,
            level=logging.ERROR,
            summary_chars=summary_chars or None,
            note=note or "persist_conversation_summary returned None",
        )
        return
    if row.get("skipped"):
        log_compaction_trace(
            "摘要落库跳过",
            session_key=sk,
            thread_id=tid,
            summary_seq=row.get("seq"),
            summary_skipped=True,
            note=note or "unchanged",
        )
        return
    mode = "append" if not row.get("skipped") else "skip"
    log_compaction_trace(
        "摘要已落库",
        session_key=sk,
        thread_id=tid,
        summary_seq=row.get("seq"),
        message_id=row.get("message_id"),
        summary_updated=False,
        persist_mode=mode,
        summary_chars=summary_chars or None,
        note=note or "append INSERT evoflow_chat_messages",
    )


def log_model_response_diagnosis(
    event: str,
    *,
    diagnosis: str,
    thread_id: str = "",
    session_key: str = "",
    model_name: str = "",
    level: int = logging.WARNING,
    **fields: Any,
) -> None:
    """写入模型轮次诊断：区分厂商空返回 vs 系统剥空/注入 fallback（见 ``context-compaction.log``）。"""
    log_compaction_trace(
        event,
        thread_id=thread_id,
        session_key=session_key,
        model_name=model_name,
        level=level,
        diagnosis=diagnosis,
        **fields,
    )


def usage_fields_from_ai(ai: Any) -> dict[str, Any]:
    """Extract token / finish_reason fields from an AIMessage for compaction diagnosis."""
    if ai is None:
        return {}
    usage = getattr(ai, "usage_metadata", None) or {}
    meta = getattr(ai, "response_metadata", None) or {}
    out: dict[str, Any] = {}
    if isinstance(usage, dict):
        if usage.get("input_tokens") is not None:
            out["input_tokens"] = usage.get("input_tokens")
        if usage.get("output_tokens") is not None:
            out["output_tokens"] = usage.get("output_tokens")
    if isinstance(meta, dict) and meta.get("finish_reason") is not None:
        out["finish_reason"] = meta.get("finish_reason")
    content = getattr(ai, "content", None)
    if isinstance(content, str):
        out["content_len"] = len(content.strip())
    tool_calls = getattr(ai, "tool_calls", None) or []
    if tool_calls:
        out["tool_calls_after"] = len(tool_calls)
    return out
