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

        m = meta if isinstance(meta, dict) else {}
        model = m.get("model") or m.get("model_id") or m.get("modelId")
        record_media_asset(
            thread_id=thread_id_from_runtime(runtime),
            tool_name=tool_name,
            media_kind=media_kind,
            provider=provider,
            model=str(model).strip() if model else None,
            task_id=task_id,
            status="processing",
            meta=meta,
        )
    except Exception:
        logger.debug("record_task_submitted skipped", exc_info=True)


def _ledger_media_usage(
    runtime: ToolRuntime[ContextT, ThreadState] | None,
    *,
    tool_name: str,
    provider: str,
    task_id: str | None,
    media_kind: str,
    status: str,
    remote_url: str | None = None,
    local_path: str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """Write Settings→使用统计 media row (best-effort; never raise)."""
    try:
        from evoflow.persistence.usage_ledger import record_media_generation_usage

        m = dict(meta) if isinstance(meta, dict) else {}
        # Fill gaps from the submit-time media_assets row (video task_wait path).
        if task_id and provider and (
            m.get("model") is None or m.get("duration") is None or m.get("mode") is None
        ):
            try:
                from evoflow.persistence.media_assets import get_media_asset_by_task

                prev = get_media_asset_by_task(provider=provider, task_id=task_id)
                prev_meta = (prev or {}).get("meta") if isinstance((prev or {}).get("meta"), dict) else {}
                for k in (
                    "mode",
                    "model",
                    "duration",
                    "aspect_ratio",
                    "resolution",
                    "prompt",
                    "reference_count",
                ):
                    if m.get(k) is None and prev_meta.get(k) is not None:
                        m[k] = prev_meta[k]
            except Exception:
                pass
        record_media_generation_usage(
            media_kind=media_kind,
            provider=provider,
            model=m.get("model") or m.get("model_id") or m.get("modelId"),
            mode=m.get("mode"),
            task_id=task_id,
            status=status,
            thread_id=thread_id_from_runtime(runtime),
            aspect_ratio=m.get("aspect_ratio") or m.get("aspectRatio") or m.get("ratio"),
            duration_seconds=m.get("duration") or m.get("duration_seconds"),
            resolution=m.get("resolution"),
            reference_count=m.get("reference_count") or m.get("referenceCount"),
            prompt=m.get("prompt"),
            remote_url=remote_url,
            local_path=local_path,
            vendor_cost=m.get("vendor_cost") or m.get("cost") or m.get("finalCost"),
            vendor_currency=m.get("vendor_currency") or m.get("currency"),
            tool_name=tool_name,
            meta=m,
        )
    except Exception:
        logger.debug("media usage ledger skipped", exc_info=True)


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
        m = meta if isinstance(meta, dict) else {}
        model = m.get("model") or m.get("model_id") or m.get("modelId")
        updated = update_media_asset_by_task(
            provider=provider,
            task_id=task_id,
            status=st,
            remote_url=remote_url,
            local_path=local_path,
            model=str(model).strip() if model else None,
            file_size_bytes=size,
            meta_patch={**m, "completed_by": tool_name},
        )
        if not updated:
            record_media_asset(
                thread_id=tid,
                tool_name=tool_name,
                media_kind=media_kind,
                provider=provider,
                model=str(model).strip() if model else None,
                task_id=task_id,
                status=st,
                remote_url=remote_url,
                local_path=local_path,
                file_size_bytes=size,
                meta=meta,
            )
        _ledger_media_usage(
            runtime,
            tool_name=tool_name,
            provider=provider,
            task_id=task_id,
            media_kind=media_kind,
            status=st,
            remote_url=remote_url,
            local_path=local_path,
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

        m = meta if isinstance(meta, dict) else {}
        model = m.get("model") or m.get("model_id") or m.get("modelId")
        record_media_asset(
            thread_id=thread_id_from_runtime(runtime),
            tool_name=tool_name,
            media_kind=media_kind,
            provider=provider,
            model=str(model).strip() if model else None,
            status="succeeded",
            remote_url=remote_url,
            local_path=local_path,
            file_size_bytes=_local_file_size(outputs_dir, local_path),
            meta=meta,
        )
        _ledger_media_usage(
            runtime,
            tool_name=tool_name,
            provider=str(provider or ""),
            task_id=str(m.get("task_id") or m.get("taskId") or "") or None,
            media_kind=media_kind,
            status="succeeded",
            remote_url=remote_url,
            local_path=local_path,
            meta=m,
        )
    except Exception:
        logger.debug("record_local_asset skipped", exc_info=True)
