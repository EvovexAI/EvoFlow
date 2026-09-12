"""Hydrate LangGraph runtime ``messages`` from ``evoflow_chat_messages`` when needed.

``evoflow_chat_messages`` remains the durable SSOT for UI / resume. On the **hot path**
(runtime ContextManager analogue) we trust in-memory / checkpoint messages after one
successful hydrate: append-only watermark advances must not force a full SQLite reload
every user turn. Rebuild only on cold cache, pending injects, compaction change, or a
**slim checkpoint** (``CheckpointTranscriptSlimMiddleware`` cleared prior history).
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime

from evoflow.agents.middleware_state import replace_messages_in_state
from evoflow.persistence.chat_message_content import (
    loads_payload,
    model_body_text,
    reasoning_text,
    tool_calls,
)
from evoflow.agents.middlewares.transcript_middleware import seed_transcript_written_ids
from evoflow.persistence.chat_message_repositories import (
    get_session_hydration_watermark,
    list_lead_chat_rows_for_model_hydration,
)

logger = logging.getLogger(__name__)


def hydration_cache_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_HYDRATION_CACHE") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


@dataclass(frozen=True)
class _HydrationCacheEntry:
    max_seq: int
    compaction_seq: int | None
    human_ids: frozenset[str]


_HYDRATION_CACHE_LOCK = threading.Lock()
_HYDRATION_CACHE: dict[str, _HydrationCacheEntry] = {}
_HYDRATION_CACHE_MAX = 256


def _trust_runtime_state_enabled() -> bool:
    """native-style: hot path trusts in-memory/LangGraph messages; SQLite is append+resume.

    Set ``EVOFLOW_HYDRATION_TRUST_RUNTIME=0`` to force full DB rebuild every turn (debug).
    """
    raw = (os.getenv("EVOFLOW_HYDRATION_TRUST_RUNTIME") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _hydration_cache_key(session_key: str, round_id: str | None) -> str:
    return f"{session_key}|{round_id or '-'}"


def clear_hydration_watermark_cache() -> None:
    """Test helper: drop process-local hydration fingerprints."""
    with _HYDRATION_CACHE_LOCK:
        _HYDRATION_CACHE.clear()


def _store_hydration_cache(cache_key: str, entry: _HydrationCacheEntry) -> None:
    with _HYDRATION_CACHE_LOCK:
        if cache_key in _HYDRATION_CACHE:
            _HYDRATION_CACHE.pop(cache_key, None)
        elif len(_HYDRATION_CACHE) >= _HYDRATION_CACHE_MAX:
            oldest = next(iter(_HYDRATION_CACHE))
            _HYDRATION_CACHE.pop(oldest, None)
        _HYDRATION_CACHE[cache_key] = entry


def _get_hydration_cache(cache_key: str) -> _HydrationCacheEntry | None:
    with _HYDRATION_CACHE_LOCK:
        return _HYDRATION_CACHE.get(cache_key)


def _drain_pending_injects_into_transcript(session_key: str, thread_id: str | None) -> int:
    """Atomically consume pending injects and write them into ``evoflow_chat_messages``.

    This runs *before* the main hydration query so the just-inserted rows are
    picked up by ``list_lead_chat_rows_for_model_hydration`` in the correct
    seq order. Returns the number of injected rows (0 if none pending).

    runtime analogue: drain ``TurnState.pending_input`` → record user prompt →
    emit ``ItemCompleted(UserMessage)``. We drain the process-local pending
    queue, write transcript + emit ``pending_inject_consumed`` for UI ack.
    """
    try:
        from evoflow.persistence.pending_inject_repository import consume_pending_injects
        from evoflow.persistence import chat_session_service as chat_svc
    except Exception:
        return 0

    sk = str(session_key or "").strip()
    if not sk:
        return 0

    # Bind consume to the active run when possible (Runtime: same turn_id).
    run_id: str | None = None
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        conf = cfg.get("configurable") if isinstance(cfg, dict) else None
        if isinstance(conf, dict):
            run_id = (
                str(conf.get("run_id") or conf.get("evf_run_id") or conf.get("thread_run_id") or "")
                .strip()
                or None
            )
    except Exception:
        run_id = None

    pending = consume_pending_injects(sk, consumed_by_run_id=run_id)
    if not pending:
        return 0

    appended = 0
    consumed_ids: list[str] = []
    for row in pending:
        try:
            payload = row.get("content_json") or {}
            result = chat_svc.append_message_and_touch_session(
                sk,
                role=str(row.get("role") or "user").strip().lower() or "user",
                content=payload,  # dict → chat_svc unpacks via content_json path
                run_id=row.get("run_id") or run_id,
                thread_id=thread_id or row.get("thread_id"),
                message_id=str(row.get("message_id") or "").strip() or None,
                tool_name=row.get("tool_name"),
            )
            if result is not None:
                appended += 1
                mid = str(row.get("message_id") or "").strip()
                if mid:
                    consumed_ids.append(mid)
        except Exception:
            logger.exception(
                "pending_inject: failed to write into transcript session=%s msg_id=%s",
                sk,
                row.get("message_id"),
            )
    if appended:
        logger.info(
            "pending_inject: drained %d rows into transcript session=%s",
            appended,
            sk,
        )
        _emit_pending_inject_consumed(
            session_key=sk,
            thread_id=thread_id or "",
            message_ids=consumed_ids,
            consumed_by_run_id=run_id,
        )
    return appended


def _emit_pending_inject_consumed(
    *,
    session_key: str,
    thread_id: str,
    message_ids: list[str],
    consumed_by_run_id: str | None,
) -> None:
    """Notify UI that steers entered transcript (runtime ItemCompleted(UserMessage) ack)."""
    if not message_ids:
        return
    payload = {
        "type": "pending_inject_consumed",
        "session_key": session_key,
        "message_ids": list(message_ids),
        "consumed_by_run_id": consumed_by_run_id,
    }
    tid = str(thread_id or "").strip()
    # Prefer injecting a direct EVF/AG-UI frame into the live stream (survives
    # stream_format=agui). Fall back to LangGraph custom writer when no thread.
    if tid:
        try:
            from app.gateway.streaming.session_stream_inject import schedule_inject_evf_frame

            schedule_inject_evf_frame(tid, {"__evf__": payload})
        except Exception:
            logger.debug(
                "pending_inject_consumed inject failed session=%s thread=%s",
                session_key,
                tid,
                exc_info=True,
            )
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        if writer is not None:
            writer(payload)
    except Exception:
        pass


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


def _session_key_for_thread(thread_id: str) -> str:
    if not thread_id:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return find_session_key_by_thread_id(thread_id) or ""
    except Exception:
        return ""


def _session_key_from_runtime(runtime: Runtime, thread_id: str = "") -> str:
    """Prefer runtime.context.session_key (proactive / employee), then thread lookup."""
    ctx = getattr(runtime, "context", None) or {}
    if isinstance(ctx, dict):
        sk = str(ctx.get("session_key") or "").strip()
        if sk:
            return sk
    tid = str(thread_id or "").strip() or _thread_id_from_runtime(runtime)
    return _session_key_for_thread(tid)


def _payload_for_row(row: dict[str, Any]) -> dict[str, Any]:
    if isinstance(row.get("payload"), dict):
        return row["payload"]
    return loads_payload(str(row.get("content_json") or ""))


def _content_for_lc(row: dict[str, Any]) -> Any:
    payload = _payload_for_row(row)
    body = payload.get("content")
    text = model_body_text(payload)
    if text and (body is None or body == "" or body == []):
        return text
    if body is not None:
        return body
    return text or ""


def lead_transcript_rows_to_lc_messages(rows: list[dict[str, Any]]) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import (
        _human_has_non_text_parts,
    )
    from evoflow.persistence.chat_message_content import _content_blocks_have_text

    out: list[BaseMessage] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        role = str(row.get("role") or "").strip().lower()
        payload = _payload_for_row(row)
        content = _content_for_lc(row)
        mid = str(row.get("message_id") or "").strip() or None
        if role == "user":
            if not content and content != 0:
                continue
            # Skip empty OpenAI-style parts: ``[{type:text,text:""}]`` (truthy list, no text).
            if not _content_blocks_have_text(content) and not _human_has_non_text_parts(content):
                continue
            uname = str(row.get("tool_name") or "").strip() or None
            kwargs: dict[str, Any] = {"content": content, "id": mid}
            if uname:
                kwargs["name"] = uname
            ctx_files = payload.get("contextFiles") or payload.get("context_files")
            if isinstance(ctx_files, list) and ctx_files:
                normalized = [
                    x for x in ctx_files if isinstance(x, dict) and str(x.get("path") or "").strip()
                ]
                if normalized:
                    kwargs["additional_kwargs"] = {"context_files": normalized}
            out.append(HumanMessage(**kwargs))
            continue
        if role == "assistant":
            tcalls = tool_calls(payload)
            if not content and not tcalls:
                continue
            kwargs: dict[str, Any] = {"content": content or "", "id": mid}
            if tcalls:
                kwargs["tool_calls"] = tcalls
            reason = reasoning_text(payload)
            if reason:
                kwargs["additional_kwargs"] = {"reasoning_content": reason}
            out.append(AIMessage(**kwargs))
            continue
        if role == "tool":
            tcid = str(row.get("tool_call_id") or "").strip()
            if not tcid:
                continue
            name = str(row.get("tool_name") or "tool").strip() or "tool"
            out.append(
                ToolMessage(
                    content=content if content is not None else "",
                    tool_call_id=tcid,
                    name=name,
                    id=mid,
                )
            )
    return out


def _proactive_hydration_round_id(runtime: Runtime, session_key: str) -> str | None:
    """Model hydration no longer scopes by ``round_id`` (always ``None``).

    Prior duty/employee chat scoped loads dumped up to 500 raw round rows and
    skipped compaction stitch, which re-inflated context and re-triggered
    compress. Transcript rows may still carry ``round_id`` for UI/telemetry;
    the model always sees ``[bridge][summary][tail]`` (or full tail).
    """
    _ = (runtime, session_key)
    return None


# Backward-compatible alias (tests / older imports)
def _proactive_duty_round_id(runtime: Runtime, session_key: str) -> str | None:
    return _proactive_hydration_round_id(runtime, session_key)


def load_model_messages_for_session(
    session_key: str,
    *,
    limit: int | None = None,
    round_id: str | None = None,
) -> list[BaseMessage]:
    """Same 3-part DB stitch as ``before_model`` hydration — SSOT for model-visible history."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    rows = list_lead_chat_rows_for_model_hydration(sk, limit=limit, round_id=round_id)
    if not rows:
        return []
    return lead_transcript_rows_to_lc_messages(rows)


