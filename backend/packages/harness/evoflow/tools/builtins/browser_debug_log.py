"""Unified browser / plugin control log (one file, three writers).

When debugging dual browser windows / panel fit / navigation, logs used to
scatter across Rust stderr, Python logging, and the frontend console. This
module appends every browser-related line to:

    {evoflow_dir}/logs/plugin-control.log

Writers:
- Rust:  ``browser_cdp_server::log_line`` (window lifecycle / CDP, prefix ``[rust]``)
- Python: :func:`browser_debug_log` (engine / gateway, prefix ``[py]``) and
  :func:`install_browser_debug_mirror` mirroring logging records that mention browser
- Frontend: ``POST /api/browser/log`` (panel / early handlers, prefix ``[web]``)

``evoflow_dir`` matches Rust ``commands::evoflow_dir``:
``EVOFLOW_CONFIG_DIR`` > ``~/.evoflow-dev`` (if present) > ``~/.evoflow``.
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from pathlib import Path

# English name under logs/ (was historically root-level ``插件控制日志.log``).
_FILE_NAME = "plugin-control.log"
_LEGACY_ROOT_NAMES = ("插件控制日志.log", "browser-debug.log")
_WRITE_LOCK = threading.Lock()


def _evoflow_dir() -> Path:
    env = os.environ.get("EVOFLOW_CONFIG_DIR")
    if env:
        return Path(env)
    home = Path(os.path.expanduser("~"))
    debug_dir = home / ".evoflow-dev"
    # Same probe order as browser_engine._resolve_evoflow_dir:
    # debug desktop builds write ~/.evoflow-dev, release writes ~/.evoflow.
    return debug_dir if debug_dir.is_dir() else home / ".evoflow"


def unified_log_path() -> Path:
    """``{evoflow_dir}/logs/plugin-control.log`` (creates ``logs/`` as needed)."""
    return _evoflow_dir() / "logs" / _FILE_NAME


def _migrate_legacy_log(dest: Path) -> None:
    """One-shot: move old root-level Chinese / prior English names into logs/."""
    if dest.exists():
        return
    base = dest.parent.parent
    for name in _LEGACY_ROOT_NAMES:
        legacy = base / name
        if not legacy.is_file():
            continue
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            legacy.replace(dest)
            return
        except OSError:
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(legacy.read_bytes())
                legacy.unlink(missing_ok=True)
            except OSError:
                return


def browser_debug_log(source: str, message: str) -> None:
    """Append one line to the unified log. Failures are silent — logging must not break work."""
    try:
        line = f"{datetime.now().strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3]} [{source}] {message}\n"
        path = unified_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _migrate_legacy_log(path)
        with _WRITE_LOCK:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line)
    except Exception:
        pass


class _BrowserMirrorHandler(logging.Handler):
    """Mirror browser/plugin-related Python logging records into the unified file.

    Match: logger name contains ``browser`` / ``node_repl`` / ``plugins`` / ``cua``,
    or the message text contains ``browser``. ``evoflow.plugins.*`` records are
    plugin-usage events by definition.
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            name = record.name.lower()
            msg = record.getMessage()
            msg_l = msg.lower()
            relevant = (
                "browser" in name
                or "node_repl" in name
                or "plugins" in name
                or "cua" in name
                or "browser" in msg_l
                or "guest poll" in msg_l
                or "webview" in msg_l
                or "hwnd" in msg_l
                or "[browser-ready]" in msg_l
                or "[browser-engine]" in msg_l
            )
            if not relevant:
                return
            browser_debug_log("py", f"{record.name}: {msg}")
        except Exception:
            pass


def _mirror_is_attached() -> bool:
    root = logging.getLogger()
    return any(isinstance(h, _BrowserMirrorHandler) for h in root.handlers)


def install_browser_debug_mirror() -> None:
    """Attach to the root logger. Idempotent and self-healing.

    LangGraph rebuilds the logging tree in lifespan (disable_existing_loggers +
    replace root handlers), which drops this handler and can disable engine
    loggers. Call at startup and from browser route entry points so a missing
    handler or disabled target logger is restored automatically.
    """
    root = logging.getLogger()
    if not _mirror_is_attached():
        root.addHandler(_BrowserMirrorHandler(level=logging.INFO))
    # Gateway root may be WARNING; most engine/bridge browser lines are INFO.
    for name in (
        "evoflow.tools.builtins.browser_engine",
        "app.gateway.routers.browser_bridge",
        "app.gateway.routers.cua_bridge",
        "evoflow.plugins.node_repl",
        "evoflow.plugins.node_repl_tool",
        "evoflow.plugins.service",
        "evoflow.plugins.runtime",
    ):
        logger = logging.getLogger(name)
        if logger.disabled:
            logger.disabled = False
        if logger.getEffectiveLevel() > logging.INFO or logger.level == logging.NOTSET:
            logger.setLevel(logging.INFO)
