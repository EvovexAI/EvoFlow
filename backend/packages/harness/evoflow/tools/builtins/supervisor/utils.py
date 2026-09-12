"""Utility and helper functions for supervisor tool.

Provides:
- _runtime_thread_id — extract thread_id from ToolRuntime context
- _dbg_enabled — opt-in noisy debug logs
- _repr_with_invisibles — make whitespace visible in debug logs
- _clamp_progress — clamp value to 0..100 range
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain.tools import ToolRuntime
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)


def _runtime_thread_id(runtime: ToolRuntime[ContextT, dict] | None) -> str | None:
    """Resolve LangGraph thread_id (context → configurable → get_config)."""
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        tid = ctx.get("thread_id")
        if tid:
            return str(tid).strip() or None
    cfg = getattr(runtime, "config", None) or {}
    if isinstance(cfg, dict):
        conf = cfg.get("configurable") or {}
        if isinstance(conf, dict):
            tid = conf.get("thread_id")
            if tid:
                return str(tid).strip() or None
    try:
        from langgraph.config import get_config

        conf = get_config().get("configurable") or {}
        if isinstance(conf, dict):
            tid = conf.get("thread_id")
            if tid:
                return str(tid).strip() or None
    except Exception:
        pass
    return None


def _dbg_enabled(runtime: ToolRuntime[ContextT, dict] | None) -> bool:
    # Opt-in noisy logs via runtime context (preferred) or env var (fallback).
    try:
        ctx = getattr(runtime, "context", None)
        if isinstance(ctx, dict) and "EVOFLOW_SUPERVISOR_DEBUG" in ctx:
            v = ctx.get("EVOFLOW_SUPERVISOR_DEBUG")
            if isinstance(v, bool):
                return v
            return str(v).strip().lower() in {"1", "true", "yes", "on"}
    except Exception:
        pass
    return str(os.getenv("EVOFLOW_SUPERVISOR_DEBUG", "")).strip().lower() in {"1", "true", "yes", "on"}


def _repr_with_invisibles(v: object) -> str:
    # Make whitespace/newlines visible in logs.
    s = "" if v is None else str(v)
    return s.replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t").replace(" ", "\u00b7")


def _clamp_progress(value: int | None) -> int:
    if value is None:
        return 0
    return max(0, min(100, int(value)))


def resolve_supervisor_task_subtask_ids(
    storage: Any,
    runtime: ToolRuntime[ContextT, dict] | None,
    task_id: str | None,
    subtask_id: str | None,
) -> tuple[str | None, str | None]:
    """Fill missing ``task_id`` / ``subtask_id`` from runtime collab context or storage lookup."""
    from evoflow.collab.storage import find_subtask_row_by_id
    from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids

    ctx_main, ctx_sub = _resolve_collab_ids(runtime)
    mid = str(task_id or ctx_main or "").strip() or None
    sid = str(subtask_id or ctx_sub or "").strip() or None

    if sid and not mid:
        found = find_subtask_row_by_id(storage, sid)
        if found is not None:
            _project, main_task, _st = found
            mid = str(main_task.get("id") or "").strip() or None

    if not mid:
        tid = _runtime_thread_id(runtime)
        if tid:
            try:
                from evoflow.collab.thread_collab import load_thread_collab_state
                from evoflow.config.paths import get_paths

                collab = load_thread_collab_state(get_paths(), tid)
                bound = str(getattr(collab, "bound_task_id", None) or "").strip()
                if bound:
                    mid = bound
            except Exception:
                logger.debug("resolve_supervisor_task_subtask_ids: bound_task lookup failed", exc_info=True)

    return mid, sid


__all__ = [
    "_runtime_thread_id",
    "_dbg_enabled",
    "_repr_with_invisibles",
    "_clamp_progress",
    "resolve_supervisor_task_subtask_ids",
]
