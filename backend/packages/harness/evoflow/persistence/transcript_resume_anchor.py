"""Transcript anchor for stream-resume: skip mirror replay of DB-persisted turn content."""

from __future__ import annotations

from typing import Any


def _is_human(msg: dict[str, Any]) -> bool:
    role = str(msg.get("role") or msg.get("type") or "").strip().lower()
    return role in {"user", "human", "humanmessage"}


def _is_assistant(msg: dict[str, Any]) -> bool:
    role = str(msg.get("role") or msg.get("type") or "").strip().lower()
    return role in {"assistant", "ai", "aimessage", "aimessagechunk"}


def _is_tool(msg: dict[str, Any]) -> bool:
    role = str(msg.get("role") or msg.get("type") or "").strip().lower()
    return role == "tool"


def _find_last_user_index(messages: list[dict[str, Any]]) -> int:
    for i in range(len(messages) - 1, -1, -1):
        if _is_human(messages[i]):
            return i
    return -1


def _merge_turn_texts(texts: list[str]) -> str:
    if not texts:
        return ""
    acc = str(texts[0] or "").strip()
    for raw in texts[1:]:
        nxt = str(raw or "").strip()
        if not nxt:
            continue
        if not acc:
            acc = nxt
            continue
        if nxt.startswith(acc):
            acc = nxt
        elif acc.startswith(nxt):
            continue
        elif acc.replace(" ", " ").find(nxt.replace(" ", " ")) >= 0:
            continue
        elif nxt.replace(" ", " ").find(acc.replace(" ", " ")) >= 0:
            acc = nxt
        else:
            acc = "\n\n".join([acc, nxt])
    return acc.strip()


