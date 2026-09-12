"""Normalize LangGraph SSE into ordered EvoFlow UI events (``event: evf``).

Single channel for the browser: delta / tool_call / tool_call_chunk / tool_result / thread_state / activity / usage / custom / run_end.
Server-side anchoring prevents previous-turn text/tools from leaking; assistant text and tool chunks are passthrough.
"""

from __future__ import annotations

import json
import logging
import re
import time
import traceback
from dataclasses import dataclass, field
from typing import Any

from app.gateway.content_block_ledger import BlockWireMeta, ContentBlockLedger
from evoflow.tools.chat_panel_tools import tool_omit_from_chat_panel

logger = logging.getLogger(__name__)

_INJECTED_HUMAN_NAMES = frozenset(
    {
        "collab_phase_hint",
        "context_compaction_summary",
        "tool_history_block",
        "goal",
        "goal_controller",
        "hosted_autofollow",
        "task_autofollow",
        "xiaomi_ui_context",
    }
)
_MIN_PREV_STRIP_LEN = 32
_SUPERVISOR = "supervisor"
_WRITE_STREAM_TOOL_NAMES = frozenset(
    {
        "write",
        "write_to_file",
        "write_file",
        "replace",
        "str_replace",
        "replace_in_file",
    }
)
# Includes delete for early tool-call wire readiness; progress slimming uses _WRITE_STREAM_TOOL_NAMES only.
_WRITE_TOOL_NAMES = _WRITE_STREAM_TOOL_NAMES | frozenset({"delete", "delete_file"})


