"""Cache for MCP tools to avoid repeated loading."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import threading
from typing import Any

from evoflow.timeutil import utc_now_iso_z

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)

_mcp_tools_cache: list[BaseTool] | None = None
_cache_initialized = False
_config_fingerprint: str | None = None
_mcp_server_status: dict[str, dict[str, Any]] = {}
_mcp_init_error: str | None = None
# 最近一次「本上下文拿不到 MCP 工具」的原因（isolation-loop / 无注册 loop / 初始化失败）。
# 不静默降级：状态快照（mcp/status.py）与 worker 日志都会消费它。
_mcp_unavailable_reason: str | None = None
_thread_init_lock = threading.Lock()
_async_init_lock: asyncio.Lock | None = None
_registered_init_loop: asyncio.AbstractEventLoop | None = None
# Split ``--mode langgraph`` never calls Gateway ``register_mcp_init_loop``.
# Keep a process-local daemon loop so sync/lazy init still works (Issue #106).
_dedicated_init_loop: asyncio.AbstractEventLoop | None = None
_dedicated_init_thread: threading.Thread | None = None
_dedicated_init_lock = threading.Lock()


def _set_unavailable_reason(reason: str) -> None:
    global _mcp_unavailable_reason
    _mcp_unavailable_reason = reason


def mcp_unavailable_reason() -> str | None:
    return _mcp_unavailable_reason


def ensure_dedicated_mcp_init_loop() -> asyncio.AbstractEventLoop:
    """Return a running loop for MCP init (Gateway-registered or process-local).

    Desktop split LangGraph has no Gateway lifespan hook in-process; without this,
    ``get_cached_mcp_tools`` stays cold forever (``mounted_mcp_tools=0``).
    """
    global _dedicated_init_loop, _dedicated_init_thread, _registered_init_loop

    if _registered_init_loop is not None and _registered_init_loop.is_running():
        return _registered_init_loop

    with _dedicated_init_lock:
        if _registered_init_loop is not None and _registered_init_loop.is_running():
            return _registered_init_loop
        if _dedicated_init_loop is not None and _dedicated_init_loop.is_running():
            return _dedicated_init_loop

        ready = threading.Event()
        holder: list[asyncio.AbstractEventLoop] = []
        error_box: list[BaseException] = []

        def _runner() -> None:
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                holder.append(loop)
            except BaseException as exc:  # noqa: BLE001 — surface start failure
                error_box.append(exc)
                ready.set()
                return
            ready.set()
            try:
                loop.run_forever()
            finally:
                with contextlib.suppress(Exception):
                    loop.close()

        thread = threading.Thread(
            target=_runner,
            name="evoflow-mcp-init-loop",
            daemon=True,
        )
        _dedicated_init_thread = thread
        thread.start()
        if not ready.wait(timeout=15.0):
            raise RuntimeError("MCP dedicated init loop failed to start within 15s")
        if error_box:
            raise RuntimeError(f"MCP dedicated init loop failed: {error_box[0]}") from error_box[0]
        if not holder:
            raise RuntimeError("MCP dedicated init loop started without an event loop")
        _dedicated_init_loop = holder[0]
        # Expose as the registered loop so later lazy paths reuse it.
        if _registered_init_loop is None or not _registered_init_loop.is_running():
            _registered_init_loop = _dedicated_init_loop
        logger.info("MCP dedicated init loop started (split LangGraph / CLI fallback)")
        return _dedicated_init_loop


def kick_mcp_tools_warmup_background() -> None:
    """Schedule ``initialize_mcp_tools`` on the dedicated/registered loop (non-blocking)."""
    try:
        loop = ensure_dedicated_mcp_init_loop()
        asyncio.run_coroutine_threadsafe(initialize_mcp_tools(), loop)
    except Exception:
        logger.warning("MCP background warmup kick failed", exc_info=True)


def _get_async_init_lock() -> asyncio.Lock:
    """Create the asyncio lock on the active loop (never at import time).

    If a previous lock was bound to a closed / different loop, recreate it.
    """
    global _async_init_lock
    loop = asyncio.get_running_loop()
    if _async_init_lock is not None:
        bound_id = getattr(_async_init_lock, "_evoflow_loop_id", None)
        if bound_id is not None and bound_id != id(loop):
            _async_init_lock = None
    if _async_init_lock is None:
        lock = asyncio.Lock()
        setattr(lock, "_evoflow_loop_id", id(loop))
        _async_init_lock = lock
    return _async_init_lock


def _init_timeout_sec() -> float:
    timeout_raw = os.environ.get("EVOFLOW_MCP_INIT_TIMEOUT_SEC", "120").strip()
    try:
        return float(timeout_raw)
    except ValueError:
        return 120.0


def _get_config_fingerprint() -> str:
    from evoflow.mcp.tools import mcp_config_fingerprint

    return mcp_config_fingerprint()


def set_mcp_server_load_status(status: dict[str, dict[str, Any]]) -> None:
    """Persist per-server MCP load outcome (ready / error) after initialization."""
    global _mcp_server_status
    _mcp_server_status = dict(status)


def get_mcp_server_load_status() -> dict[str, dict[str, Any]]:
    return dict(_mcp_server_status)


def mcp_cache_config_mtime() -> str | None:
    """Config fingerprint when cache was last built (legacy name kept for API compat)."""
    return _config_fingerprint


def mcp_init_error() -> str | None:
    return _mcp_init_error


def _is_cache_stale() -> bool:
    global _config_fingerprint

    if not _cache_initialized:
        return False

    current = _get_config_fingerprint()
    if _config_fingerprint is None or not current:
        return False

    if current != _config_fingerprint:
        logger.info("MCP config changed since cache was built, cache is stale")
        return True

    return False


def register_mcp_init_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Register the Gateway/LangGraph asyncio loop for off-thread lazy MCP init."""
    global _registered_init_loop
    _registered_init_loop = loop


