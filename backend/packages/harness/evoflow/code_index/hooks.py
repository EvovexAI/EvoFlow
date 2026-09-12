"""Hooks for file-mutating tools → incremental code index updates."""

from __future__ import annotations

import logging
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from evoflow.config.code_index_config import get_code_index_config

logger = logging.getLogger(__name__)

_HOOK_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="code-index-hook")


def _ctx_from_runtime(runtime: Any | None) -> dict[str, Any]:
    if runtime is None:
        return {}
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict) and ctx:
        return dict(ctx)
    if ctx is not None and hasattr(ctx, "get"):
        try:
            keys = ("local_workspace_root", "thread_id", "parent_thread_id")
            bag = {k: ctx.get(k) for k in keys}
            if any(v is not None and str(v).strip() for v in bag.values()):
                return bag
        except Exception:
            pass
    for attr in ("configurable",):
        bag = getattr(runtime, attr, None)
        if isinstance(bag, dict) and bag:
            return dict(bag)
    config = getattr(runtime, "config", None)
    if isinstance(config, dict):
        bag = config.get("configurable")
        if isinstance(bag, dict) and bag:
            return dict(bag)
    return {}


def _guess_workspace_for_path(abs_path: str) -> tuple[str | None, str | None]:
    """Match *abs_path* against indexed workspace roots stored in existing SQLite DBs."""
    try:
        target = Path(abs_path).resolve()
    except OSError:
        return None, None
    base = Path(os.environ.get("EVOFLOW_DATA_DIR", Path.home() / ".evoflow")) / "code_index"
    if not base.is_dir():
        return None, None
    for dbp in base.glob("*.db"):
        try:
            conn = sqlite3.connect(str(dbp))
            row = conn.execute("SELECT value FROM meta WHERE key='root'").fetchone()
            conn.close()
            if not row:
                continue
            wr = Path(str(row[0])).resolve()
            if not wr.is_dir():
                continue
            rel = target.relative_to(wr).as_posix()
            return str(wr), rel
        except (ValueError, OSError, sqlite3.Error):
            continue
    return None, None


def resolve_path_under_workspace(
    abs_path: str,
    *,
    workspace_root: str | None = None,
    thread_id: str | None = None,
) -> tuple[str | None, str | None]:
    """Map absolute *abs_path* to ``(workspace_root, relative_path)`` if under a known root."""
    try:
        target = Path(abs_path).resolve()
    except OSError:
        return None, None

    root_s = str(workspace_root or "").strip()
    if root_s:
        try:
            base = Path(root_s).resolve()
            if base.is_dir():
                rel = target.relative_to(base).as_posix()
                return str(base), rel
        except ValueError:
            pass

    tid = str(thread_id or "").strip()
    if tid:
        try:
            from evoflow.config.paths import get_paths

            base = get_paths().sandbox_work_dir(tid).resolve()
            if base.is_dir():
                rel = target.relative_to(base).as_posix()
                return str(base), rel
        except (ValueError, Exception):
            pass

    return None, None


def _run_index_file(root: str, rel: str, *, deleted: bool) -> None:
    try:
        from evoflow.code_index.store import index_file

        index_file(root, relative_path=rel, thread_id=None, deleted=deleted)
    except Exception as e:
        logger.debug("code_index hook failed for %s/%s: %s", root, rel, e)


def drain_index_hook_pool_for_tests(timeout: float = 10.0) -> None:
    """Block until queued hook jobs finish (tests only)."""
    _HOOK_POOL.submit(lambda: None).result(timeout=timeout)


def notify_file_changed(
    path: str,
    *,
    runtime: Any | None = None,
    workspace_root: str | None = None,
    thread_id: str | None = None,
    deleted: bool = False,
) -> None:
    """Best-effort incremental index update after a tool changes a file."""
    cfg = get_code_index_config()
    if not cfg.enabled or not cfg.incremental_enabled:
        return

    ctx = _ctx_from_runtime(runtime)
    ws = str(workspace_root or ctx.get("local_workspace_root") or "").strip() or None
    tid = str(thread_id or ctx.get("thread_id") or "").strip() or None

    root, rel = resolve_path_under_workspace(path, workspace_root=ws, thread_id=tid)
    if not root or not rel:
        root, rel = _guess_workspace_for_path(path)
    if not root or not rel:
        logger.debug("code_index hook: path outside workspace, skip %s", path)
        return

    # Do not block file tools on sqlite busy_timeout while a full index build holds the DB lock.
    _HOOK_POOL.submit(_run_index_file, root, rel, deleted=deleted)


def notify_tool_result(
    path: str,
    result: str,
    *,
    runtime: Any | None = None,
    workspace_root: str | None = None,
    thread_id: str | None = None,
    deleted: bool = False,
) -> None:
    """Call after host_direct file tools; only runs on successful ``OK:`` results."""
    if not str(result or "").strip().startswith("OK:"):
        return
    try:
        from evoflow.context.file_read_cache import invalidate_path

        invalidate_path(path)
    except Exception:
        pass
    notify_file_changed(
        path,
        runtime=runtime,
        workspace_root=workspace_root,
        thread_id=thread_id,
        deleted=deleted,
    )
