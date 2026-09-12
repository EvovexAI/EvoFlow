"""目标模式专用追踪日志：写入独立文件，不与主流程 console 混排。

环境变量：

- ``EVOFLOW_GOAL_TRACE_LOG``：``0`` / ``false`` / ``off`` 关闭文件日志。
- ``EVOFLOW_GOAL_TRACE_LOG_FILE``：完整路径（优先）。
- ``EVOFLOW_GOAL_TRACE_LOG_DIR`` 或 ``EVOFLOW_LOGS_DIR``：目录，默认 ``goal-trace.log``。
- ``EVOFLOW_GOAL_TRACE_CONSOLE``：``1`` / ``true`` 时同时输出到 root console（默认关闭）。

默认路径：``<repo>/logs/goal-trace.log``（与 ``stream-trace.log`` 同目录）。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

_GOAL_LOGGER_NAME = "evoflow.goal_trace"
_CONFIGURED = False
_FILE_LOCK = threading.Lock()

_FIELD_LABELS: dict[str, str] = {
    "user_input": "用户输入",
    "nudge_input": "续跑输入",
    "assistant_output": "助手输出",
    "response": "助手输出",
    "decision": "决策",
    "judgment": "判定",
    "action": "动作",
    "state_patch": "状态写入",
    "tool_result": "工具返回",
    "goal_text": "目标",
    "goal_status": "目标状态",
    "db_status": "DB状态",
    "completed_reason": "完成原因",
    "next_nudge": "续跑输入",
    "tools": "工具",
    "reason": "原因",
    "tool_count": "工具数",
    "hosted_id": "托管ID",
}


def goal_trace_now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def clip_goal_trace_text(text: str | None, *, max_len: int = 480) -> str:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return "（空）"
    one_line = " ".join(raw.split())
    if len(one_line) <= max_len:
        return one_line
    return one_line[:max_len] + "…"


def _file_logging_disabled() -> bool:
    return os.environ.get("EVOFLOW_GOAL_TRACE_LOG", "").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    )


def _console_mirror_enabled() -> bool:
    return os.environ.get("EVOFLOW_GOAL_TRACE_CONSOLE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _resolve_logs_dir() -> Path:
    for env in ("EVOFLOW_GOAL_TRACE_LOG_DIR", "EVOFLOW_LOGS_DIR"):
        raw = os.environ.get(env, "").strip()
        if raw:
            return Path(raw).expanduser().resolve()
    for base in (Path.cwd(), Path.cwd().parent, Path.cwd().parent.parent):
        if (base / "logs").is_dir():
            return (base / "logs").resolve()
        if (base / "Makefile").is_file() and (base / "backend").is_dir():
            return (base / "logs").resolve()
    return (Path.cwd() / "logs").resolve()


def goal_trace_log_path() -> Path:
    explicit = os.environ.get("EVOFLOW_GOAL_TRACE_LOG_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return _resolve_logs_dir() / "goal-trace.log"


def ensure_goal_trace_file_logging() -> None:
    """幂等：为 ``evoflow.goal_trace`` 挂 FileHandler，默认不向 root 传播。"""
    global _CONFIGURED
    if _CONFIGURED or _file_logging_disabled():
        return
    path = goal_trace_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(
        logging.Formatter("%(message)s"),
    )
    audit = logging.getLogger(_GOAL_LOGGER_NAME)
    audit.addHandler(fh)
    audit.setLevel(logging.DEBUG)
    audit.propagate = _console_mirror_enabled()
    _CONFIGURED = True
    audit.info(
        "%s | 目标模式 | 日志启动 | path=%s",
        goal_trace_now_str(),
        str(path.resolve()),
    )


def _goal_logger() -> logging.Logger:
    if not _file_logging_disabled():
        ensure_goal_trace_file_logging()
    return logging.getLogger(_GOAL_LOGGER_NAME)


def _format_multiline_block(label: str, text: str, *, max_len: int = 2000) -> str:
    clipped = clip_goal_trace_text(text, max_len=max_len)
    if len(clipped) <= 160 and "\n" not in str(text or ""):
        return f"  {label}: {clipped}"
    return f"  {label}:\n    {clipped}"


def _collect_labeled_fields(
    *,
    goal_text: str | None = None,
    user_input: str | None = None,
    nudge_input: str | None = None,
    assistant_output: str | None = None,
    response: str | None = None,
    decision: str | None = None,
    judgment: str | None = None,
    action: str | None = None,
    state_patch: str | None = None,
    tool_result: str | None = None,
    **fields: Any,
) -> list[tuple[str, str]]:
    ordered: list[tuple[str, str | None]] = [
        ("目标", goal_text),
        ("用户输入", user_input),
        ("续跑输入", nudge_input or fields.pop("next_nudge", None)),
        ("助手输出", assistant_output or response),
        ("判定", judgment),
        ("决策", decision),
        ("动作", action),
        ("状态写入", state_patch),
        ("工具返回", tool_result),
    ]
    for key, val in fields.items():
        if val is None or val == "":
            continue
        label = _FIELD_LABELS.get(key, key)
        ordered.append((label, str(val)))

    out: list[tuple[str, str]] = []
    seen_labels: set[str] = set()
    for label, val in ordered:
        if val is None or str(val).strip() == "":
            continue
        if label in seen_labels:
            continue
        seen_labels.add(label)
        out.append((label, str(val)))
    return out


def log_goal_trace(
    event: str,
    *,
    session_key: str = "",
    turn_no: int | None = None,
    max_steps: int | None = None,
    goal_text: str | None = None,
    user_input: str | None = None,
    nudge_input: str | None = None,
    assistant_output: str | None = None,
    response: str | None = None,
    decision: str | None = None,
    judgment: str | None = None,
    action: str | None = None,
    state_patch: str | None = None,
    tool_result: str | None = None,
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    """写入 ``logs/goal-trace.log``（结构化中文，便于排查判定 / 输入 / 输出 / 轮次）。"""
    if _file_logging_disabled():
        return

    head_parts: list[str] = [goal_trace_now_str(), "目标模式", event]

    if turn_no is not None:
        if max_steps is not None and int(max_steps) > 0:
            head_parts.append(f"轮次={int(turn_no)}/{int(max_steps)}")
        else:
            head_parts.append(f"轮次={int(turn_no)}")

    sk = str(session_key or "").strip()
    if sk:
        head_parts.append(f"sk={sk}")

    body_fields = _collect_labeled_fields(
        goal_text=goal_text,
        user_input=user_input,
        nudge_input=nudge_input,
        assistant_output=assistant_output,
        response=response,
        decision=decision,
        judgment=judgment,
        action=action,
        state_patch=state_patch,
        tool_result=tool_result,
        **fields,
    )

    lines = [" | ".join(head_parts)]
    for label, val in body_fields:
        max_len = 3200 if label in {"续跑输入", "用户输入", "助手输出"} else 2000
        lines.append(_format_multiline_block(label, val, max_len=max_len))
    lines.append("---")

    message = "\n".join(lines)
    with _FILE_LOCK:
        _goal_logger().log(level, message, exc_info=level >= logging.ERROR)


def format_goal_state_patch(**fields: Any) -> str:
    """Helper for middleware / tools: ``status=running step_count=2``."""
    parts: list[str] = []
    for key, val in fields.items():
        if val is None:
            continue
        parts.append(f"{key}={val}")
    return " ".join(parts)
