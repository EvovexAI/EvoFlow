"""Lazy singleton that forwards to :class:`ObservabilitySqliteStore` when config enables observability."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from evoflow.observability.sqlite_store import ObservabilitySqliteStore

logger = logging.getLogger(__name__)


def _fire_and_forget(fn: Any, **kwargs: Any) -> None:
    """Schedule a best-effort SQLite write in a background thread.

    When called from within a running event loop (e.g. agent middleware hooks),
    the write is scheduled via ``asyncio.create_task(asyncio.to_thread(...))``
    so it never blocks the event loop. When no event loop is available (sync
    context, worker thread, or ``asyncio.to_thread`` caller), it runs directly.
    """
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(asyncio.to_thread(fn, **kwargs))
    except RuntimeError:
        # No running event loop — run synchronously (best-effort).
        try:
            fn(**kwargs)
        except Exception:
            logger.debug("observability fire-and-forget sync fallback failed", exc_info=True)

_lock = threading.Lock()
_store: ObservabilitySqliteStore | None = None
_store_path: str | None = None


def _store_for_config() -> ObservabilitySqliteStore | None:
    global _store, _store_path
    try:
        from evoflow.config.app_config import get_app_config
        from evoflow.config.data_paths import resolve_observability_db_config_path
        from evoflow.debug.trace_sink import observability_enabled

        if not observability_enabled():
            return None
        raw_path = str(
            resolve_observability_db_config_path(
                (get_app_config().observability.sqlite_path or "").strip() or None
            )
        )
    except Exception:
        return None
    with _lock:
        if _store is not None and _store_path == raw_path:
            return _store
        if _store is not None:
            try:
                _store.close()
            except Exception:
                pass
        _store_path = raw_path
        _store = ObservabilitySqliteStore(raw_path)
        return _store


def get_observability_recorder() -> ObservabilityRecorder:
    return ObservabilityRecorder()


class ObservabilityRecorder:
    """Best-effort recorder; never raises to callers."""

    def record_gateway_request(
        self,
        *,
        occurred_at: str,
        method: str,
        path: str,
        query_string: str | None = None,
        client_ip: str | None = None,
        user_agent: str | None = None,
        request_content_type: str | None = None,
        response_content_type: str | None = None,
        status_code: int | None = None,
        duration_ms: float,
        request_headers: dict[str, Any] | None = None,
        response_headers: dict[str, Any] | None = None,
        request_body_sample: str | None = None,
        response_body_sample: str | None = None,
        request_body_truncated: bool = False,
        response_body_truncated: bool = False,
        error_type: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        st = _store_for_config()
        if st is None:
            return
        try:
            st.insert_gateway_request(
                occurred_at=occurred_at,
                method=method,
                path=path,
                query_string=query_string,
                client_ip=client_ip,
                user_agent=user_agent,
                request_content_type=request_content_type,
                response_content_type=response_content_type,
                status_code=status_code,
                duration_ms=duration_ms,
                request_headers=request_headers,
                response_headers=response_headers,
                request_body_sample=request_body_sample,
                response_body_sample=response_body_sample,
                request_body_truncated=request_body_truncated,
                response_body_truncated=response_body_truncated,
                error_type=error_type,
                metadata=metadata,
            )
        except Exception:
            logger.debug("observability gateway request insert failed", exc_info=True)

    def record_trace_event(
        self,
        *,
        thread_id: str | None,
        run_id: str | None = None,
        lane: str,
        occurred_at: str,
        event: str,
        payload: dict[str, Any],
    ) -> None:
        st = _store_for_config()
        if st is None:
            return
        _fire_and_forget(
            st.insert_trace_event,
            thread_id=thread_id,
            run_id=run_id,
            lane=lane,
            occurred_at=occurred_at,
            event=event,
            payload=payload,
        )

    def record_tool_invocation(
        self,
        *,
        thread_id: str,
        run_id: str | None = None,
        tool_call_id: str,
        tool_name: str,
        started_at: str,
        ended_at: str,
        duration_ms: float,
        status: str,
        input_obj: Any,
        output_text: str | None,
        collab_phase: str | None = None,
        invocation_source: str = "tool_middleware",
        error_type: str | None = None,
        error_message: str | None = None,
        error_detail: dict[str, Any] | None = None,
        agent_code: str | None = None,
        position_code: str | None = None,
    ) -> None:
        st = _store_for_config()
        if st is None:
            return
        _fire_and_forget(
            st.insert_tool_invocation,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=duration_ms,
            status=status,
            input_obj=input_obj,
            output_text=output_text,
            collab_phase=collab_phase,
            invocation_source=invocation_source,
            error_type=error_type,
            error_message=error_message,
            error_detail=error_detail,
            agent_code=agent_code,
            position_code=position_code,
        )

    def record_task_lifecycle(
        self,
        *,
        thread_id: str | None,
        occurred_at: str,
        schema_version: str | None,
        event: str,
        main_task_id: str | None = None,
        subtask_id: str | None = None,
        status: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        st = _store_for_config()
        if st is None:
            return
        _fire_and_forget(
            st.insert_task_lifecycle,
            thread_id=thread_id,
            occurred_at=occurred_at,
            schema_version=schema_version,
            event=event,
            main_task_id=main_task_id,
            subtask_id=subtask_id,
            status=status,
            detail=detail,
        )

    def record_im_channel_error(self, *, thread_id: str | None, occurred_at: str, payload: dict[str, Any]) -> None:
        st = _store_for_config()
        if st is None:
            return
        _fire_and_forget(
            st.insert_im_channel_error,
            thread_id=thread_id,
            occurred_at=occurred_at,
            payload=payload,
        )

    def record_model_request_payload(
        self,
        *,
        thread_id: str | None,
        run_id: str | None,
        model_call_seq: int | None,
        provider: str,
        model: str | None,
        stage: str,
        trace_id: str | None,
        requested_at: str,
        latency_ms: float | None,
        first_token_latency_ms: float | None = None,
        request_json: str | None = None,
        response_json: str | None = None,
        usage_json: str | None = None,
        cache_read_tokens: int | None = None,
        cache_creation_tokens: int | None = None,
        cache_miss_tokens: int | None = None,
        collab_phase: str | None = None,
        checkpoint_id: str | None = None,
        invocation_kind: str | None = None,
        thinking_enabled: int | None = None,
        reasoning_effort: str | None = None,
        thinking_type: str | None = None,
        thinking_budget_tokens: int | None = None,
        session_mode: str | None = None,
    ) -> None:
        st = _store_for_config()
        if st is None:
            return
        _fire_and_forget(
            st.insert_model_invocation,
            thread_id=thread_id,
            run_id=run_id,
            model_call_seq=model_call_seq,
            provider=provider,
            model=model,
            stage=stage,
            trace_id=trace_id,
            requested_at=requested_at,
            latency_ms=latency_ms,
            first_token_latency_ms=first_token_latency_ms,
            request_json=request_json,
            response_json=response_json,
            usage_json=usage_json,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
            cache_miss_tokens=cache_miss_tokens,
            collab_phase=collab_phase,
            checkpoint_id=checkpoint_id,
            invocation_kind=invocation_kind,
            thinking_enabled=thinking_enabled,
            reasoning_effort=reasoning_effort,
            thinking_type=thinking_type,
            thinking_budget_tokens=thinking_budget_tokens,
            session_mode=session_mode,
        )

    # ── Two-phase model invocation recording ────────────────────────────
    # Phase 1: record_model_invocation_pending → returns row_id synchronously
    # Phase 2: record_model_invocation_complete → fire-and-forget UPDATE

    def record_model_invocation_pending(
        self,
        *,
        thread_id: str | None,
        run_id: str | None,
        model_call_seq: int | None,
        provider: str,
        model: str | None,
        stage: str,
        trace_id: str | None,
        requested_at: str,
        request_json: str | None = None,
        collab_phase: str | None = None,
        checkpoint_id: str | None = None,
        invocation_kind: str | None = None,
        thinking_enabled: int | None = None,
        reasoning_effort: str | None = None,
        thinking_type: str | None = None,
        thinking_budget_tokens: int | None = None,
        session_mode: str | None = None,
        agent_code: str | None = None,
        position_code: str | None = None,
    ) -> str | None:
        """Phase 1: insert a *running* row synchronously and return its id.

        Runs synchronously (not fire-and-forget) because the caller needs the
        ``row_id`` to pass to :meth:`record_model_invocation_complete`.
        The INSERT itself is sub-millisecond so blocking is negligible.
        """
        st = _store_for_config()
        if st is None:
            return None
        try:
            return st.insert_model_invocation_pending(
                thread_id=thread_id,
                run_id=run_id,
                model_call_seq=model_call_seq,
                provider=provider,
                model=model,
                stage=stage,
                trace_id=trace_id,
                requested_at=requested_at,
                request_json=request_json,
                collab_phase=collab_phase,
                checkpoint_id=checkpoint_id,
                invocation_kind=invocation_kind,
                thinking_enabled=thinking_enabled,
                reasoning_effort=reasoning_effort,
                thinking_type=thinking_type,
                thinking_budget_tokens=thinking_budget_tokens,
                session_mode=session_mode,
                agent_code=agent_code,
                position_code=position_code,
            )
        except Exception:
            logger.debug("observability model invocation pending insert failed", exc_info=True)
            return None

    def record_model_invocation_complete(
        self,
        *,
        row_id: str,
        latency_ms: float | None,
        first_token_latency_ms: float | None = None,
        response_json: str | None = None,
        usage_json: str | None = None,
        cache_read_tokens: int | None = None,
        cache_creation_tokens: int | None = None,
        cache_miss_tokens: int | None = None,
        status: str = "completed",
        request_json: str | None = None,
        thinking_enabled: int | None = None,
        reasoning_effort: str | None = None,
        thinking_type: str | None = None,
        thinking_budget_tokens: int | None = None,
        session_mode: str | None = None,
    ) -> None:
        """Phase 2: fill in completion data for a pending row (fire-and-forget).

        *request_json* (when not ``None``) overwrites the Phase-1 preview via
        ``COALESCE`` — pass the full vendor-request payload for roundtrip mode.
        """
        st = _store_for_config()
        if st is None:
            return
        _fire_and_forget(
            st.complete_model_invocation,
            row_id=row_id,
            latency_ms=latency_ms,
            first_token_latency_ms=first_token_latency_ms,
            response_json=response_json,
            usage_json=usage_json,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
            cache_miss_tokens=cache_miss_tokens,
            status=status,
            request_json=request_json,
            thinking_enabled=thinking_enabled,
            reasoning_effort=reasoning_effort,
            thinking_type=thinking_type,
            thinking_budget_tokens=thinking_budget_tokens,
            session_mode=session_mode,
        )


def reset_observability_store_for_tests() -> None:
    """Close singleton (tests only)."""
    global _store, _store_path
    with _lock:
        if _store is not None:
            try:
                _store.close()
            except Exception:
                pass
        _store = None
        _store_path = None
