"""Best-effort persistence hooks for media tools → ``evoflow_media_assets``."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from langchain.tools import ToolRuntime
from langgraph.typing import ContextT

from evoflow.agents.thread_state import ThreadState

logger = logging.getLogger(__name__)


def thread_id_from_runtime(runtime: ToolRuntime[ContextT, ThreadState] | None) -> str | None:
    if runtime is None:
        return None
    tid = None
    if runtime.context:
        tid = runtime.context.get("thread_id")
    if not tid and runtime.config:
        tid = (runtime.config.get("configurable") or {}).get("thread_id")
    s = str(tid or "").strip()
    return s or None


def _local_file_size(outputs_dir: Path | None, local_rel: str | None) -> int | None:
    if not outputs_dir or not local_rel:
        return None
    rel = str(local_rel).strip().replace("\\", "/")
    if rel.startswith("outputs/"):
        rel = rel[len("outputs/") :]
    try:
        p = outputs_dir / rel
        if p.is_file():
            return p.stat().st_size
    except OSError:
        pass
    return None


def record_task_submitted(
    runtime: ToolRuntime[ContextT, ThreadState] | None,
    *,
    tool_name: str,
    provider: str,
    task_id: str,
    media_kind: str,
    meta: dict[str, Any] | None = None,
) -> None:
    try:
        from evoflow.persistence.media_assets import record_media_asset

        record_media_asset(
            thread_id=thread_id_from_runtime(runtime),
            tool_name=tool_name,
            media_kind=media_kind,
            provider=provider,
            task_id=task_id,
            status="processing",
            meta=meta,
        )
    except Exception:
        logger.debug("record_task_submitted skipped", exc_info=True)


def record_task_completed(
    runtime: ToolRuntime[ContextT, ThreadState] | None,
    *,
    tool_name: str,
    provider: str,
    task_id: str,
    media_kind: str,
    status: str,
    remote_url: str | None = None,
    local_path: str | None = None,
    outputs_dir: Path | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    try:
        from evoflow.persistence.media_assets import record_media_asset, update_media_asset_by_task

        tid = thread_id_from_runtime(runtime)
        size = _local_file_size(outputs_dir, local_path)
        st = "succeeded" if status.lower() in ("succeeded", "success", "completed", "done") else status
        if st.lower() in ("failed", "error", "cancelled"):
            st = "failed"
        updated = update_media_asset_by_task(
            provider=provider,
            task_id=task_id,
            status=st,
            remote_url=remote_url,
            local_path=local_path,
            file_size_bytes=size,
            meta_patch={**(meta or {}), "completed_by": tool_name},
        )
        if not updated:
            record_media_asset(
                thread_id=tid,
                tool_name=tool_name,
                media_kind=media_kind,
                provider=provider,
                task_id=task_id,
                status=st,
                remote_url=remote_url,
                local_path=local_path,
                file_size_bytes=size,
                meta=meta,
            )
    except Exception:
        logger.debug("record_task_completed skipped", exc_info=True)


def record_local_asset(
    runtime: ToolRuntime[ContextT, ThreadState] | None,
    *,
    tool_name: str,
    media_kind: str,
    local_path: str,
    provider: str | None = None,
    remote_url: str | None = None,
    meta: dict[str, Any] | None = None,
    outputs_dir: Path | None = None,
) -> None:
    try:
        from evoflow.persistence.media_assets import record_media_asset

        record_media_asset(
            thread_id=thread_id_from_runtime(runtime),
            tool_name=tool_name,
            media_kind=media_kind,
            provider=provider,
            status="succeeded",
            remote_url=remote_url,
            local_path=local_path,
            file_size_bytes=_local_file_size(outputs_dir, local_path),
            meta=meta,
        )
    except Exception:
        logger.debug("record_local_asset skipped", exc_info=True)