def _human_message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict) and str(p.get("type") or "") == "text":
                parts.append(str(p.get("text") or ""))
        return "".join(parts)
    return str(content or "")


def _db_lc_has_compaction_summary(db_lc: list[BaseMessage]) -> bool:
    for m in db_lc:
        if isinstance(m, HumanMessage) and str(getattr(m, "name", None) or "").strip() == "conversation_summary":
            return True
    return False


def _is_injected_runtime_human_text(text: str) -> bool:
    t = str(text or "").strip()
    if not t:
        return True
    lower = t.lower()
    if lower.startswith("here is a summary of the conversation to date"):
        return True
    if lower.startswith("here's a summary of the conversation to date"):
        return True
    markers = (
        "[CONTEXT COMPACTION",
        "[上下文摘要",
        "[深度压缩摘要",
        "[MODEL_SWITCH]",
        "[重复探索",
        "[tool:history]",
        "[tool:summary]",
        "__evf_tool_approval_v1__:",
        "__evf_tool_approval_replay_v1__:",
    )
    return any(t.startswith(m) for m in markers)


def _lc_message_id(msg: Any) -> str:
    mid = str(getattr(msg, "id", None) or "").strip()
    if mid:
        return mid
    ak = getattr(msg, "additional_kwargs", None) or {}
    if isinstance(ak, dict):
        return str(ak.get("message_id") or "").strip()
    return ""


