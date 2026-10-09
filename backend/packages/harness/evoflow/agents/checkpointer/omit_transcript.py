"""Strip conversation transcript from durable LangGraph checkpoints.

``evoflow_chat_messages`` is the SSOT for history. Runtime ``messages`` still exist
in-memory during a run (hydrate + model + tools), but **must not** be persisted on
every ``put``/``aput`` — including the current user turn.

Exception: keep ``messages`` when there are unresolved tool_calls (HITL / mid-tool
resume). Those cannot be reconstructed from the chat table alone without the
pending AIMessage tool_calls shape LangGraph expects.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_TRANSCRIPT_CHANNELS = ("messages", "ui_messages")


def omit_transcript_on_checkpoint_put_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_CHECKPOINT_OMIT_TRANSCRIPT") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _tool_call_id(tc: Any) -> str:
    if isinstance(tc, dict):
        return str(tc.get("id") or tc.get("tool_call_id") or "").strip()
    return str(getattr(tc, "id", None) or getattr(tc, "tool_call_id", None) or "").strip()


def _message_type_name(msg: Any) -> str:
    if isinstance(msg, dict):
        t = str(msg.get("type") or msg.get("role") or "").strip().lower()
        if t in {"ai", "assistant"}:
            return "ai"
        if t == "tool":
            return "tool"
        return t
    name = type(msg).__name__.lower()
    if "ai" in name:
        return "ai"
    if "tool" in name:
        return "tool"
    return name


def has_unresolved_tool_calls(messages: Any) -> bool:
    """True when an AI tool_call has no matching ToolMessage yet (interrupt / mid-tool)."""
    if not isinstance(messages, list) or not messages:
        return False
    pending: set[str] = set()
    for msg in messages:
        kind = _message_type_name(msg)
        if kind == "ai":
            raw_tcs = None
            if isinstance(msg, dict):
                raw_tcs = msg.get("tool_calls")
                if raw_tcs is None and isinstance(msg.get("kwargs"), dict):
                    raw_tcs = msg["kwargs"].get("tool_calls")
            else:
                raw_tcs = getattr(msg, "tool_calls", None)
            for tc in raw_tcs or []:
                tid = _tool_call_id(tc)
                if tid:
                    pending.add(tid)
        elif kind == "tool":
            if isinstance(msg, dict):
                tid = str(msg.get("tool_call_id") or "").strip()
                if not tid and isinstance(msg.get("kwargs"), dict):
                    tid = str(msg["kwargs"].get("tool_call_id") or "").strip()
            else:
                tid = str(getattr(msg, "tool_call_id", None) or "").strip()
            if tid:
                pending.discard(tid)
    return bool(pending)


def omit_transcript_channels(checkpoint: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow-copied checkpoint with transcript channels cleared when safe."""
    if not isinstance(checkpoint, dict):
        return checkpoint
    cv = checkpoint.get("channel_values")
    if not isinstance(cv, dict):
        return checkpoint
    messages = cv.get("messages")
    if has_unresolved_tool_calls(messages):
        return checkpoint
    # Nothing to strip?
    if not messages and not cv.get("ui_messages"):
        return checkpoint

    new_cv = dict(cv)
    new_cv["messages"] = []
    if "ui_messages" in new_cv:
        new_cv["ui_messages"] = []
    out = dict(checkpoint)
    out["channel_values"] = new_cv
    return out


def _tid_from_cp_config(config: Any) -> tuple[str, str | None]:
    conf: dict[str, Any] = {}
    if isinstance(config, dict):
        raw = config.get("configurable")
        if isinstance(raw, dict):
            conf = raw
    tid = str(conf.get("thread_id") or "").strip()
    tr = str(conf.get("evf_trace_id") or "").strip() or None
    return tid, tr


def _emit_cp_io(event: str, config: Any, *, duration_ms: float, method: str) -> None:
    tid, tr = _tid_from_cp_config(config)
    if not tid:
        return
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        write_run_latency_event(
            tid,
            event,
            {"method": method, "duration_ms": round(duration_ms, 2)},
            trace_id=tr,
        )
    except Exception:
        pass


