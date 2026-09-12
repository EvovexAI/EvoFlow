"""Model-callback mirror bridge — middle layer below Gateway SSE.

When the browser POST / join path is not mirroring model tokens (e.g. after
refresh, during background join), stream LLM tokens here into ag-ui mirror frames.
Skipped while Gateway ASGI stream is still active (mirror lane handles POST).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any
from uuid import UUID

from langchain_core.callbacks.base import BaseCallbackHandler

logger = logging.getLogger(__name__)

_CTX = threading.local()
_STATE = threading.local()


def _bridge_enabled() -> bool:
    """Model bridge only when mirror table writes are enabled (default off)."""
    try:
        from app.gateway.streaming.stream_mirror import stream_mirror_writes_enabled

        if not stream_mirror_writes_enabled():
            return False
    except Exception:
        env_mirror = os.environ.get("EVOFLOW_STREAM_MIRROR", "0").strip().lower()
        if env_mirror in ("0", "false", "no", "off"):
            return False
    return os.environ.get("EVOFLOW_STREAM_MIRROR_MODEL_BRIDGE", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def set_mirror_model_ctx(
    *,
    thread_id: str,
    session_key: str | None = None,
    run_id: str | None = None,
    message_id: str | None = None,
    stream_kind: str = "text",
) -> None:
    """Set per-model-call context for ``MirrorStreamTokenCallback``."""
    _CTX.ctx = {
        "thread_id": str(thread_id or "").strip(),
        "session_key": str(session_key or "").strip() or None,
        "run_id": str(run_id or "").strip() or None,
        "message_id": str(message_id or "").strip() or None,
        "stream_kind": "reasoning" if str(stream_kind or "").strip().lower() == "reasoning" else "text",
    }


def clear_mirror_model_ctx() -> None:
    _CTX.ctx = None


def _asgi_stream_active(thread_id: str) -> bool:
    try:
        from app.gateway.routers.langgraph_proxy import _active_stream_proxies

        return str(thread_id or "").strip() in _active_stream_proxies
    except Exception:
        return False


def _state_key(thread_id: str, langchain_run_id: UUID) -> str:
    return f"{thread_id}:{langchain_run_id}"


def _get_block_state(key: str) -> dict[str, Any]:
    store = getattr(_STATE, "blocks", None)
    if store is None:
        store = {}
        _STATE.blocks = store
    if key not in store:
        store[key] = {"opened": False}
    return store[key]


def _clear_block_state(key: str) -> None:
    store = getattr(_STATE, "blocks", None)
    if store is not None:
        store.pop(key, None)


def _emit_agui(thread_id: str, payload: dict[str, Any], *, run_id: str | None, source: str) -> None:
    wire = f"event: ag-ui\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
    try:
        from app.gateway.streaming.stream_middle_layer import try_feed_middle_layer_wire

        if try_feed_middle_layer_wire(thread_id, wire, run_id=run_id, source=source):
            return
    except Exception:
        logger.debug("model bridge middle layer feed failed thread=%s", thread_id, exc_info=True)
    if _asgi_stream_active(thread_id):
        return
    try:
        from app.gateway.streaming.stream_mirror import enqueue_wire_chunk_sync

        enqueue_wire_chunk_sync(thread_id, wire, run_id=run_id, source=source)
    except Exception:
        logger.debug("model bridge mirror enqueue failed thread=%s", thread_id, exc_info=True)


class MirrorStreamTokenCallback(BaseCallbackHandler):
    """Mirror LLM token deltas when Gateway SSE lane is not active."""

    raise_error: bool = False

    def on_llm_new_token(
        self,
        token: str,
        *,
        chunk: object | None = None,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: object,
    ) -> None:
        if not _bridge_enabled():
            return
        ctx = getattr(_CTX, "ctx", None) or {}
        tid = str(ctx.get("thread_id") or "").strip()
        if not tid or not token:
            return
        layer = None
        try:
            from app.gateway.streaming.stream_middle_layer import get_active_middle_layer

            layer = get_active_middle_layer(tid)
        except Exception:
            layer = None
        if _asgi_stream_active(tid) and not (layer is not None and layer.in_tool_pause):
            return

        kind = str(ctx.get("stream_kind") or "text")
        msg_id = str(ctx.get("message_id") or "").strip() or f"{tid}:bridge"
        lg_run_id = str(ctx.get("run_id") or "").strip() or None
        st = _get_block_state(_state_key(tid, run_id))

        if not st.get("opened"):
            st["opened"] = True
            if kind == "reasoning":
                _emit_agui(tid, {"type": "REASONING_START", "messageId": msg_id}, run_id=lg_run_id, source="model-bridge")
                _emit_agui(
                    tid,
                    {"type": "REASONING_MESSAGE_START", "messageId": msg_id, "role": "reasoning"},
                    run_id=lg_run_id,
                    source="model-bridge",
                )
            else:
                _emit_agui(
                    tid,
                    {"type": "TEXT_MESSAGE_START", "messageId": msg_id, "role": "assistant"},
                    run_id=lg_run_id,
                    source="model-bridge",
                )

        if kind == "reasoning":
            _emit_agui(
                tid,
                {"type": "REASONING_MESSAGE_CONTENT", "messageId": msg_id, "delta": token},
                run_id=lg_run_id,
                source="model-bridge",
            )
        else:
            _emit_agui(
                tid,
                {"type": "TEXT_MESSAGE_CONTENT", "messageId": msg_id, "delta": token},
                run_id=lg_run_id,
                source="model-bridge",
            )

    def _close_open_block(self, run_id: UUID) -> None:
        """Emit AG-UI block end events when a stream opened TEXT/REASONING but did not finish cleanly."""
        ctx = getattr(_CTX, "ctx", None) or {}
        tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            return
        key = _state_key(tid, run_id)
        st = _get_block_state(key)
        if not st.get("opened"):
            _clear_block_state(key)
            return
        kind = str(ctx.get("stream_kind") or "text")
        msg_id = str(ctx.get("message_id") or "").strip() or f"{tid}:bridge"
        lg_run_id = str(ctx.get("run_id") or "").strip() or None
        if kind == "reasoning":
            _emit_agui(tid, {"type": "REASONING_MESSAGE_END", "messageId": msg_id}, run_id=lg_run_id, source="model-bridge")
            _emit_agui(tid, {"type": "REASONING_END", "messageId": msg_id}, run_id=lg_run_id, source="model-bridge")
        else:
            _emit_agui(tid, {"type": "TEXT_MESSAGE_END", "messageId": msg_id}, run_id=lg_run_id, source="model-bridge")
        _clear_block_state(key)

    def on_llm_end(
        self,
        response: object,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: object,
    ) -> None:
        self._close_open_block(run_id)

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        **kwargs: object,
    ) -> None:
        # Match on_llm_end so AGUI clients close open text/reasoning blocks after timeout/cancel.
        self._close_open_block(run_id)