# ── 跨进程状态快照（mcp-status 假阴性修复，2026-11-07） ──────────────────────
# platform(action='mcp.list') / CLI 与网关 HTTP 服务可能不在同一进程：
# ``_cache_initialized`` 是进程内全局变量，别的进程永远是 False → 假阴性
# 「total_tools=0 / pending」。warmup 完成后把快照写到 mcp.json 同目录，
# 任何进程都能读到「整个系统的 MCP 状态」。读取方用 writer_pid 存活检测
# 区分「网关在跑（信快照）」与「网关已死（降级 unknown，不冒充 ready/pending）」。


def _mcp_snapshot_path():
    from pathlib import Path

    try:
        from evoflow.mcp.tools import _get_mcp_config_path

        cfg = Path(str(_get_mcp_config_path()))
        return cfg.parent / "mcp-status-snapshot.json"
    except Exception:
        return None


def _process_alive(pid: int | None) -> bool:
    """进程存活探测（stdlib-only）：Windows 用 OpenProcess+WaitForSingleObject，POSIX 用 kill 0。"""
    pid = int(pid or 0)
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
        try:
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(PROCESS_SYNCHRONIZE, False, pid)
            if not handle or handle == INVALID_HANDLE_VALUE:
                return False
            try:
                return int(kernel32.WaitForSingleObject(handle, 0)) == WAIT_TIMEOUT
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # 存在但无权发信号 —— 视为存活
    except OSError:
        return False


def persist_mcp_status_snapshot() -> dict[str, Any] | None:
    """把当前 MCP 状态持久化到 mcp.json 同目录（跨进程可读）。best-effort。"""
    path = _mcp_snapshot_path()
    if path is None:
        return None
    tools_by_server: dict[str, list[str]] = {}
    for t in _mcp_tools_cache or []:
        name = str(getattr(t, "name", "") or "").strip()
        if not name:
            continue
        parts = name.split("__")
        server = parts[1] if len(parts) >= 3 and parts[0] == "mcp" else (parts[0] if len(parts) >= 2 else "unknown")
        tools_by_server.setdefault(server, []).append(name)
    payload: dict[str, Any] = {
        "generated_at": utc_now_iso_z(),
        "writer_pid": os.getpid(),
        "cache_initialized": bool(_cache_initialized),
        "total_tools": len(_mcp_tools_cache or []),
        "server_status": get_mcp_server_load_status(),
        "config_fingerprint": _config_fingerprint,
        "init_error": _mcp_init_error,
        "tools_by_server": tools_by_server,
    }
    try:
        import tempfile

        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".mcp-status-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            os.replace(tmp_name, str(path))
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
        return payload
    except Exception:
        logger.debug("persist_mcp_status_snapshot failed", exc_info=True)
        return None


