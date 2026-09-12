"""Instrument LangGraph API path that sits in make_lead → before_agent blind time.

Patches (applied once at Gateway LG lifespan):

- ``langgraph_api.graph.get_graph`` **and** ``langgraph_api.stream.get_graph``
  (stream does ``from langgraph_api.graph import get_graph`` — patching only the
  graph module leaves stream holding the unbound original)
- ``langgraph.pregel.Pregel.copy`` — per-run copy+revalidate cost
- ``langgraph_api.stream.astream_state`` — enter / first non-metadata chunk

Also wraps a compiled Pregel so ``astream`` / ``astream_events`` / ``ainvoke`` emit
``graph_stream_*`` even if the stream helper path changes.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

_PATCHED = False
_GRAPH_MARK = "_evoflow_blind_span_wrapped"


def _tid_from_config(config: Any) -> tuple[str, str | None]:
    conf: dict[str, Any] = {}
    if isinstance(config, dict):
        raw = config.get("configurable")
        if isinstance(raw, dict):
            conf = raw
    tid = str(conf.get("thread_id") or "").strip()
    tr = str(conf.get("evf_trace_id") or "").strip() or None
    return tid, tr


def _tid_from_run(run: Any) -> tuple[str, str | None, str]:
    kwargs = (run.get("kwargs") or {}) if isinstance(run, dict) else {}
    cfg = kwargs.get("config") if isinstance(kwargs, dict) else {}
    tid, tr = _tid_from_config(cfg)
    if not tid and isinstance(run, dict):
        tid = str(run.get("thread_id") or "").strip()
    rid = str((run.get("run_id") if isinstance(run, dict) else "") or "").strip()
    return tid, tr, rid


def _write(tid: str, event: str, payload: dict[str, Any] | None = None, *, trace_id: str | None = None) -> None:
    if not tid:
        return
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        write_run_latency_event(tid, event, payload or {}, trace_id=trace_id)
    except Exception:
        pass


def wrap_compiled_graph_for_blind_span(graph: Any, *, thread_id: str = "", trace_id: str | None = None) -> Any:
    """Attach stream/invoke enter+first-yield markers on a compiled graph instance.

    ``thread_id`` / ``trace_id`` are optional fallbacks; wrappers prefer the live
    RunnableConfig passed into astream/ainvoke (cached graphs are shared).
    """
    if graph is None:
        return graph
    if getattr(graph, _GRAPH_MARK, False):
        return graph

    def _resolve_live(args: tuple[Any, ...], kwargs: dict[str, Any]) -> tuple[str, str | None]:
        cfg = kwargs.get("config")
        if cfg is None and len(args) >= 2:
            cfg = args[1]
        tid, tr = _tid_from_config(cfg)
        return tid or thread_id, tr or trace_id

    def _wrap_async_gen(method_name: str, orig: Callable[..., Any]) -> Callable[..., Any]:
        async def wrapped(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
            tid, tr = _resolve_live(args, kwargs)
            t0 = time.perf_counter()
            _write(tid, "graph_stream_enter", {"method": method_name}, trace_id=tr)
            first = True
            try:
                async for item in orig(*args, **kwargs):
                    if first:
                        first = False
                        _write(
                            tid,
                            "graph_stream_first_yield",
                            {
                                "method": method_name,
                                "since_enter_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                            },
                            trace_id=tr,
                        )
                    yield item
            finally:
                _write(
                    tid,
                    "graph_stream_exit",
                    {
                        "method": method_name,
                        "total_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                        "yielded": not first,
                    },
                    trace_id=tr,
                )

        return wrapped

    def _wrap_async_fn(method_name: str, orig: Callable[..., Any]) -> Callable[..., Any]:
        async def wrapped(*args: Any, **kwargs: Any) -> Any:
            tid, tr = _resolve_live(args, kwargs)
            t0 = time.perf_counter()
            _write(tid, "graph_stream_enter", {"method": method_name}, trace_id=tr)
            try:
                return await orig(*args, **kwargs)
            finally:
                _write(
                    tid,
                    "graph_stream_exit",
                    {
                        "method": method_name,
                        "total_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                    },
                    trace_id=tr,
                )

        return wrapped

    for name in ("astream", "astream_events"):
        orig = getattr(graph, name, None)
        if callable(orig):
            try:
                object.__setattr__(graph, name, _wrap_async_gen(name, orig))
            except Exception:
                pass
    for name in ("ainvoke",):
        orig = getattr(graph, name, None)
        if callable(orig):
            try:
                object.__setattr__(graph, name, _wrap_async_fn(name, orig))
            except Exception:
                pass
    try:
        object.__setattr__(graph, _GRAPH_MARK, True)
    except Exception:
        setattr(graph, _GRAPH_MARK, True)
    return graph


def _patch_on_chain_start() -> bool:
    """Time LangChain AsyncCallbackManager.on_chain_start (LangSmith / callbacks)."""
    try:
        from langchain_core.callbacks.manager import AsyncCallbackManager
    except Exception:
        return False
    orig = AsyncCallbackManager.on_chain_start
    if getattr(orig, "_evoflow_blind_span_ocs", False):
        return True

    async def _timed_on_chain_start(self: Any, *args: Any, **kwargs: Any) -> Any:
        tid = ""
        tr = None
        try:
            from langgraph_api.utils.config import var_child_runnable_config

            cfg = var_child_runnable_config.get() if var_child_runnable_config is not None else None
            tid, tr = _tid_from_config(cfg)
        except Exception:
            pass
        if not tid:
            # fallback: run config often in kwargs / self
            try:
                meta = getattr(self, "metadata", None) or {}
                tid = str(meta.get("thread_id") or "").strip()
            except Exception:
                pass
        t0 = time.perf_counter()
        try:
            return await orig(self, *args, **kwargs)
        finally:
            _write(
                tid,
                "on_chain_start",
                {"duration_ms": round((time.perf_counter() - t0) * 1000.0, 2)},
                trace_id=tr,
            )

    _timed_on_chain_start._evoflow_blind_span_ocs = True  # type: ignore[attr-defined]
    AsyncCallbackManager.on_chain_start = _timed_on_chain_start  # type: ignore[method-assign]
    return True


def _patch_pregel_stream_methods() -> bool:
    """Class-level astream/astream_events enter markers (survive Pregel.copy)."""
    try:
        from langgraph.pregel.main import Pregel
    except Exception:
        return False
    if getattr(Pregel.astream, "_evoflow_blind_span_astream", False):
        return True

    _orig_astream = Pregel.astream
    _orig_astream_events = getattr(Pregel, "astream_events", None)

    async def _timed_astream(self: Any, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        tid, tr = _tid_from_config(kwargs.get("config"))
        if not tid and len(args) >= 2:
            tid, tr = _tid_from_config(args[1])
        t0 = time.perf_counter()
        _write(tid, "graph_stream_enter", {"method": "astream", "via": "class"}, trace_id=tr)
        first = True
        try:
            async for item in _orig_astream(self, *args, **kwargs):
                if first:
                    first = False
                    _write(
                        tid,
                        "graph_stream_first_yield",
                        {
                            "method": "astream",
                            "since_enter_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                        },
                        trace_id=tr,
                    )
                yield item
        finally:
            _write(
                tid,
                "graph_stream_exit",
                {
                    "method": "astream",
                    "total_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                    "yielded": not first,
                },
                trace_id=tr,
            )

    _timed_astream._evoflow_blind_span_astream = True  # type: ignore[attr-defined]
    Pregel.astream = _timed_astream  # type: ignore[method-assign]

    if callable(_orig_astream_events):

        async def _timed_astream_events(self: Any, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
            tid, tr = _tid_from_config(kwargs.get("config"))
            if not tid and len(args) >= 2:
                tid, tr = _tid_from_config(args[1])
            t0 = time.perf_counter()
            _write(
                tid,
                "graph_stream_enter",
                {"method": "astream_events", "via": "class"},
                trace_id=tr,
            )
            first = True
            try:
                async for item in _orig_astream_events(self, *args, **kwargs):
                    if first:
                        first = False
                        _write(
                            tid,
                            "graph_stream_first_yield",
                            {
                                "method": "astream_events",
                                "since_enter_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                            },
                            trace_id=tr,
                        )
                    yield item
            finally:
                _write(
                    tid,
                    "graph_stream_exit",
                    {
                        "method": "astream_events",
                        "total_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                        "yielded": not first,
                    },
                    trace_id=tr,
                )

        _timed_astream_events._evoflow_blind_span_astream = True  # type: ignore[attr-defined]
        Pregel.astream_events = _timed_astream_events  # type: ignore[method-assign]

    return True


def _patch_pregel_copy() -> bool:
    """Time Pregel.copy (re-__init__ + validate) which runs on every run after factory."""
    try:
        from langgraph.pregel.main import Pregel
    except Exception:
        return False
    if getattr(Pregel.copy, "_evoflow_blind_span_copy", False):
        return True

    _orig_copy = Pregel.copy

    def _timed_copy(self: Any, update: dict[str, Any] | None = None) -> Any:
        tid = ""
        tr = None
        try:
            from langgraph_api.utils.config import var_child_runnable_config

            cfg = var_child_runnable_config.get() if var_child_runnable_config is not None else None
            tid, tr = _tid_from_config(cfg)
        except Exception:
            pass
        t0 = time.perf_counter()
        out = _orig_copy(self, update)
        ms = round((time.perf_counter() - t0) * 1000.0, 2)
        _write(
            tid,
            "pregel_copy",
            {
                "duration_ms": ms,
                "name": getattr(self, "name", None),
                "node_count": len(getattr(self, "nodes", {}) or {}),
                "update_keys": sorted((update or {}).keys()),
            },
            trace_id=tr,
        )
        return out

    _timed_copy._evoflow_blind_span_copy = True  # type: ignore[attr-defined]
    Pregel.copy = _timed_copy  # type: ignore[method-assign]
    return True


def _patch_context_filter_gap() -> bool:
    """Time the only awaits between get_graph ready and metadata yield."""
    try:
        from langgraph.pregel.main import Pregel
        from langgraph_api import stream as lg_stream
    except Exception:
        return False

    if getattr(Pregel.get_context_jsonschema, "_evoflow_blind_span_jschema", False):
        return True

    _orig_jschema = Pregel.get_context_jsonschema
    _orig_filter = getattr(lg_stream, "_filter_context_by_schema", None)

    def _timed_jschema(self: Any) -> Any:
        tid, tr = "", None
        try:
            from langgraph_api.utils.config import var_child_runnable_config

            cfg = var_child_runnable_config.get() if var_child_runnable_config is not None else None
            tid, tr = _tid_from_config(cfg)
        except Exception:
            pass
        t0 = time.perf_counter()
        try:
            return _orig_jschema(self)
        finally:
            _write(
                tid,
                "context_jsonschema",
                {"duration_ms": round((time.perf_counter() - t0) * 1000.0, 2)},
                trace_id=tr,
            )

    _timed_jschema._evoflow_blind_span_jschema = True  # type: ignore[attr-defined]
    Pregel.get_context_jsonschema = _timed_jschema  # type: ignore[method-assign]

    if callable(_orig_filter):

        async def _timed_filter(context: Any, context_schema: Any) -> Any:
            tid, tr = "", None
            try:
                from langgraph_api.utils.config import var_child_runnable_config

                cfg = var_child_runnable_config.get() if var_child_runnable_config is not None else None
                tid, tr = _tid_from_config(cfg)
            except Exception:
                pass
            n_keys = len(context) if isinstance(context, dict) else -1
            t0 = time.perf_counter()
            try:
                out = await _orig_filter(context, context_schema)
                return out
            finally:
                _write(
                    tid,
                    "context_filter",
                    {
                        "duration_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                        "context_keys": n_keys,
                        "schema_props": (
                            len((context_schema or {}).get("properties") or {})
                            if isinstance(context_schema, dict)
                            else -1
                        ),
                    },
                    trace_id=tr,
                )

        lg_stream._filter_context_by_schema = _timed_filter  # type: ignore[assignment]

    return True


def apply_lg_blind_span_patches() -> bool:
    """Monkey-patch LangGraph API helpers. Idempotent. Returns True if applied."""
    global _PATCHED
    if _PATCHED:
        return True
    try:
        from langgraph_api import graph as lg_graph
        from langgraph_api import stream as lg_stream
    except Exception:
        return False

    _orig_get_graph = lg_graph.get_graph
    _orig_astream_state = lg_stream.astream_state

    @asynccontextmanager
    async def _patched_get_graph(graph_id: str, config: Any, **kwargs: Any):
        tid, tr = _tid_from_config(config)
        t0 = time.perf_counter()
        _write(tid, "lg_get_graph_enter", {"graph_id": str(graph_id)}, trace_id=tr)
        async with _orig_get_graph(graph_id, config, **kwargs) as graph_obj:
            # Context manager yields AFTER factory + Pregel.copy inside orig get_graph.
            ready_ms = round((time.perf_counter() - t0) * 1000.0, 2)
            try:
                wrap_compiled_graph_for_blind_span(graph_obj, thread_id=tid, trace_id=tr)
            except Exception:
                pass
            _write(
                tid,
                "lg_get_graph_ready",
                {
                    "graph_id": str(graph_id),
                    "factory_to_ready_ms": ready_ms,
                    "graph_type": type(graph_obj).__name__,
                },
                trace_id=tr,
            )
            try:
                yield graph_obj
            finally:
                _write(
                    tid,
                    "lg_get_graph_exit",
                    {
                        "graph_id": str(graph_id),
                        "total_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                    },
                    trace_id=tr,
                )

    async def _patched_astream_state(run: Any, attempt: int, done: Any, **kwargs: Any):
        tid, tr, rid = _tid_from_run(run)
        t0 = time.perf_counter()
        _write(
            tid,
            "lg_astream_state_enter",
            {"attempt": attempt, "run_id": rid or None},
            trace_id=tr,
        )
        first_data = True
        meta_seen = False
        t_meta: float | None = None
        try:
            async for item in _orig_astream_state(run, attempt, done, **kwargs):
                mode = item[0] if isinstance(item, tuple) and item else None
                if mode == "metadata" and not meta_seen:
                    meta_seen = True
                    t_meta = time.perf_counter()
                    _write(
                        tid,
                        "lg_astream_metadata_yield",
                        {
                            "since_enter_ms": round((t_meta - t0) * 1000.0, 2),
                            "run_id": rid or None,
                        },
                        trace_id=tr,
                    )
                if first_data and mode != "metadata":
                    first_data = False
                    now = time.perf_counter()
                    _write(
                        tid,
                        "lg_astream_state_first_data",
                        {
                            "mode": str(mode) if mode is not None else None,
                            "since_enter_ms": round((now - t0) * 1000.0, 2),
                            "since_metadata_ms": (
                                round((now - t_meta) * 1000.0, 2) if t_meta is not None else None
                            ),
                            "run_id": rid or None,
                        },
                        trace_id=tr,
                    )
                yield item
        finally:
            _write(
                tid,
                "lg_astream_state_exit",
                {
                    "total_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                    "run_id": rid or None,
                },
                trace_id=tr,
            )

    lg_graph.get_graph = _patched_get_graph  # type: ignore[assignment]
    # CRITICAL: stream imported get_graph by name — must rebind there too.
    lg_stream.get_graph = _patched_get_graph  # type: ignore[assignment]
    lg_stream.astream_state = _patched_astream_state  # type: ignore[assignment]
    _patch_pregel_copy()
    _patch_pregel_stream_methods()
    _patch_on_chain_start()
    _patch_context_filter_gap()
    _PATCHED = True
    return True