def _encode_evf(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: evf\ndata: {body}\n\n".encode()


EvfPayloadList = list[dict[str, Any]]


def _evf_payloads_to_wire(payloads: EvfPayloadList) -> list[bytes]:
    return [_encode_evf(p) for p in payloads]


def _normalize_sse_buffer(text: str) -> str:
    """LangGraph SSE uses CRLF; normalize so ``\\n\\n`` frame splits work."""
    return (text or "").replace("\r\n", "\n")


def _norm_loose(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


_EXECUTION_PLAN_HINT = re.compile(
    r"(?:目标|步骤|验收|方案|打算|首先|然后|接着|最后|第一|第二|验收标准|完成条件)",
    re.I,
)
_OPENING_ACK_PLAN = re.compile(r"^(?:好[，,。.!]?|OK[,.!?]?|嗯[，,]?|行[，,]?)", re.I)


def _is_substantive_execution_plan_outline(text: str) -> bool:
    """普通会话顶栏执行说明（自然语言），非 Plan 协作 ``plan`` 工具落库。"""
    t = (text or "").strip()
    if len(t) < 36 or len(t) > 900:
        return False
    if _OPENING_ACK_PLAN.match(t) and len(t) < 72 and not _EXECUTION_PLAN_HINT.search(t):
        return False
    lines = [ln for ln in t.splitlines() if ln.strip()]
    if len(lines) >= 2 and len(t) >= 40:
        return True
    return bool(_EXECUTION_PLAN_HINT.search(t) and len(t) >= 36)


def _is_human(m: dict[str, Any]) -> bool:
    if m.get("role") == "user":
        return True
    t = str(m.get("type") or "").strip()
    return t in {"human", "HumanMessage", "HumanMessageChunk"}


def _is_assistant(m: dict[str, Any]) -> bool:
    if m.get("role") == "assistant":
        return True
    t = str(m.get("type") or "").strip()
    return t in {"ai", "AIMessage", "AIMessageChunk", "assistant"}


def _is_tool(m: dict[str, Any]) -> bool:
    if m.get("role") == "tool":
        return True
    t = str(m.get("type") or "").strip()
    return t in {"tool", "ToolMessage", "ToolMessageChunk"}


def _is_streaming_message_chunk(m: dict[str, Any]) -> bool:
    """LangGraph live model output uses *Chunk types; hydrated transcript uses complete messages."""
    return str(m.get("type") or "").strip().endswith("Chunk")


def _is_live_messages_stream_row(m: dict[str, Any]) -> bool:
    """SSE only carries incremental *Chunk rows; complete messages are state/history sync."""
    return _is_streaming_message_chunk(m)


def _is_injected_human(m: dict[str, Any]) -> bool:
    n = str(m.get("name") or "").strip()
    if n in _INJECTED_HUMAN_NAMES:
        return True
    content = m.get("content")
    head = ""
    if isinstance(content, str):
        head = content[:200]
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                head += str(block.get("text") or "")
    head = head.strip()
    return (
        head.startswith("[LOOP DETECTED]")
        or head.startswith("[FORCED STOP]")
        or head.startswith("<xiaomi_ui_context>")
    )


def _find_last_real_human_idx(messages: list[Any]) -> int:
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if not isinstance(m, dict):
            continue
        if _is_human(m) and not _is_injected_human(m):
            return i
    return -1


def _find_last_human_idx_for_anchor(messages: list[Any], *, expected_text: str = "") -> int:
    """Stream anchor: match contextual goal fragments by text; else last visible user."""
    exp = _norm_loose(expected_text)
    if exp:
        for i in range(len(messages) - 1, -1, -1):
            m = messages[i]
            if not isinstance(m, dict) or not _is_human(m):
                continue
            if _norm_loose(_message_text(m)) == exp:
                return i
    return _find_last_real_human_idx(messages)


def _is_system_like_message(m: dict[str, Any]) -> bool:
    if m.get("role") == "system":
        return True
    t = str(m.get("type") or "").strip().lower()
    return t in {"system", "systemmessage"}


def _last_substantive_index_after_human(messages: list[dict[str, Any]], human_idx: int) -> int:
    if human_idx < 0:
        return human_idx
    end = len(messages) - 1
    while end > human_idx:
        m = messages[end]
        if _is_system_like_message(m) or (_is_human(m) and _is_injected_human(m)):
            end -= 1
            continue
        break
    return end


def _find_last_assistant_before_index(messages: list[dict[str, Any]], before_idx: int) -> dict[str, Any] | None:
    if before_idx <= 0:
        return None
    for i in range(before_idx - 1, -1, -1):
        if _is_assistant(messages[i]):
            return messages[i]
    return None


def _message_has_ready_tool_calls(m: dict[str, Any]) -> bool:
    tcs = m.get("tool_calls")
    if not isinstance(tcs, list):
        return False
    return any(_tool_ready(t) for t in tcs if isinstance(t, dict))


def _message_has_tool_signal(m: dict[str, Any]) -> bool:
    """AIMessageChunk 可能仅有 tool_call_chunks、尚无完整 tool_calls。"""
    chunks = m.get("tool_call_chunks")
    if isinstance(chunks, list) and any(isinstance(c, dict) for c in chunks):
        return True
    return _message_has_ready_tool_calls(m)


def _find_last_display_assistant_after_index(
    messages: list[dict[str, Any]], human_idx: int
) -> dict[str, Any] | None:
    """Last assistant message in this turn whose text is user-facing (no tool_calls on same generation)."""
    if human_idx < 0:
        return None
    for i in range(len(messages) - 1, human_idx, -1):
        m = messages[i]
        if not isinstance(m, dict) or not _is_assistant(m):
            continue
        if _message_has_ready_tool_calls(m):
            continue
        return m
    return None


def _has_graph_progress_after_human(messages: list[dict[str, Any]], human_idx: int) -> bool:
    """True when something substantive exists after this user turn (not only stale prev-turn AI)."""
    if human_idx < 0:
        return False
    last_sub = _last_substantive_index_after_human(messages, human_idx)
    if last_sub <= human_idx:
        return False
    # [user_new, prev assistant+tool_calls] — not progress for the new turn yet.
    if last_sub == human_idx + 1 and _is_assistant(messages[last_sub]):
        return False
    if not _is_assistant(messages[last_sub]):
        return True
    for i in range(human_idx + 1, last_sub):
        m = messages[i]
        if _is_injected_human(m):
            return True
        if _is_system_like_message(m):
            continue
        if _is_tool(m):
            return True
        if _is_human(m) and not _is_injected_human(m):
            return True
        if _is_assistant(m):
            return True
    return False


def _resolve_thread_activity_from_messages(
    messages: list[dict[str, Any]],
    human_idx: int,
    *,
    thread_id: str,
    anchored: bool,
) -> tuple[str, str, list[dict[str, Any]]]:
    """Map LangGraph tail messages to live activity (tools only while calls are in flight)."""
    if not anchored or human_idx < 0:
        return "idle", "", []
    tail = messages[human_idx + 1 :]
    if not tail:
        return "idle", "", []

    last = tail[-1]
    if _is_tool(last):
        return "thinking", "推理中", []

    if _is_assistant(last):
        raw_calls = last.get("tool_calls")
        if isinstance(raw_calls, list):
            calls = [c for c in raw_calls if isinstance(c, dict)]
            if calls and _message_has_ready_tool_calls(last):
                from evoflow.tools.tool_activity_ui import format_activity_detail_from_tool_calls

                return (
                    "tools",
                    format_activity_detail_from_tool_calls(calls, latest_only=True),
                    calls[-1:],
                )
        if _extract_assistant_text(last).strip():
            return "idle", "", []
        return "thinking", "推理中", []

    live_detail = ""
    tid = str(thread_id or "").strip()
    if tid:
        try:
            from evoflow.observability.run_latency_trace import get_live_progress

            live_detail = str(get_live_progress(tid) or "").strip()
        except Exception:
            live_detail = ""
    if live_detail:
        return "thinking", live_detail, []

    return "thinking", "推理中", []


def _message_text(m: dict[str, Any]) -> str:
    content = m.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return str(m.get("text") or "")


def _extract_assistant_text(m: dict[str, Any]) -> str:
    return _message_text(m)


def _extract_assistant_reasoning(m: dict[str, Any]) -> str:
    ak = m.get("additional_kwargs")
    if isinstance(ak, dict):
        rc = ak.get("reasoning_content")
        if isinstance(rc, str) and rc.strip():
            return rc.strip()
    content = m.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "thinking":
                t = part.get("thinking")
                if isinstance(t, str) and t.strip():
                    parts.append(t.strip())
        if parts:
            return "\n\n".join(parts)
    return ""


def _strip_prior_reasoning_piece(incoming: str, prior: str) -> str:
    raw = incoming or ""
    p = (prior or "").strip()
    if not p or not raw:
        return raw
    if raw.strip() == p:
        return ""
    if raw.startswith(p):
        return raw[len(p) :].lstrip()
    np = _norm_loose(p)
    nr = _norm_loose(raw)
    if np and nr == np:
        return ""
    if np and nr.startswith(np) and len(nr) > len(np):
        probe = p[: min(240, len(p))].strip()
        if len(probe) >= 20:
            idx = raw.find(probe)
            if 0 <= idx < 48:
                return raw[idx + len(probe) :].lstrip()
    return raw


def _merge_reasoning_piece(last: str, incoming: str) -> str:
    """Merge streaming reasoning fragments; preserve leading spaces in delta pieces."""
    r = incoming or ""
    if not r:
        return last or ""
    prev = last or ""
    if not prev:
        return r
    if r.startswith(prev):
        return r
    if prev.startswith(r):
        return prev
    max_check = min(len(prev), len(r), 800)
    for n in range(max_check, 7, -1):
        if prev[-n:] == r[:n]:
            return prev + r[n:]
    return prev + r


def _reasoning_stream_delta(accum: str, incoming: str) -> tuple[str, str]:
    """Return (merged_full, delta_piece) for evf; emit delta so UI types incrementally."""
    r = incoming or ""
    if not r:
        return accum or "", ""
    prev = accum or ""
    if r.startswith(prev):
        return r, r[len(prev) :]
    if prev.startswith(r):
        return prev, ""
    merged = _merge_reasoning_piece(prev, r)
    if merged.startswith(prev) and len(merged) > len(prev):
        return merged, merged[len(prev) :]
    return merged, r


def _pick_richest_prefix(*candidates: str, min_len: int = _MIN_PREV_STRIP_LEN) -> str:
    listed = [str(c or "").strip() for c in candidates if str(c or "").strip()]
    floor = max(1, int(min_len))
    listed = [c for c in listed if len(c) >= floor]
    if not listed:
        return ""
    best = listed[0]
    for cur in listed[1:]:
        if cur.startswith(best) or best.startswith(cur):
            best = cur if len(cur) >= len(best) else best
        elif len(cur) > len(best):
            best = cur
    return best


def _strip_prev_prefix(
    text: str,
    prefix: str,
    *,
    min_len: int | None = None,
    allow_hard_join: bool = False,
) -> str:
    floor = _MIN_PREV_STRIP_LEN if min_len is None else max(1, int(min_len))
    p = prefix or ""
    s = text or ""
    if not p or len(p.strip()) < floor or not s:
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
    np = _norm_loose(p)
    ns = _norm_loose(s)
    if len(np) >= floor and ns.startswith(np) and len(ns) > len(np):
        probe = p[: min(240, len(p))].strip()
        probe_floor = 4 if allow_hard_join else 20
        if len(probe) >= probe_floor:
            idx = s.find(probe)
            if 0 <= idx < 48:
                return s[idx + len(probe) :].lstrip()
    return s


def _collect_assistant_texts_after_human(
    messages: list[dict[str, Any]], human_idx: int, prefix: str
) -> list[str]:
    """本轮 user 之后每条 assistant 的可见正文（含带 tool_calls 的计划段）。"""
    if human_idx < 0:
        return []
    texts: list[str] = []
    for i in range(human_idx + 1, len(messages)):
        m = messages[i]
        if not isinstance(m, dict) or not _is_assistant(m):
            continue
        t = _strip_prev_prefix(_extract_assistant_text(m), prefix).strip()
        if t:
            texts.append(t)
    return texts


def _merge_turn_assistant_texts(texts: list[str]) -> str:
    """与前端 chat-normalize / ws-client 合并规则一致。"""
    if not texts:
        return ""
    acc = (texts[0] or "").strip()
    for nxt in texts[1:]:
        next_t = (nxt or "").strip()
        if not next_t:
            continue
        if not acc:
            acc = next_t
            continue
        if next_t.startswith(acc):
            acc = next_t
        elif acc.startswith(next_t):
            continue
        acc_norm = re.sub(r"\s+", " ", acc)
        next_norm = re.sub(r"\s+", " ", next_t)
        if next_norm in acc_norm:
            continue
        if acc_norm in next_norm:
            acc = next_t
            continue
        acc = f"{acc}\n\n{next_t}"
    return acc.strip()


def _join_display_segment_texts(segs: list[dict[str, Any]]) -> str:
    """Join plan/body text blocks in ``seq`` order (authoritative stream timeline)."""
    if not segs:
        return ""
    ordered = sorted(segs, key=lambda s: int(s.get("seq") or 0))
    parts: list[str] = []
    for seg in ordered:
        if str(seg.get("kind") or "") != "text":
            continue
        t = str(seg.get("text") or "").strip()
        if t:
            parts.append(t)
    if not parts:
        return ""
    return _merge_turn_assistant_texts(parts)


def _pick_richest_display_text(*candidates: str) -> str:
    parts = [str(c or "").strip() for c in candidates if str(c or "").strip()]
    if not parts:
        return ""
    best = parts[0]
    for cur in parts[1:]:
        if len(cur) > len(best):
            best = cur
        elif cur.startswith(best):
            best = cur
        elif best.startswith(cur):
            continue
        else:
            best_norm = re.sub(r"\s+", " ", best)
            cur_norm = re.sub(r"\s+", " ", cur)
            if cur_norm in best_norm:
                continue
            if best_norm in cur_norm:
                best = cur
            elif cur != best:
                best = f"{best}\n\n{cur}"
    return best.strip()


_TOOL_RESULT_KEEP_KEYS = (
    "type",
    "role",
    "id",
    "name",
    "tool_call_id",
    "content",
    "status",
    "artifact",
    "additional_kwargs",
    "response_metadata",
    "isError",
    "tool_name",
    "truncated",
    "content_bytes",
    "output_truncated",
    "output_bytes",
)


def _envelope_status_from_tool_content(content: Any) -> str | None:
    """Read ``_evoflow_tool.status`` from tool JSON (e.g. pending_approval gate)."""
    if content is None:
        return None
    obj: Any = content
    if isinstance(content, str):
        raw = content.strip()
        if not raw or raw[0] != "{":
            return None
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            return None
    if not isinstance(obj, dict):
        return None
    meta = obj.get("_evoflow_tool")
    if not isinstance(meta, dict):
        return None
    st = str(meta.get("status") or "").strip().lower()
    return st or None


def _slim_tool_result_message(msg: dict[str, Any]) -> dict[str, Any]:
    """Keep fields ToolCallList / chat-normalize need for special tool UI (media, approval, paths)."""
    out: dict[str, Any] = {}
    for k in _TOOL_RESULT_KEEP_KEYS:
        if k in msg and msg[k] is not None:
            out[k] = msg[k]
    if "type" not in out:
        out["type"] = "tool"
    if "role" not in out:
        out["role"] = "tool"
    tcid = str(out.get("tool_call_id") or out.get("id") or "").strip()
    tool_name = str(out.get("name") or out.get("tool_name") or "tool")
    payload = out.get("content_json") if isinstance(out.get("content_json"), dict) else None
    body = out.get("content") if payload is None else payload.get("content")
    if tcid and body is not None:
        try:
            from evoflow.tools.tool_result_store import slim_content_for_ui

            display_content, meta = slim_content_for_ui(tcid, tool_name, body)
            if payload is not None:
                payload = dict(payload)
                payload["content"] = display_content
                out["content_json"] = payload
            else:
                out["content"] = display_content
            out.update(meta)
        except Exception:
            pass
    elif payload is not None:
        out["content_json"] = payload
    if not str(out.get("status") or "").strip():
        env_st = _envelope_status_from_tool_content(out.get("content"))
        if env_st:
            out["status"] = env_st
    return out


def _unwrap_messages_root(data: Any) -> dict[str, Any] | None:
    if isinstance(data, dict) and (data.get("type") or data.get("role")):
        return data
    if isinstance(data, list) and data:
        if isinstance(data[0], dict) and (data[0].get("type") or data[0].get("role")):
            return data[0]
        if len(data) >= 2 and isinstance(data[1], dict) and (data[1].get("type") or data[1].get("role")):
            return data[1]
    return None


def _unwrap_messages_stream_meta(data: Any) -> dict[str, Any]:
    """LangGraph messages-tuple metadata (second element): ``langgraph_node``, checkpoint, etc."""
    if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
        meta = data[1]
        if meta.get("type") or meta.get("role"):
            return {}
        return meta
    return {}


def _is_nested_tool_node_stream(meta: dict[str, Any]) -> bool:
    """AIMessageChunk from ``tools`` node = nested tool LLM (e.g. view_image vision), not user reply."""
    node = str(meta.get("langgraph_node") or "").strip().lower()
    return node == "tools"


def _normalize_tool_args(tc: dict[str, Any]) -> dict[str, Any]:
    direct = tc.get("args")
    if direct is None:
        direct = tc.get("input") or tc.get("parameters") or tc.get("kwargs")
    if isinstance(direct, dict) and direct:
        return direct
    fn = tc.get("function")
    if isinstance(fn, dict) and isinstance(fn.get("arguments"), str) and fn["arguments"].strip():
        try:
            parsed = json.loads(fn["arguments"])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    if isinstance(direct, dict):
        return direct
    return {}


_PATH_ARG_KEYS = ("path", "target_file", "file_path", "filepath", "filePath", "file")
_CONTENT_ARG_KEYS = ("content", "new_string", "contents", "text", "new_str")
_OLD_STRING_ARG_KEYS = ("old_string",)


def _merge_complete_tool_arg_dicts(po: dict[str, Any], ro: dict[str, Any]) -> str | None:
    """Merge two parseable tool-arg objects without dropping path when content grows."""
    merged: dict[str, Any] = {**po, **ro}
    for key in _PATH_ARG_KEYS:
        pv = po.get(key)
        rv = ro.get(key)
        if isinstance(pv, str) and pv.strip() and not (isinstance(rv, str) and rv.strip()):
            merged[key] = pv
    for key in (*_CONTENT_ARG_KEYS, *_OLD_STRING_ARG_KEYS):
        pv = po.get(key)
        rv = ro.get(key)
        if isinstance(pv, str) and isinstance(rv, str) and len(pv) > len(rv):
            merged[key] = pv
        elif isinstance(pv, str) and pv and not (isinstance(rv, str) and rv):
            merged[key] = pv
    try:
        return json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        return None


def _merge_tool_call_arg_strings(prev: str, incoming: str) -> str:
    """Concatenate vendor tool-arg fragments (cumulative or incremental).

    Handles both:
    - OpenAI-style incremental fragments (``{"path":`` then ``"a","content":"x`` …)
    - Cumulative complete JSON snapshots (each frame is a full parseable object)
    """
    r = incoming or ""
    if not r:
        return prev or ""
    p = prev or ""
    if not p:
        return r
    if r.startswith(p):
        return r
    if p.startswith(r):
        return p
    # Two complete JSON objects: merge keys (do not drop path when content grows).
    if p.lstrip().startswith("{") and r.lstrip().startswith("{"):
        try:
            po = json.loads(p)
            ro = json.loads(r)
        except json.JSONDecodeError:
            po = ro = None
        if isinstance(po, dict) and isinstance(ro, dict):
            merged = _merge_complete_tool_arg_dicts(po, ro)
            if merged is not None:
                return merged
            pc = str(
                po.get("content") or po.get("new_string") or po.get("contents") or po.get("text") or ""
            )
            rc = str(
                ro.get("content") or ro.get("new_string") or ro.get("contents") or ro.get("text") or ""
            )
            if len(rc) > len(pc):
                return r
            if len(pc) > len(rc):
                return p
            if len(r) >= len(p):
                return r
            return p
    # Incremental fragment concat (with overlap dedupe).
    max_check = min(len(p), len(r), 800)
    for n in range(max_check, 7, -1):
        if p[-n:] == r[:n]:
            return p + r[n:]
    return p + r


def _merge_tool_calls(prev: dict[str, Any] | None, nxt: dict[str, Any]) -> dict[str, Any]:
    """Merge successive tool_call / tool_call_chunk frames.

    Vendor ``function.arguments`` arrive as *incremental* JSON fragments (not
    always cumulative snapshots). Merge so write-file content grows
    token-by-token and ``write_file_progress.content_delta`` can fire on each
    growth instead of dumping once at the end.
    """
    if not nxt:
        return prev or {}
    if not prev:
        return dict(nxt)

    def merge_obj(p: Any, n: Any) -> Any:
        if n is None:
            return p
        if isinstance(n, dict) and not n and isinstance(p, dict):
            return p
        if isinstance(p, dict) and isinstance(n, dict):
            out = dict(p)
            for k, v in n.items():
                if isinstance(v, dict) and isinstance(out.get(k), dict):
                    out[k] = merge_obj(out[k], v)
                else:
                    out[k] = v
            return out
        return n

    out = dict(prev)
    for key in ("args", "input", "parameters", "kwargs"):
        if key not in nxt:
            continue
        nval = nxt.get(key)
        pval = prev.get(key)
        if isinstance(nval, str) or isinstance(pval, str):
            ps = str(pval or "") if isinstance(pval, str) else ""
            ns = str(nval or "") if isinstance(nval, str) else ""
            out[key] = _merge_tool_call_arg_strings(ps, ns)
        else:
            out[key] = merge_obj(pval, nval)
    pfn = prev.get("function") if isinstance(prev.get("function"), dict) else {}
    nfn = nxt.get("function") if isinstance(nxt.get("function"), dict) else {}
    if pfn or nfn:
        fn = {**pfn, **nfn}
        ps = str(pfn.get("arguments") or "")
        ns = str(nfn.get("arguments") or "")
        if ps or ns:
            fn["arguments"] = _merge_tool_call_arg_strings(ps, ns)
        out["function"] = fn
    for k, v in nxt.items():
        if k in {"args", "input", "parameters", "kwargs", "function"}:
            continue
        if v is not None:
            out[k] = v
    return out


def _partial_tool_arguments(tc: dict[str, Any]) -> str:
    """Best-effort args JSON text from a (possibly partial) tool_call chunk."""
    fn = tc.get("function")
    if isinstance(fn, dict):
        fa = str(fn.get("arguments") or "")
        if fa:
            return fa
    for key in ("args", "input", "arguments"):
        raw = tc.get(key)
        if isinstance(raw, str) and raw:
            return raw
        if isinstance(raw, dict) and raw:
            try:
                return json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
            except Exception:
                continue
    return ""


def _tool_ready(tc: dict[str, Any]) -> bool:
    name = str(tc.get("name") or (tc.get("function") or {}).get("name") or "").strip()
    nargs = name.lower()
    partial_args = _partial_tool_arguments(tc).strip()
    args = _normalize_tool_args(tc)
    if nargs == _SUPERVISOR and not args:
        return False
    if nargs in _WRITE_TOOL_NAMES:
        return bool(name or partial_args)
    return bool(name)


def _tool_sig(tc: dict[str, Any]) -> str:
    try:
        return json.dumps(tc, ensure_ascii=False, sort_keys=True, default=str)
    except Exception:
        return str(tc.get("id") or "")


def _is_write_tool(tc: dict[str, Any]) -> bool:
    name = str(tc.get("name") or (tc.get("function") or {}).get("name") or "").strip().lower()
    return name in _WRITE_STREAM_TOOL_NAMES


def _message_has_write_tool_signal(m: dict[str, Any]) -> bool:
    """True when this AI row is streaming/holding a write-family tool call."""
    for key in ("tool_calls", "tool_call_chunks"):
        raw = m.get(key)
        if not isinstance(raw, list):
            continue
        for tc in raw:
            if isinstance(tc, dict) and _is_write_tool(tc):
                return True
    return False


def _write_tool_path_content(tc: dict[str, Any]) -> tuple[str, str]:
    args = _normalize_tool_args(tc)
    if not isinstance(args, dict):
        return "", ""
    path = str(
        args.get("path") or args.get("target_file") or args.get("file_path") or args.get("file") or ""
    ).strip()
    content = str(
        args.get("content") or args.get("new_string") or args.get("contents") or ""
    )
    return path, content


def _unescape_partial_json_string(raw: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            nxt = raw[i + 1]
            if nxt == "n":
                out.append("\n")
            elif nxt == "t":
                out.append("\t")
            elif nxt == "r":
                out.append("\r")
            elif nxt in {'"', "\\", "/"}:
                out.append(nxt)
            elif nxt == "u" and i + 5 < len(raw):
                try:
                    out.append(chr(int(raw[i + 2 : i + 6], 16)))
                    i += 6
                    continue
                except Exception:
                    out.append(nxt)
            else:
                out.append(nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _extract_json_string_value_for_key(raw: str, key: str) -> str | None:
    """Extract a string value for ``key`` from partial JSON args.

    Only matches the key at the **root object** (depth 1). A naive
    ``"path":`` search would hit the same token inside ``old_string`` /
    ``new_string`` / ``content`` bodies — common for ``replace`` — and leave
    the real path empty or wrong for the whole stream.
    """
    text = str(raw or "")
    if not text:
        return None
    key_pat = f'"{key}"'
    key_pat_lower = key_pat.lower()
    depth = 0
    in_string = False
    escape = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            # Root-object key candidate (inside the outermost ``{...}``).
            if depth == 1 and text[i : i + len(key_pat)].lower() == key_pat_lower:
                j = i + len(key_pat)
                while j < n and text[j].isspace():
                    j += 1
                if j < n and text[j] == ":":
                    j += 1
                    while j < n and text[j].isspace():
                        j += 1
                    if j < n and text[j] == '"':
                        j += 1
                        buf: list[str] = []
                        while j < n:
                            c = text[j]
                            if c == "\\" and j + 1 < n:
                                buf.append(c + text[j + 1])
                                j += 2
                                continue
                            if c == '"':
                                break
                            buf.append(c)
                            j += 1
                        return _unescape_partial_json_string("".join(buf))
            in_string = True
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth = max(0, depth - 1)
        i += 1
    return None


def _extract_write_fields_from_partial_args(raw: str) -> dict[str, str]:
    text = str(raw or "")
    path = ""
    for key in _PATH_ARG_KEYS:
        val = _extract_json_string_value_for_key(text, key)
        if val and val.strip():
            path = val.strip()
            break
    content = ""
    for key in _CONTENT_ARG_KEYS:
        val = _extract_json_string_value_for_key(text, key)
        if val:
            content = val
            break
    old_string = _extract_json_string_value_for_key(text, "old_string") or ""
    return {"path": path, "content": content, "old_string": old_string}


def _count_text_lines(text: str) -> int:
    if not text:
        return 0
    normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
    return len(normalized.split("\n"))


def _write_tool_line_stats(tool_name: str, fields: dict[str, str]) -> tuple[int, int]:
    name = str(tool_name or "").strip().lower()
    content = str(fields.get("content") or "")
    old_string = str(fields.get("old_string") or "")
    if name in {"str_replace", "replace_in_file", "replace"}:
        return _count_text_lines(content), _count_text_lines(old_string)
    return _count_text_lines(content), 0


def _merge_write_fields(parsed: dict[str, Any], partial: dict[str, str]) -> dict[str, str]:
    out = dict(partial)
    if not isinstance(parsed, dict):
        return out
    for src_key, dst_key in (
        ("path", "path"),
        ("target_file", "path"),
        ("file_path", "path"),
        ("file", "path"),
        ("content", "content"),
        ("contents", "content"),
        ("new_string", "content"),
        ("new_str", "content"),
        ("text", "content"),
        ("old_string", "old_string"),
    ):
        val = parsed.get(src_key)
        if isinstance(val, str) and val:
            if dst_key == "path" and not out.get("path"):
                out["path"] = val.strip()
            elif dst_key == "content" and len(val) >= len(out.get("content") or ""):
                out["content"] = val
            elif dst_key == "old_string" and len(val) >= len(out.get("old_string") or ""):
                out["old_string"] = val
    return out


def _write_tool_wire_args(fields: dict[str, str]) -> str:
    """Build JSON arguments for TOOL_CALL_ARGS wire.

    Keep the payload small: path (+ replace old_string marker only when short).
    Live file body streams via ``write_file_progress.content_delta`` — putting the
    full ``content`` into every growing snapshot re-floods SSE and the UI.

    Return empty string (not ``{}``) until path is known so AG-UI does not emit a
    useless TOOL_CALL_ARGS delta that sticks as empty args while content streams.
    """
    payload: dict[str, str] = {}
    path = str(fields.get("path") or "").strip()
    if path:
        payload["path"] = path
    if not payload:
        return ""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _tool_call_display_name(tc: dict[str, Any]) -> str:
    return str(tc.get("name") or (tc.get("function") or {}).get("name") or "").strip()


def _chat_panel_visible_tool_call(tc: dict[str, Any]) -> bool:
    return isinstance(tc, dict) and not tool_omit_from_chat_panel(tc)


def _build_slim_write_tool_call(tc: dict[str, Any], fields: dict[str, str]) -> dict[str, Any]:
    out = dict(tc)
    wire_args = _write_tool_wire_args(fields)
    fn = dict(out.get("function") or {}) if isinstance(out.get("function"), dict) else {}
    # Always rewrite arguments: path-only JSON, or "" until path is known (never "{}").
    if fn or wire_args or "function" in out:
        fn = dict(fn)
        fn["arguments"] = wire_args
        if not fn.get("name"):
            fn["name"] = _tool_call_display_name(tc)
        out["function"] = fn
    # Keep args/input with path-only wire_args (content streams via write_file_progress).
    args_obj: dict[str, Any] = {}
    if wire_args:
        try:
            parsed = json.loads(wire_args)
            if isinstance(parsed, dict):
                args_obj = parsed
        except json.JSONDecodeError:
            pass
    if args_obj:
        out["args"] = args_obj
        out["input"] = args_obj
    else:
        out.pop("args", None)
        out.pop("input", None)
    # Remove top-level content keys -- they're already in function.arguments
    for key in ("content", "new_string", "old_string", "contents", "text"):
        out.pop(key, None)
    return out


def _pick_values_root(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("values")
    return raw if isinstance(raw, dict) else data


def _display_messages(data: dict[str, Any]) -> list[dict[str, Any]]:
    raw = _pick_values_root(data)
    msgs = raw.get("messages")
    if not isinstance(msgs, list):
        return []
    return [m for m in msgs if isinstance(m, dict) and not _is_injected_human(m)]


def _collect_turn_tool_calls(messages: list[dict[str, Any]], human_idx: int) -> list[dict[str, Any]]:
    """Collect assistant tool_calls for the current turn only (align ws-client turn guards)."""
    if human_idx < 0:
        return []
    last_sub = _last_substantive_index_after_human(messages, human_idx)
    if last_sub <= human_idx:
        return []
    # [user_new, prev assistant+tool_calls]: do not treat previous assistant as this turn.
    if last_sub == human_idx + 1 and _is_assistant(messages[last_sub]):
        prev_ai = _find_last_assistant_before_index(messages, human_idx)
        if prev_ai is not None and prev_ai is messages[last_sub]:
            return []
    by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for i in range(human_idx + 1, last_sub + 1):
        m = messages[i]
        if not _is_assistant(m):
            continue
        tcs = m.get("tool_calls")
        if not isinstance(tcs, list):
            continue
        for j, tc in enumerate(tcs):
            if not isinstance(tc, dict):
                continue
            cid = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
            key = cid if cid else f"__anon__:{i}:{j}"
            if key not in by_id:
                order.append(key)
            by_id[key] = _merge_tool_calls(by_id.get(key), tc)
    return [by_id[k] for k in order]


def _usage_triplet(obj: dict[str, Any] | None) -> dict[str, int] | None:
    from evoflow.agents.middlewares.message_usage_helpers import normalize_usage_triplet_for_wire

    return normalize_usage_triplet_for_wire(obj)


def _usage_from_ai_message_dict(msg: dict[str, Any] | None) -> dict[str, int] | None:
    """Normalize usage on a streaming AI message/chunk (vendor fields often live under ``response_metadata``)."""
    if not isinstance(msg, dict):
        return None
    from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_from_checkpoint_ai_dict

    return infer_usage_metadata_from_checkpoint_ai_dict(msg)


@dataclass
class UiStreamNormalizer:
    """Stateful LangGraph → evf translator for one run."""

    user_input: str = ""
    use_claude_code_chat: bool = False
    """UI 封存的上轮 assistant 全文（停后继续），与 checkpoint 前缀取更完整者。"""
    client_prior_prefix: str = ""
    client_prior_message_id: str = ""
    client_prior_reasoning: str = ""

    anchored: bool = False
    anchored_human_idx: int = -1
    prev_turn_prefix: str = ""
    prev_turn_assistant_id: str = ""
    prev_turn_reasoning: str = ""
    """本轮已下发给前端的 assistant 流式累积（按 LangGraph message id）。"""
    per_message_stream_text: dict[str, str] = field(default_factory=dict)
    final_text: str = ""
    stream_text_from_messages: bool = False
    allow_tuple_tools: bool = False

    pre_anchor_tuple_tools: bool = False
    pre_anchor_pending_text_by_ai_id: dict[str, str] = field(default_factory=dict)
    # 锚定前按到达顺序缓冲 delta / tool 事件（透传，不在 Gateway 合并）
    pre_anchor_stream_events: list[dict[str, Any]] = field(default_factory=list)
    last_values_tools_sig: str = ""
    last_thread_state_sig: str = ""
    usage_by_ai_id: dict[str, dict[str, int]] = field(default_factory=dict)
    end_usage: dict[str, int] | None = None
    last_usage_emit_sig: str = ""
    tuple_tools_kicked: bool = False
    # tool_call_id 已在本轮向前端下发过；无对应 tool_call 的 tool_result 多为 LangGraph 历史回放。
    emitted_tool_call_ids: set[str] = field(default_factory=set)
    # 流式 AI 块：同 id 上 tool_calls 出现前暂存正文，确认带工具则丢弃（非用户可见回复）。
    stream_ai_id: str = ""
    pending_text_by_ai_id: dict[str, str] = field(default_factory=dict)
    tool_call_ai_ids: set[str] = field(default_factory=set)
    last_emitted_replace_text: str = ""
    reasoning_accum: str = ""
    last_values_messages: list[dict[str, Any]] = field(default_factory=list)
    upstream_event_counts: dict[str, int] = field(default_factory=dict)
    emit_debug_stats: bool = False
    thread_id: str = ""
    last_live_activity_sig: str = ""
    run_end_emitted: bool = False
    write_tool_wire_state: dict[str, dict[str, Any]] = field(default_factory=dict)
    write_tool_index_to_key: dict[int, str] = field(default_factory=dict)
    subagent_root_task_ids: set[str] = field(default_factory=set)
    subagent_nested_tool_call_ids: set[str] = field(default_factory=set)
    subagent_stream_text_blocks: set[str] = field(default_factory=set)
    block_ledger: ContentBlockLedger = field(default_factory=ContentBlockLedger)

    def _wire_block(self, payload: dict[str, Any], meta: BlockWireMeta | None) -> None:
        if not meta:
            return
        payload.update(meta.as_wire())

    def _track_subagent_custom_chunk(self, chunk: dict[str, Any]) -> None:
        t = str(chunk.get("type") or "").strip()
        if t == "task_started":
            tid = str(chunk.get("task_id") or "").strip()
            if tid:
                self.subagent_root_task_ids.add(tid)
            return
        if t in {"task_completed", "task_failed", "task_timed_out", "task_cancelled"}:
            tid = str(chunk.get("task_id") or "").strip()
            if tid:
                self.subagent_root_task_ids.discard(tid)
            return
        if t != "task_running":
            return
        msg = chunk.get("message")
        if not isinstance(msg, dict):
            return
        text = _extract_assistant_text(msg) or str(msg.get("content") or "")
        piece = str(text or "").strip()
        if piece:
            self.subagent_stream_text_blocks.add(piece[:4000])
        raw_calls = msg.get("tool_calls")
        if isinstance(raw_calls, list):
            for tc in raw_calls:
                if not isinstance(tc, dict):
                    continue
                cid = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
                if cid:
                    self.subagent_nested_tool_call_ids.add(cid)

    def _is_subagent_leaked_text(self, piece: str) -> bool:
        p = str(piece or "").strip()
        if not p:
            return False
        for block in self.subagent_stream_text_blocks:
            if not block:
                continue
            if p == block or block.startswith(p) or p.startswith(block):
                return True
        return False

    def _is_subagent_nested_tool_id(self, tool_call_id: str) -> bool:
        cid = str(tool_call_id or "").strip()
        return bool(cid and cid in self.subagent_nested_tool_call_ids)

    def _emit_tools_phase_kick(
        self,
        out: EvfPayloadList,
        tool_calls: list[dict[str, Any]] | None = None,
    ) -> None:
        """Close open plan/body blocks when side-channel tool activity starts (incl. hidden tools)."""
        if not self.anchored:
            return
        meta = self.block_ledger.before_tools()
        for tc in tool_calls or []:
            if not isinstance(tc, dict):
                continue
            wire_id = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
            if wire_id and not self._is_subagent_nested_tool_id(wire_id):
                self.block_ledger.register_tool_id(meta.block_id, wire_id)
        self._extend_block_close_frames(out)

    def _block_ui_payload_for_run_end(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        segs = self.block_ledger.finalize_for_persist()
        if not segs:
            return {}, []
        out: dict[str, Any] = {"display_segments": segs}
        reasoning_segments = self.block_ledger.reasoning_segments()
        if reasoning_segments:
            out["reasoning_segments"] = reasoning_segments
            out["reasoning_preview"] = reasoning_segments[-1][:8000]
        return out, segs

    def _reset_block_ledger(self, human_idx: int) -> None:
        run_key = f"{self.thread_id or 'run'}:{human_idx}"
        self.block_ledger.reset(run_key)

    def _extend_block_close_frames(self, out: EvfPayloadList) -> None:
        closed = self.block_ledger.drain_closed()
        for meta in closed:
            payload: dict[str, Any] = {"type": "block_close"}
            self._wire_block(payload, meta)
            out.append(payload)

    def _resolve_write_tool_key(self, tc: dict[str, Any], chunk_meta: dict[str, Any] | None = None) -> str:
        cid = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
        idx_raw = chunk_meta.get("index") if isinstance(chunk_meta, dict) else None
        idx: int | None
        try:
            idx = int(idx_raw) if idx_raw is not None else None
        except (TypeError, ValueError):
            idx = None
        if cid:
            if idx is not None:
                prev_key = self.write_tool_index_to_key.get(idx)
                if prev_key and prev_key != cid and prev_key in self.write_tool_wire_state:
                    self.write_tool_wire_state[cid] = self.write_tool_wire_state.pop(prev_key)
                self.write_tool_index_to_key[idx] = cid
            return cid
        if idx is not None:
            return self.write_tool_index_to_key.get(idx) or f"idx:{idx}"
        return f"anon:{_tool_call_display_name(tc) or 'tool'}"

    def _sanitize_write_tool_call(
        self,
        tc: dict[str, Any],
        *,
        chunk_meta: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        key = self._resolve_write_tool_key(tc, chunk_meta)
        prev = self.write_tool_wire_state.get(key) or {}
        known_name = str(prev.get("tool_name") or "").strip()
        if not _is_write_tool(tc) and known_name.lower() not in _WRITE_TOOL_NAMES:
            logger.debug(f"[SANITIZE_WRITE] skipped: not write tool, key={key}, known_name={known_name}")
            return tc, None
        logger.debug(f"[SANITIZE_WRITE] processing: key={key}, tc_keys={list(tc.keys()) if isinstance(tc, dict) else type(tc)}")
        if idx_raw := (chunk_meta or {}).get("index"):
            try:
                self.write_tool_index_to_key[int(idx_raw)] = key
            except (TypeError, ValueError):
                pass
        merged = _merge_tool_calls(prev.get("_tc") if isinstance(prev.get("_tc"), dict) else None, tc)
        logger.debug(f"[SANITIZE_WRITE] merged: keys={list(merged.keys()) if isinstance(merged, dict) else type(merged)}")
        partial = _extract_write_fields_from_partial_args(_partial_tool_arguments(merged))
        logger.debug(f"[SANITIZE_WRITE] partial: path={partial.get('path', '')[:50] if partial.get('path') else 'empty'}, content_len={len(partial.get('content', ''))}")
        fields = _merge_write_fields(_normalize_tool_args(merged), partial)
        logger.debug(f"[SANITIZE_WRITE] fields: path={fields.get('path', '')[:50] if fields.get('path') else 'empty'}, content_len={len(fields.get('content', ''))}")
        tool_name = _tool_call_display_name(merged) or str(prev.get("tool_name") or "write_to_file")
        lines_added, lines_removed = _write_tool_line_stats(tool_name, fields)
        prev_added = int(prev.get("lines_added") or 0)
        prev_removed = int(prev.get("lines_removed") or 0)
        content = str(fields.get("content") or "")
        old_string = str(fields.get("old_string") or "")
        prev_content = str(prev.get("content") or "")
        prev_old = str(prev.get("old_string") or "")
        content_grew = len(content) > len(prev_content)
        old_grew = len(old_string) > len(prev_old)
        lines_changed = lines_added != prev_added or lines_removed != prev_removed
        path_now = str(fields.get("path") or prev.get("path") or "").strip()
        path_prev = str(prev.get("path") or "").strip()
        # Models often stream content-before-path JSON. Path may arrive on the
        # final fragment with no further content growth — still must emit progress
        # so the UI / wire log get a non-empty path.
        path_arrived = bool(path_now) and path_now != path_prev
        logger.debug(
            f"[SANITIZE_WRITE] stats: content_len={len(content)}, content_grew={content_grew}, "
            f"lines_changed={lines_changed}, path_arrived={path_arrived}"
        )
        progress: dict[str, Any] | None = None
        # Only emit progress when args actually arrive (content/old_string grows,
        # lines change, or path becomes known). Do NOT emit on first sight alone —
        # args may not have arrived yet, resulting in content_len=0 and empty path
        # clobbering the correct event later.
        if lines_changed or content_grew or old_grew or path_arrived:
            wire_id = key if not key.startswith(("idx:", "anon:")) else str(merged.get("id") or merged.get("tool_call_id") or "").strip()
            progress = {
                "type": "write_file_progress",
                "phase": "args",
                "tool_call_id": wire_id,
                "tool_name": tool_name,
                "path": path_now,
                "lines_added": lines_added,
                "lines_removed": lines_removed,
                "content_len": len(content),
            }
            # Stream body via deltas (not TOOL_CALL_ARGS). Cap per event; large jumps
            # send an absolute ``content`` snapshot so the UI does not lose the middle.
            _DELTA_MAX = 4096
            if content_grew:
                cdelta = content[len(prev_content) :]
                if len(cdelta) <= _DELTA_MAX:
                    if cdelta:
                        progress["content_delta"] = cdelta
                        # replace family: content is aliased from new_string — also
                        # emit new_string_delta so AG-UI / diff modal bind the same channel.
                        if tool_name.strip().lower() in {"replace", "str_replace", "replace_in_file"}:
                            progress["new_string_delta"] = cdelta
                else:
                    progress["content"] = content
                    if tool_name.strip().lower() in {"replace", "str_replace", "replace_in_file"}:
                        progress["new_string"] = content
            if old_grew:
                odelta = old_string[len(prev_old) :]
                if len(odelta) <= _DELTA_MAX:
                    if odelta:
                        progress["old_string_delta"] = odelta
                else:
                    progress["old_string"] = old_string
            logger.debug(
                f"[SANITIZE_WRITE] emitted progress: phase=args, content_len={len(content)}, "
                f"has_delta={bool(progress.get('content_delta') or progress.get('content'))}"
            )
        self.write_tool_wire_state[key] = {
            "_tc": merged,
            "tool_name": tool_name,
            "path": path_now,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            "content": content,
            "old_string": old_string,
        }
        sanitized = _build_slim_write_tool_call(merged, fields)
        logger.debug(f"[SANITIZE_WRITE] built sanitized: keys={list(sanitized.keys()) if isinstance(sanitized, dict) else type(sanitized)}")
        if isinstance(sanitized, dict):
            fn = sanitized.get("function") or {}
            fn_args = fn.get("arguments", "") if isinstance(fn, dict) else ""
            logger.debug(f"[SANITIZE_WRITE] sanitized.function.arguments: len={len(fn_args)}, preview={fn_args[:100] if fn_args else 'empty'}")
            args_obj = sanitized.get("args") or {}
            logger.debug(f"[SANITIZE_WRITE] sanitized.args: keys={list(args_obj.keys()) if isinstance(args_obj, dict) else type(args_obj)}")
            if isinstance(args_obj, dict):
                content_val = args_obj.get("content", "")
                logger.debug(f"[SANITIZE_WRITE] sanitized.args.content: len={len(content_val) if isinstance(content_val, str) else 0}")
        return sanitized, progress

    def _append_write_tool_wire(
        self,
        out: EvfPayloadList,
        tc: dict[str, Any],
        *,
        ev_type: str,
        source: str,
        chunk_meta: dict[str, Any] | None = None,
        meta: BlockWireMeta | None = None,
    ) -> None:
        if not isinstance(tc, dict):
            return
        # Later vendor chunks often omit name (only arguments delta). Inherit from
        # prior write-tool wire state so we don't drop them as "hidden" tools.
        key = self._resolve_write_tool_key(tc, chunk_meta)
        known = self.write_tool_wire_state.get(key) if key else None
        known_name = str((known or {}).get("tool_name") or "").strip()
        if known_name and not _tool_call_display_name(tc):
            tc = dict(tc)
            tc["name"] = known_name
            fn = dict(tc.get("function") or {}) if isinstance(tc.get("function"), dict) else {}
            if not fn.get("name"):
                fn["name"] = known_name
            tc["function"] = fn
        elif known_name and known_name.lower() in _WRITE_STREAM_TOOL_NAMES:
            # Already tracked write tool — allow continuation even if name resolves oddly.
            pass
        if not _chat_panel_visible_tool_call(tc):
            # Continuation args for an in-flight write tool must still stream.
            if known_name.lower() not in _WRITE_STREAM_TOOL_NAMES:
                logger.debug(
                    f"[APPEND_WRITE_TOOL] skipped: not chat_panel_visible, "
                    f"tc_keys={list(tc.keys()) if isinstance(tc, dict) else type(tc)}"
                )
                return
        wire_id = str(
            tc.get("id") or tc.get("tool_call_id") or (chunk_meta or {}).get("id") or ""
        ).strip()
        if self._is_subagent_nested_tool_id(wire_id):
            logger.debug(f"[APPEND_WRITE_TOOL] skipped: subagent_nested, wire_id={wire_id}")
            return
        logger.debug(f"[APPEND_WRITE_TOOL] processing: ev_type={ev_type}, wire_id={wire_id}, source={source}")
        sanitized, progress = self._sanitize_write_tool_call(tc, chunk_meta=chunk_meta)
        logger.debug(f"[APPEND_WRITE_TOOL] sanitized: keys={list(sanitized.keys()) if isinstance(sanitized, dict) else type(sanitized)}")
        if isinstance(sanitized, dict):
            fn = sanitized.get("function") or {}
            fn_args = fn.get("arguments", "") if isinstance(fn, dict) else ""
            logger.debug(f"[APPEND_WRITE_TOOL] sanitized.function.arguments: len={len(fn_args)}, preview={fn_args[:100] if fn_args else 'empty'}")
            args_obj = sanitized.get("args") or {}
            logger.debug(f"[APPEND_WRITE_TOOL] sanitized.args: keys={list(args_obj.keys()) if isinstance(args_obj, dict) else type(args_obj)}")
            if isinstance(args_obj, dict):
                content_val = args_obj.get("content", "")
                logger.debug(f"[APPEND_WRITE_TOOL] sanitized.args.content: len={len(content_val) if isinstance(content_val, str) else 0}")
        wire_id = str(
            sanitized.get("id") or sanitized.get("tool_call_id") or tc.get("id") or tc.get("tool_call_id") or ""
        ).strip()
        if wire_id:
            self.emitted_tool_call_ids.add(wire_id)
            if meta is not None:
                self.block_ledger.register_tool_id(meta.block_id, wire_id)
        if ev_type == "tool_call_chunk":
            payload: dict[str, Any] = {"type": "tool_call_chunk", "chunk": sanitized, "source": source}
            self._wire_block(payload, meta)
            out.append(payload)
            logger.debug("[APPEND_WRITE_TOOL] emitted tool_call_chunk payload")
        else:
            payload = {"type": "tool_call", "tool_calls": [sanitized], "source": source}
            self._wire_block(payload, meta)
            out.append(payload)
            logger.debug("[APPEND_WRITE_TOOL] emitted tool_call payload")
        if progress:
            out.append(progress)
            logger.debug(f"[APPEND_WRITE_TOOL] emitted progress: phase={progress.get('phase')}, content_len={progress.get('content_len')}")
        self._extend_block_close_frames(out)

    def _explicit_turn_isolation(self) -> bool:
        return bool(
            str(self.client_prior_prefix or "").strip()
            or str(self.client_prior_reasoning or "").strip()
        )

    def _strip_prev_prefix_for_turn(self, text: str, prefix: str) -> str:
        explicit = self._explicit_turn_isolation()
        min_len = 4 if explicit else _MIN_PREV_STRIP_LEN
        return _strip_prev_prefix(text, prefix, min_len=min_len, allow_hard_join=explicit)

    def _effective_prev_prefix(self) -> str:
        min_len = 4 if self._explicit_turn_isolation() else _MIN_PREV_STRIP_LEN
        return _pick_richest_prefix(self.prev_turn_prefix, self.client_prior_prefix, min_len=min_len)

    def _effective_prior_reasoning(self) -> str:
        min_len = 4 if self._explicit_turn_isolation() else _MIN_PREV_STRIP_LEN
        return _pick_richest_prefix(
            self.prev_turn_reasoning,
            self.client_prior_reasoning,
            min_len=min_len,
        )

    def _prior_reasoning_parts(self) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for blob in (self.client_prior_reasoning, self.prev_turn_reasoning):
            s = str(blob or "").strip()
            if not s:
                continue
            chunks = [s] if "\n\n" not in s else [p.strip() for p in s.split("\n\n") if p.strip()]
            for part in chunks:
                if len(part) < 8 or part in seen:
                    continue
                seen.add(part)
                out.append(part)
        return out

    def _strip_prior_reasoning_cumulative(self, incoming: str) -> str:
        out = incoming or ""
        for part in self._prior_reasoning_parts():
            out = _strip_prior_reasoning_piece(out, part)
            if not str(out or "").strip():
                return ""
        full = self._effective_prior_reasoning()
        if full:
            out = _strip_prior_reasoning_piece(out, full)
        return out

    def _refilter_preanchor_stream_events(self) -> None:
        """Anchor 后按上一轮正文前缀重滤 pre-anchor 缓冲，去掉 checkpoint 回灌。"""
        eff = self._effective_prev_prefix()
        if not eff:
            return
        kept: list[dict[str, Any]] = []
        for ev in self.pre_anchor_stream_events:
            if not isinstance(ev, dict):
                continue
            if ev.get("type") != "delta":
                kept.append(ev)
                continue
            text = self._strip_prev_prefix_for_turn(str(ev.get("text") or ""), eff)
            if str(text or "").strip():
                kept.append({**ev, "text": text})
        self.pre_anchor_stream_events = kept
        if not kept:
            self.pre_anchor_tuple_tools = False

    def _cumulative_usage_triplet(self) -> dict[str, int] | None:
        if self.end_usage:
            return dict(self.end_usage)
        inp = out_tok = total = 0
        cread = ccreate = cmiss = 0
        for t in self.usage_by_ai_id.values():
            inp += int(t.get("input_tokens") or 0)
            out_tok += int(t.get("output_tokens") or 0)
            total += int(t.get("total_tokens") or 0)
            cread += int(t.get("cache_read_tokens") or 0)
            ccreate += int(t.get("cache_creation_tokens") or 0)
            cmiss += int(t.get("cache_miss_tokens") or 0)
        if not inp and not out_tok and not total:
            return None
        out: dict[str, int] = {
            "input_tokens": inp,
            "output_tokens": out_tok,
            "total_tokens": total or inp + out_tok,
        }
        if cread:
            out["cache_read_tokens"] = cread
        if ccreate:
            out["cache_creation_tokens"] = ccreate
        if cmiss:
            out["cache_miss_tokens"] = cmiss
        return out

    def _emit_usage_updates(self) -> EvfPayloadList:
        """Push cumulative turn usage whenever a model call reports usage_metadata."""
        um = self._cumulative_usage_triplet()
        if not um:
            return []
        try:
            sig = json.dumps(um, ensure_ascii=False, sort_keys=True)
        except Exception:
            sig = str(um)
        if sig == self.last_usage_emit_sig:
            return []
        self.last_usage_emit_sig = sig
        return [{"type": "usage", "usage": um}]

    def _should_skip_stale_piece_for_prev_id(self, msg_id: str, piece: str) -> bool:
        """停后继续：禁止把已封存 assistant 全文当作新 delta 重放。"""
        if not msg_id or msg_id != self.prev_turn_assistant_id:
            return False
        eff = self._effective_prev_prefix()
        if not eff or not piece:
            return False
        p = piece.strip()
        e = eff.strip()
        if not p or not e:
            return False
        if p == e or e.startswith(p):
            return True
        if len(p) >= _MIN_PREV_STRIP_LEN and e.startswith(p[: min(len(p), 200)]):
            return True
        return False

    def feed_evf_payloads(self, event_name: str, data: Any) -> EvfPayloadList:
        ev = (event_name or "").strip().lower()
        if ev:
            self.upstream_event_counts[ev] = self.upstream_event_counts.get(ev, 0) + 1
        if ev in {"messages", "messages-tuple", "message"}:
            return self._on_messages(data)
        if ev == "values":
            return self._on_values(data)
        if ev == "custom":
            return self._on_custom(data)
        if ev == "end":
            return self._on_end(data)
        if ev == "metadata":
            return []
        if ev == "error":
            err_obj = data if isinstance(data, dict) else {}
            err_code = str(err_obj.get("error") or "").strip()
            if err_code == "UserInterrupt" or "UserInterrupt" in err_code:
                return [{"type": "aborted", "reason": "user_interrupt"}]
            return [{"type": "error", "error": data}]
        if ev:
            logger.debug("Unknown SSE event: %s", ev)
        return []

    def feed_frame(self, event_name: str, data: Any) -> list[bytes]:
        return _evf_payloads_to_wire(self.feed_evf_payloads(event_name, data))

    def _sync_prev_turn_prefix(self, messages: list[dict[str, Any]], human_idx: int) -> None:
        if human_idx <= 0:
            return
        for i in range(human_idx - 1, -1, -1):
            if _is_assistant(messages[i]):
                self.prev_turn_prefix = _extract_assistant_text(messages[i])
                self.prev_turn_reasoning = _extract_assistant_reasoning(messages[i])
                mid = str(messages[i].get("id") or "").strip()
                self.prev_turn_assistant_id = mid
                if self.client_prior_message_id and not mid:
                    self.prev_turn_assistant_id = self.client_prior_message_id
                break
        if self.client_prior_message_id and not self.prev_turn_assistant_id:
            self.prev_turn_assistant_id = self.client_prior_message_id

    def _try_anchor(self, messages: list[dict[str, Any]]) -> None:
        human_idx = _find_last_human_idx_for_anchor(messages, expected_text=self.user_input)
        if human_idx < 0:
            return
        expected = _norm_loose(self.user_input)
        human_text = _norm_loose(_message_text(messages[human_idx]))
        if expected and human_text != expected:
            return
        # Join/attach streams have no POST body user_input — anchor on last real human.
        if self.anchored:
            self._sync_prev_turn_prefix(messages, human_idx)
            return
        pre_tuple = self.pre_anchor_tuple_tools
        had_preanchor_deltas = any(
            ev.get("type") == "delta" for ev in self.pre_anchor_stream_events if isinstance(ev, dict)
        )
        # Hydrated transcript on a fresh LangGraph thread can arrive as complete AIMessages
        # before values anchors — do not replay that history as live SSE.
        if _has_graph_progress_after_human(messages, human_idx):
            self.pre_anchor_stream_events.clear()
            self.pre_anchor_tuple_tools = False
            pre_tuple = False
            had_preanchor_deltas = False
        self.anchored = True
        self.anchored_human_idx = human_idx
        self.per_message_stream_text.clear()
        self.pre_anchor_pending_text_by_ai_id.clear()
        self.last_values_tools_sig = ""
        self.allow_tuple_tools = pre_tuple
        self.tuple_tools_kicked = pre_tuple
        self.pre_anchor_tuple_tools = False
        self.final_text = ""
        self.prev_turn_assistant_id = ""
        self.emitted_tool_call_ids.clear()
        self.stream_ai_id = ""
        self.pending_text_by_ai_id.clear()
        self.tool_call_ai_ids.clear()
        self.last_emitted_replace_text = ""
        self.reasoning_accum = ""
        self.write_tool_wire_state.clear()
        self.write_tool_index_to_key.clear()
        self.subagent_root_task_ids.clear()
        self.subagent_nested_tool_call_ids.clear()
        self.subagent_stream_text_blocks.clear()
        self.stream_text_from_messages = had_preanchor_deltas
        self._sync_prev_turn_prefix(messages, human_idx)
        self._refilter_preanchor_stream_events()
        self._reset_block_ledger(human_idx)

    def _register_tool_id(self, tc_or_chunk: dict[str, Any]) -> None:
        cid = str(tc_or_chunk.get("id") or tc_or_chunk.get("tool_call_id") or "").strip()
        if cid:
            self.emitted_tool_call_ids.add(cid)

    def _buffer_preanchor_stream(self, root: dict[str, Any]) -> None:
        """按 messages 到达顺序缓冲，锚定后原序重放（避免工具全在顶、正文沉底）。"""
        if not _is_streaming_message_chunk(root):
            return
        piece = self._strip_prev_prefix_for_turn(_message_text(root), self._effective_prev_prefix())
        msg_id = str(root.get("id") or "").strip() or "__noid__"
        has_tools = _message_has_tool_signal(root)
        if has_tools:
            if piece:
                self.pre_anchor_stream_events.append(
                    {"type": "delta", "text": piece, "delta_kind": "append"}
                )
            self._discard_assistant_stream_text(msg_id)
            self.pre_anchor_tuple_tools = True
        elif piece and msg_id not in self.tool_call_ai_ids:
            self.pre_anchor_stream_events.append({"type": "delta", "text": piece, "delta_kind": "append"})
        chunks = root.get("tool_call_chunks")
        chunk_list = [ch for ch in chunks if isinstance(ch, dict)] if isinstance(chunks, list) else []
        if chunk_list:
            self.pre_anchor_tuple_tools = True
            for ch in chunk_list:
                if _chat_panel_visible_tool_call(ch):
                    self.pre_anchor_stream_events.append({"type": "tool_call_chunk", "chunk": ch})
            return
        tcs = root.get("tool_calls")
        if isinstance(tcs, list):
            for tc in tcs:
                if isinstance(tc, dict) and _chat_panel_visible_tool_call(tc):
                    self.pre_anchor_tuple_tools = True
                    self.pre_anchor_stream_events.append({"type": "tool_call", "tool_calls": [tc]})

    def _replay_preanchor_stream(self) -> EvfPayloadList:
        if not self.pre_anchor_stream_events and not self.pre_anchor_tuple_tools and not self.tuple_tools_kicked:
            return []
        self.allow_tuple_tools = True
        out: EvfPayloadList = []
        for ev in self.pre_anchor_stream_events:
            if not isinstance(ev, dict):
                continue
            if ev.get("type") == "delta":
                text = str(ev.get("text") or "")
                if text:
                    out.extend(self._emit_delta_raw(text, delta_kind=str(ev.get("delta_kind") or "append")))
            elif ev.get("type") == "tool_call_chunk":
                ch = ev.get("chunk")
                if isinstance(ch, dict):
                    meta = self.block_ledger.before_tools()
                    self._append_write_tool_wire(
                        out, ch, ev_type="tool_call_chunk", source="messages", chunk_meta=ch, meta=meta
                    )
            elif ev.get("type") == "tool_call":
                tcs = ev.get("tool_calls")
                if isinstance(tcs, list):
                    meta = self.block_ledger.before_tools()
                    for tc in tcs:
                        if isinstance(tc, dict):
                            self._append_write_tool_wire(
                                out, tc, ev_type="tool_call", source="messages", chunk_meta=tc, meta=meta
                            )
        self.pre_anchor_stream_events.clear()
        return out

    def _emit_tools_passthrough(self, root: dict[str, Any], *, source: str) -> EvfPayloadList:
        """透传上游 tool_call_chunks / tool_calls，不在 Gateway 拼装 JSON。"""
        if not self.anchored or not self.allow_tuple_tools:
            logger.debug(f"[SSE_PASSTHROUGH] skipped: anchored={self.anchored}, allow_tuple_tools={self.allow_tuple_tools}")
            return []
        out: EvfPayloadList = []
        chunks = root.get("tool_call_chunks")
        chunk_list = [ch for ch in chunks if isinstance(ch, dict)] if isinstance(chunks, list) else []
        if chunk_list:
            logger.debug(f"[SSE_PASSTHROUGH] processing {len(chunk_list)} tool_call_chunks from source={source}")
            meta = self.block_ledger.before_tools()
            for i, ch in enumerate(chunk_list):
                # Log chunk structure
                fn_args = (ch.get("function") or {}).get("arguments", "") if isinstance(ch.get("function"), dict) else ""
                logger.debug(f"[SSE_PASSTHROUGH] chunk[{i}]: id={ch.get('id')}, args_len={len(fn_args)}, args_preview={fn_args[:100] if fn_args else 'empty'}")
                self._append_write_tool_wire(
                    out, ch, ev_type="tool_call_chunk", source=source, chunk_meta=ch, meta=meta
                )
            return out
        tcs = root.get("tool_calls")
        # LangGraph often sends ``tool_calls: []`` on plain text/reasoning chunks.
        # Calling ``before_tools()`` on an empty list closes the open body_text and
        # allocates empty tools blocks → one word per TEXT_MESSAGE_* in the UI.
        tc_list = [tc for tc in tcs if isinstance(tc, dict)] if isinstance(tcs, list) else []
        if not tc_list:
            return out
        logger.debug(f"[SSE_PASSTHROUGH] processing {len(tc_list)} tool_calls from source={source}")
        meta = self.block_ledger.before_tools()
        for i, tc in enumerate(tc_list):
            fn_args = (tc.get("function") or {}).get("arguments", "") if isinstance(tc.get("function"), dict) else ""
            logger.debug(f"[SSE_PASSTHROUGH] tc[{i}]: id={tc.get('id')}, args_len={len(fn_args)}, args_preview={fn_args[:100] if fn_args else 'empty'}")
            self._append_write_tool_wire(
                out, tc, ev_type="tool_call", source=source, chunk_meta=tc, meta=meta
            )
        return out

    def _emit_tool_calls_list_passthrough(self, calls: list[dict[str, Any]], *, source: str) -> EvfPayloadList:
        tc_list = [tc for tc in calls if isinstance(tc, dict)]
        if not tc_list:
            return []
        out: EvfPayloadList = []
        meta = self.block_ledger.before_tools()
        for tc in tc_list:
            self._append_write_tool_wire(out, tc, ev_type="tool_call", source=source, chunk_meta=tc, meta=meta)
        return out

    def _emit_delta_raw(
        self,
        piece: str,
        *,
        delta_kind: str = "append",
        content_phase: str | None = None,
        message_id: str = "",
    ) -> EvfPayloadList:
        """Emit one text frame. Append = passthrough; never rewrite live token text.

        ``per_message_stream_text`` only records what we already emitted (ledger /
        run_end fallback). It must not decide whether a chunk is “cumulative”.
        Prev-turn prefix strip is the only mutation, and only to block resume leak.
        """
        mid = str(message_id or "").strip() or "__noid__"
        eff = self._effective_prev_prefix()
        if mid == self.prev_turn_assistant_id:
            piece = _strip_prev_prefix(piece, eff)
        elif eff and piece.startswith(eff):
            piece = _strip_prev_prefix(piece, eff)
        if not piece or self._should_skip_stale_piece_for_prev_id(mid, piece):
            return []
        if self._is_subagent_leaked_text(piece):
            return []
        kind = "replace" if delta_kind == "replace" else "append"
        baseline = self.per_message_stream_text.get(mid, "")
        if mid == self.prev_turn_assistant_id and eff and not baseline:
            baseline = eff
        if kind == "replace":
            # Explicit replace frames may carry a growing snapshot; emit the suffix only.
            if piece.startswith(baseline):
                emit_piece = piece[len(baseline) :]
            elif baseline.startswith(piece):
                emit_piece = ""
            else:
                emit_piece = piece
            if not emit_piece:
                return []
            if emit_piece == self.last_emitted_replace_text:
                return []
            self.last_emitted_replace_text = emit_piece
            self.per_message_stream_text[mid] = piece
        else:
            # Live *Chunk text is incremental. Append as-is — no startswith / dedupe.
            emit_piece = piece
            self.per_message_stream_text[mid] = baseline + emit_piece
        self.stream_text_from_messages = True
        payload: dict[str, Any] = {
            "type": "delta",
            "text": emit_piece,
            "delta_kind": kind,
            "message_id": mid if mid != "__noid__" else None,
        }
        if content_phase in {"post_tools", "pre_tools"}:
            payload["content_phase"] = content_phase
        block_meta = self.block_ledger.delta_text(emit_piece, content_phase)
        self._wire_block(payload, block_meta)
        if payload.get("message_id") is None:
            payload.pop("message_id", None)
        frames = [payload]
        self._extend_block_close_frames(frames)
        self._emit_content_activity(frames, kind="model", detail="输出中…")
        return frames

    def _emit_content_activity(self, out: EvfPayloadList, *, kind: str, detail: str) -> None:
        """Push a content-phase activity event (思考中… / 输出中…) with dedup + ts.

        Called when reasoning delta or text delta arrives, so the frontend
        never needs to infer status from content — the backend is the single
        source of truth for all activity states.
        """
        act_sig = f"{kind}:{detail}"
        if act_sig == self.last_live_activity_sig:
            return
        self.last_live_activity_sig = act_sig
        out.append(
            {
                "type": "activity",
                "kind": kind,
                "detail": detail,
                "ts": int(time.time() * 1000),
            }
        )

    def _discard_assistant_stream_text(self, ai_id: str) -> None:
        """Drop text for an AI generation that ended with tool_calls (not user-facing reply)."""
        if ai_id:
            self.tool_call_ai_ids.add(ai_id)

    def _on_messages(self, data: Any) -> EvfPayloadList:
        root = _unwrap_messages_root(data)
        if not root:
            return []
        stream_meta = _unwrap_messages_stream_meta(data)
        nested_tool_llm = _is_nested_tool_node_stream(stream_meta)
        chunks = root.get("tool_call_chunks")
        if isinstance(chunks, list) and chunks:
            self.tuple_tools_kicked = True
            if self.anchored:
                self.allow_tuple_tools = True
            else:
                self.pre_anchor_tuple_tools = True
        if not self.anchored:
            if _is_assistant(root) or str(root.get("type") or "").endswith("Chunk"):
                self._buffer_preanchor_stream(root)
            return []
        out: EvfPayloadList = []

        if _is_assistant(root) or str(root.get("type") or "").endswith("Chunk"):
            # Complete AIMessage rows are transcript/state sync — never replay as live SSE.
            if not _is_live_messages_stream_row(root):
                return []
            um = _usage_from_ai_message_dict(root)
            if um:
                mid = str(root.get("id") or "__noid__")
                self.usage_by_ai_id[mid] = um
                out.extend(self._emit_usage_updates())

            if self.use_claude_code_chat:
                out.extend(self._emit_tools_passthrough(root, source="messages"))
                return out

            # view_image / vision_analyze call a vision model inside the tools node; LangGraph
            # still streams AIMessageChunk rows — must not treat as assistant reply text.
            if nested_tool_llm:
                msg_id = str(root.get("id") or "").strip() or "__noid__"
                if _message_has_tool_signal(root):
                    self._discard_assistant_stream_text(msg_id)
                    self.tuple_tools_kicked = True
                    self.allow_tuple_tools = True
                out.extend(self._emit_tools_passthrough(root, source="messages"))
                return out

            piece = _message_text(root)
            eff = self._effective_prev_prefix()
            msg_id = str(root.get("id") or "").strip() or "__noid__"
            if msg_id == self.prev_turn_assistant_id:
                piece_use = self._strip_prev_prefix_for_turn(piece, eff)
            elif eff and piece.startswith(eff):
                piece_use = self._strip_prev_prefix_for_turn(piece, eff)
            else:
                piece_use = piece
            has_tools = _message_has_tool_signal(root)

            if has_tools:
                # Write-tool args (and any content echoed while tool_call_chunks stream)
                # must not become chat body_text — that produces fragmented "Thinking N"
                # stacks and dumps file prose into the transcript.
                streaming_tool_args = isinstance(chunks, list) and any(
                    isinstance(c, dict) for c in chunks
                )
                if (
                    piece_use
                    and not streaming_tool_args
                    and not _message_has_write_tool_signal(root)
                ):
                    out.extend(self._emit_delta_raw(piece_use, message_id=msg_id))
                self._discard_assistant_stream_text(msg_id)
                self.tuple_tools_kicked = True
                self.allow_tuple_tools = True
            elif piece_use:
                self.allow_tuple_tools = True
                if msg_id not in self.tool_call_ai_ids:
                    out.extend(self._emit_delta_raw(piece_use, message_id=msg_id))

            out.extend(self._emit_tools_passthrough(root, source="messages"))

            ak = root.get("additional_kwargs")
            if isinstance(ak, dict) and isinstance(ak.get("reasoning_content"), str):
                rc = self._strip_prior_reasoning_cumulative(ak["reasoning_content"])
                if rc and self.anchored:
                    merged, delta = _reasoning_stream_delta(self.reasoning_accum, rc)
                    self.reasoning_accum = merged
                    if delta:
                        reasoning_payload: dict[str, Any] = {
                            "type": "reasoning",
                            "preview": delta[:8000],
                        }
                        block_meta = self.block_ledger.reasoning_delta(delta)
                        self._wire_block(reasoning_payload, block_meta)
                        out.append(reasoning_payload)
                        self._emit_content_activity(out, kind="model", detail="思考中…")
            self._extend_block_close_frames(out)
            return out

        if _is_tool(root):
            if not self.anchored:
                return []
            tool_payload = _slim_tool_result_message(root)
            tcid = str(tool_payload.get("tool_call_id") or tool_payload.get("id") or "").strip()
            tool_name = str(
                tool_payload.get("name") or tool_payload.get("tool_name") or "tool"
            ).strip()
            if tool_omit_from_chat_panel(tool_name):
                return out
            if not tcid or tcid not in self.emitted_tool_call_ids:
                return out
            out.append(
                {
                    "type": "tool_result",
                    "tool": tool_payload,
                    "tool_call_id": tcid,
                    "name": tool_payload.get("name") or tool_payload.get("tool_name") or "tool",
                    "content": tool_payload.get("content"),
                    "status": tool_payload.get("status") or "ok",
                    **(
                        {"truncated": True, "content_bytes": tool_payload.get("content_bytes")}
                        if tool_payload.get("truncated")
                        else {}
                    ),
                }
            )
        return out

    def _on_values(self, data: Any) -> EvfPayloadList:
        if not isinstance(data, dict):
            return []
        messages = _display_messages(data)
        was_anchored = self.anchored
        self._try_anchor(messages)
        out: EvfPayloadList = []
        if not was_anchored and self.anchored:
            out.extend(self._replay_preanchor_stream())

        raw = _pick_values_root(data)
        human_idx_for_state = _find_last_real_human_idx(messages) if self.anchored else -1
        if human_idx_for_state >= 0:
            for m in messages[human_idx_for_state + 1:]:
                if not isinstance(m, dict) or not _is_assistant(m):
                    continue
                um = _usage_from_ai_message_dict(m)
                if um:
                    mid = str(m.get("id") or "__noid__")
                    self.usage_by_ai_id[mid] = um
            out.extend(self._emit_usage_updates())
        turn_calls_for_state = (
            _collect_turn_tool_calls(messages, human_idx_for_state) if human_idx_for_state >= 0 else []
        )
        tool_names = [
            str(tc.get("name") or (tc.get("function") or {}).get("name") or "").strip()
            for tc in turn_calls_for_state
            if _chat_panel_visible_tool_call(tc)
            and str(tc.get("name") or (tc.get("function") or {}).get("name") or "").strip()
        ]
        activity_kind, activity_detail, last_assistant_calls = _resolve_thread_activity_from_messages(
            messages,
            human_idx_for_state,
            thread_id=str(self.thread_id or ""),
            anchored=self.anchored,
        )
        wire_tool_calls: list[dict[str, Any]] = []
        if last_assistant_calls:
            for tc in last_assistant_calls[-1:]:
                if not isinstance(tc, dict) or not _chat_panel_visible_tool_call(tc):
                    continue
                slim, _ = self._sanitize_write_tool_call(tc, chunk_meta=tc)
                wire_tool_calls.append(slim)
        state_payload = {
            "type": "thread_state",
            "title": raw.get("title") if isinstance(raw.get("title"), str) else None,
            "todos": raw.get("todos") if isinstance(raw.get("todos"), list) else [],
            "artifacts": raw.get("artifacts") if isinstance(raw.get("artifacts"), list) else [],
            "anchored": self.anchored,
            "activityKind": activity_kind,
            "activityDetail": activity_detail,
            "toolNames": tool_names,
            "toolCalls": wire_tool_calls if activity_kind == "tools" else [],
        }
        try:
            sig = json.dumps(state_payload, ensure_ascii=False, sort_keys=True, default=str)
        except Exception:
            sig = ""
        if sig != self.last_thread_state_sig:
            self.last_thread_state_sig = sig
            if activity_kind == "tools":
                self._emit_tools_phase_kick(out, wire_tool_calls)
            out.append(state_payload)
        # 不再从 thread_state 块重复推送 activity 事件。
        # activity 状态已由 _emit_content_activity（reasoning/text delta）和
        # 中间件 agent_activity（准备中/生成中/调用工具/推理中）统一推送，
        # 此处基于累积 messages 的推断会推送过时状态，覆盖实时状态。

        if not self.anchored:
            return out

        human_idx = _find_last_real_human_idx(messages)
        if human_idx < 0:
            return out
        self.last_values_messages = [m for m in messages if isinstance(m, dict)]

        # Values tool_calls: bootstrap only before live messages-tuple stream starts.
        may_values_tools = self.stream_text_from_messages or self.tuple_tools_kicked
        turn_calls = _collect_turn_tool_calls(messages, human_idx)
        visible_turn_calls = [tc for tc in turn_calls if isinstance(tc, dict) and _chat_panel_visible_tool_call(tc)]
        # messages-tuple 已在流式下发工具时间线；values 快照勿整批重放，否则 Exploring 时序错乱。
        if visible_turn_calls and may_values_tools and not self.tuple_tools_kicked:
            calls_sig = json.dumps(visible_turn_calls, ensure_ascii=False, sort_keys=True, default=str)
            if calls_sig != self.last_values_tools_sig:
                self.last_values_tools_sig = calls_sig
                if any(_tool_ready(tc) for tc in visible_turn_calls):
                    self.allow_tuple_tools = True
                    self.tuple_tools_kicked = True
                out.extend(self._emit_tool_calls_list_passthrough(visible_turn_calls, source="values"))

        return out

    def _on_custom(self, data: Any) -> EvfPayloadList:
        chunk: Any = data
        if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
            chunk = data[1]
        elif isinstance(data, dict) and isinstance(data.get("chunk"), dict):
            chunk = data["chunk"]
        if not isinstance(chunk, dict):
            return []
        t = str(chunk.get("type") or "").strip()
        self._track_subagent_custom_chunk(chunk)
        # Promote steer-ack to a first-class EVF type so AG-UI can emit a named CUSTOM
        # (default stream_format=agui was dropping it inside the generic custom envelope).
        if t == "pending_inject_consumed":
            return [dict(chunk)]
        out: EvfPayloadList = [{"type": "custom", "chunk": chunk}]
        if t == "agent_activity":
            detail = str(chunk.get("detail") or "").strip()
            raw_calls = chunk.get("tool_calls")
            call_list = [c for c in raw_calls if isinstance(c, dict)] if isinstance(raw_calls, list) else []
            if call_list or str(chunk.get("kind") or "") == "tools":
                self._emit_tools_phase_kick(out, call_list or None)
            if detail:
                act: dict[str, Any] = {
                    "type": "activity",
                    "kind": str(chunk.get("kind") or "system").strip() or "system",
                    "detail": detail,
                    "ts": int(time.time() * 1000),
                }
                tool_name = str(chunk.get("tool_name") or "").strip()
                if tool_name:
                    act["tool_name"] = tool_name
                raw_calls = chunk.get("tool_calls")
                if isinstance(raw_calls, list) and raw_calls:
                    act["tool_calls"] = [c for c in raw_calls if isinstance(c, dict)]
                out.append(act)
            return out
        if t == "context_compaction_start":
            out.append(
                {
                    "type": "activity",
                    "kind": "compacting",
                    "detail": "正在压缩上下文…",
                    "ts": int(time.time() * 1000),
                }
            )
            return out
        if t == "context_compaction_end":
            out.append(
                {
                    "type": "activity",
                    "kind": "pre_model",
                    "detail": "准备中…",
                    "ts": int(time.time() * 1000),
                }
            )
            return out
        if t == "empty_response_fallback":
            piece = str(chunk.get("text") or "")
            if piece:
                out.extend(self._emit_delta_raw(piece, delta_kind="append"))
            return out
        if t == "model_fallback_switch":
            model_name = str(chunk.get("model_name") or "").strip()
            text = str(chunk.get("text") or "").strip()
            out.append(
                {
                    "type": "model_fallback_switch",
                    "model_name": model_name,
                    "from_model": str(chunk.get("from_model") or "").strip(),
                    "text": text,
                }
            )
            if text:
                out.extend(self._emit_delta_raw(text, delta_kind="append"))
            return out
        if t == "tool_approval_pending":
            tcid = str(chunk.get("tool_call_id") or "").strip()
            if not tcid:
                return out
            self.emitted_tool_call_ids.add(tcid)
            tool_name = str(chunk.get("tool_name") or "tool").strip()
            content = chunk.get("content")
            tool_payload = _slim_tool_result_message(
                {
                    "type": "tool",
                    "role": "tool",
                    "tool_call_id": tcid,
                    "name": tool_name,
                    "content": content,
                    "status": "pending_approval",
                }
            )
            wire_status = str(tool_payload.get("status") or "pending_approval").strip() or "pending_approval"
            if wire_status == "ok":
                wire_status = "pending_approval"
            out.append(
                {
                    "type": "tool_result",
                    "tool": tool_payload,
                    "tool_call_id": tcid,
                    "name": tool_payload.get("name") or tool_payload.get("tool_name") or tool_name,
                    "content": tool_payload.get("content"),
                    "status": wire_status,
                }
            )
            out.append(
                {
                    "type": "activity",
                    "kind": "tool_approval",
                    "detail": "等待工具授权…",
                    "ts": int(time.time() * 1000),
                }
            )
            tid = str(self.thread_id or "").strip()
            if tid:
                try:
                    from app.gateway.streaming.post_stream_ui_normalize import mark_thread_tool_approval_pause

                    mark_thread_tool_approval_pause(tid)
                except Exception:
                    pass
            return out
        if t == "tool_approval_decision":
            tcid = str(chunk.get("tool_call_id") or "").strip()
            if not tcid:
                return out
            tool_name = str(chunk.get("tool_name") or "tool").strip()
            wire_status = str(chunk.get("status") or "approved_waiting").strip() or "approved_waiting"
            content = chunk.get("content")
            if not isinstance(content, str) or not content.strip():
                content = json.dumps(
                    {
                        "_evoflow_tool": {"status": wire_status},
                        "message": f"工具授权结果：{wire_status}",
                    },
                    ensure_ascii=False,
                )
            tool_payload = _slim_tool_result_message(
                {
                    "type": "tool",
                    "role": "tool",
                    "tool_call_id": tcid,
                    "name": tool_name,
                    "content": content,
                    "status": wire_status,
                }
            )
            out.append(
                {
                    "type": "tool_result",
                    "tool": tool_payload,
                    "tool_call_id": tcid,
                    "name": tool_name,
                    "content": tool_payload.get("content"),
                    "status": wire_status,
                }
            )
            if wire_status in {"approved_waiting", "awaiting_other_approval"}:
                out.append(
                    {
                        "type": "activity",
                        "kind": "tool_approval",
                        "detail": "已批准，等待其余工具授权…",
                        "ts": int(time.time() * 1000),
                    }
                )
            elif wire_status == "denied":
                out.append(
                    {
                        "type": "activity",
                        "kind": "tools",
                        "detail": "已拒绝工具授权",
                        "ts": int(time.time() * 1000),
                    }
                )
            else:
                out.append(
                    {
                        "type": "activity",
                        "kind": "tools",
                        "detail": "工具已授权，继续执行…",
                        "ts": int(time.time() * 1000),
                    }
                )
            return out
        if t == "tool_execution_result":
            tcid = str(chunk.get("tool_call_id") or "").strip()
            if not tcid:
                return out
            tool_name = str(chunk.get("tool_name") or "tool").strip()
            wire_status = str(chunk.get("status") or "ok").strip() or "ok"
            content = chunk.get("content")
            tool_payload = _slim_tool_result_message(
                {
                    "type": "tool",
                    "role": "tool",
                    "tool_call_id": tcid,
                    "name": tool_name,
                    "content": content,
                    "status": wire_status,
                }
            )
            out.append(
                {
                    "type": "tool_result",
                    "tool": tool_payload,
                    "tool_call_id": tcid,
                    "name": tool_name,
                    "content": tool_payload.get("content"),
                    "status": wire_status,
                }
            )
            out.append(
                {
                    "type": "activity",
                    "kind": "tools",
                    "detail": "工具执行完成",
                    "ts": int(time.time() * 1000),
                }
            )
            return out
        if t == "write_file_progress":
            # Live progress emitted by write_file_hd / str_replace_hd during disk I/O.
            # Passthrough to UI (schema matches args-streaming progress + extra phase/bytes fields).
            payload: dict[str, Any] = {
                "type": "write_file_progress",
                "phase": str(chunk.get("phase") or "writing"),
                "tool_call_id": str(chunk.get("tool_call_id") or "").strip(),
                "tool_name": str(chunk.get("tool_name") or "write"),
                "path": str(chunk.get("path") or ""),
                "lines_added": int(chunk.get("lines_added") or 0),
                "lines_removed": int(chunk.get("lines_removed") or 0),
                "content_len": int(chunk.get("content_len") or 0),
            }
            if chunk.get("bytes_total") is not None:
                payload["bytes_total"] = int(chunk.get("bytes_total") or 0)
            if chunk.get("bytes_written") is not None:
                payload["bytes_written"] = int(chunk.get("bytes_written") or 0)
            if isinstance(chunk.get("message"), str) and chunk.get("message"):
                payload["message"] = str(chunk.get("message"))
            if isinstance(chunk.get("content_delta"), str) and chunk.get("content_delta"):
                payload["content_delta"] = chunk["content_delta"][:4096]
            if isinstance(chunk.get("old_string_delta"), str) and chunk.get("old_string_delta"):
                payload["old_string_delta"] = chunk["old_string_delta"][:4096]
            if isinstance(chunk.get("new_string_delta"), str) and chunk.get("new_string_delta"):
                payload["new_string_delta"] = chunk["new_string_delta"][:4096]
            if isinstance(chunk.get("content"), str) and chunk.get("content"):
                payload["content"] = chunk["content"]
            if isinstance(chunk.get("old_string"), str) and chunk.get("old_string"):
                payload["old_string"] = chunk["old_string"]
            if isinstance(chunk.get("new_string"), str) and chunk.get("new_string"):
                payload["new_string"] = chunk["new_string"]
            # Skip the generic {"type":"custom"} envelope for progress events — the UI
            # only needs the typed payload; the envelope would bloat the stream.
            out = [payload]
            return out
        if t == "trae_stream_delta" and self.anchored:
            piece = str(chunk.get("text") or "")
            if piece:
                dt = str(chunk.get("delta_type") or "delta")
                if dt == "replace":
                    out.extend(self._emit_delta_raw(piece, delta_kind="replace"))
                else:
                    out.extend(self._emit_delta_raw(piece))
        return out

    def _on_end(self, data: Any) -> EvfPayloadList:
        out: EvfPayloadList = []
        if isinstance(data, dict):
            for k in ("usage", "usage_metadata"):
                um = _usage_triplet(data.get(k) if isinstance(data.get(k), dict) else None)
                if um:
                    self.end_usage = um
                    break
            if not self.end_usage:
                um = _usage_triplet(data)
                if um:
                    self.end_usage = um
        out.extend(self._emit_usage_updates())
        # LangGraph ``event: end`` marks run completion; emit ``run_end`` immediately so the
        # browser can clear "generating" without waiting for upstream SSE close / inject tail.
        out.extend(self._build_run_end_payloads())
        return out

    def _build_run_end_payloads(self) -> EvfPayloadList:
        if self.run_end_emitted:
            return []
        self._touch_run_ended_from_stream()
        out: EvfPayloadList = []
        usage = self.end_usage or self._cumulative_usage_triplet()
        block_ui, block_segs = self._block_ui_payload_for_run_end()
        end_text = _join_display_segment_texts(block_segs)
        if not end_text:
            merged_turn = ""
            if self.last_values_messages:
                hidx = _find_last_real_human_idx(self.last_values_messages)
                if hidx >= 0:
                    merged_turn = _merge_turn_assistant_texts(
                        _collect_assistant_texts_after_human(
                            self.last_values_messages, hidx, self.prev_turn_prefix
                        )
                    )
            stream_turn = ""
            if self.per_message_stream_text:
                stream_turn = _merge_turn_assistant_texts(list(self.per_message_stream_text.values()))
            # Prefer live stream merge over values snapshot — LangGraph values order can lag.
            end_text = _pick_richest_display_text(self.final_text, stream_turn, merged_turn)
        if not str(end_text or "").strip():
            usage_hint = usage or {}
            logger.info(
                "[ui_stream] run_end 正文为空 已锚定=%s 流式正文长度=%d 合并正文长度=%d token用量=%s 上游事件=%s",
                self.anchored,
                len(str(self.final_text or "")),
                len(str(end_text or "")),
                usage_hint,
                dict(self.upstream_event_counts),
            )
        payload: dict[str, Any] = {"type": "run_end", "text": end_text}
        if usage:
            payload["usage"] = usage
        if block_ui:
            payload.update(block_ui)
        out.append(payload)
        # 标记放在帧成功产出之后——若中途异常，run_end_emitted 仍为 False，
        # finish() 可重试补发 RUN_FINISHED，避免永久丢失结束标识。
        self.run_end_emitted = True
        if self.emit_debug_stats:
            out.append(
                {
                    "type": "_debug_upstream",
                    "upstream_event_counts": dict(self.upstream_event_counts),
                }
            )
        return out

    def _build_run_end_frames(self) -> list[bytes]:
        return _evf_payloads_to_wire(self._build_run_end_payloads())

    def _touch_run_ended_from_stream(self) -> None:
        tid = str(self.thread_id or "").strip()
        if not tid:
            return
        try:
            from evoflow.session_execution import force_end_session_turn

            force_end_session_turn(thread_id=tid, reason="run_end", source="ui_stream")
        except Exception:
            logger.debug("force_end_session_turn failed thread=%s", tid, exc_info=True)

    def finish_evf_payloads(self) -> EvfPayloadList:
        return self._build_run_end_payloads()

    def finish(self) -> list[bytes]:
        return _evf_payloads_to_wire(self.finish_evf_payloads())


async def normalize_langgraph_sse_stream(
    upstream: Any,
    *,
    thread_id: str = "",
    user_input: str = "",
    use_claude_code_chat: bool = False,
    emit_debug_stats: bool = False,
    prior_assistant_prefix: str = "",
    prior_assistant_message_id: str = "",
    prior_assistant_reasoning: str = "",
) -> Any:
    """Async generator: LangGraph SSE bytes → ``evf`` SSE bytes."""
    tid = str(thread_id or "").strip()
    normalizer = UiStreamNormalizer(
        user_input=user_input,
        use_claude_code_chat=use_claude_code_chat,
        emit_debug_stats=emit_debug_stats,
        client_prior_prefix=str(prior_assistant_prefix or "").strip(),
        client_prior_message_id=str(prior_assistant_message_id or "").strip(),
        client_prior_reasoning=str(prior_assistant_reasoning or "").strip(),
        thread_id=tid,
    )
    buffer = ""

    def _emit_parsed_frames() -> Any:
        nonlocal buffer
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            if not frame.strip():
                continue
            event_name = ""
            data_raw = ""
            for ln in frame.split("\n"):
                ln = ln.strip()
                if ln.startswith("event:"):
                    event_name = ln[6:].strip()
                elif ln.startswith("data:"):
                    data_raw += ln[5:].strip()
            if not data_raw or data_raw in ("{}", "[DONE]"):
                # event:end 携带 data:[DONE] 或 data:{} 时仍需触发 _on_end，
                # 否则 run_end evf 不会在流式中产生，RUN_FINISHED 只能依赖 finish() 补发。
                if event_name.lower() != "end":
                    continue
                data_json = {}
            else:
                try:
                    data_json = json.loads(data_raw)
                except json.JSONDecodeError:
                    continue
            # Per-frame guard: a single malformed/oversized tool result or any
            # bug inside feed_frame() must NOT terminate the entire SSE stream.
            # Previously any Exception here bubbled to the outer try/except and
            # `return`-ed the generator, silently dropping all later upstream
            # frames (messages/values/custom/end). See sse_tool_error bugfix.
            try:
                frames = normalizer.feed_frame(event_name, data_json)
            except Exception as exc:
                # Build a compact context snippet so logs + wire trace tell us
                # exactly which upstream frame blew up next time.
                try:
                    data_preview = json.dumps(data_json, ensure_ascii=False, default=str)[:400]
                except Exception:
                    data_preview = repr(data_json)[:400]
                tb = traceback.format_exc()
                logger.error(
                    "[sse-ui] feed_frame raised — stream continues, frame skipped\n"
                    "  event=%s tid=%s\n  exc=%s: %s\n  data_preview=%s\n%s",
                    event_name,
                    tid,
                    exc.__class__.__name__,
                    exc,
                    data_preview,
                    tb,
                )
                # Surface to the SSE wire as a comment frame so the browser
                # devtools Network tab shows the crash without breaking the
                # EventSource parser (lines starting with ":" are ignored by
                # the SSE spec).
                comment = (
                    f": [sse-ui][feed_frame error] event={event_name} "
                    f"exc={exc.__class__.__name__}: {str(exc)[:200]}\n\n"
                ).encode("utf-8", errors="replace")
                yield comment
                continue
            for out in frames:
                if tid:
                    try:
                        from app.gateway.streaming.live_run_snapshot import schedule_snapshot_from_normalizer

                        schedule_snapshot_from_normalizer(tid, normalizer)
                    except Exception:
                        logger.debug(
                            "schedule_snapshot_from_normalizer failed tid=%s",
                            tid,
                            exc_info=True,
                        )
                yield out

    try:
        async for chunk in upstream:
            if not chunk:
                continue
            text = bytes(chunk).decode("utf-8", errors="ignore") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
            buffer = _normalize_sse_buffer(buffer + text)
            for out in _emit_parsed_frames():
                yield out
    except Exception as exc:
        logger.error("normalize_langgraph_sse_stream upstream error: %s: %s", exc.__class__.__name__, exc)
        for out in normalizer.finish():
            yield out
        if tid:
            from app.gateway.streaming.live_run_snapshot import clear_gateway_live_snapshot

            clear_gateway_live_snapshot(tid)
        yield _encode_evf({"type": "error", "error": str(exc)[:1000]})
        return

    buffer = _normalize_sse_buffer(buffer)
    for out in _emit_parsed_frames():
        yield out
    for out in normalizer.finish():
        yield out
    if tid:
        from app.gateway.streaming.live_run_snapshot import clear_gateway_live_snapshot

        clear_gateway_live_snapshot(tid)
