"""In-memory user request log — survives context compression, injected into system prompt.

Why in-memory (not DB):
  * The async mission_state queue creates fresh ``MissionState`` objects from LLM
    analysis and saves them — a DB-stored ``user_requests`` field would be
    overwritten on every analysis cycle.
  * User messages are already persisted in ``evoflow_chat_messages``; this store
    is a lightweight pointer for "which recent user messages to surface in the
    system prompt so the model doesn't lose track after compression".
  * Survives context compression (injected into system prompt, not conversation
    history). Does not survive process restart — acceptable, since the main
    concern is compression, not restarts.
"""

from __future__ import annotations

import threading

# Temporarily off: do not capture user text or inject <user_requests> onto mind-map prompt.
USER_REQUESTS_PROMPT_INJECTION_ENABLED = False

_MAX_ENTRIES = 10
_MAX_TEXT_CHARS = 500

_store: dict[str, list[dict[str, str]]] = {}
_lock = threading.Lock()


def append_user_request(thread_id: str, text: str) -> None:
    """Append a user message (truncated) to the per-thread FIFO log."""
    if not USER_REQUESTS_PROMPT_INJECTION_ENABLED:
        return
    tid = str(thread_id or "").strip()
    raw = str(text or "").strip()
    if not tid or not raw:
        return
    from evoflow.persistence.timestamps import now_iso_z

    entry = {
        "text": raw[:_MAX_TEXT_CHARS],
        "ts": now_iso_z()[11:16],  # Beijing ISO "2026-06-27T09:36:00+08:00" → "09:36"
    }
    with _lock:
        entries = _store.get(tid, [])
        # Dedup: skip if identical to the last entry (tool-loop re-entry).
        if entries and entries[-1]["text"] == entry["text"]:
            return
        entries.append(entry)
        if len(entries) > _MAX_ENTRIES:
            entries = entries[-_MAX_ENTRIES:]
        _store[tid] = entries


def get_user_requests(thread_id: str) -> list[dict[str, str]]:
    """Return the user request log for this thread.

    Memory first; if empty or incomplete (e.g. after process restart), merge
    with DB (``evoflow_chat_messages``) to recover full history.  Dedup by text.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    with _lock:
        mem_entries = list(_store.get(tid, []))

    # Case 1: memory empty — pure DB fallback, warm cache.
    if not mem_entries:
        try:
            from evoflow.persistence.chat_message_repositories import list_recent_real_user_texts

            db_entries = list_recent_real_user_texts(thread_id=tid, limit=_MAX_ENTRIES)
            if db_entries:
                with _lock:
                    _store[tid] = list(db_entries)
                return list(db_entries)
        except Exception:
            pass
        return []

    # Case 2: memory has entries but may be incomplete (e.g. restart with
    # only the latest 1-2 messages).  Merge DB history, dedup by text.
    if len(mem_entries) < _MAX_ENTRIES:
        try:
            from evoflow.persistence.chat_message_repositories import list_recent_real_user_texts

            db_entries = list_recent_real_user_texts(thread_id=tid, limit=_MAX_ENTRIES)
            if db_entries:
                mem_texts = {e.get("text", "") for e in mem_entries}
                # DB entries are older; mem entries are newer.  Append mem
                # after DB, then keep the last _MAX_ENTRIES.
                merged = [e for e in db_entries if e.get("text", "") not in mem_texts]
                merged.extend(mem_entries)
                merged = merged[-_MAX_ENTRIES:]
                with _lock:
                    _store[tid] = list(merged)
                return list(merged)
        except Exception:
            pass

    # Case 3: memory full — return as-is.
    return mem_entries


def clear_user_requests(thread_id: str) -> None:
    """Drop the log for a thread (e.g. on session reset)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        _store.pop(tid, None)


def format_user_requests_section(thread_id: str) -> str:
    """Build the ``<user_requests>`` XML block for model payload injection."""
    if not USER_REQUESTS_PROMPT_INJECTION_ENABLED:
        return ""
    reqs = get_user_requests(thread_id)
    if not reqs:
        return ""
    lines = ["<user_requests>"]
    lines.append(
        "# 以下是用户最近提出的请求原文（按时间顺序，最多 10 条）。"
        "即使对话被压缩，这些请求也不会丢失。"
        "最后一条是用户最新提出的请求，即当前应执行的任务；"
        "之前的请求仅作为上下文参考，不要重复已完成的工作。"
    )
    for i, req in enumerate(reqs, 1):
        ts = str(req.get("ts") or "").strip()
        text = str(req.get("text") or "").strip()
        if text:
            marker = " ← 最新" if i == len(reqs) else ""
            lines.append(f"{i}. [{ts}] {text}{marker}")
    lines.append("</user_requests>")
    return "\n".join(lines)