def load_persisted_mcp_status_snapshot(*, require_writer_alive: bool = True) -> dict[str, Any] | None:
    """读取持久化快照；writer 进程已死（或快照超龄）时视为不存在。"""
    path = _mcp_snapshot_path()
    if path is None or not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        logger.debug("load_persisted_mcp_status_snapshot read failed", exc_info=True)
        return None
    if not isinstance(payload, dict):
        return None
    try:
        generated_at = str(payload.get("generated_at") or "")
        # 超龄保护：writer 存活但快照太久没刷新（异常场景兜底），7 天视为失效。
        if generated_at:
            from datetime import datetime, timezone

            age_days = (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
            ).total_seconds() / 86400.0
            if age_days > 7:
                return None
    except Exception:
        pass
    if require_writer_alive and not _process_alive(payload.get("writer_pid")):
        return None
    return payload


def _on_asyncio_loop_thread() -> bool:
    """True when called from a coroutine running on an event-loop thread."""
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def schedule_mcp_tools_warmup() -> asyncio.Task[list[BaseTool]] | None:
    """Schedule non-blocking MCP init on the registered loop (safe at Gateway startup)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return loop.create_task(initialize_mcp_tools(), name="mcp-tools-warmup")


@contextlib.contextmanager
def _suppress_mcp_stdio_parse_noise():
    """browser-tools-mcp prints port-scan lines to stdout; SDK logs benign JSON parse errors."""
    log = logging.getLogger("mcp.client.stdio")
    prev = log.level
    log.setLevel(logging.CRITICAL)
    try:
        yield
    finally:
        log.setLevel(prev)


async def initialize_mcp_tools() -> list[BaseTool]:
    """Initialize and cache MCP tools on the **current running** event loop.

    MCP 工具对象本身经 mcp/pool marshal（会话常驻池专属 loop），**不绑定初始化时
    所在的 loop**——在 gateway 主 loop 或 worker isolated loop 上初始化都安全。
    """
    global _mcp_tools_cache, _cache_initialized, _config_fingerprint, _mcp_init_error, _mcp_server_status

    async with _get_async_init_lock():
        if _cache_initialized:
            logger.info("MCP tools already initialized")
            return _mcp_tools_cache or []

        from evoflow.mcp.tools import get_mcp_tools

        logger.info("Initializing MCP tools...")
        timeout_sec = _init_timeout_sec()
        _mcp_init_error = None
        _mcp_server_status = {}

        try:
            with _suppress_mcp_stdio_parse_noise():
                if timeout_sec > 0:
                    _mcp_tools_cache = await asyncio.wait_for(get_mcp_tools(), timeout=timeout_sec)
                else:
                    _mcp_tools_cache = await get_mcp_tools()
        except TimeoutError:
            _mcp_init_error = f"MCP initialization timed out after {timeout_sec:.0f}s (stdio/network MCP server may be hung)"
            logger.error(
                "%s. Continuing with partial/zero MCP tools. Fix or disable servers in mcp.json, or set EVOFLOW_MCP_INIT_TIMEOUT_SEC.",
                _mcp_init_error,
            )
            _mcp_tools_cache = _mcp_tools_cache or []
        except Exception as exc:
            _mcp_init_error = str(exc)[:500]
            logger.error("MCP tools initialization failed: %s", exc, exc_info=True)
            _mcp_tools_cache = []

        _cache_initialized = True
        _config_fingerprint = _get_config_fingerprint()
        if not _mcp_tools_cache:
            _set_unavailable_reason(
                f"MCP initialization produced 0 tools (init_error={_mcp_init_error or 'none'})"
            )
        else:
            _set_unavailable_reason(None)
        logger.info(
            "MCP tools initialized: %d tool(s) loaded (config fingerprint: %s…)",
            len(_mcp_tools_cache or []),
            (_config_fingerprint or "")[:12],
        )

        # Invalidate the LRU cache on get_available_tools() so that subsequent
        # agent builds pick up the freshly loaded MCP tools. Without this, the
        # stale cache (populated before MCP warmup completed, returning 0 MCP
        # tools) would persist for the entire process lifetime.
        try:
            from evoflow.tools.tools import _cached_resolve_tools

            _cached_resolve_tools.cache_clear()
            logger.info("Cleared _cached_resolve_tools LRU cache after MCP init (%d tools)", len(_mcp_tools_cache or []))
        except Exception:
            logger.debug("Could not clear _cached_resolve_tools LRU cache", exc_info=True)

        # Session/agent tool-name LRU also snapshots MCP before remount; clear it
        # so role mcp_servers bindings see the warm catalog.
        try:
            from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache

            invalidate_agent_tool_names_cache()
            logger.info("Cleared agent tool-names cache after MCP init (%d tools)", len(_mcp_tools_cache or []))
        except Exception:
            logger.debug("Could not clear agent tool-names cache after MCP init", exc_info=True)

        # Also clear the lead-agent graph cache: graphs built before MCP warmup
        # completed may have been compiled without MCP tools, and the graph cache
        # key does not distinguish "has MCP tools" vs "MCP tools not yet loaded".
        try:
            from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache

            clear_lead_agent_graph_cache()
            logger.info("Cleared lead-agent graph cache after MCP init (%d tools)", len(_mcp_tools_cache or []))
        except Exception:
            logger.debug("Could not clear lead-agent graph cache", exc_info=True)

        # 跨进程快照：别的进程（platform 工具 / CLI / LangGraph 进程）读不到本进程
        # 内存缓存——不落盘它们会看到假阴性 total_tools=0 / pending。
        persist_mcp_status_snapshot()

        return _mcp_tools_cache or []


def _sync_initialize_on_loop(loop: asyncio.AbstractEventLoop, timeout_sec: float) -> None:
    """Block until MCP init completes on ``loop`` (must be the LangGraph worker loop)."""
    fut = asyncio.run_coroutine_threadsafe(initialize_mcp_tools(), loop)
    if timeout_sec > 0:
        fut.result(timeout=timeout_sec + 5.0)
    else:
        fut.result()


async def ensure_mcp_tools_ready(timeout_sec: float | None = None) -> list[BaseTool]:
    """Awaitable MCP readiness for **any** event loop (gateway main / worker isolated).

    ``get_cached_mcp_tools`` must return ``[]`` on an asyncio loop thread while the
    cache is cold (blocking there wedged the whole gateway once). Workers on
    isolated loops therefore saw an empty ``mcp_catalog`` forever: no warmup ever
    runs on *their* loop and ``_registered_init_loop`` points elsewhere.

    Fix: run the init coroutine on the **calling** loop. Pool-bound tools marshal
    every call onto the dedicated pool loop, so tool objects created here are safe
    to use from any loop/thread afterwards. Idempotent — concurrent callers share
    the cache via ``_cache_initialized`` (per-loop asyncio locks make a double init
    merely redundant, never inconsistent).

    Never disables ``EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS``; failures are recorded
    via ``mcp_unavailable_reason()`` instead of silently degrading.
    """
    if _is_cache_stale():
        logger.info("MCP cache is stale, resetting for re-initialization (ensure)...")
        reset_mcp_tools_cache()
    if _cache_initialized:
        _set_unavailable_reason_compat_clear()
        return _mcp_tools_cache or []

    timeout = _init_timeout_sec() if timeout_sec is None else float(timeout_sec)
    try:
        if timeout > 0:
            tools = await asyncio.wait_for(initialize_mcp_tools(), timeout=timeout)
        else:
            tools = await initialize_mcp_tools()
        if not tools:
            _set_unavailable_reason(
                "ensure_mcp_tools_ready: initialization returned 0 tools "
                f"(init_error={_mcp_init_error or 'none'})"
            )
        else:
            _set_unavailable_reason(None)
        return tools
    except Exception as e:
        logger.error(
            "ensure_mcp_tools_ready failed on this loop: %s — falling back to warm peek",
            e,
            exc_info=True,
        )
        _set_unavailable_reason(f"ensure_mcp_tools_ready failed: {str(e)[:300]}")
        return peek_cached_mcp_tools()


def _set_unavailable_reason_compat_clear() -> None:
    _set_unavailable_reason(None)


def peek_cached_mcp_tools() -> list[BaseTool]:
    """Return cached MCP tools when init already completed; otherwise ``[]``.

    Unlike :func:`get_cached_mcp_tools`, this never blocks or triggers lazy init —
    safe for Gateway HTTP handlers that run on the asyncio event loop.
    """
    if not _cache_initialized:
        return []
    return _mcp_tools_cache or []


def mcp_cache_initialized() -> bool:
    """Whether MCP tools have been loaded at least once in this process."""
    return _cache_initialized


def get_cached_mcp_tools() -> list[BaseTool]:
    """Return cached MCP tools; lazy-init from a worker thread when possible.

    Never blocks the asyncio event loop: calling this from an ``async`` HTTP handler
    (or any coroutine on the loop thread) returns ``[]`` while the cache is cold.
    Gateway startup should call :func:`schedule_mcp_tools_warmup` instead.
    """
    global _cache_initialized

    if _is_cache_stale():
        logger.info("MCP cache is stale, resetting for re-initialization...")
        reset_mcp_tools_cache()

    if _cache_initialized:
        return _mcp_tools_cache or []

    # NON-BLOCKING: return early on the event loop thread BEFORE acquiring
    # _thread_init_lock. If we waited for the lock here, a worker thread
    # holding it while waiting for this loop (via _sync_initialize_on_loop)
    # would deadlock — see hang-diagnostics/gateway-hang-*.json.
    # Async callers must switch to ``await ensure_mcp_tools_ready()`` — that
    # initializes on the *calling* loop (pool-marshaled tools are loop-agnostic).
    if not _cache_initialized and _on_asyncio_loop_thread():
        # Kick background init (dedicated loop) so the next graph rebuild sees tools.
        # Do not block this loop — Gateway hang history.
        kick_mcp_tools_warmup_background()
        _set_unavailable_reason(
            "get_cached_mcp_tools: cache cold inside asyncio task (use await ensure_mcp_tools_ready())"
        )
        logger.debug(
            "get_cached_mcp_tools: cache cold inside asyncio task; returning []. "
            "Use schedule_mcp_tools_warmup() / await ensure_mcp_tools_ready()."
        )
        return []

    with _thread_init_lock:
        if _cache_initialized:
            _set_unavailable_reason(None)
            return _mcp_tools_cache or []

        loop = _registered_init_loop
        if loop is None or not loop.is_running():
            try:
                loop = ensure_dedicated_mcp_init_loop()
            except Exception as e:
                _set_unavailable_reason(
                    "get_cached_mcp_tools: cache cold and no init loop "
                    f"(dedicated start failed: {str(e)[:200]})"
                )
                logger.warning(
                    "get_cached_mcp_tools: cache cold and no registered init loop; "
                    "dedicated loop start failed: %s",
                    e,
                    exc_info=True,
                )
                return []

        timeout_sec = _init_timeout_sec()
        try:
            _sync_initialize_on_loop(loop, timeout_sec)
        except Exception as e:
            _set_unavailable_reason(f"lazy init on registered loop failed: {str(e)[:300]}")
            logger.error("Failed to lazy-initialize MCP tools on registered loop: %s", e, exc_info=True)
            return []

    _set_unavailable_reason(None)
    return _mcp_tools_cache or []


def reset_mcp_tools_cache() -> None:
    """Reset the MCP tools cache."""
    global _mcp_tools_cache, _cache_initialized, _config_fingerprint, _async_init_lock
    global _mcp_server_status, _mcp_init_error
    _mcp_tools_cache = None
    _cache_initialized = False
    _config_fingerprint = None
    _mcp_server_status = {}
    _mcp_init_error = None
    # 常驻会话一并关闭：下次 initialize 走连接池重建（配置变更/手动重置语义）。
    try:
        from evoflow.mcp.pool import reset_mcp_connection_pool

        reset_mcp_connection_pool()
    except Exception:
        logger.debug("MCP connection pool reset skipped", exc_info=True)
    # annotations 登记随缓存失效：重建 warmup 时重新登记。
    try:
        from evoflow.mcp.annotations import reset_tool_annotations

        reset_tool_annotations()
    except Exception:
        logger.debug("MCP annotations reset skipped", exc_info=True)
    # Do not unconditionally null ``_async_init_lock``: concurrent
    # ``initialize_mcp_tools`` on the same loop must keep sharing one lock.
    # Cross-loop staleness is handled lazily in ``_get_async_init_lock``.
    try:
        loop = asyncio.get_running_loop()
        lock = _async_init_lock
        if lock is not None and getattr(lock, "_evoflow_loop_id", None) != id(loop):
            _async_init_lock = None
    except RuntimeError:
        # No running loop — safe to drop the lock so the next loop recreates it.
        _async_init_lock = None
    logger.info("MCP tools cache reset")
    # Invalidate LRU cache so get_available_tools() rebuilds with fresh MCP tools
    try:
        from evoflow.tools.tools import _cached_resolve_tools

        _cached_resolve_tools.cache_clear()
        logger.info("Cleared _cached_resolve_tools LRU cache on MCP reset")
    except Exception:
        logger.debug("Could not clear _cached_resolve_tools LRU cache on reset", exc_info=True)
    try:
        from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache

        invalidate_agent_tool_names_cache()
    except Exception:
        logger.debug("Could not clear agent tool-names cache on MCP reset", exc_info=True)
    try:
        from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache

        clear_lead_agent_graph_cache()
        logger.info("Cleared lead-agent graph cache on MCP reset")
    except Exception:
        logger.debug("Could not clear lead-agent graph cache on reset", exc_info=True)
    try:
        schedule_mcp_tools_warmup()
    except Exception:
        logger.debug("MCP warmup reschedule skipped after cache reset", exc_info=True)