class OmitTranscriptCheckpointer:
    """Proxy saver: strip transcript on put/aput; time get/aget for blind-span logs."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def get(self, config: Any) -> Any:
        import time

        t0 = time.perf_counter()
        try:
            return self._inner.get(config)
        finally:
            _emit_cp_io(
                "checkpointer_get",
                config,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                method="get",
            )

    def get_tuple(self, config: Any) -> Any:
        import time

        t0 = time.perf_counter()
        try:
            return self._inner.get_tuple(config)
        finally:
            _emit_cp_io(
                "checkpointer_get",
                config,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                method="get_tuple",
            )

    async def aget(self, config: Any) -> Any:
        import time

        t0 = time.perf_counter()
        try:
            return await self._inner.aget(config)
        finally:
            _emit_cp_io(
                "checkpointer_get",
                config,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                method="aget",
            )

    async def aget_tuple(self, config: Any) -> Any:
        import time

        t0 = time.perf_counter()
        try:
            return await self._inner.aget_tuple(config)
        finally:
            _emit_cp_io(
                "checkpointer_get",
                config,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                method="aget_tuple",
            )

    def put(
        self,
        config: Any,
        checkpoint: Any,
        metadata: Any,
        new_versions: Any,
    ) -> Any:
        if omit_transcript_on_checkpoint_put_enabled() and isinstance(checkpoint, dict):
            checkpoint = omit_transcript_channels(checkpoint)
        return self._inner.put(config, checkpoint, metadata, new_versions)

    async def aput(
        self,
        config: Any,
        checkpoint: Any,
        metadata: Any,
        new_versions: Any,
    ) -> Any:
        if omit_transcript_on_checkpoint_put_enabled() and isinstance(checkpoint, dict):
            checkpoint = omit_transcript_channels(checkpoint)
        return await self._inner.aput(config, checkpoint, metadata, new_versions)

    # ------------------------------------------------------------------
    # Pass-through methods — explicitly declared so the LangGraph API
    # checkpointer capability detection (``_is_overridden`` at class level)
    # recognizes them. ``__getattr__`` is not consulted for class-level
    # ``getattr`` lookups, so without these definitions the adapter reports
    # ``has_adelete_thread=False`` and ``DELETE /threads/<id>`` raises
    # ``RuntimeError: Please implement adelete_thread …`` at the gateway
    # route level (e.g. session delete in chat_session_service).
    # ------------------------------------------------------------------
    async def aput_writes(
        self,
        config: Any,
        writes: Any,
        task_id: str,
        task_path: str = "",
    ) -> Any:
        return await self._inner.aput_writes(config, writes, task_id, task_path)

    async def alist(
        self,
        config: Any,
        *,
        filter: dict[str, Any] | None = None,
        before: Any = None,
        limit: int | None = None,
    ) -> Any:
        # ``alist`` is an async iterator; the return value is itself an
        # ``AsyncIterator[CheckpointTuple]`` (or compatible async generator),
        # NOT a coroutine, so we pass it through unchanged.
        return self._inner.alist(config, filter=filter, before=before, limit=limit)

    async def adelete_thread(self, thread_id: str) -> None:
        return await self._inner.adelete_thread(thread_id)

    async def adelete_for_runs(self, run_ids: Any) -> None:
        return await self._inner.adelete_for_runs(run_ids)

    async def acopy_thread(self, source_thread_id: str, target_thread_id: str) -> Any:
        return await self._inner.acopy_thread(source_thread_id, target_thread_id)

    async def aprune(
        self,
        thread_ids: Any,
        *,
        strategy: str = "keep_latest",
    ) -> Any:
        return await self._inner.aprune(thread_ids, strategy=strategy)

    async def aget_iter(self, config: Any) -> Any:
        # ``aget_iter`` is an async iterator on LangGraph's BaseCheckpointSaver.
        # Return the inner async generator directly (no await).
        return self._inner.aget_iter(config)