def _is_tool_approval_replay_human(msg: HumanMessage) -> bool:
    try:
        from evoflow.agents.tool_approval_service import parse_replay_message

        text = _human_message_text(getattr(msg, "content", None)).strip()
        return bool(parse_replay_message(text))
    except Exception:
        return False


def _collect_missing_state_humans(
    db_lc: list[BaseMessage],
    state_messages: list[Any] | None,
) -> list[HumanMessage]:
    """Optionally keep the *current turn* Human if transcript append has not landed yet.

    ``evoflow_chat_messages`` is the model-history SSOT. Do **not** re-merge historical
    Humans from the LangGraph checkpoint: older checkpoints often carry auto-ids that
    differ from transcript ``message_id``, which previously duplicated every past user
    turn onto the end of the hydrated list.

    Only the latest non-injected HumanMessage from state may be appended, and only when
    its id *and* text are both absent from the DB load (true in-flight race).
    """
    if _db_lc_has_compaction_summary(db_lc):
        return []

    db_ids = {_lc_message_id(m) for m in db_lc if _lc_message_id(m)}
    db_texts = {
        _human_message_text(getattr(m, "content", None)).strip()
        for m in db_lc
        if isinstance(m, HumanMessage)
    }

    last_human: HumanMessage | None = None
    for m in reversed(list(state_messages or [])):
        if not isinstance(m, HumanMessage):
            continue
        if _is_tool_approval_replay_human(m):
            continue
        text = _human_message_text(getattr(m, "content", None)).strip()
        if _is_injected_runtime_human_text(text):
            continue
        last_human = m
        break
    if last_human is None:
        return []

    mid = _lc_message_id(last_human)
    text = _human_message_text(getattr(last_human, "content", None)).strip()
    if mid and mid in db_ids:
        return []
    # Text already in transcript (id mismatch between LG input and append) → trust DB.
    if text and text in db_texts:
        return []
    return [last_human]


