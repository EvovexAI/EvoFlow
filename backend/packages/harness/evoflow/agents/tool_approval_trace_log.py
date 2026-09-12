"""工具授权专用追踪日志：写入独立文件 ``logs/tool-approval-trace.log``（中文）。

环境变量：

- ``EVOFLOW_TOOL_APPROVAL_TRACE_LOG``：``0`` / ``false`` / ``off`` 关闭。
- ``EVOFLOW_TOOL_APPROVAL_TRACE_LOG_FILE``：完整路径（优先）。
- ``EVOFLOW_TOOL_APPROVAL_TRACE_LOG_DIR`` 或 ``EVOFLOW_LOGS_DIR``：目录。
- ``EVOFLOW_TOOL_APPROVAL_TRACE_CONSOLE``：``1`` 时同时输出到 console。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

_LOGGER_NAME = "evoflow.tool_approval_trace"
_CONFIGURED = False
_FILE_LOCK = threading.Lock()


def trace_now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def clip_trace_text(text: str | None, *, max_len: int = 600) -> str:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return "（空）"
    one_line = " ".join(raw.split())
    if len(one_line) <= max_len:
        return one_line
    return one_line[:max_len] + "…"


def _file_logging_disabled() -> bool:
    return os.environ.get("EVOFLOW_TOOL_APPROVAL_TRACE_LOG", "").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    )


def _console_mirror_enabled() -> bool:
    return os.environ.get("EVOFLOW_TOOL_APPROVAL_TRACE_CONSOLE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _resolve_logs_dir() -> Path:
    for env in ("EVOFLOW_TOOL_APPROVAL_TRACE_LOG_DIR", "EVOFLOW_LOGS_DIR"):
        raw = os.environ.get(env, "").strip()
        if raw:
            return Path(raw).expanduser().resolve()
    for base in (Path.cwd(), Path.cwd().parent, Path.cwd().parent.parent):
        if (base / "logs").is_dir():
            return (base / "logs").resolve()
        if (base / "Makefile").is_file() and (base / "backend").is_dir():
            return (base / "logs").resolve()
    return (Path.cwd() / "logs").resolve()


def tool_approval_trace_log_path() -> Path:
    explicit = os.environ.get("EVOFLOW_TOOL_APPROVAL_TRACE_LOG_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return _resolve_logs_dir() / "tool-approval-trace.log"


def ensure_tool_approval_trace_file_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED or _file_logging_disabled():
        return
    path = tool_approval_trace_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(message)s"))
    audit = logging.getLogger(_LOGGER_NAME)
    audit.addHandler(fh)
    audit.setLevel(logging.DEBUG)
    audit.propagate = _console_mirror_enabled()
    _CONFIGURED = True
    audit.info("%s | 工具授权 | 日志启动 | path=%s", trace_now_str(), str(path.resolve()))


def _trace_logger() -> logging.Logger:
    if not _file_logging_disabled():
        ensure_tool_approval_trace_file_logging()
    return logging.getLogger(_LOGGER_NAME)


def _format_extra(fields: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for key, val in fields.items():
        if val is None or val == "":
            continue
        label = str(key)
        if isinstance(val, (dict, list)):
            try:
                text = json.dumps(val, ensure_ascii=False, default=str)
            except Exception:
                text = str(val)
        else:
            text = str(val)
        lines.append(f"  {label}: {clip_trace_text(text, max_len=1200)}")
    return lines


def log_tool_approval_trace(
    event: str,
    *,
    side: str = "后端",
    thread_id: str = "",
    session_key: str = "",
    tool_name: str = "",
    tool_call_id: str = "",
    run_id: str = "",
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    """写入 ``logs/tool-approval-trace.log``。"""
    if _file_logging_disabled():
        return

    head: list[str] = [trace_now_str(), "工具授权", side, event]
    tid = str(thread_id or fields.pop("threadId", "") or "").strip()
    sk = str(session_key or fields.pop("sessionKey", "") or "").strip()
    tn = str(tool_name or fields.pop("toolName", "") or "").strip()
    tc = str(tool_call_id or fields.pop("toolCallId", "") or "").strip()
    rid = str(run_id or fields.pop("runId", "") or "").strip()
    if tid:
        head.append(f"thread={tid}")
    if sk:
        head.append(f"session={sk}")
    if tn:
        head.append(f"tool={tn}")
    if tc:
        head.append(f"tc={tc}")
    if rid:
        head.append(f"run={rid}")

    lines = [" | ".join(head), *_format_extra(fields)]
    lines.append("---")
    message = "\n".join(lines)
    with _FILE_LOCK:
        _trace_logger().log(level, message, exc_info=level >= logging.ERROR)


__all__ = [
    "clip_trace_text",
    "log_tool_approval_trace",
    "tool_approval_trace_log_path",
    "trace_now_str",
]
