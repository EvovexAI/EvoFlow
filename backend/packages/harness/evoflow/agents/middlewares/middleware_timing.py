"""Per-middleware wall-clock timing framework for the lead-agent chain.

Wraps each middleware hook so slow steps surface as::

    [AGENT-TIMING] mw.SessionTranscriptHydration.before_model=42ms

Hooks below ``EVOFLOW_MW_TIMING_MS`` (default **3**) are silent for console.
``wrap_model_call`` / ``wrap_tool_call`` only log **pre-handler** cost
(so vendor TTFT / tool work is not attributed to the middleware).

``before_agent`` / ``abefore_agent`` always persist enter+exit breadcrumbs to the
obs DB (blind-span diagnosis). Nested sync-from-async calls emit once.

Important: wrappers **must preserve the original call signature** (including
named ``runtime``). LangGraph injects ``runtime`` via ``inspect.signature``;
a ``*args, **kwargs``-only wrapper drops that injection and crashes runs with::

    TypeError: ...before_agent() missing 1 required positional argument: 'runtime'
"""

from __future__ import annotations

import functools
import inspect
import os
import time
from collections.abc import Callable
from contextvars import ContextVar
from typing import Any

from langchain.agents.middleware import AgentMiddleware

_MARK = "_evoflow_mw_timing_patched"
_agent_hook_depth: ContextVar[int] = ContextVar("evoflow_mw_agent_hook_depth", default=0)


def _threshold_ms() -> float:
    raw = (os.getenv("EVOFLOW_MW_TIMING_MS") or "3").strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 3.0


def _resolve_tid_trace() -> tuple[str, str | None]:
    try:
        from evoflow.observability.run_latency_trace import read_configurable_trace_fields

        tid, trace_id, _ = read_configurable_trace_fields()
        if tid:
            return tid, trace_id
    except Exception:
        pass
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(conf, dict):
            tid = str(conf.get("thread_id") or "").strip()
            tr = str(conf.get("evf_trace_id") or "").strip() or None
            return tid, tr
    except Exception:
        pass
    return "", None


def _persist_agent_hook(
    *,
    phase: str,
    name: str,
    hook: str,
    seq: int,
    duration_ms: float | None = None,
) -> None:
    tid, trace_id = _resolve_tid_trace()
    if not tid:
        return
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        payload: dict[str, Any] = {
            "mw": name,
            "hook": hook,
            "seq": seq,
            "phase": phase,
        }
        if duration_ms is not None:
            payload["duration_ms"] = round(duration_ms, 2)
        write_run_latency_event(
            tid,
            "mw_hook_enter" if phase == "enter" else "mw_hook_exit",
            payload,
            trace_id=trace_id,
        )
    except Exception:
        pass


def _log(name: str, hook: str, elapsed_ms: float) -> None:
    thr = _threshold_ms()
    persist_agent_hooks = hook in {
        "before_agent",
        "abefore_agent",
        "after_agent",
        "aafter_agent",
    }
    # before/after_agent sit outside the model-cycle clock — persist ≥1ms to obs DB.
    if elapsed_ms < thr and not (persist_agent_hooks and elapsed_ms >= 1.0):
        return
    if elapsed_ms >= thr:
        print(f"[AGENT-TIMING] mw.{name}.{hook}={elapsed_ms:.0f}ms", flush=True)
    try:
        from evoflow.observability.run_latency_trace import record_phase, write_run_latency_event

        # Compact key for pre_model_breakdown phases_ms (optional; no-op before cycle).
        record_phase(f"mw.{name}.{hook}", elapsed_ms)
        if persist_agent_hooks and elapsed_ms >= 1.0:
            tid, trace_id = _resolve_tid_trace()
            if tid:
                write_run_latency_event(
                    tid,
                    "mw_hook",
                    {"mw": name, "hook": hook, "duration_ms": round(elapsed_ms, 2)},
                    trace_id=trace_id,
                )
    except Exception:
        pass


def _hook_overridden(cls: type, attr: str) -> bool:
    base = getattr(AgentMiddleware, attr, None)
    own = getattr(cls, attr, None)
    return own is not None and own is not base


def _preserve_signature(wrapper: Callable[..., Any], orig: Callable[..., Any]) -> Callable[..., Any]:
    """Copy metadata + ``__signature__`` so LangGraph runtime injection still works."""
    functools.update_wrapper(wrapper, orig)
    try:
        wrapper.__signature__ = inspect.signature(orig)  # type: ignore[attr-defined]
    except (TypeError, ValueError):
        pass
    return wrapper


def _patch_sync_hook(
    mw: AgentMiddleware,
    cls: type,
    attr: str,
    label: str,
    *,
    seq: int = -1,
    blind_span: bool = False,
) -> None:
    if not _hook_overridden(cls, attr):
        return
    # Unbound function on the class — keep (self, state, runtime, ...) intact.
    orig = getattr(cls, attr)

    def timed(*args: Any, **kwargs: Any) -> Any:
        depth = _agent_hook_depth.get()
        token = _agent_hook_depth.set(depth + 1)
        outer = blind_span and depth == 0
        if outer:
            _persist_agent_hook(phase="enter", name=mw.name, hook=label, seq=seq)
        t0 = time.perf_counter()
        try:
            return orig(*args, **kwargs)
        finally:
            elapsed = (time.perf_counter() - t0) * 1000.0
            try:
                if outer:
                    _persist_agent_hook(
                        phase="exit",
                        name=mw.name,
                        hook=label,
                        seq=seq,
                        duration_ms=elapsed,
                    )
                _log(mw.name, label, elapsed)
            finally:
                _agent_hook_depth.reset(token)

    _preserve_signature(timed, orig)
    object.__setattr__(mw, attr, timed.__get__(mw, cls))