def _state_humans_missing_from_ids(
    state_messages: list[Any] | None,
    known_human_ids: frozenset[str],
) -> bool:
    """True when the *latest* state Human id is not in the last successful hydrate.

    Historical checkpoint Humans with foreign ids must not force perpetual rebuilds;
    only the current-turn in-flight Human matters for the watermark short-circuit.
    """
    for m in reversed(list(state_messages or [])):
        if not isinstance(m, HumanMessage):
            continue
        if _is_tool_approval_replay_human(m):
            continue
        text = _human_message_text(getattr(m, "content", None)).strip()
        if _is_injected_runtime_human_text(text):
            continue
        mid = _lc_message_id(m)
        if mid and mid not in known_human_ids:
            return True
        if not mid:
            return True
        return False
    return False


def _extract_tool_approval_replay_messages(messages: list[Any] | None) -> list[HumanMessage]:
    """Keep non-persisted replay markers across DB hydration (they are filtered from chat_messages)."""
    from evoflow.agents.tool_approval_service import parse_replay_message

    found: list[HumanMessage] = []
    for m in messages or []:
        if not isinstance(m, HumanMessage):
            continue
        text = _human_message_text(getattr(m, "content", None)).strip()
        if not parse_replay_message(text):
            continue
        if isinstance(m.content, str):
            found.append(m)
        else:
            found.append(
                m.model_copy(update={"content": text, "name": getattr(m, "name", None) or "tool_approval_resume"})
            )
    # Only the latest marker is needed for ToolApprovalReplayMiddleware.
    return found[-1:] if found else []


def _human_ids_from_messages(messages: list[BaseMessage]) -> frozenset[str]:
    ids: set[str] = set()
    for m in messages:
        if not isinstance(m, HumanMessage):
            continue
        mid = _lc_message_id(m)
        if mid:
            ids.add(mid)
    return frozenset(ids)


