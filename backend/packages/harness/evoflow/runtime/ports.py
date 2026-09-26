"""Runtime ports — the one sanctioned bridge from core to the application layer.

Rule R1 (backend/ARCHITECTURE.md): files under ``evoflow/`` must not import
``app.*``. When core code needs an application capability (Gateway SSE
singletons, channel service, speech, diagnostics…), it consumes one of the
ports below; the application layer registers its adapters at process startup
via ``backend/app/gateway/runtime_adapters.py``.

Semantics
---------
- **Gateway process**: adapters are installed during ``create_app()`` bootstrap
  (before any router registration), so every port resolves to the real
  implementation.
- **External LangGraph process / harness-only tests**: no adapters — each
  wrapper degrades exactly like the legacy ``try: from app... except
  ImportError`` blocks it replaces (no-op, safe default, or ``None``).

Port keys are stable API: renaming one requires updating the baseline doc.
Adding a new port is fine — prefer grouping by domain in this file.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

_lock = threading.Lock()
_impls: dict[str, Any] = {}


def register(key: str, impl: Any) -> None:
    """Register an application-layer adapter under ``key`` (idempotent)."""
    with _lock:
        _impls[key] = impl


def register_many(entries: dict[str, Any]) -> None:
    with _lock:
        _impls.update(entries)


def unregister(key: str) -> None:
    with _lock:
        _impls.pop(key, None)


def get(key: str) -> Any | None:
    impl = _impls.get(key)
    return impl


def is_registered(key: str) -> bool:
    return key in _impls


# ---------------------------------------------------------------------------
# events — SSE broadcaster singleton (app.gateway.routers.events)
# ---------------------------------------------------------------------------


class _BroadcasterProxy:
    """Lazy proxy for ``from evoflow.runtime.ports import broadcaster``.

    Keeps the exact legacy call sites ``await broadcaster.broadcast(...)``
    working with zero second-order changes. Off-process it is a no-op.
    """

    async def broadcast(self, thread_id: str, event_type: str, data: dict[str, Any]) -> None:
        impl = get("events.broadcaster")
        if impl is None:
            return
        await impl.broadcast(thread_id, event_type, data)


broadcaster = _BroadcasterProxy()


def get_event_broadcaster() -> Any | None:
    """Return the Gateway SSE ``broadcaster`` singleton, or ``None`` off-process."""
    return get("events.broadcaster")


async def broadcast_event(thread_id: str, event_type: str, data: dict[str, Any]) -> bool:
    """Async broadcast to SSE subscribers; False when no adapter or broadcast failed.

    Mirrors ``EventBroadcaster.get_instance().broadcast(...)`` usage in
    ``collab/sse_notify.py``. Returns a bool so callers can fall back to the
    HTTP relay path (external LangGraph process) exactly like the legacy code.
    """
    impl = get("events.broadcaster")
    if impl is None:
        return False
    try:
        await impl.broadcast(thread_id, event_type, data)
        return True
    except Exception:
        return False


def get_broadcaster() -> Any | None:
    """Return the registered broadcaster singleton (alias of get_event_broadcaster)."""
    return get_event_broadcaster()


def get_event_broadcaster_cls() -> Any | None:
    """Return the ``EventBroadcaster`` class itself, or None off-process."""
    return get("events.broadcaster_cls")


def _active_stream_proxies() -> dict:
    """Live ASGI stream-proxy registry; empty mapping when no adapter registered."""
    impl = get("proxy.active_stream_proxies")
    if impl is None:
        return {}
    return impl()


def automation_langgraph_outer_rules() -> str | None:
    """Automation-mode LangGraph outer prompt rules (Gateway copy), or None."""
    return get("automation.outer_rules")


# ---------------------------------------------------------------------------
# stream_inject — live run inject queue (app.gateway.streaming.session_stream_inject)
# ---------------------------------------------------------------------------


def schedule_inject_evf_frame(thread_id: str, payload: dict[str, Any]) -> None:
    impl = get("stream_inject.schedule_evf_frame")
    if impl is not None:
        impl(thread_id, payload)


def inject_langgraph_custom(thread_id: str, data: dict[str, Any]) -> bool:
    impl = get("stream_inject.inject_langgraph_custom")
    if impl is None:
        return False
    return bool(impl(thread_id, data))


def _has_pending_collab_subtasks(thread_id: str) -> bool:
    impl = get("stream_inject.has_pending_collab_subtasks")
    if impl is None:
        return False
    return bool(impl(thread_id))


# ---------------------------------------------------------------------------
# middle_layer — collab middle layer (app.gateway.streaming.stream_middle_layer)
# ---------------------------------------------------------------------------


def middle_layer_covers_thread(thread_id: str) -> bool:
    impl = get("middle_layer.covers_thread")
    if impl is None:
        return False
    return bool(impl(thread_id))


def get_active_middle_layer(thread_id: str) -> Any | None:
    impl = get("middle_layer.get_active")
    if impl is None:
        return None
    return impl(thread_id)


async def resume_middle_layer_tool_approval(
    *,
    thread_id: str,
    resume_payload: dict[str, Any],
    session_key: str = "",
    workspace_root: str | None = None,
) -> Any:
    impl = get("middle_layer.resume_tool_approval")
    if impl is None:
        return None
    return await impl(
        thread_id=thread_id,
        resume_payload=resume_payload,
        session_key=session_key,
        workspace_root=workspace_root,
    )


# ---------------------------------------------------------------------------
# proxy — live runs/stream proxies (app.gateway.routers.langgraph_proxy)
# ---------------------------------------------------------------------------


def asgi_stream_active(thread_id: str) -> bool:
    """Whether an ASGI ``runs/stream`` proxy is attached for the thread."""
    impl = get("proxy.asgi_stream_active")
    if impl is None:
        return False
    return bool(impl(thread_id))


def unregister_active_stream_proxy(thread_id: str | None) -> None:
    impl = get("proxy.unregister_active_stream_proxy")
    if impl is not None:
        impl(thread_id)


def _touch_session_run_started(thread_id: str | None, *, run_id: str | None = None) -> None:
    impl = get("proxy.touch_session_run_started")
    if impl is not None:
        impl(thread_id, run_id=run_id)


# Back-compat alias kept in sync with the original app-layer symbol name.
touch_session_run_started = _touch_session_run_started


# ---------------------------------------------------------------------------
# reconcile — run status caches (app.gateway.run_status_reconcile)
# ---------------------------------------------------------------------------


def invalidate_runs_probe_cache(thread_id: str | None = None) -> None:
    impl = get("reconcile.invalidate_runs_probe_cache")
    if impl is not None:
        impl(thread_id)


async def is_thread_run_active(client: Any, thread_id: str, *, run_id: str | None = None) -> bool | None:
    impl = get("reconcile.is_thread_run_active")
    if impl is None:
        return None
    return await impl(client, thread_id, run_id=run_id)


def _invalidate_active_sessions_cache() -> None:
    impl = get("reconcile.invalidate_active_sessions_cache")
    if impl is not None:
        impl()


# ---------------------------------------------------------------------------
# snapshot / defer — live run snapshot + run-finished deferral
# (app.gateway.streaming.live_run_snapshot / post_stream_ui_normalize)
# ---------------------------------------------------------------------------


def clear_gateway_live_snapshot(thread_id: str | None = None, *, session_key: str | None = None) -> None:
    impl = get("snapshot.clear_gateway_live_snapshot")
    if impl is not None:
        impl(thread_id, session_key=session_key)


def thread_in_tool_approval_pause(thread_id: str) -> bool:
    impl = get("defer.thread_in_tool_approval_pause")
    if impl is None:
        return False
    return bool(impl(thread_id))


def _should_defer_run_finished(thread_id: str) -> bool:
    impl = get("defer.should_defer_run_finished")
    if impl is None:
        return False
    return bool(impl(thread_id))


# ---------------------------------------------------------------------------
# mirror — stream mirror writes (app.gateway.streaming.stream_mirror,
# stream_mirror_model_bridge). Default off, mirrors the legacy env gating.
# ---------------------------------------------------------------------------


def enqueue_wire_text(
    thread_id: str,
    text: str,
    *,
    run_id: str | None = None,
    session_key: str | None = None,
) -> None:
    impl = get("mirror.enqueue_wire_text")
    if impl is not None:
        impl(thread_id, text, run_id=run_id, session_key=session_key)


def set_mirror_model_ctx(
    *,
    thread_id: str,
    session_key: str | None = None,
    run_id: str | None = None,
    message_id: str | None = None,
    stream_kind: str = "text",
) -> None:
    impl = get("mirror.set_model_ctx")
    if impl is not None:
        impl(
            thread_id=thread_id,
            session_key=session_key,
            run_id=run_id,
            message_id=message_id,
            stream_kind=stream_kind,
        )


def clear_mirror_model_ctx() -> None:
    impl = get("mirror.clear_model_ctx")
    if impl is not None:
        impl()


def get_mirror_token_callback_cls() -> Any | None:
    return get("mirror.token_callback_cls")


def make_mirror_token_callback() -> Any | None:
    """Instantiate ``MirrorStreamTokenCallback()``, or None when not registered."""
    cls = get("mirror.token_callback_cls")
    if cls is None:
        return None
    try:
        return cls()
    except Exception:
        return None


def get_ui_stream_normalizer_cls() -> Any | None:
    """``UiStreamNormalizer`` class (hosted-goal goal step mirror)."""
    return get("stream.ui_normalizer_cls")


def make_ui_stream_normalizer(**kwargs: Any) -> Any | None:
    """Instantiate the app-layer ``UiStreamNormalizer``, or None off-process."""
    cls = get("stream.ui_normalizer_cls")
    if cls is None:
        return None
    try:
        return cls(**kwargs)
    except Exception:
        return None


def get_stream_background_worker_cls() -> Any | None:
    """``StreamBackgroundWorker`` class (Gateway background run/stream lane)."""
    return get("stream.background_worker_cls")


# ---------------------------------------------------------------------------
# kb_citations — live KB injection citation SSE push
# (app.gateway.streaming.kb_citations_publisher)
# ---------------------------------------------------------------------------


def publish_kb_citations(
    *,
    thread_id: str | None,
    query: str,
    agent_code: str | None,
    results: list[dict[str, Any]],
) -> bool:
    """Push a ``kb_citations`` EVF frame onto the live SSE channel.

    Returns ``True`` when queued; ``False`` when no live thread or off-process
    (background worker). Never raises.
    """
    impl = get("kb_citations.publish")
    if impl is None:
        return False
    try:
        return bool(
            impl(
                thread_id=thread_id,
                query=query,
                agent_code=agent_code,
                results=results,
            )
        )
    except Exception:
        return False


# ---------------------------------------------------------------------------
# channels — channel service & push routing (app.channels / channel_result_push)
# ---------------------------------------------------------------------------


def get_channel_service() -> Any | None:
    impl = get("channels.service")
    return impl


def resolve_push_target(
    *,
    push_enabled: bool,
    push_channel: str | None = None,
    push_target_id: str | None = None,
) -> tuple[str, str] | None:
    impl = get("channels.resolve_push_target")
    if impl is None:
        return None
    return impl(push_enabled=push_enabled, push_channel=push_channel, push_target_id=push_target_id)


def get_feishu_registration_client() -> Any | None:
    return get("channels.feishu_registration_client")


def get_feishu_stream_bridge() -> Any | None:
    return get("channels.feishu_stream_bridge")


def read_learned_feishu_automation_account_id() -> str | None:
    impl = get("channels.feishu_learned_account_id")
    if impl is None:
        return None
    return impl()


def read_learned_feishu_automation_chat_id() -> str | None:
    impl = get("channels.feishu_learned_chat_id")
    if impl is None:
        return None
    return impl()


# ---------------------------------------------------------------------------
# speech — volcengine TTS/ASR (app.gateway.speech.volcengine_speech)
# ---------------------------------------------------------------------------


def speech_configured() -> bool:
    impl = get("speech.configured")
    if impl is None:
        return False
    return bool(impl())


def speech_streaming_asr_available() -> bool:
    impl = get("speech.streaming_asr_available")
    if impl is None:
        return False
    return bool(impl())


def synthesize_speech_v3(
    text: str,
    *,
    speaker: str | None = None,
    preview: bool = False,
) -> tuple[bytes, str] | None:
    impl = get("speech.synthesize_v3")
    if impl is None:
        return None
    return impl(text, speaker=speaker, preview=preview)


# ---------------------------------------------------------------------------
# diagnostics — Gateway event-loop health (app.gateway.hang_diagnostics)
# ---------------------------------------------------------------------------


def get_event_loop_lag_seconds() -> float:
    impl = get("diagnostics.event_loop_lag_seconds")
    if impl is None:
        return 0.0
    return float(impl())


def is_listen_socket_broken() -> bool:
    impl = get("diagnostics.listen_socket_broken")
    if impl is None:
        return False
    return bool(impl())


# ---------------------------------------------------------------------------
# logs — gateway daily-log helpers (app.gateway.logging_setup)
# ---------------------------------------------------------------------------


def resolve_gateway_logs_dir() -> Path | None:
    impl = get("logs.resolve_gateway_logs_dir")
    if impl is None:
        return None
    return impl()


def prune_old_daily_logs(log_dir: Path, base_name: str, *, days: int | None = None) -> int:
    impl = get("logs.prune_old_daily_logs")
    if impl is None:
        return 0
    return impl(log_dir, base_name, days=days)


# ---------------------------------------------------------------------------
# goal events — hosted-goal live state (app.gateway.streaming.goal_stream_events)
# ---------------------------------------------------------------------------


def is_goal_active_for_session(session_key: str) -> bool:
    impl = get("goal.is_active_for_session")
    if impl is None:
        return False
    return bool(impl(session_key))


# ---------------------------------------------------------------------------
# unattended — unattended task pipeline (app.gateway.unattended_task_pipeline)
# ---------------------------------------------------------------------------


async def advance_unattended_task(task_id: str) -> dict[str, Any] | None:
    impl = get("unattended.advance_task")
    if impl is None:
        return None
    return await impl(task_id)