def _extract_text(msg: dict[str, Any]) -> str:
    payload = msg.get("content_json")
    if isinstance(payload, dict):
        content = payload.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and part.get("type") == "text":
                    parts.append(str(part.get("text") or ""))
            return "".join(parts).strip()
    for key in ("content", "text"):
        val = msg.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _collect_tool_ids(msg: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    tc = msg.get("tool_calls") or msg.get("toolCalls")
    if isinstance(tc, list):
        for item in tc:
            if not isinstance(item, dict):
                continue
            tid = item.get("id") or item.get("tool_call_id")
            if tid is not None and str(tid).strip():
                ids.append(str(tid).strip())
    direct = msg.get("tool_call_id") or msg.get("toolCallId")
    if direct is not None and str(direct).strip():
        ids.append(str(direct).strip())
    return ids


def _find_assistant_before_user(messages: list[dict[str, Any]], user_idx: int) -> dict[str, Any] | None:
    if user_idx <= 0:
        return None
    for i in range(user_idx - 1, -1, -1):
        msg = messages[i]
        if _is_assistant(msg):
            return msg
        if _is_human(msg):
            break
    return None


def _reasoning_segments_from_message(msg: dict[str, Any]) -> list[str]:
    from evoflow.persistence.chat_message_content import loads_payload, _pick_reasoning

    payload = msg.get("content_json")
    if not isinstance(payload, dict):
        payload = loads_payload(str(msg.get("content_json") or ""))
    out: list[str] = []
    seen: set[str] = set()
    ui = payload.get("ui") if isinstance(payload.get("ui"), dict) else {}
    display_segments = ui.get("display_segments") or ui.get("displaySegments")
    if isinstance(display_segments, list):
        for seg in display_segments:
            if not isinstance(seg, dict):
                continue
            if str(seg.get("kind") or "") != "reasoning":
                continue
            text = str(seg.get("text") or "").strip()
            if text and text not in seen:
                seen.add(text)
                out.append(text)
    reasoning = _pick_reasoning(payload)
    if reasoning and reasoning not in seen:
        out.append(reasoning)
    return out


def _strip_prior_prefix(text: str, prefix: str, *, allow_hard_join: bool = True) -> str:
    p = str(prefix or "").strip()
    s = str(text or "")
    if not p or not s:
        return s
    if s.startswith(p):
        rest = s[len(p) :]
        if (
            not allow_hard_join
            and rest
            and not rest[0].isspace()
            and rest[0] not in "，。！？、,:;)]"
        ):
            return s
        return rest.lstrip()
    return s


def _ordered_strip_candidates(body: str, reasoning: str) -> list[str]:
    b = str(body or "").strip()
    r = str(reasoning or "").strip()
    out: list[str] = []
    if r and b:
        out.extend([r + b, f"{r}\n\n{b}", f"{r}\n{b}"])
    if b:
        out.append(b)
    if r:
        out.append(r)
    return out


def strip_prior_turn_pollutants_from_text(text: str, *, body: str, reasoning: str) -> str:
    """Remove checkpoint-replayed prior turn body/reasoning prefix from assistant text."""
    out = str(text or "")
    if not out:
        return out
    for prefix in _ordered_strip_candidates(body, reasoning):
        out = _strip_prior_prefix(out, prefix, allow_hard_join=True)
    return out


def _lc_message_dict(msg: Any) -> dict[str, Any]:
    if isinstance(msg, dict):
        return msg
    role = "assistant"
    try:
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        if isinstance(msg, HumanMessage):
            role = "user"
        elif isinstance(msg, ToolMessage):
            role = "tool"
    except Exception:
        pass
    content = getattr(msg, "content", "")
    out: dict[str, Any] = {
        "role": role,
        "content": content,
        "type": type(msg).__name__,
    }
    ak = getattr(msg, "additional_kwargs", None)
    if isinstance(ak, dict) and ak:
        out["additional_kwargs"] = dict(ak)
    return out


def prior_turn_strip_from_lc_messages(messages: list[Any]) -> dict[str, str]:
    """Body + reasoning immediately before the latest human in LangGraph state."""
    if not messages:
        return {"body": "", "reasoning": ""}
    dicts = [_lc_message_dict(m) for m in messages]
    user_idx = _find_last_user_index(dicts)
    prior = _find_assistant_before_user(dicts, user_idx)
    if not prior:
        return {"body": "", "reasoning": ""}
    body = _extract_text(prior)
    reasoning_segments = _reasoning_segments_from_message(prior)
    ak = prior.get("additional_kwargs") if isinstance(prior.get("additional_kwargs"), dict) else {}
    reasoning = "\n\n".join(reasoning_segments).strip()
    if not reasoning:
        reasoning = str(ak.get("reasoning_content") or "").strip()
    return {"body": body, "reasoning": reasoning}


def last_user_index_lc(messages: list[Any]) -> int:
    if not messages:
        return -1
    return _find_last_user_index([_lc_message_dict(m) for m in messages])


def strip_assistant_message_dict_for_turn_isolation(
    msg: dict[str, Any],
    *,
    body: str,
    reasoning: str,
) -> dict[str, Any]:
    """Strip prior-turn replay from assistant message dict before DB persist."""
    if not body and not reasoning:
        return msg
    out = dict(msg)
    content = out.get("content")
    if isinstance(content, str):
        cleaned = strip_prior_turn_pollutants_from_text(content, body=body, reasoning=reasoning)
        if cleaned != content:
            out["content"] = cleaned
    elif isinstance(content, list):
        blocks: list[Any] = []
        changed = False
        for block in content:
            if isinstance(block, str):
                cleaned = strip_prior_turn_pollutants_from_text(block, body=body, reasoning=reasoning)
                blocks.append(cleaned)
                changed = changed or cleaned != block
            elif isinstance(block, dict) and block.get("type") == "text":
                raw = str(block.get("text") or "")
                cleaned = strip_prior_turn_pollutants_from_text(raw, body=body, reasoning=reasoning)
                blocks.append({**block, "text": cleaned})
                changed = changed or cleaned != raw
            else:
                blocks.append(block)
        if changed:
            out["content"] = blocks
    ak = out.get("additional_kwargs")
    if isinstance(ak, dict) and reasoning:
        ak_copy = dict(ak)
        rc = ak_copy.get("reasoning_content")
        if isinstance(rc, str) and rc.strip():
            cleaned = strip_prior_turn_pollutants_from_text(rc, body="", reasoning=reasoning)
            if cleaned != rc:
                ak_copy["reasoning_content"] = cleaned
                out["additional_kwargs"] = ak_copy
    cj = out.get("content_json")
    if isinstance(cj, dict):
        cj_copy = dict(cj)
        inner = cj_copy.get("content")
        if isinstance(inner, str):
            cleaned = strip_prior_turn_pollutants_from_text(inner, body=body, reasoning=reasoning)
            if cleaned != inner:
                cj_copy["content"] = cleaned
                out["content_json"] = cj_copy
        r0 = cj_copy.get("reasoning")
        if isinstance(r0, str) and reasoning:
            cleaned = strip_prior_turn_pollutants_from_text(r0, body="", reasoning=reasoning)
            if cleaned != r0:
                cj_copy["reasoning"] = cleaned
                out["content_json"] = cj_copy
    return out


def build_prior_turn_isolation_anchor(session_key: str) -> dict[str, Any]:
    """Assistant body/reasoning immediately before the latest user message (turn isolation)."""
    from evoflow.persistence import chat_message_repositories as msg_repo

    empty = {
        "priorTurnBody": "",
        "priorTurnReasoning": "",
        "priorTurnReasoningSegments": [],
        "priorTurnMessageId": "",
    }
    sk = str(session_key or "").strip()
    if not sk:
        return empty

    messages = list(msg_repo.list_messages_for_display(sk, limit=500))
    user_idx = _find_last_user_index(messages)
    prior = _find_assistant_before_user(messages, user_idx)
    if not prior:
        return empty

    body = _extract_text(prior)
    reasoning_segments = _reasoning_segments_from_message(prior)
    reasoning = "\n\n".join(reasoning_segments).strip()
    return {
        "priorTurnBody": body,
        "priorTurnReasoning": reasoning,
        "priorTurnReasoningSegments": reasoning_segments,
        "priorTurnMessageId": str(prior.get("id") or "").strip(),
    }


def build_transcript_resume_anchor(
    session_key: str,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    from evoflow.persistence import chat_message_repositories as msg_repo

    sk = str(session_key or "").strip()
    if not sk:
        return {"persistedTurnText": "", "persistedToolCallIds": []}

    page = msg_repo.list_messages_for_display_all(sk)
    messages = list(page.get("messages") or [])
    wanted_run_id = str(run_id or "").strip()
    user_idx = _find_last_user_index(messages)
    if user_idx < 0:
        return {"persistedTurnText": "", "persistedToolCallIds": []}

    tool_ids: set[str] = set()
    assistant_texts: list[str] = []
    for msg in messages[user_idx + 1 :]:
        msg_run_id = str(msg.get("run_id") or msg.get("runId") or "").strip()
        if wanted_run_id and msg_run_id and msg_run_id != wanted_run_id:
            continue
        if _is_assistant(msg):
            text = _extract_text(msg)
            if text:
                assistant_texts.append(text)
            for tid in _collect_tool_ids(msg):
                tool_ids.add(tid)
        elif _is_tool(msg):
            for tid in _collect_tool_ids(msg):
                tool_ids.add(tid)

    return {
        "persistedTurnText": _merge_turn_texts(assistant_texts),
        "persistedToolCallIds": sorted(tool_ids),
    }


def latest_turn_reply_text(session_key: str) -> str:
    """Reply text for the turn after the last user message (from ``evoflow_chat_messages``)."""
    from evoflow.persistence import chat_message_repositories as msg_repo
    from evoflow.persistence.chat_message_content import plain_text

    sk = str(session_key or "").strip()
    if not sk:
        return ""
    messages = msg_repo.list_messages_for_display(sk, limit=500)
    user_idx = _find_last_user_index(messages)
    if user_idx < 0:
        return ""
    for i in range(len(messages) - 1, user_idx, -1):
        msg = messages[i]
        if _is_human(msg):
            break
        if _is_tool(msg):
            name = str(msg.get("name") or msg.get("tool_name") or "")
            if name == "ask_clarification":
                payload = msg.get("content_json")
                if isinstance(payload, dict):
                    text = plain_text(payload).strip()
                    if text:
                        return text
        if _is_assistant(msg):
            text = _extract_text(msg)
            if text:
                return text
    return ""
