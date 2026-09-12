"""Middleware that persists AI/tool messages to ``evoflow_chat_messages`` in real-time.

Covers all invocation paths: Gateway HTTP SSE, Embedded Client, Channel, Automation.
Replaces the Gateway-layer SSE transcript tap for persistence, ensuring transcript
data survives stream interruptions regardless of how the agent was invoked.

**Interruption recovery**: ``awrap_model_call`` / ``wrap_model_call`` inject a
``StreamAccumulatorHandler`` callback into the model invocation.  On normal
completion the accumulator is discarded (``after_model`` writes the complete
message).  On cancellation / error the accumulated partial content is flushed
to ``evoflow_chat_messages`` so partial AI output survives mid-stream interrupts.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware, ModelRequest
from langchain.agents.middleware.types import ModelCallResult
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from evoflow.agents.middlewares.stream_accumulator import (
    StreamAccumulatorHandler,
    _all_accumulators,
    _clear_all_accumulators,
)

logger = logging.getLogger(__name__)


def _thread_id_from_runtime(runtime: Runtime) -> str:
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        tid = ctx.get("thread_id")
        if tid:
            return str(tid).strip()
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return ""


def _parent_thread_id_from_runtime(runtime: Runtime | None) -> str | None:
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        p = ctx.get("parent_thread_id")
        if p:
            return str(p).strip() or None
    try:
        from langgraph.config import get_config

        p = str(get_config().get("configurable", {}).get("parent_thread_id") or "").strip()
        if p:
            return p
    except Exception:
        pass
    tid = _thread_id_from_runtime(runtime)
    if not tid:
        return None
    from evoflow.persistence.chat_message_repositories import resolve_parent_thread_id

    return resolve_parent_thread_id(tid)


def _round_id_from_runtime(runtime: Runtime | None) -> str | None:
    """Proactive duty ``round_id`` from runtime.context / configurable."""
    if runtime is not None:
        try:
            from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

            ctx = runtime_context_mapping(runtime)
            rid = str(ctx.get("round_id") or ctx.get("proactive_round_id") or "").strip()
            if rid:
                return rid
        except Exception:
            pass
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else None
        if isinstance(cfg, dict):
            rid = str(cfg.get("round_id") or cfg.get("proactive_round_id") or "").strip()
            if rid:
                return rid
    except Exception:
        pass
    return None


def _principal_id_from_runtime(runtime: Runtime | None) -> str | None:
    try:
        from evoflow.authz.runtime_identity import principal_id_from_runtime

        return principal_id_from_runtime(runtime)
    except Exception:
        return None


def _round_id_from_session_context(session_key: str) -> str | None:
    """Fallback: session.context.proactive_round_id (latest duty round)."""
    sk = str(session_key or "").strip()
    if not sk.startswith("proactive:"):
        return None
    try:
        from evoflow.persistence import session_repositories as sess_repo

        row = sess_repo.load_session_map().get(sk) or {}
        ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
        return str(ctx.get("proactive_round_id") or "").strip() or None
    except Exception:
        return None


def _session_key_for_thread(thread_id: str) -> str:
    if not thread_id:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = find_session_key_by_thread_id(thread_id) or ""
        if sk:
            return sk
        # Workflow / no-lead SubThread_* and {lead}__sub__* with missing lead session
        from evoflow.collab.thread_ids import is_collab_executor_thread, lead_thread_from_executor_thread
        from evoflow.persistence.chat_session_service import ensure_executor_transcript_session

        tid = str(thread_id or "").strip()
        if not is_collab_executor_thread(tid):
            return ""
        return (
            ensure_executor_transcript_session(
                tid,
                lead_thread_id=lead_thread_from_executor_thread(tid),
            )
            or ""
        )
    except Exception:
        return ""


def _bind_mirror_model_bridge(runtime: Runtime) -> None:
    """Context for model-callback mirror bridge (middle layer below Gateway SSE)."""
    try:
        from app.gateway.streaming.stream_mirror_model_bridge import (
            clear_mirror_model_ctx,
            set_mirror_model_ctx,
        )
    except Exception:
        return
    tid = _thread_id_from_runtime(runtime)
    if not tid:
        clear_mirror_model_ctx()
        return
    sk = _session_key_for_thread(tid)
    rid = _run_id_for_transcript(tid, sk) if sk else None
    set_mirror_model_ctx(
        thread_id=tid,
        session_key=sk or None,
        run_id=rid,
        message_id=f"{tid}:live",
        stream_kind="text",
    )


def _run_id_for_transcript(thread_id: str, session_key: str) -> str | None:
    from evoflow.persistence.transcript_run_id import resolve_run_id_for_transcript

    return resolve_run_id_for_transcript(
        session_key,
        role="assistant",
        thread_id=thread_id,
    )


# Per-thread set of already-persisted message IDs (in-memory dedup).
# Capped to prevent unbounded memory growth in long-running processes.
_written_message_ids: dict[str, set[str]] = {}
_WRITTEN_IDS_MAX_PER_THREAD = 2000
_WRITTEN_IDS_MAX_THREADS = 500


def _register_written_id(thread_id: str, mid: str) -> None:
    """Track a persisted message ID, evicting old entries to bound memory."""
    if not thread_id or not mid:
        return
    written = _written_message_ids.get(thread_id)
    if written is None:
        if len(_written_message_ids) >= _WRITTEN_IDS_MAX_THREADS:
            # Evict the oldest thread entry (dict preserves insertion order).
            oldest = next(iter(_written_message_ids))
            _written_message_ids.pop(oldest, None)
        written = set()
        _written_message_ids[thread_id] = written
    if mid in written:
        return
    if len(written) >= _WRITTEN_IDS_MAX_PER_THREAD:
        # Evict ~20% oldest entries (set is unordered, but this bounds growth).
        for _ in range(_WRITTEN_IDS_MAX_PER_THREAD // 5):
            written.pop()
    written.add(mid)


def seed_transcript_written_ids(thread_id: str, messages: list[Any]) -> None:
    """Mark DB-hydrated AI/tool rows as already persisted so after_model only writes new ones."""
    tid = str(thread_id or "").strip()
    if not tid or not messages:
        return
    for msg in messages:
        if not isinstance(msg, (AIMessage, ToolMessage)):
            continue
        mid_s = str(getattr(msg, "id", None) or "").strip()
        if mid_s:
            _register_written_id(tid, mid_s)


def persist_transcript_tool_message_now(
    runtime: Runtime | None,
    tool_message: ToolMessage,
    *,
    thread_id: str | None = None,
    message_id_prefix: str = "gate-tool",
) -> bool:
    """Write one ToolMessage to ``evoflow_chat_messages`` immediately.

    For **human-gate** tools that end the graph turn with ``Command(..., goto=END)``:
    the ToolMessage must land in the transcript **before** the user's next message is
    appended, otherwise hydration order breaks.

    See ``HUMAN_GATE_TOOL_KINDS`` in ``human_gate_tools.py``.
    """
    tid = str(thread_id or "").strip() or _thread_id_from_runtime(runtime)  # type: ignore[arg-type]
    if not tid:
        return False
    session_key = _session_key_for_thread(tid)
    if not session_key:
        return False

    tcid = str(getattr(tool_message, "tool_call_id", None) or "").strip()
    mid_s = str(getattr(tool_message, "id", None) or "").strip()
    prefix = str(message_id_prefix or "gate-tool").strip() or "gate-tool"
    if not mid_s and tcid:
        mid_s = f"{prefix}-{tcid}"

    written = _written_message_ids.get(tid, set())
    if mid_s and mid_s in written:
        return False

    msg_dict = TranscriptMiddleware._message_to_dict(tool_message)
    if mid_s:
        msg_dict["id"] = mid_s

    try:
        rid = _run_id_for_transcript(tid, session_key)
        from evoflow.persistence.chat_message_repositories import resolve_parent_thread_id

        TranscriptMiddleware._append_transcript_batch(
            session_key,
            [msg_dict],
            thread_id=tid,
            run_id=rid,
            parent_thread_id=resolve_parent_thread_id(tid),
        )
        if mid_s:
            _register_written_id(tid, mid_s)
        logger.info(
            "persisted ask_clarification tool transcript thread=%s tool_call_id=%s",
            tid,
            tcid or "?",
        )
        return True
    except Exception:
        logger.debug(
            "persist ask_clarification tool transcript failed thread=%s",
            tid,
            exc_info=True,
        )
        return False


def _persist_platform_artifact_from_tool(
    request: ToolCallRequest,
    result: ToolMessage,
    *,
    session_key: str,
    thread_id: str,
) -> None:
    """Persist successful platform write feedback into session artifacts (type=platform)."""
    tc = request.tool_call if isinstance(getattr(request, "tool_call", None), dict) else {}
    tool_name = str(tc.get("name") or "").strip().lower()
    if tool_name != "platform":
        return
    raw = getattr(result, "content", None)
    if raw is None:
        return
    text = raw if isinstance(raw, str) else str(raw)
    text = text.strip()
    if not text:
        return
    try:
        payload = json.loads(text)
    except Exception:
        return
    if not isinstance(payload, dict) or not payload.get("ok") or payload.get("pending_confirm"):
        return
    ui = payload.get("ui")
    if not isinstance(ui, dict):
        return
    tcid = str(getattr(result, "tool_call_id", None) or tc.get("id") or "").strip()
    try:
        from evoflow.admin.platform_ui_feedback import platform_ui_to_chat_artifact
        from evoflow.persistence.artifact_repositories import upsert_artifacts

        item = platform_ui_to_chat_artifact(
            ui,
            tool_call_id=tcid,
            action=str(payload.get("action") or ""),
        )
        if item:
            upsert_artifacts(session_key, thread_id, [item])
    except Exception:
        logger.debug(
            "transcript persist platform artifact failed thread=%s tool_call_id=%s",
            thread_id,
            tcid,
            exc_info=True,
        )


class TranscriptMiddleware(AgentMiddleware[AgentState]):
    """Persist AI/tool messages and business data to independent tables.

    **after_model** — persists new assistant messages after each successful model call.

    **wrap_tool_call** — persists each ToolMessage immediately after tool execution so
    ``SessionTranscriptHydrationMiddleware`` can rebuild model context from DB alone.

    Both paths share ``_written_message_ids`` for in-memory dedup, and
    ``append_message`` provides DB-level ``message_id`` dedup as a safety net.
    """

    def before_model(
        self,
        state: AgentState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        """Mark session turn active before each model call."""
        self._mark_run_active(runtime)
        self._persist_artifacts(state, runtime)
        return None

    async def abefore_model(
        self,
        state: AgentState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        self.before_model(state, runtime)
        return None

    def after_model(
        self,
        state: AgentState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        """Persist new messages after each successful model call."""
        self._persist_messages(state, runtime)
        self._persist_artifacts(state, runtime)
        self._write_mirror_if_disconnected(state, runtime)
        return None

    async def aafter_model(
        self,
        state: AgentState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        # Run sync SQLite persistence in a worker thread so the event loop
        # is never blocked by message/artifact INSERTs after each model call.
        await asyncio.to_thread(self.after_model, state, runtime)
        return None

    @classmethod
    def flush_messages_now(cls, state: AgentState, runtime: Runtime) -> None:
        """Persist pending AI/tool rows (e.g. before ``jump_to`` short-circuits after_model chain)."""
        cls()._persist_messages(state, runtime)

    def _persist_tool_result_now(self, request: ToolCallRequest, result: ToolMessage | Any) -> None:
        # Multiple middlewares (DeferredToolFilterMiddleware for tool_search/scenario,
        # ToolApprovalMiddleware for batched approved tools, setup_agent_tool) may
        # return a Command wrapping one or more ToolMessages instead of a bare
        # ToolMessage. Extract ALL ToolMessages so they reach evoflow_chat_messages;
        # otherwise SessionTranscriptHydrationMiddleware rebuilds state.messages from
        # DB and loses un-persisted ToolMessages, triggering DanglingToolCallMiddleware
        # to inject "interrupted" placeholders.
        if isinstance(result, Command):
            update = getattr(result, "update", None)
            tool_msgs = (
                [m for m in (update.get("messages") or []) if isinstance(m, ToolMessage)]
                if isinstance(update, dict)
                else []
            )
        elif isinstance(result, ToolMessage):
            tool_msgs = [result]
        else:
            return

        for msg in tool_msgs:
            self._persist_one_tool_message(request, msg)

    def _persist_one_tool_message(self, request: ToolCallRequest, result: ToolMessage) -> None:
        runtime = getattr(request, "runtime", None)
        if runtime is None:
            return
        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return
        tcid = str(getattr(result, "tool_call_id", None) or "").strip()
        mid_s = str(getattr(result, "id", None) or "").strip()
        if not mid_s and tcid:
            mid_s = f"tool-{tcid}"
        if mid_s and mid_s in _written_message_ids.get(thread_id, set()):
            return
        session_key = _session_key_for_thread(thread_id)
        if not session_key:
            return
        msg_dict = self._message_to_dict(result)
        if mid_s:
            msg_dict["id"] = mid_s
            _register_written_id(thread_id, mid_s)
        self._append_transcript_batch(
            session_key,
            [msg_dict],
            thread_id=thread_id,
            run_id=_run_id_for_transcript(thread_id, session_key),
            parent_thread_id=_parent_thread_id_from_runtime(runtime),
            round_id=_round_id_from_runtime(runtime),
            principal_id=_principal_id_from_runtime(runtime),
        )
        _persist_platform_artifact_from_tool(
            request,
            result,
            session_key=session_key,
            thread_id=thread_id,
        )

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Any],
    ) -> ToolMessage | Any:
        result = handler(request)
        self._persist_tool_result_now(request, result)
        return result

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Any]],
    ) -> ToolMessage | Any:
        result = await handler(request)
        await asyncio.to_thread(self._persist_tool_result_now, request, result)
        return result

    # ------------------------------------------------------------------
    # Stream interruption recovery: capture partial tokens via callback
    # ------------------------------------------------------------------

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelCallResult]],
    ) -> ModelCallResult:
        """Wrap model invocation to capture partial content on cancellation.

        Injects a ``StreamAccumulatorHandler`` into the model's callbacks.
        On normal completion the accumulator is discarded (``after_model``
        persists the full message).  On cancellation/error the accumulated
        partial tokens are flushed to ``evoflow_chat_messages``.
        """
        if not hasattr(self, "_acc_handler"):
            self._acc_handler = StreamAccumulatorHandler()
        if not hasattr(self, "_mirror_token_handler"):
            try:
                from app.gateway.streaming.stream_mirror_model_bridge import MirrorStreamTokenCallback

                self._mirror_token_handler = MirrorStreamTokenCallback()
            except Exception:
                self._mirror_token_handler = None

        _bind_mirror_model_bridge(request.runtime)
        model = request.model
        original = getattr(model, "callbacks", None)
        injected = False
        extra = [self._acc_handler]
        if getattr(self, "_mirror_token_handler", None) is not None:
            extra.append(self._mirror_token_handler)
        try:
            if original is not None:
                if isinstance(original, list):
                    model.callbacks = [*original, *extra]
                else:
                    model.callbacks = [original, *extra]
            else:
                model.callbacks = list(extra)
            injected = True

            return await handler(request)
        except BaseException as exc:
            self._flush_partial_content(request, exc)
            raise
        finally:
            try:
                from app.gateway.streaming.stream_mirror_model_bridge import clear_mirror_model_ctx

                clear_mirror_model_ctx()
            except Exception:
                pass
            if injected:
                if original is not None:
                    model.callbacks = original
                else:
                    model.callbacks = None

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelCallResult],
    ) -> ModelCallResult:
        """Sync version of :meth:`awrap_model_call`."""
        if not hasattr(self, "_acc_handler"):
            self._acc_handler = StreamAccumulatorHandler()
        if not hasattr(self, "_mirror_token_handler"):
            try:
                from app.gateway.streaming.stream_mirror_model_bridge import MirrorStreamTokenCallback

                self._mirror_token_handler = MirrorStreamTokenCallback()
            except Exception:
                self._mirror_token_handler = None

        _bind_mirror_model_bridge(request.runtime)
        model = request.model
        original = getattr(model, "callbacks", None)
        injected = False
        extra = [self._acc_handler]
        if getattr(self, "_mirror_token_handler", None) is not None:
            extra.append(self._mirror_token_handler)
        try:
            if original is not None:
                if isinstance(original, list):
                    model.callbacks = [*original, *extra]
                else:
                    model.callbacks = [original, *extra]
            else:
                model.callbacks = list(extra)
            injected = True

            return handler(request)
        except BaseException as exc:
            self._flush_partial_content(request, exc)
            raise
        finally:
            try:
                from app.gateway.streaming.stream_mirror_model_bridge import clear_mirror_model_ctx

                clear_mirror_model_ctx()
            except Exception:
                pass
            if injected:
                if original is not None:
                    model.callbacks = original
                else:
                    model.callbacks = None

    def _flush_partial_content(
        self,
        request: ModelRequest,
        exc: BaseException,
    ) -> None:
        """Flush any accumulated partial tokens to ``evoflow_chat_messages``."""
        accumulators = _all_accumulators()
        if not accumulators:
            return

        thread_id = _thread_id_from_runtime(request.runtime)
        if not thread_id:
            _clear_all_accumulators()
            return
        session_key = _session_key_for_thread(thread_id)
        if not session_key:
            _clear_all_accumulators()
            return

        for run_id_str, tokens in accumulators.items():
            content = "".join(tokens)
            if not content:
                continue

            partial_msg: dict[str, Any] = {
                "id": f"partial_{run_id_str}",
                "role": "assistant",
                "type": "AIMessage",
                "content": content,
                "partial": True,
            }
            from evoflow.persistence.transcript_resume_anchor import (
                build_prior_turn_isolation_anchor,
                strip_assistant_message_dict_for_turn_isolation,
            )

            anchor = build_prior_turn_isolation_anchor(session_key)
            if anchor.get("priorTurnBody") or anchor.get("priorTurnReasoning"):
                partial_msg = strip_assistant_message_dict_for_turn_isolation(
                    partial_msg,
                    body=str(anchor.get("priorTurnBody") or ""),
                    reasoning=str(anchor.get("priorTurnReasoning") or ""),
                )

            self._append_transcript_batch(
                session_key,
                [partial_msg],
                thread_id=thread_id,
                run_id=_run_id_for_transcript(thread_id, session_key),
                parent_thread_id=_parent_thread_id_from_runtime(request.runtime),
                round_id=_round_id_from_runtime(request.runtime),
                principal_id=_principal_id_from_runtime(request.runtime),
            )
            logger.info(
                "Persisted partial AI content (%d chars) thread=%s on %s",
                len(content),
                thread_id,
                type(exc).__name__,
            )

        _clear_all_accumulators()

    # ------------------------------------------------------------------
    # Run status (session row)
    # ------------------------------------------------------------------

    def _mark_run_active(self, runtime: Runtime) -> None:
        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return
        session_key = _session_key_for_thread(thread_id)
        if not session_key:
            return
        rid = _run_id_for_transcript(thread_id, session_key)
        if not rid:
            return
        try:
            from evoflow.persistence.session_run_state import peek_current_run_id
            from evoflow.session_execution.lifecycle import start_session_turn

            # Tool hops may see a new LangGraph configurable.run_id each model call.
            # Keep session current_run_id stable for the whole user turn so compaction
            # same_run / turn_run_id detection does not re-arm compress every hop.
            existing = peek_current_run_id(session_key=session_key, thread_id=thread_id)
            if existing:
                rid = existing
            start_session_turn(session_key=session_key, thread_id=thread_id, run_id=rid, source="model_step")
        except Exception:
            logger.debug("mark run active before model failed thread=%s", thread_id, exc_info=True)

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    @staticmethod
    def _append_transcript_batch(
        session_key: str,
        messages: list[dict[str, Any]],
        *,
        thread_id: str,
        run_id: str | None = None,
        parent_thread_id: str | None = None,
        round_id: str | None = None,
        principal_id: str | None = None,
    ) -> None:
        """Unified transcript batch write — eliminates repeated import + param assembly."""
        if not messages:
            return
        try:
            from evoflow.persistence.chat_message_repositories import resolve_parent_thread_id
            from evoflow.persistence.chat_session_service import (
                append_messages_batch_and_touch_session,
            )

            rid = run_id or _run_id_for_transcript(thread_id, session_key)
            if rid:
                for item in messages:
                    if isinstance(item, dict) and not str(item.get("run_id") or item.get("runId") or "").strip():
                        item["run_id"] = rid
            round_rid = str(round_id or "").strip() or _round_id_from_session_context(session_key)
            if round_rid:
                for item in messages:
                    if isinstance(item, dict) and not str(
                        item.get("round_id") or item.get("roundId") or ""
                    ).strip():
                        item["round_id"] = round_rid
            parent_tid = str(parent_thread_id or "").strip() or resolve_parent_thread_id(thread_id)
            pid = str(principal_id or "").strip() or None
            if not pid:
                try:
                    from evoflow.authz.runtime_identity import resolve_identity_from_session

                    pid = resolve_identity_from_session(session_key).get("principal_id")
                except Exception:
                    pid = None
            append_messages_batch_and_touch_session(
                session_key,
                messages,
                thread_id=thread_id,
                parent_thread_id=parent_tid,
                run_id=rid,
                round_id=round_rid,
                skip_if_seq_exists=True,
                principal_id=pid,
            )
        except Exception:
            logger.debug(
                "transcript batch persist failed thread=%s", thread_id, exc_info=True
            )

    def _persist_messages(self, state: AgentState, runtime: Runtime) -> None:
        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return
        session_key = _session_key_for_thread(thread_id)
        if not session_key:
            return
        parent_thread_id = _parent_thread_id_from_runtime(runtime)

        messages = state.get("messages") or []

        new_msgs: list[dict[str, Any]] = []
        written = _written_message_ids.get(thread_id, set())

        for msg in messages:
            if not isinstance(msg, (AIMessage, ToolMessage)):
                continue
            mid = getattr(msg, "id", None)
            mid_s = str(mid).strip() if mid else ""
            if mid_s and mid_s in written:
                continue
            if isinstance(msg, AIMessage):
                from evoflow.persistence.chat_message_content import ai_message_has_visible_output

                if not ai_message_has_visible_output(msg):
                    logger.debug(
                        "Skip persisting empty AI message thread=%s msg_id=%s",
                        thread_id,
                        mid_s,
                    )
                    if mid_s:
                        _register_written_id(thread_id, mid_s)
                    continue
            if mid_s:
                _register_written_id(thread_id, mid_s)
            new_msgs.append(self._message_to_dict(msg))

        if not new_msgs:
            return

        self._append_transcript_batch(
            session_key,
            new_msgs,
            thread_id=thread_id,
            parent_thread_id=parent_thread_id,
            round_id=_round_id_from_runtime(runtime),
            principal_id=_principal_id_from_runtime(runtime),
        )

    # ------------------------------------------------------------------
    # Artifacts
    # ------------------------------------------------------------------

    def _persist_artifacts(self, state: AgentState, runtime: Runtime) -> None:
        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return
        session_key = _session_key_for_thread(thread_id)
        if not session_key:
            return

        artifacts = state.get("artifacts")
        if isinstance(artifacts, list):
            try:
                from evoflow.persistence.artifact_repositories import save_artifacts

                save_artifacts(session_key, thread_id, artifacts)
            except Exception:
                logger.debug(
                    "transcript persist artifacts failed thread=%s",
                    thread_id,
                    exc_info=True,
                )

    # ------------------------------------------------------------------
    # Mirror writing when client disconnected (ASGI inactive)
    # ------------------------------------------------------------------

    # Per-run dedup: f"{thread_id}:{run_id}" already wrote a terminal frame.
    _mirror_terminal_written: set[str] = set()
    # Per-thread: background mirror writer launched after ASGI disconnect.
    _mirror_bg_launched: set[str] = set()

    def _write_mirror_if_disconnected(self, state: AgentState, runtime: Runtime) -> None:
        """当客户端断连（ASGI 不活跃）时，写入终止帧让续流触发 runCompleted。

        after_model 在每次 model 调用后被 create_agent 保证调用。
        如果此时 ASGI middleware 不活跃（客户端已断连），说明 SSE 管道已断。

        Mirror delta 由 Gateway ASGI 统一写入；此处只写终止帧（event:done / data:[DONE]），让续流检测到终止后
        从 DB 加载完整消息（runCompleted），格式自然正确。
        """
        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return

        # 检查 ASGI 是否活跃（客户端是否还连着）
        try:
            from app.gateway.streaming.stream_middle_layer import middle_layer_covers_thread

            if middle_layer_covers_thread(thread_id):
                return
            from app.gateway.routers.langgraph_proxy import _active_stream_proxies

            asgi_active = thread_id in _active_stream_proxies
        except Exception:
            asgi_active = False

        if asgi_active:
            # 客户端还连着 → ASGI 在写 mirror → 不需要这里写
            return

        # 客户端已断连 → 需要写终止帧
        session_key = _session_key_for_thread(thread_id)
        if not session_key:
            return

        rid = _run_id_for_transcript(thread_id, session_key)
        if not rid:
            return

        # 同一 run 只写一次终止帧
        term_key = f"{thread_id}:{rid}"
        if term_key in self._mirror_terminal_written:
            return

        # 找最后一条 AI 消息
        messages = state.get("messages") or []
        last_ai_msg: AIMessage | None = None
        for msg in reversed(messages):
            if isinstance(msg, AIMessage):
                last_ai_msg = msg
                break

        if not last_ai_msg:
            return

        # 如果 AI 消息含 tool_calls，说明 agent 还要继续执行工具，不能写终止帧
        has_tool_calls = bool(getattr(last_ai_msg, "tool_calls", None))
        if has_tool_calls:
            return

        # 写入终止帧 — 让续流检测到终止后从 DB 加载完整消息（runCompleted）
        try:
            from evoflow.persistence.stream_mirror_repositories import append_mirror_frame

            terminal_wire = "event: done\ndata: [DONE]\n\n"
            append_mirror_frame(
                session_key,
                thread_id=thread_id,
                run_id=rid,
                raw_frame=terminal_wire,
                is_terminal=True,
            )
            self._mirror_terminal_written.add(term_key)
        except Exception:
            logger.debug("[镜像回调] 终止帧写入失败 thread=%s", thread_id, exc_info=True)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _message_to_dict(msg: AIMessage | ToolMessage) -> dict[str, Any]:
        """Convert LangChain message to a dict compatible with
        ``append_messages_batch`` (same shape as checkpoint serialization)."""
        result: dict[str, Any] = {
            "id": getattr(msg, "id", None),
            "role": "assistant" if isinstance(msg, AIMessage) else "tool",
            "type": type(msg).__name__,
            "content": getattr(msg, "content", ""),
        }

        if isinstance(msg, AIMessage):
            tool_calls = getattr(msg, "tool_calls", None)
            if tool_calls:
                result["tool_calls"] = tool_calls
            usage = getattr(msg, "usage_metadata", None)
            if usage:
                result["usage_metadata"] = usage
            resp_meta = getattr(msg, "response_metadata", None)
            if resp_meta:
                result["response_metadata"] = resp_meta
            ak = getattr(msg, "additional_kwargs", None)
            if ak:
                result["additional_kwargs"] = ak
            name = getattr(msg, "name", None)
            if name:
                result["name"] = name

        if isinstance(msg, ToolMessage):
            tcid = getattr(msg, "tool_call_id", None)
            if tcid:
                result["tool_call_id"] = tcid
            name = getattr(msg, "name", None)
            if name:
                result["name"] = name
            status = getattr(msg, "status", None)
            if status:
                result["status"] = status

        for attr in ("run_id", "runId"):
            val = getattr(msg, attr, None)
            if isinstance(val, str) and val.strip():
                result["run_id"] = val.strip()
                break
        ak = getattr(msg, "additional_kwargs", None)
        if isinstance(ak, dict):
            for attr in ("run_id", "runId"):
                val = ak.get(attr)
                if isinstance(val, str) and val.strip():
                    result["run_id"] = val.strip()
                    break

        return result