def _patch_async_hook(
    mw: AgentMiddleware,
    cls: type,
    attr: str,
    label: str,
    *,
    seq: int = -1,
    blind_span: bool = False,
) -> None:
    if not _hook_overridden(cls, attr):
        return
    orig = getattr(cls, attr)

    async def timed(*args: Any, **kwargs: Any) -> Any:
        depth = _agent_hook_depth.get()
        token = _agent_hook_depth.set(depth + 1)
        outer = blind_span and depth == 0
        if outer:
            _persist_agent_hook(phase="enter", name=mw.name, hook=label, seq=seq)
        t0 = time.perf_counter()
        try:
            return await orig(*args, **kwargs)
        finally:
            elapsed = (time.perf_counter() - t0) * 1000.0
            try:
                if outer:
                    _persist_agent_hook(
                        phase="exit",
                        name=mw.name,
                        hook=label,
                        seq=seq,
                        duration_ms=elapsed,
                    )
                _log(mw.name, label, elapsed)
            finally:
                _agent_hook_depth.reset(token)

    _preserve_signature(timed, orig)
    object.__setattr__(mw, attr, timed.__get__(mw, cls))


def _patch_wrap_sync(mw: AgentMiddleware, cls: type, attr: str, label: str) -> None:
    """Time only middleware work before it calls ``handler`` (vendor/tool excluded)."""
    if not _hook_overridden(cls, attr):
        return
    orig = getattr(cls, attr)

    def timed(self: Any, request: Any, handler: Any, *args: Any, **kwargs: Any) -> Any:
        t0 = time.perf_counter()
        pre_logged = False

        def timed_handler(*h_args: Any, **h_kwargs: Any) -> Any:
            nonlocal pre_logged
            if not pre_logged:
                _log(mw.name, f"{label}.pre", (time.perf_counter() - t0) * 1000.0)
                pre_logged = True
            return handler(*h_args, **h_kwargs)

        return orig(self, request, timed_handler, *args, **kwargs)

    _preserve_signature(timed, orig)
    object.__setattr__(mw, attr, timed.__get__(mw, cls))


def _patch_wrap_async(mw: AgentMiddleware, cls: type, attr: str, label: str) -> None:
    if not _hook_overridden(cls, attr):
        return
    orig = getattr(cls, attr)

    async def timed(self: Any, request: Any, handler: Any, *args: Any, **kwargs: Any) -> Any:
        t0 = time.perf_counter()
        pre_logged = False

        async def timed_handler(*h_args: Any, **h_kwargs: Any) -> Any:
            nonlocal pre_logged
            if not pre_logged:
                _log(mw.name, f"{label}.pre", (time.perf_counter() - t0) * 1000.0)
                pre_logged = True
            return await handler(*h_args, **h_kwargs)

        return await orig(self, request, timed_handler, *args, **kwargs)

    _preserve_signature(timed, orig)
    object.__setattr__(mw, attr, timed.__get__(mw, cls))


def instrument_middleware_timing(middlewares: list[AgentMiddleware]) -> None:
    """Attach timing wrappers to every middleware instance (idempotent)."""
    if not middlewares:
        return
    # Opt-out: EVOFLOW_MW_TIMING_MS=-1 / off / false disables patching.
    raw = (os.getenv("EVOFLOW_MW_TIMING_MS") or "3").strip()
    if raw in ("-1", "off", "false", "OFF", "False"):
        return

    for seq, mw in enumerate(middlewares):
        if getattr(mw, _MARK, False):
            continue
        cls = type(mw)
        try:
            _patch_sync_hook(mw, cls, "before_agent", "before_agent", seq=seq, blind_span=True)
            _patch_async_hook(mw, cls, "abefore_agent", "abefore_agent", seq=seq, blind_span=True)
            _patch_sync_hook(mw, cls, "after_agent", "after_agent")
            _patch_async_hook(mw, cls, "aafter_agent", "aafter_agent")
            _patch_sync_hook(mw, cls, "before_model", "before_model")
            _patch_async_hook(mw, cls, "abefore_model", "abefore_model")
            _patch_sync_hook(mw, cls, "after_model", "after_model")
            _patch_async_hook(mw, cls, "aafter_model", "aafter_model")
            _patch_wrap_sync(mw, cls, "wrap_model_call", "wrap_model_call")
            _patch_wrap_async(mw, cls, "awrap_model_call", "awrap_model_call")
            _patch_wrap_sync(mw, cls, "wrap_tool_call", "wrap_tool_call")
            _patch_wrap_async(mw, cls, "awrap_tool_call", "awrap_tool_call")
            object.__setattr__(mw, _MARK, True)
        except Exception:
            # Timing must never break the agent graph.
            pass
