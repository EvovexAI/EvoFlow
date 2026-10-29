"""飞书入站媒体 / 合并专用追踪日志：写入独立文件 ``feishu-inbound-trace.log``。

重启后仍可按时间线排查：收包 → 解析 refs → 下载 → coalesce 合并 → flush。
不依赖 uvicorn/root logger（launcher 丢 stderr 时也能看到）。

环境变量：

- ``EVOFLOW_FEISHU_INBOUND_TRACE_LOG``：``0`` / ``false`` / ``off`` 关闭。
- ``EVOFLOW_FEISHU_INBOUND_TRACE_LOG_FILE``：完整路径（优先）。
- ``EVOFLOW_FEISHU_INBOUND_TRACE_LOG_DIR`` / ``EVOFLOW_LOGS_DIR`` / ``EVOFLOW_LOG_DIR``：目录。
- ``EVOFLOW_FEISHU_INBOUND_TRACE_CONSOLE``：``1`` 时同时打到 console。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

_LOGGER_NAME = "evoflow.feishu_inbound_trace"
_CONFIGURED = False
_FILE_LOCK = threading.Lock()


def _now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def _clip(text: Any, *, max_len: int = 240) -> str:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return "（空）"
    one = " ".join(raw.split())
    if len(one) <= max_len:
        return one
    return one[:max_len] + "…"


def _disabled() -> bool:
    return os.environ.get("EVOFLOW_FEISHU_INBOUND_TRACE_LOG", "").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    )


def _console_mirror() -> bool:
    return os.environ.get("EVOFLOW_FEISHU_INBOUND_TRACE_CONSOLE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _resolve_logs_dir() -> Path:
    for env in (
        "EVOFLOW_FEISHU_INBOUND_TRACE_LOG_DIR",
        "EVOFLOW_LOGS_DIR",
        "EVOFLOW_LOG_DIR",
    ):
        raw = os.environ.get(env, "").strip()
        if raw:
            return Path(raw).expanduser().resolve()
    # Prefer EVOFLOW_HOME (dev: ~/.evoflow-dev) so traces sit next to wecom-diag /
    # channel-diag — not under whichever cwd the backend process happened to use.
    home = os.environ.get("EVOFLOW_HOME", "").strip()
    if home:
        base = Path(home).expanduser().resolve()
        # EVOFLOW_HOME may already be …/data; logs live at sibling or under home.
        if base.name.lower() == "data":
            return (base.parent / "logs").resolve()
        return (base / "logs").resolve()
    for candidate in (
        Path.home() / ".evoflow-dev" / "logs",
        Path.home() / ".evoflow" / "logs",
    ):
        if candidate.is_dir() or candidate.parent.is_dir():
            return candidate.resolve()
    for base in (Path.cwd(), Path.cwd().parent, Path.cwd().parent.parent):
        if (base / "logs").is_dir():
            return (base / "logs").resolve()
        if (base / "Makefile").is_file() and (base / "backend").is_dir():
            return (base / "logs").resolve()
    return (Path.cwd() / "logs").resolve()


def feishu_inbound_trace_log_path() -> Path:
    explicit = os.environ.get("EVOFLOW_FEISHU_INBOUND_TRACE_LOG_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return _resolve_logs_dir() / "feishu-inbound-trace.log"


def ensure_feishu_inbound_trace_file_logging() -> None:
    global _CONFIGURED
    if _CONFIGURED or _disabled():
        return
    path = feishu_inbound_trace_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(message)s"))
    audit = logging.getLogger(_LOGGER_NAME)
    audit.addHandler(fh)
    audit.setLevel(logging.DEBUG)
    audit.propagate = _console_mirror()
    _CONFIGURED = True
    audit.info("%s | 飞书入站 | 日志启动 | path=%s", _now_str(), str(path.resolve()))


def _logger() -> logging.Logger:
    if not _disabled():
        ensure_feishu_inbound_trace_file_logging()
    return logging.getLogger(_LOGGER_NAME)


def log_feishu_inbound_trace(
    event: str,
    *,
    level: int = logging.INFO,
    account_id: str = "",
    chat_id: str = "",
    msg_id: str = "",
    **fields: Any,
) -> None:
    """Append one structured block to ``feishu-inbound-trace.log`` (never raises)."""
    if _disabled():
        return
    try:
        head = [_now_str(), "飞书入站", str(event or "").strip() or "event"]
        aid = str(account_id or "").strip()
        cid = str(chat_id or "").strip()
        mid = str(msg_id or "").strip()
        if aid:
            head.append(f"account={aid}")
        if cid:
            head.append(f"chat={cid[:24]}")
        if mid:
            head.append(f"msg={mid[:40]}")

        extras: list[str] = []
        for key, val in fields.items():
            if val is None or val == "":
                continue
            if isinstance(val, (dict, list)):
                try:
                    text = json.dumps(val, ensure_ascii=False, default=str)
                except Exception:
                    text = str(val)
                extras.append(f"  {key}: {_clip(text, max_len=800)}")
            else:
                extras.append(f"  {key}: {_clip(val, max_len=400)}")

        message = "\n".join([" | ".join(head), *extras, "---"])
        with _FILE_LOCK:
            _logger().log(level, message, exc_info=level >= logging.ERROR)
    except Exception:
        pass


__all__ = [
    "feishu_inbound_trace_log_path",
    "ensure_feishu_inbound_trace_file_logging",
    "log_feishu_inbound_trace",
]
