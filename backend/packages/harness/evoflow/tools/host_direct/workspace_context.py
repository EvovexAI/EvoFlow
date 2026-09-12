"""Resolve workspace root / thread_id for host-direct tools (lead + subagent)."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from evoflow.collab.thread_ids import is_collab_executor_thread, lead_thread_from_executor_thread

logger = logging.getLogger(__name__)


def _clean_workspace_root(raw: object) -> str:
    s = str(raw or "").strip()
    if not s or "MagicMock" in s or s.startswith("<"):
        return ""
    return s


def thread_use_virtual_paths(thread_id: str | None) -> bool:
    """Whether the chat session bound to *thread_id* uses virtual /mnt sandbox paths."""
    tid = str(thread_id or "").strip()
    if not tid or is_collab_executor_thread(tid):
        return False
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id, get_session_row_for_ui

        session_key = find_session_key_by_thread_id(tid)
        if not session_key:
            return False
        row = get_session_row_for_ui(session_key)
        if not row:
            return False
        ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
        uvp = ctx.get("use_virtual_paths")
        if isinstance(uvp, bool):
            return uvp
        return bool(row.get("useVirtualPaths"))
    except Exception as exc:
        logger.debug("workspace: use_virtual_paths lookup failed for thread_id=%s: %s", tid, exc)
        return False


def evoflow_home_project_root() -> str:
    """Host project root for default local mode (never ``threads/{id}``).

    When Tauri sets ``EVOFLOW_HOME`` to ``<userWorkspaceRoot>/data``, return
    ``<userWorkspaceRoot>`` so ``outputs/`` maps to ``{root}/outputs/``.
    """
    from evoflow.config.paths import get_paths

    raw = os.getenv("EVOFLOW_HOME", "").strip()
    if not raw:
        return str(get_paths().base_dir)
    norm = raw.replace("\\", "/").rstrip("/")
    lower = norm.lower()
    if lower.endswith("/workspace/data"):
        return norm[: -len("/workspace/data")]
    if lower.endswith("/data"):
        return norm[: -len("/data")]
    return raw


def resolve_host_workspace_root_for_files(*, thread_id: str | None = None) -> str | None:
    """Resolve host workspace root for EvoPanel file APIs and code index.

    Priority: session ``local_workspace_root`` → :func:`evoflow_home_project_root` (``~/.evoflow``
    or parent of ``EVOFLOW_HOME``). Does **not** default to ``threads/{thread_id}/user-data``.
    """
    tid = str(thread_id or "").strip() or None
    if tid:
        bound = load_local_workspace_root_for_thread(tid)
        if bound:
            return bound
    return evoflow_home_project_root()


def load_local_workspace_root_for_thread(thread_id: str | None) -> str:
    """Read ``local_workspace_root`` from ``evoflow_chat_sessions`` (sidebar binding), not EVOFLOW_HOME."""
    tid = str(thread_id or "").strip()
    if not tid or is_collab_executor_thread(tid):
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id, get_session_row_for_ui

        session_key = find_session_key_by_thread_id(tid)
        if not session_key:
            return ""
        row = get_session_row_for_ui(session_key)
        if not row:
            return ""
        ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
        root = str(ctx.get("local_workspace_root") or row.get("localWorkspaceRoot") or "").strip()
        if root:
            logger.debug("workspace: loaded local_workspace_root=%s for thread_id=%s", root, tid)
        return root
    except Exception as exc:
        logger.debug("workspace: session DB lookup failed for thread_id=%s: %s", tid, exc)
        return ""


def resolve_tool_workspace_root(
    *,
    runtime: Any = None,
    parent_thread_id: str | None = None,
) -> tuple[str, str | None]:
    """Session ``local_workspace_root``: runtime context → configurable → session DB (not tool args / not EVOFLOW_HOME)."""
    root = ""
    thread_id: str | None = None

    ctx = getattr(runtime, "context", None) if runtime is not None else None
    if ctx is not None and hasattr(ctx, "get"):
        if not root:
            root = _clean_workspace_root(ctx.get("local_workspace_root"))
        thread_id = str(ctx.get("thread_id") or "").strip() or None
        if not parent_thread_id:
            parent_thread_id = str(ctx.get("parent_thread_id") or "").strip() or None

    if runtime is not None:
        try:
            cfg = getattr(runtime, "config", None) or {}
            if isinstance(cfg, dict):
                conf = cfg.get("configurable") or {}
                if isinstance(conf, dict):
                    if not root:
                        root = _clean_workspace_root(conf.get("local_workspace_root"))
                    if not thread_id:
                        thread_id = str(conf.get("thread_id") or "").strip() or None
                    if not parent_thread_id:
                        parent_thread_id = str(conf.get("parent_thread_id") or "").strip() or None
        except Exception:
            pass

    if not root or not thread_id:
        try:
            from langgraph.config import get_config

            gconf = (get_config() or {}).get("configurable") or {}
            if isinstance(gconf, dict):
                if not root:
                    root = _clean_workspace_root(gconf.get("local_workspace_root"))
                if not thread_id:
                    thread_id = str(gconf.get("thread_id") or "").strip() or thread_id
                if not parent_thread_id:
                    parent_thread_id = str(gconf.get("parent_thread_id") or "").strip() or None
        except Exception:
            pass

    if not root:
        lookup_tid = str(parent_thread_id or "").strip()
        if not lookup_tid and thread_id:
            lookup_tid = lead_thread_from_executor_thread(thread_id) or (
                str(thread_id).strip() if not is_collab_executor_thread(thread_id) else ""
            )
        root = _clean_workspace_root(load_local_workspace_root_for_thread(lookup_tid))

    return root, thread_id


def runtime_use_virtual_paths(runtime: Any = None) -> bool:
    """Whether the session prefers virtual /mnt paths (default False = LOCAL_HOST)."""
    if runtime is None:
        return False
    ctx = getattr(runtime, "context", None)
    if ctx is not None and hasattr(ctx, "get"):
        val = ctx.get("use_virtual_paths")
        if isinstance(val, bool):
            return val
    try:
        cfg = getattr(runtime, "config", None) or {}
        if isinstance(cfg, dict):
            conf = cfg.get("configurable") or {}
            if isinstance(conf, dict):
                val = conf.get("use_virtual_paths")
                if isinstance(val, bool):
                    return val
    except Exception:
        pass
    try:
        from langgraph.config import get_config

        gconf = (get_config() or {}).get("configurable") or {}
        if isinstance(gconf, dict):
            val = gconf.get("use_virtual_paths")
            if isinstance(val, bool):
                return val
    except Exception:
        pass
    return False


def _host_outputs_root_for_runtime(*, runtime: Any = None) -> str:
    """Bound session folder, else global ``~/.evoflow`` — never implicit ``threads/{id}``."""
    root, tid = resolve_tool_workspace_root(runtime=runtime)
    if not root and tid:
        root = load_local_workspace_root_for_thread(str(tid))
    if not root:
        root = evoflow_home_project_root()
    return str(root or "").strip()


def bound_workspace_thread_paths(
    sandbox_paths: dict[str, str],
    *,
    runtime: Any = None,
) -> dict[str, str]:
    """Map thread_data to bound host root or ``~/.evoflow/{workspace,uploads,outputs}``."""
    root = _host_outputs_root_for_runtime(runtime=runtime)
    if not root:
        return sandbox_paths
    root_path = Path(root).expanduser().resolve()
    uploads = root_path / "uploads"
    outputs = root_path / "outputs"
    uploads.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)
    return {
        "workspace_path": str(root_path),
        "uploads_path": str(uploads.resolve()),
        "outputs_path": str(outputs.resolve()),
    }


def resolve_effective_outputs_dir(*, runtime: Any = None) -> Path | None:
    """Outputs directory for media downloads: bound or ``~/.evoflow/outputs``."""
    root = _host_outputs_root_for_runtime(runtime=runtime)
    if root:
        out = Path(root).expanduser().resolve() / "outputs"
        out.mkdir(parents=True, exist_ok=True)
        return out.resolve()

    if runtime is None:
        return None
    state = getattr(runtime, "state", None)
    if state is None or not hasattr(state, "get"):
        return None
    thread_data = state.get("thread_data") or {}
    raw = thread_data.get("outputs_path")
    if not raw:
        return None
    return Path(str(raw)).resolve()