def checkpoint_messages_look_slim(state_messages: list[Any], max_seq: int | None) -> bool:
    """True when checkpoint only has this-turn input but DB already has history.

    After ``CheckpointTranscriptSlimMiddleware``, the latest checkpoint is empty (or
    just the new HumanMessage). Trusting that runtime would skip DB hydrate and the
    model would see only the latest user turn.
    """
    try:
        seq = int(max_seq or 0)
    except (TypeError, ValueError):
        seq = 0
    if seq <= 0:
        return False
    msgs = list(state_messages or [])
    ai_n = sum(1 for m in msgs if isinstance(m, AIMessage))
    # Cleared checkpoint + new input: no prior AI, but transcript has prior rows.
    if ai_n == 0 and seq >= 2:
        return True
    # Very short runtime vs watermark (e.g. 1 human + optional marker).
    if len(msgs) <= 2 and seq >= 4:
        return True
    return False


def prime_hydration_cache_for_session(
    session_key: str,
    *,
    round_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    """Warm process-local hydration watermark without starting a LangGraph run.

    Used by composer focus/type prefetch so the next ``before_model`` can skip a
    full rebuild when the transcript watermark is unchanged.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return {"ok": False, "primed": False, "reason": "session_key_required"}
    if not hydration_cache_enabled():
        return {"ok": True, "primed": False, "reason": "cache_disabled", "sessionKey": sk}

    tid = str(thread_id or "").strip() or None
    # Do NOT drain pending injects here. Composer prime only warms the watermark;
    # draining outside before_model can advance max_seq + cache so the next
    # before_model skips rebuild and the model never sees the steer in state.
    injected = 0
    max_seq, compaction_seq = get_session_hydration_watermark(sk)
    cache_key = _hydration_cache_key(sk, round_id)

    db_lc = load_model_messages_for_session(
        sk,
        round_id=round_id,
    )
    if not db_lc:
        # Empty transcript: still record watermark so a subsequent identical
        # empty hydrate can short-circuit.
        _store_hydration_cache(
            cache_key,
            _HydrationCacheEntry(
                max_seq=max_seq,
                compaction_seq=compaction_seq,
                human_ids=frozenset(),
            ),
        )
        return {
            "ok": True,
            "primed": True,
            "sessionKey": sk,
            "maxSeq": max_seq,
            "compactionSeq": compaction_seq,
            "dbMsgs": 0,
            "injected": injected,
        }

    if tid:
        seed_transcript_written_ids(tid, db_lc)

    max_seq_after, compaction_after = get_session_hydration_watermark(sk)
    _store_hydration_cache(
        cache_key,
        _HydrationCacheEntry(
            max_seq=max_seq_after,
            compaction_seq=compaction_after,
            human_ids=_human_ids_from_messages(db_lc),
        ),
    )
    logger.info(
        "session transcript hydration: primed cache session=%s max_seq=%s compaction_seq=%s db_msgs=%s injected=%s",
        sk,
        max_seq_after,
        compaction_after,
        len(db_lc),
        injected,
    )
    return {
        "ok": True,
        "primed": True,
        "sessionKey": sk,
        "maxSeq": max_seq_after,
        "compactionSeq": compaction_after,
        "dbMsgs": len(db_lc),
        "injected": injected,
    }


class SessionTranscriptHydrationMiddleware(AgentMiddleware[AgentState]):
    """Replace runtime history from ``evoflow_chat_messages`` before every model call."""

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        thread_id = _thread_id_from_runtime(runtime)
        session_key = _session_key_from_runtime(runtime, thread_id)
        if not session_key:
            return None

        state_messages = list(state.get("messages") or [])
        # Capture before wipe — replay markers are intentionally not written to chat_messages.
        replay_msgs = _extract_tool_approval_replay_messages(state_messages)

        # ── Drain pending injects (↑ mid-turn steering) into transcript ──
        # Must happen BEFORE the hydration query so the new rows get picked
        # up with correct seq ordering.
        injected = _drain_pending_injects_into_transcript(session_key, thread_id)

        cache_key = _hydration_cache_key(session_key, None)
        max_seq, compaction_seq = get_session_hydration_watermark(session_key)
        cached = _get_hydration_cache(cache_key) if hydration_cache_enabled() else None

        # After compaction, LangGraph checkpoints can still hold the full pre-compact
        # transcript. Never skip rebuild when state lacks conversation_summary but DB
        # watermark says a summary exists (stale checkpoint).
        from evoflow.agents.context_compaction_core import transcript_has_conversation_summary

        stale_checkpoint = bool(
            compaction_seq is not None
            and len(state_messages) >= 24
            and not transcript_has_conversation_summary(state_messages)
        )
        slim_checkpoint = checkpoint_messages_look_slim(state_messages, max_seq)

        can_skip = (
            hydration_cache_enabled()
            and injected == 0
            and cached is not None
            and cached.max_seq == max_seq
            and cached.compaction_seq == compaction_seq
            and not _state_humans_missing_from_ids(state_messages, cached.human_ids)
            and not stale_checkpoint
            and not slim_checkpoint
        )
        # runtime ContextManager analogue: after one successful hydrate, trust runtime
        # messages for subsequent turns even when DB watermark advanced (new user /
        # assistant rows). Only rebuild on compaction change, injects, or cold cache.
        # Never trust a slimmed checkpoint (messages cleared after_agent).
        trust_runtime = (
            _trust_runtime_state_enabled()
            and hydration_cache_enabled()
            and injected == 0
            and cached is not None
            and cached.compaction_seq == compaction_seq
            and not stale_checkpoint
            and not slim_checkpoint
            and len(state_messages) > 0
            and (
                cached.max_seq == max_seq
                or not _state_humans_missing_from_ids(state_messages, cached.human_ids)
                or any(isinstance(m, HumanMessage) for m in state_messages)
            )
        )
        if can_skip or trust_runtime:
            if trust_runtime and not can_skip and hydration_cache_enabled():
                # Watermark moved (append-only); refresh cache without SQLite full reload.
                _store_hydration_cache(
                    cache_key,
                    _HydrationCacheEntry(
                        max_seq=max_seq,
                        compaction_seq=compaction_seq,
                        human_ids=_human_ids_from_messages(state_messages)
                        or (cached.human_ids if cached else frozenset()),
                    ),
                )
            logger.info(
                "session transcript hydration: skip rebuild (%s) thread=%s session=%s "
                "max_seq=%s compaction_seq=%s state_msgs=%s",
                "watermark hit" if can_skip else "trust runtime",
                thread_id,
                session_key,
                max_seq,
                compaction_seq,
                len(state_messages),
            )
            return None

        # Single DB pass (avoid list_rows + load_model_messages double query).
        db_lc = load_model_messages_for_session(session_key)
        if not db_lc:
            return None

        seed_transcript_written_ids(thread_id, db_lc)

        merged = list(db_lc)
        missing_humans = _collect_missing_state_humans(db_lc, state_messages)
        if missing_humans:
            merged.extend(missing_humans)
            logger.info(
                "session transcript hydration: merged %d in-flight human(s) from state thread=%s session=%s",
                len(missing_humans),
                thread_id,
                session_key,
            )
        if replay_msgs:
            merged.extend(replay_msgs)
            logger.info(
                "session transcript hydration: re-append tool-approval replay marker thread=%s session=%s",
                thread_id,
                session_key,
            )

        # Re-read watermark after load (inject/append may have advanced seq).
        max_seq_after, compaction_after = get_session_hydration_watermark(session_key)
        if hydration_cache_enabled():
            _store_hydration_cache(
                cache_key,
                _HydrationCacheEntry(
                    max_seq=max_seq_after,
                    compaction_seq=compaction_after,
                    human_ids=_human_ids_from_messages(merged),
                ),
            )

        logger.info(
            "session transcript hydration: replace runtime from chat_messages thread=%s session=%s "
            "state_msgs=%s db_msgs=%s compaction_seq=%s injected=%s stale_checkpoint=%s",
            thread_id,
            session_key,
            len(state_messages),
            len(db_lc),
            compaction_after,
            injected,
            stale_checkpoint,
        )
        return replace_messages_in_state(merged)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
