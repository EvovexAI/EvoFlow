"""Register application-layer adapters into the kernel runtime ports.

This is the **only** sanctioned bridge from ``evoflow`` back to ``app``
(backend/ARCHITECTURE.md, rule R1). It runs once during Gateway startup,
before any router mounts, so every ``evoflow.runtime.ports`` accessor resolves
to the real Gateway implementation.

External LangGraph processes / CLI / harness tests never import this module,
so the ports stay in their no-op / None degradation — exactly like the legacy
``try: from app... except ImportError`` blocks this replaces.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_registered = False


def register_runtime_adapters() -> None:
    """Install every app-layer adapter into ``evoflow.runtime.ports`` (idempotent)."""
    global _registered
    if _registered:
        return
    _registered = True

    from evoflow.runtime import ports

    # ── events: SSE broadcaster ─────────────────────────────────────────
    try:
        from app.gateway.routers import events as _ev

        broadcaster_obj = getattr(_ev, "broadcaster", None)
        broadcaster_cls = getattr(_ev, "EventBroadcaster", None)
        ports.register("events.broadcaster", broadcaster_obj)
        if broadcaster_cls is not None:
            ports.register("events.broadcaster_cls", broadcaster_cls)
    except Exception:
        logger.debug("register events failed", exc_info=True)

    # ── stream inject queue ─────────────────────────────────────────────
    try:
        from app.gateway.streaming import session_stream_inject as _sji

        ports.register("stream_inject.schedule_evf_frame", _sji.schedule_inject_evf_frame)
        ports.register("stream_inject.inject_langgraph_custom", _sji.inject_langgraph_custom)
        ports.register("stream_inject.has_pending_collab_subtasks", _sji._has_pending_collab_subtasks)
    except Exception:
        logger.debug("register stream_inject failed", exc_info=True)

    # ── middle layer ────────────────────────────────────────────────────
    try:
        from app.gateway.streaming import stream_middle_layer as _sml

        ports.register("middle_layer.covers_thread", _sml.middle_layer_covers_thread)
        ports.register("middle_layer.get_active", _sml.get_active_middle_layer)
        ports.register("middle_layer.resume_tool_approval", _sml.resume_middle_layer_tool_approval)
    except Exception:
        logger.debug("register middle_layer failed", exc_info=True)

    # ── langgraph proxy / snapshot / defer ──────────────────────────────
    try:
        from app.gateway.routers import langgraph_proxy as _lgp

        ports.register("proxy.asgi_stream_active", lambda tid: str(tid or "").strip() in _lgp._active_stream_proxies)
        ports.register("proxy.active_stream_proxies", lambda: _lgp._active_stream_proxies)
        ports.register("proxy.unregister_active_stream_proxy", _lgp.unregister_active_stream_proxy)
        ports.register("proxy.touch_session_run_started", _lgp._touch_session_run_started)
    except Exception:
        logger.debug("register langgraph_proxy failed", exc_info=True)

    try:
        from app.gateway.streaming import live_run_snapshot as _lrs

        ports.register("snapshot.clear_gateway_live_snapshot", _lrs.clear_gateway_live_snapshot)
    except Exception:
        logger.debug("register live_run_snapshot failed", exc_info=True)

    try:
        from app.gateway.streaming import post_stream_ui_normalize as _psui

        ports.register("defer.thread_in_tool_approval_pause", _psui.thread_in_tool_approval_pause)
        ports.register("defer.should_defer_run_finished", _psui._should_defer_run_finished)
    except Exception:
        logger.debug("register post_stream_ui_normalize failed", exc_info=True)

    # ── run status reconcile ────────────────────────────────────────────
    try:
        from app.gateway import run_status_reconcile as _rsr

        ports.register("reconcile.invalidate_runs_probe_cache", _rsr.invalidate_runs_probe_cache)
        ports.register("reconcile.invalidate_active_sessions_cache", _rsr._invalidate_active_sessions_cache)
        ports.register("reconcile.is_thread_run_active", _rsr.is_thread_run_active)
    except Exception:
        logger.debug("register run_status_reconcile failed", exc_info=True)

    # ── stream mirror + model bridge + normalizer + background worker ────
    try:
        from app.gateway.streaming import stream_mirror as _sm

        ports.register("mirror.enqueue_wire_text", _sm.enqueue_wire_text)
        ports.register("mirror.stream_mirror_writes_enabled", _sm.stream_mirror_writes_enabled)
    except Exception:
        logger.debug("register stream_mirror failed", exc_info=True)

    try:
        from app.gateway.streaming import stream_mirror_model_bridge as _smb

        ports.register("mirror.set_model_ctx", _smb.set_mirror_model_ctx)
        ports.register("mirror.clear_model_ctx", _smb.clear_mirror_model_ctx)
        ports.register("mirror.token_callback_cls", _smb.MirrorStreamTokenCallback)
    except Exception:
        logger.debug("register stream_mirror_model_bridge failed", exc_info=True)

    try:
        from app.gateway import sse_ui_normalize as _sui

        ports.register("stream.ui_normalizer_cls", _sui.UiStreamNormalizer)
    except Exception:
        logger.debug("register sse_ui_normalize failed", exc_info=True)

    try:
        from app.gateway.streaming import background_worker as _bw

        ports.register("stream.background_worker_cls", _bw.StreamBackgroundWorker)
    except Exception:
        logger.debug("register background_worker failed", exc_info=True)

    try:
        from app.gateway.streaming.kb_citations_publisher import publish_kb_citations

        ports.register("kb_citations.publish", publish_kb_citations)
    except Exception:
        logger.debug("register kb_citations_publisher failed", exc_info=True)

    # ── channels + push routing + feishu ────────────────────────────────
    try:
        from app.channels.service import get_channel_service

        ports.register("channels.service", get_channel_service)
    except Exception:
        logger.debug("register channels.service failed", exc_info=True)

    try:
        from app.gateway.channel_result_push import resolve_push_target

        ports.register("channels.resolve_push_target", resolve_push_target)
    except Exception:
        logger.debug("register channels.resolve_push_target failed", exc_info=True)

    try:
        from app.channels.feishu_registration import get_registration_client

        ports.register("channels.feishu_registration_client", get_registration_client)
    except Exception:
        logger.debug("register channels.feishu_registration_client failed", exc_info=True)

    try:
        from app.channels.feishu_stream_bridge import get_feishu_stream_bridge

        ports.register("channels.feishu_stream_bridge", get_feishu_stream_bridge)
    except Exception:
        logger.debug("register channels.feishu_stream_bridge failed", exc_info=True)

    try:
        from app.channels import feishu_automation_learned_chat as _flc

        ports.register("channels.feishu_learned_account_id", _flc.read_learned_feishu_automation_account_id)
        ports.register("channels.feishu_learned_chat_id", _flc.read_learned_feishu_automation_chat_id)
    except Exception:
        logger.debug("register feishu_automation_learned_chat failed", exc_info=True)

    # ── speech ──────────────────────────────────────────────────────────
    try:
        from app.gateway.speech import volcengine_speech as _vs

        ports.register("speech.configured", _vs.speech_configured)
        ports.register("speech.streaming_asr_available", _vs.speech_streaming_asr_available)
        ports.register("speech.synthesize_v3", _vs.synthesize_speech_v3)
    except Exception:
        logger.debug("register speech failed", exc_info=True)

    # ── diagnostics / logs / automation / goal events / unattended ──────
    try:
        from app.gateway import hang_diagnostics as _hd

        ports.register("diagnostics.event_loop_lag_seconds", _hd.get_event_loop_lag_seconds)
        ports.register("diagnostics.listen_socket_broken", _hd.is_listen_socket_broken)
    except Exception:
        logger.debug("register hang_diagnostics failed", exc_info=True)

    try:
        from app.gateway import logging_setup as _ls

        ports.register("logs.resolve_gateway_logs_dir", _ls.resolve_gateway_logs_dir)
        ports.register("logs.prune_old_daily_logs", _ls.prune_old_daily_logs)
    except Exception:
        logger.debug("register logging_setup failed", exc_info=True)

    try:
        from app.gateway.automation_runner import _AUTOMATION_LANGGRAPH_OUTER_RULES

        ports.register("automation.outer_rules", _AUTOMATION_LANGGRAPH_OUTER_RULES)
    except Exception:
        logger.debug("register automation_runner outer rules failed", exc_info=True)

    try:
        from app.gateway.streaming.goal_stream_events import is_goal_active_for_session

        ports.register("goal.is_active_for_session", is_goal_active_for_session)
    except Exception:
        logger.debug("register goal_stream_events failed", exc_info=True)

    try:
        from app.gateway.unattended_task_pipeline import advance_unattended_task

        ports.register("unattended.advance_task", advance_unattended_task)
    except Exception:
        logger.debug("register unattended_task_pipeline failed", exc_info=True)
