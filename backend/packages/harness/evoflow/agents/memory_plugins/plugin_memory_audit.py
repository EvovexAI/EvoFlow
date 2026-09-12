"""外部插件记忆专用文件日志（与根 logger 分离，默认写入系统 temp 目录）。

环境变量：

- ``EVOFLOW_EXTERNAL_MEMORY_LOG``：设为 ``0`` / ``false`` / ``off`` 关闭文件日志。
- ``EVOFLOW_EXTERNAL_MEMORY_LOG_FILE``：日志文件完整路径（优先）。
- ``EVOFLOW_EXTERNAL_MEMORY_LOG_DIR``：目录；使用其中 ``plugin-memory.log``。

默认文件：``{tempfile.gettempdir()}/evoflow-external-memory/plugin-memory.log``
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

_AUDIT = logging.getLogger("evoflow.plugin_memory")
_CONFIGURED = False


def _log_file_path() -> Path:
    explicit = os.environ.get("EVOFLOW_EXTERNAL_MEMORY_LOG_FILE", "").strip()
    if explicit:
        return Path(explicit)
    d = os.environ.get("EVOFLOW_EXTERNAL_MEMORY_LOG_DIR", "").strip()
    if d:
        base = Path(d)
    else:
        base = Path(tempfile.gettempdir()) / "evoflow-external-memory"
    base.mkdir(parents=True, exist_ok=True)
    return base / "plugin-memory.log"


def _file_logging_disabled() -> bool:
    return os.environ.get("EVOFLOW_EXTERNAL_MEMORY_LOG", "").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    )


def ensure_plugin_memory_file_logging() -> None:
    """幂等：为 ``evoflow.plugin_memory`` 挂单一 FileHandler，不向 root 传播。"""
    global _CONFIGURED
    if _CONFIGURED or _file_logging_disabled():
        return
    path = _log_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
    _AUDIT.addHandler(fh)
    _AUDIT.setLevel(logging.INFO)
    _AUDIT.propagate = False
    _CONFIGURED = True
    _AUDIT.info(
        "plugin_memory_file_logging_started | path=%s",
        str(path.resolve()),
    )


def _short(text: str | None, max_len: int = 400) -> str:
    if text is None:
        return ""
    s = text.replace("\r", " ").replace("\n", "↵")
    if len(s) > max_len:
        return s[: max_len - 3] + "..."
    return s


def pm_event(event: str, **fields: object) -> None:
    """写一条结构化审计行（仅文件，不依赖 console）。"""
    if _file_logging_disabled():
        return
    ensure_plugin_memory_file_logging()
    tail = " ".join(f"{k}={_short(str(v), 800)}" for k, v in fields.items())
    _AUDIT.info("%s | %s", event, tail)
