"""Windows LangGraph runtime fixes for long runs (httpx stream teardown + isolated loops).

Symptom: model HTTP 200, then ``RuntimeError: Event loop is closed`` during streaming
response cleanup — often after multi-minute plan/supervisor runs on Windows.

Mitigations (idempotent, safe to call multiple times):
1. ``WindowsSelectorEventLoopPolicy`` on the main process (httpx/OpenAI streaming).
2. Unless ``EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS=1`` (Gateway in-process default for
   multi-session job isolation), force ``BG_JOB_ISOLATED_LOOPS=false`` on
   Windows so long httpx streams are not torn down mid-flight on isolated loops.
3. Patch ``httpx.Response.aclose`` to swallow closed-loop teardown errors.
4. Loop exception handler: downgrade SSE/client disconnect noise
   (``ConnectionResetError`` / WinError 10054 from ``_call_connection_lost``).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
import weakref
from typing import Any

logger = logging.getLogger(__name__)

_APPLIED = False
_DISCONNECT_HANDLER_LOOPS: weakref.WeakSet[asyncio.AbstractEventLoop] = weakref.WeakSet()


def _windows_selector_event_loop_enabled() -> bool:
    raw = os.environ.get("EVOFLOW_WIN_SELECTOR_EVENT_LOOP", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _apply_windows_selector_event_loop_policy() -> None:
    if sys.platform != "win32" or not _windows_selector_event_loop_enabled():
        return
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        logger.debug("WindowsSelectorEventLoopPolicy unavailable", exc_info=True)


def _force_bg_job_isolated_loops_off_on_windows() -> None:
    """Per-run isolated loops on Windows tear down httpx streams mid-flight on long runs."""
    if sys.platform != "win32":
        return
    force = os.environ.get("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS", "").strip().lower()
    if force in ("1", "true", "yes", "on"):
        return
    prev = os.environ.get("BG_JOB_ISOLATED_LOOPS", "")
    if prev.strip().lower() in ("0", "false", "no", "off", ""):
        os.environ["BG_JOB_ISOLATED_LOOPS"] = "false"
        return
    os.environ["BG_JOB_ISOLATED_LOOPS"] = "false"
    logger.warning(
        "Windows long-run stability: forced BG_JOB_ISOLATED_LOOPS=false (was %r). "
        "Set EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS=1 to keep isolated loops anyway.",
        prev,
    )


def _patch_httpx_response_aclose() -> None:
    try:
        import httpx
    except ImportError:
        return
    Response = httpx.Response
    if getattr(Response, "_evoflow_aclose_patched", False):
        return
    original = Response.aclose

    async def _safe_aclose(self: Any) -> None:
        try:
            loop = asyncio.get_running_loop()
            if loop.is_closed():
                logger.debug("httpx Response.aclose skipped (running loop already closed)")
                return
        except RuntimeError:
            pass
        try:
            await original(self)
        except RuntimeError as exc:
            if is_event_loop_closed_runtime_error(exc):
                logger.debug("httpx Response.aclose ignored closed event loop")
                return
            raise

    Response.aclose = _safe_aclose  # type: ignore[method-assign]
    Response._evoflow_aclose_patched = True


def is_event_loop_closed_runtime_error(exc: BaseException) -> bool:
    if not isinstance(exc, RuntimeError):
        return False
    msg = str(exc).lower()
    return (
        "event loop is closed" in msg
        or "loop is closed" in msg
        or "bound to a different event loop" in msg
    )


def is_benign_client_disconnect_error(exc: BaseException | None) -> bool:
    """True for expected peer-close errors (SSE/client abort), especially on Windows."""
    if exc is None:
        return False
    if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
        return True
    if isinstance(exc, OSError):
        winerror = getattr(exc, "winerror", None)
        # 995 ERROR_OPERATION_ABORTED (thread exit / app request during shutdown poll)
        # 10054 WSAECONNRESET, 10053 WSAECONNABORTED
        if winerror in (995, 10054, 10053):
            return True
        errno = getattr(exc, "errno", None)
        # Linux ECONNRESET=104; macOS ECONNRESET=54; some stacks surface WinError as errno
        if errno in (104, 54, 10054, 10053, 995):
            return True
    return False


def is_benign_asyncio_shutdown_error(exc: BaseException | None) -> bool:
    """True for Windows SelectorEventLoop teardown races (WinError 995 / InvalidStateError)."""
    if exc is None:
        return False
    if isinstance(exc, asyncio.InvalidStateError):
        return True
    if is_benign_client_disconnect_error(exc):
        return True
    if isinstance(exc, RuntimeError) and is_event_loop_closed_runtime_error(exc):
        return True
    cause = exc.__cause__
    if isinstance(cause, BaseException) and cause is not exc:
        if is_benign_asyncio_shutdown_error(cause):
            return True
    context = exc.__context__
    if isinstance(context, BaseException) and context is not exc and context is not cause:
        if is_benign_asyncio_shutdown_error(context):
            return True
    return False


def install_asyncio_benign_disconnect_handler(
    loop: asyncio.AbstractEventLoop | None = None,
) -> bool:
    """Downgrade Proactor/SSE disconnect callbacks from ERROR to debug (idempotent per loop)."""
    if sys.platform != "win32":
        return False
    try:
        target = loop if loop is not None else asyncio.get_running_loop()
    except RuntimeError:
        return False
    if target in _DISCONNECT_HANDLER_LOOPS:
        return False

    previous = target.get_exception_handler()

    def _handler(handler_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if isinstance(exc, BaseException) and is_benign_asyncio_shutdown_error(exc):
            logger.debug(
                "Ignored benign asyncio shutdown/disconnect (%s): %s",
                type(exc).__name__,
                context.get("message") or exc,
            )
            return
        message = str(context.get("message") or "")
        if "connection_lost" in message and is_benign_client_disconnect_error(
            exc if isinstance(exc, BaseException) else None
        ):
            logger.debug("Ignored connection_lost disconnect: %s", message)
            return
        if previous is not None:
            previous(handler_loop, context)
        else:
            handler_loop.default_exception_handler(context)

    target.set_exception_handler(_handler)
    _DISCONNECT_HANDLER_LOOPS.add(target)
    return True


def claude_session_subprocess_supported() -> bool:
    """Whether ``asyncio`` subprocess spawn works in the current (or next) loop on this OS.

    EvoFlow sets ``WindowsSelectorEventLoopPolicy`` on Windows for httpx streaming stability.
    Selector loops cannot run ``asyncio.create_subprocess_exec``, which ``claude_agent_sdk``
    requires to launch Claude Code CLI.
    """
    if sys.platform != "win32":
        return True
    if not _windows_selector_event_loop_enabled():
        return True
    policy = asyncio.get_event_loop_policy()
    if type(policy).__name__ == "WindowsSelectorEventLoopPolicy":
        try:
            loop = asyncio.get_running_loop()
            # A dedicated worker may switch to Proactor for one-off subprocess work.
            return type(loop).__name__ != "SelectorEventLoop"
        except RuntimeError:
            return False
    try:
        loop = asyncio.get_running_loop()
        return type(loop).__name__ != "SelectorEventLoop"
    except RuntimeError:
        return True


def is_subprocess_spawn_runtime_error(exc: BaseException) -> bool:
    """True when failure is due to asyncio subprocess unsupported on this event loop."""
    if isinstance(exc, NotImplementedError):
        return True
    cur: BaseException | None = exc
    seen: set[int] = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, NotImplementedError):
            return True
        msg = str(cur).lower()
        if "failed to start claude code" in msg or "cliconnectionerror" in msg:
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def run_coroutine_factory_on_subprocess_safe_loop(factory: Any) -> Any:
    """Run an async factory on a fresh Windows Proactor loop (subprocess-safe)."""
    import concurrent.futures

    def _worker() -> Any:
        if sys.platform == "win32":
            try:
                asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
            except AttributeError:
                pass
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(factory())
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            try:
                loop.run_until_complete(loop.shutdown_default_executor())
            except Exception:
                pass
            loop.close()
            asyncio.set_event_loop(None)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="subprocess-loop-") as pool:
        return pool.submit(_worker).result()


def run_uvicorn_with_windows_shutdown_guard(run_callable: Any) -> None:
    """Run ``uvicorn.run(...)``; swallow benign Windows asyncio teardown races."""
    try:
        run_callable()
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as exc:
        if is_benign_asyncio_shutdown_error(exc):
            logger.debug("Ignored benign Windows gateway shutdown I/O race: %r", exc)
            return
        raise


async def serve_uvicorn_config(config: Any) -> None:
    """``await server.serve()`` with disconnect/shutdown handler installed on the loop."""
    import uvicorn

    install_asyncio_benign_disconnect_handler(asyncio.get_running_loop())
    server = uvicorn.Server(config)
    await server.serve()


def apply_windows_langgraph_runtime_fixes() -> None:
    """Apply Windows asyncio/httpx mitigations (no-op on other platforms)."""
    global _APPLIED
    if sys.platform != "win32":
        return
    _apply_windows_selector_event_loop_policy()
    _force_bg_job_isolated_loops_off_on_windows()
    _patch_httpx_response_aclose()
    # If a loop is already running (e.g. lifespan), install disconnect muffler now.
    install_asyncio_benign_disconnect_handler()
    if not _APPLIED:
        _APPLIED = True
        logger.info(
            "Windows LangGraph runtime fixes active "
            "(selector_loop=%s, BG_JOB_ISOLATED_LOOPS=%s, httpx_aclose_patch=on)",
            _windows_selector_event_loop_enabled(),
            os.environ.get("BG_JOB_ISOLATED_LOOPS", ""),
        )


# ── Clock-jump detection for sleep/wake recovery ──────────────────────

_clock_jump_threshold_s: float = 60.0
_last_wall_clock: float | None = None
_last_monotonic: float | None = None
_httpx_clients_to_reset: list[Any] = []


def register_httpx_client_for_reset(client: Any) -> None:
    """Register an httpx.AsyncClient whose connection pool should be rebuilt
    after a detected sleep/wake clock jump."""
    _httpx_clients_to_reset.append(client)


def check_clock_jump() -> None:
    """Detect system time discontinuity (sleep/wake signal).

    Compares wall-clock progress against monotonic progress. If they diverge
    by more than ``_clock_jump_threshold_s`` seconds, the system likely
    suspended and resumed. In that case, reset registered httpx clients so
    stale TCP connections are not reused.

    Safe to call from periodic tasks (proactive tick, zombie sweeper, etc.).
    No-op on non-Windows platforms.
    """
    if sys.platform != "win32":
        return
    global _last_wall_clock, _last_monotonic

    now_mono = time.monotonic()
    now_wall = time.time()

    if _last_wall_clock is None or _last_monotonic is None:
        _last_wall_clock = now_wall
        _last_monotonic = now_mono
        return

    mono_gap = now_mono - _last_monotonic
    wall_gap = now_wall - _last_wall_clock
    _last_wall_clock = now_wall
    _last_monotonic = now_mono

    # If wall clock advanced significantly more than monotonic (or went backward),
    # the system was likely suspended.
    divergence = abs(wall_gap - mono_gap)
    if divergence > _clock_jump_threshold_s:
        logger.warning(
            "Clock jump detected (divergence=%.1fs) - likely sleep/wake. Resetting httpx clients.",
            divergence,
        )
        _reset_registered_httpx_clients()


def _reset_registered_httpx_clients() -> None:
    """Best-effort reset of all registered httpx clients' connection pools."""
    for client in _httpx_clients_to_reset:
        try:
            # httpx.AsyncClient stores connections in _transport; clearing it
            # forces re-creation on the next request.
            if hasattr(client, "_transport"):
                old_transport = client._transport
                client._transport = None
                # Best-effort close of old transport (may need async context)
                if hasattr(old_transport, "aclose"):
                    try:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            loop.create_task(old_transport.aclose())
                        else:
                            loop.run_until_complete(old_transport.aclose())
                    except Exception:
                        pass
            elif hasattr(client, "_reset_connections"):
                client._reset_connections()
        except Exception:
            logger.debug("httpx client reset failed", exc_info=True)
