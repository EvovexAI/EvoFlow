"""Dev-only JSON APIs: aggregate per-thread debug logs (model payloads, collab cycle, tools).

Structured index ``conversation_turns`` groups by user turn (``turn_snapshot``) and model step
(``model_call_tools`` / ``model_call_seq``), attaching matching HTTP payload rows and tool I/O by timestamp.

``task_progress_snapshot`` merges the on-disk main/subtask view (same as EvoPanel); ``collab_phase`` is inferred
from task rows (terminal ``done``, in-flight ``executing``, virtual ``plan_ready`` when disk is still ``idle``) and
may self-heal stuck ``planning`` to ``done`` when the **main** task is terminal (``completed`` / ``failed`` / ``cancelled``), not merely when all subtasks finish; ``collab_phase_disk`` is the raw
persisted phase. Log-derived sections can lag when execution completes without another ``supervisor`` tool call.

``task_lifecycle_trace`` reads ``task_lifecycle_trace.log``: main/subtask status transitions, supervisor dispatch,
rollup, and monitor requeue (append-only JSONL per thread).

``im_channel_errors`` reads ``im_channel_error.log`` (ChannelManager 在飞书/Slack/Telegram 分发失败时按 thread 追加).

Enabled by default. Set ``EVOFLOW_DEBUG_TRACE_UI=0`` to disable (e.g. production).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from evoflow.agents.middlewares.message_usage_helpers import infer_usage_metadata_from_checkpoint_ai_dict
from evoflow.config.paths import get_paths
from evoflow.debug.thread_scoped_file_log import thread_log_paths
from evoflow.debug.trace_sink import observability_reads_primary
from evoflow.observability.invocation_kinds import label_zh as invocation_kind_label_zh

router = APIRouter(prefix="/api/debug/agent-trace", tags=["debug"])


def _debug_ui_enabled() -> bool:
    v = (os.environ.get("EVOFLOW_DEBUG_TRACE_UI") or "").strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    return True


def _repo_root() -> Path:
    # backend/app/gateway/routers/this_file.py -> parents[4] = workspace root
    return Path(__file__).resolve().parents[4]


def _backend_dir() -> Path:
    """``backend/`` (contains ``app/``)."""
    return Path(__file__).resolve().parents[3]


def _base_dir_optional() -> Path | None:
    try:
        bd = get_paths().base_dir
        return Path(bd).resolve() if bd else None
    except Exception:
        return None


def _debug_scan_roots() -> list[Path]:
    """Ordered unique directories: repo root, backend/, then evoflow base_dir."""
    roots: list[Path] = []
    try:
        roots.append(_repo_root().resolve())
    except Exception:
        pass
    try:
        b = _backend_dir().resolve()
        if all(str(b) != str(x) for x in roots):
            roots.append(b)
    except Exception:
        pass
    bd = _base_dir_optional()
    if bd is not None and all(str(bd) != str(x) for x in roots):
        roots.append(bd)
    return roots


def _unique_paths(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[str] = set()
    for p in paths:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def _paths_join_under_roots(*relative: str) -> list[Path]:
    """For each root, append path segments; de-duplicate resolved paths."""
    out: list[Path] = []
    seen: set[str] = set()
    for root in _debug_scan_roots():
        p = (root / Path(*relative)).resolve()
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


_DEBUG_LOG_FULL_MAX_BYTES = 64 * 1024 * 1024


def _read_tail_text(path: Path, max_bytes: int = 2_500_000) -> str:
    if not path.is_file():
        return ""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size <= max_bytes:
                raw = f.read()
            else:
                f.seek(max(0, size - max_bytes))
                raw = f.read()
        text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        # Seeking mid-file can split UTF-8 sequences or land inside a log frame; start at next full line.
        if size > max_bytes:
            nl = text.find("\n")
            if nl != -1:
                text = text[nl + 1 :]
        return text
    except OSError:
        return ""


def _read_debug_log_text(path: Path) -> str:
    """Read full log file for agent-trace API (large cap; model / vendor JSON must not be tail-truncated)."""
    return _read_tail_text(path, max_bytes=_DEBUG_LOG_FULL_MAX_BYTES)


def _iter_model_payload_records(text: str) -> list[dict[str, Any]]:
    """Parse ``model_request_payload.log`` file text into JSON records (one per block)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return []
    sep = "\n" + "=" * 88 + "\n"
    out: list[dict[str, Any]] = []
    for ch in text.split(sep):
        ch = ch.strip()
        if not ch or "model_request_payload" not in ch:
            continue
        idx = ch.find("{")
        if idx < 0:
            continue
        try:
            obj = json.loads(ch[idx:].strip())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _model_payload_matches_thread(record: dict[str, Any], tid: str) -> bool:
    """Match explicit ``thread_id`` field (new logs) or legacy substring in serialized record."""
    if str(record.get("thread_id", "")).strip() == tid:
        return True
    try:
        blob = json.dumps(record, ensure_ascii=False)
    except Exception:
        blob = ""
    return tid in blob


def _merge_model_payloads_for_thread(paths: list[Path], tid: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Read tail of each log file, parse blocks, filter by thread, de-dupe by (ts_ms, provider, model)."""
    merged: list[dict[str, Any]] = []
    sources: list[str] = []
    seen_sig: set[tuple[Any, ...]] = set()
    for p in paths:
        raw = _read_tail_text(p)
        if not raw:
            continue
        sources.append(str(p))
        for rec in _iter_model_payload_records(raw):
            if not _model_payload_matches_thread(rec, tid):
                continue
            sig = (rec.get("ts_ms"), rec.get("provider"), rec.get("model"), rec.get("stage"))
            if sig in seen_sig:
                continue
            seen_sig.add(sig)
            merged.append(rec)
    merged.sort(key=lambda r: int(r.get("ts_ms") or 0))
    return merged, sources


def _inject_vendor_response_into_model_payloads(
    payload_rows: list[dict[str, Any]],
    roundtrip_rows: list[dict[str, Any]],
) -> None:
    """Attach ``vendor_response`` / ``vendor_latency_ms`` / ``vendor_request_full`` from ``model_vendor_roundtrip.jsonl`` rows."""
    if not payload_rows or not roundtrip_rows:
        return
    pr = [r for r in payload_rows if isinstance(r, dict)]
    rt = [r for r in roundtrip_rows if isinstance(r, dict)]
    if not pr or not rt:
        return
    pr.sort(key=lambda r: int(r.get("ts_ms") or 0))
    rt.sort(key=lambda r: int(r.get("ts_ms") or 0))
    used: set[int] = set()
    for row in pr:
        t0 = int(row.get("ts_ms") or 0)
        best_i: int | None = None
        best_t1: int | None = None
        for i, r in enumerate(rt):
            if i in used:
                continue
            t1 = int(r.get("ts_ms") or 0)
            if t1 + 5000 < t0:
                continue
            if best_t1 is None or t1 < best_t1:
                best_i = i
                best_t1 = t1
        if best_i is None or best_t1 is None:
            continue
        used.add(best_i)
        tr = rt[best_i]
        row["vendor_response"] = tr.get("response")
        row["vendor_latency_ms"] = tr.get("latency_ms")
        if tr.get("invocation_kind") and not row.get("invocation_kind"):
            row["invocation_kind"] = tr.get("invocation_kind")
        vr = tr.get("vendor_request")
        if isinstance(vr, dict):
            row["vendor_request_full"] = vr


def _merge_jsonl_by_thread(paths: list[Path], tid: str) -> tuple[list[dict[str, Any]], list[str]]:
    """JSONL files with a top-level ``thread_id`` field (exact match). De-dupe identical rows."""
    rows: list[dict[str, Any]] = []
    sources: list[str] = []
    seen: set[str] = set()
    for p in paths:
        raw = _read_debug_log_text(p)
        if not raw:
            continue
        sources.append(str(p))
        for line in raw.splitlines():
            line = line.strip()
            if not line or tid not in line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict) or str(obj.get("thread_id", "")).strip() != tid:
                continue
            key = json.dumps(obj, sort_keys=True, ensure_ascii=False)
            if key in seen:
                continue
            seen.add(key)
            rows.append(obj)
    return rows, sources


def _normalize_thread_id(thread_id: str) -> str:
    s = (thread_id or "").strip()
    if not s:
        raise HTTPException(status_code=400, detail="thread_id is required")
    if not re.fullmatch(r"[a-zA-Z0-9._-]+", s):
        raise HTTPException(status_code=400, detail="invalid thread_id")
    return s


def _find_recursion_limit_nested(obj: Any, depth: int = 0) -> int | None:
    """Best-effort: LangGraph run JSON may nest ``recursion_limit`` under config/kwargs."""
    if depth > 8 or obj is None:
        return None
    if isinstance(obj, dict):
        v = obj.get("recursion_limit")
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            return v
        if isinstance(v, float) and v == int(v):
            return int(v)
        if isinstance(v, str) and v.strip().isdigit():
            return int(v.strip())
        for x in obj.values():
            found = _find_recursion_limit_nested(x, depth + 1)
            if found is not None:
                return found
    if isinstance(obj, list):
        for x in obj:
            found = _find_recursion_limit_nested(x, depth + 1)
            if found is not None:
                return found
    return None


def _slim_langgraph_run(run: dict[str, Any]) -> dict[str, Any]:
    """Keep small primitives + shallow dicts; drop huge payloads."""
    skip = {"kwargs", "input", "output", "state", "messages", "checkpoint", "values"}
    out: dict[str, Any] = {}
    for k, v in run.items():
        if k in skip:
            continue
        if isinstance(v, (str, int, float, bool)) or v is None:
            if isinstance(v, str) and len(v) > 480:
                out[k] = v[:477] + "…"
            else:
                out[k] = v
        elif isinstance(v, dict) and k in ("config", "metadata", "runtime", "assistant_version"):
            shallow: dict[str, Any] = {}
            for i, (sk, sv) in enumerate(v.items()):
                if i >= 14:
                    shallow["_truncated"] = True
                    break
                if isinstance(sv, (str, int, float, bool)) or sv is None:
                    shallow[sk] = sv if not isinstance(sv, str) or len(sv) < 200 else sv[:197] + "…"
                elif isinstance(sv, dict):
                    shallow[sk] = {kk: vv for kk, vv in list(sv.items())[:8]}
                else:
                    shallow[sk] = str(type(sv).__name__)
            out[k] = shallow
    lim = _find_recursion_limit_nested(run)
    if lim is not None:
        out["recursion_limit_extracted"] = lim
    return out


def _fetch_langgraph_runs_sync(thread_id: str) -> dict[str, Any]:
    """GET LangGraph ``/threads/{id}/runs`` (same base as gateway proxy)."""
    try:
        from app.gateway.routers.langgraph_proxy import LANGGRAPH_BASE_URL
    except Exception:
        LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph")
    base = str(LANGGRAPH_BASE_URL or "").rstrip("/") or "http://127.0.0.1:8070/api/langgraph"
    url = f"{base}/threads/{thread_id}/runs"
    out: dict[str, Any] = {
        "ok": False,
        "http_status": None,
        "error": None,
        "url": url,
        "runs": [],
    }
    try:
        import httpx

        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.get(url, params={"limit": 40})
            out["http_status"] = resp.status_code
            if resp.status_code != 200:
                out["error"] = (resp.text or "")[:500]
                return out
            data: Any = resp.json()
            items: Any = data
            if isinstance(data, dict):
                items = data.get("items") if isinstance(data.get("items"), list) else data.get("runs")
            if not isinstance(items, list):
                out["error"] = "unexpected_runs_json_shape"
                return out
            out["runs"] = [_slim_langgraph_run(x) for x in items if isinstance(x, dict)]
            out["ok"] = True
    except Exception as e:
        out["error"] = str(e)[:500]
    return out


def _fetch_langgraph_thread_state_sync(thread_id: str) -> dict[str, Any]:
    """GET LangGraph ``/threads/{id}/state`` (checkpoint ``values`` for token / message debugging)."""
    try:
        from app.gateway.routers.langgraph_proxy import LANGGRAPH_BASE_URL
    except Exception:
        LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph")
    base = str(LANGGRAPH_BASE_URL or "").rstrip("/") or "http://127.0.0.1:8070/api/langgraph"
    url = f"{base}/threads/{thread_id}/state"
    out: dict[str, Any] = {
        "ok": False,
        "http_status": None,
        "error": None,
        "url": url,
        "raw_keys": None,
    }
    try:
        import httpx

        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            resp = client.get(url)
            out["http_status"] = resp.status_code
            if resp.status_code != 200:
                out["error"] = (resp.text or "")[:800]
                return out
            data: Any = resp.json()
            out["ok"] = True
            out["raw_keys"] = list(data.keys())[:40] if isinstance(data, dict) else None
            out["body"] = data
    except Exception as e:
        out["error"] = str(e)[:800]
    return out


def _state_values_from_langgraph_state(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {}
    v = body.get("values")
    return v if isinstance(v, dict) else body


def _is_ai_checkpoint_row(m: dict[str, Any]) -> bool:
    t = str(m.get("type") or "").strip()
    role = str(m.get("role") or "").strip().lower()
    return role == "assistant" or t in ("ai", "AIMessage", "AIMessageChunk")


def _content_preview_checkpoint(msg: dict[str, Any], limit: int = 100) -> str:
    c = msg.get("content")
    if isinstance(c, str):
        s = c.strip().replace("\n", " ")
        return (s[: limit - 1] + "…") if len(s) > limit else s
    if isinstance(c, list):
        parts: list[str] = []
        for block in c[:6]:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        s = "".join(parts).strip().replace("\n", " ")
        return (s[: limit - 1] + "…") if len(s) > limit else s
    return ""


def _is_human_checkpoint_row(m: dict[str, Any]) -> bool:
    t = str(m.get("type") or "").strip().lower()
    role = str(m.get("role") or "").strip().lower()
    return role in ("user", "human") or t in ("human", "humanmessage")


def _checkpoint_message_full_text(msg: dict[str, Any]) -> str:
    c = msg.get("content")
    if isinstance(c, str):
        return c.strip()
    if isinstance(c, list):
        parts: list[str] = []
        for block in c:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if str(block.get("type") or "") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
        return "".join(parts).strip()
    if c is None:
        return ""
    return str(c).strip()


def _conversation_turns_from_langgraph_checkpoint_fetch(fetch: dict[str, Any]) -> dict[str, Any] | None:
    """When ``lead_agent_round`` is empty (e.g. ``claude_code_chat`` graph), derive turns from checkpoint ``messages``."""
    if not fetch.get("ok"):
        return None
    body = fetch.get("body")
    values = _state_values_from_langgraph_state(body)
    msgs_raw = values.get("messages")
    if not isinstance(msgs_raw, list) or not msgs_raw:
        return None

    msgs = [m for m in msgs_raw if isinstance(m, dict)]
    turns_out: list[dict[str, Any]] = []
    turn_idx = 0
    base_ms = 1_700_000_000_000.0
    i = 0
    while i < len(msgs):
        if not _is_human_checkpoint_row(msgs[i]):
            i += 1
            continue
        human_txt = _checkpoint_message_full_text(msgs[i])
        i += 1
        ai_chunks: list[str] = []
        while i < len(msgs):
            nm = msgs[i]
            if _is_human_checkpoint_row(nm):
                break
            if _is_ai_checkpoint_row(nm):
                ai_chunks.append(_checkpoint_message_full_text(nm))
            i += 1
        assistant_txt = "\n\n".join(x for x in ai_chunks if x.strip()).strip()
        start_ms = base_ms + turn_idx * 60_000.0
        end_ms = start_ms + 59_999.0
        iso_ts = datetime.fromtimestamp(start_ms / 1000.0, tz=UTC).isoformat()
        turns_out.append(
            {
                "turn_index": turn_idx,
                "label": f"第 {turn_idx + 1} 轮（checkpoint · Claude Code / 最小图）",
                "start_ms": start_ms,
                "end_ms": end_ms,
                "user_input": human_txt,
                "checkpoint_assistant_reply": assistant_txt,
                "model_cycles": [{"model_call_seq": 1, "timestamp_ms": start_ms + 1000.0}],
                "turn_snapshot": {"timestamp": iso_ts},
            },
        )
        turn_idx += 1

    if not turns_out:
        return None

    note_zh = "以下回合由 LangGraph checkpoint ``messages`` 推导（无 ``lead_agent_round_trace`` / ``turn_snapshot`` 日志时生效，例如 **claude_code_chat** 直连）。时间戳为占位排序，便于时间轴折叠，非真实时钟。"
    return {
        "schema": "evoflow.agent_trace.turns.v1",
        "note_zh": note_zh,
        "turns": turns_out,
        "counts": {"turns": len(turns_out), "model_cycles": len(turns_out)},
    }


def _slim_token_usage_row(msg: dict[str, Any], *, source: str, index: int) -> dict[str, Any]:
    rm = msg.get("response_metadata") if isinstance(msg.get("response_metadata"), dict) else {}
    rm_keys = sorted(rm.keys())[:48]
    tu = rm.get("token_usage") if isinstance(rm.get("token_usage"), dict) else None
    usage_rm = rm.get("usage") if isinstance(rm.get("usage"), dict) else None
    tu_preview: dict[str, Any] | None = None
    for cand in (tu, usage_rm):
        if isinstance(cand, dict):
            tu_preview = {
                k: cand.get(k)
                for k in (
                    "prompt_tokens",
                    "completion_tokens",
                    "total_tokens",
                    "input_tokens",
                    "output_tokens",
                )
                if k in cand
            }
            if tu_preview:
                break
    um = msg.get("usage_metadata")
    inferred = infer_usage_metadata_from_checkpoint_ai_dict(msg)
    return {
        "source": source,
        "index": index,
        "id": msg.get("id"),
        "type": msg.get("type"),
        "content_preview": _content_preview_checkpoint(msg),
        "usage_metadata_raw": um if isinstance(um, dict) else None,
        "response_metadata_keys": rm_keys,
        "response_token_usage_preview": tu_preview,
        "inferred_normalized": inferred,
        "has_any_usage_signal": bool(inferred or (isinstance(um, dict) and um) or tu_preview),
    }


def _build_token_usage_debug(thread_id: str) -> dict[str, Any]:
    """Attach LangGraph checkpoint AI rows + usage inference (UI transcript is in evoflow_chat_messages)."""
    fetch = _fetch_langgraph_thread_state_sync(thread_id)
    note_zh = (
        "UI 历史在 ``evoflow_chat_messages``；此处对比 checkpoint ``messages``（及旧版 ``ui_messages`` 若仍存在）。"
        "``usage_metadata_raw`` 常为 null；若 ``response_token_usage_preview`` 或 ``inferred_normalized`` 有值，"
        "说明厂商返回在 response_metadata（见 infer_usage_metadata_from_checkpoint_ai_dict）。"
    )
    base_out: dict[str, Any] = {
        "fetch_ok": bool(fetch.get("ok")),
        "http_status": fetch.get("http_status"),
        "error": fetch.get("error"),
        "state_url": fetch.get("url"),
        "raw_top_level_keys": fetch.get("raw_keys"),
        "note_zh": note_zh,
        "messages_ai_rows": [],
        "ui_messages_ai_rows": [],
        "totals": {
            "messages_ai_count": 0,
            "ui_messages_ai_count": 0,
            "ui_messages_with_inferred": 0,
            "ui_messages_with_raw_usage_metadata": 0,
            "sum_inferred_ui_input": 0,
            "sum_inferred_ui_output": 0,
            "sum_inferred_ui_total": 0,
        },
    }
    try:
        from evoflow.persistence import chat_message_repositories as msg_repo

        app_msgs = msg_repo.list_messages_for_thread_id(thread_id, limit=48)
        base_out["app_transcript_message_count"] = len(app_msgs)
    except Exception:
        base_out["app_transcript_message_count"] = 0

    if not fetch.get("ok"):
        return base_out

    body = fetch.get("body")
    values = _state_values_from_langgraph_state(body)
    msgs = values.get("messages") if isinstance(values.get("messages"), list) else []
    ui = values.get("ui_messages") if isinstance(values.get("ui_messages"), list) else []

    def _collect(rows: list[Any], source: str, max_rows: int = 48) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        n = 0
        for i, m in enumerate(rows):
            if not isinstance(m, dict) or not _is_ai_checkpoint_row(m):
                continue
            out.append(_slim_token_usage_row(m, source=source, index=i))
            n += 1
            if n >= max_rows:
                break
        return out

    base_out["messages_ai_rows"] = _collect(msgs, "messages")
    base_out["ui_messages_ai_rows"] = _collect(ui, "ui_messages")

    tot = base_out["totals"]
    tot["messages_ai_count"] = sum(1 for m in msgs if isinstance(m, dict) and _is_ai_checkpoint_row(m))
    tot["ui_messages_ai_count"] = sum(1 for m in ui if isinstance(m, dict) and _is_ai_checkpoint_row(m))

    for m in ui:
        if not isinstance(m, dict) or not _is_ai_checkpoint_row(m):
            continue
        inferred = infer_usage_metadata_from_checkpoint_ai_dict(m)
        if inferred:
            tot["ui_messages_with_inferred"] += 1
            tot["sum_inferred_ui_input"] += int(inferred.get("input_tokens") or 0)
            tot["sum_inferred_ui_output"] += int(inferred.get("output_tokens") or 0)
            tot["sum_inferred_ui_total"] += int(inferred.get("total_tokens") or 0)
        um = m.get("usage_metadata")
        if isinstance(um, dict) and (um.get("input_tokens") or um.get("prompt_tokens") or um.get("total_tokens") or um.get("output_tokens")):
            tot["ui_messages_with_raw_usage_metadata"] += 1

    return base_out


def _build_graph_execution(payload: dict[str, Any]) -> dict[str, Any]:
    """Explain mismatch between logged tools and LangGraph ``recursion_limit`` super-steps."""
    models = payload.get("model_request_payloads") or []
    rounds = payload.get("lead_agent_round") or []
    tools = payload.get("tool_call_io") or []
    lg = payload.get("langgraph") or {}
    runs: list[Any] = lg.get("runs") or []
    n_round = len(rounds)
    n_tool = len(tools)
    n_model = len(models)
    # Conservative lower bound: each tool row implies at least one tool-node step plus surrounding model steps.
    lower_bound = max(n_round * 2, n_tool * 2 + 1, n_model + 1, 1)
    latest: dict[str, Any] | None = runs[-1] if runs and isinstance(runs[-1], dict) else None
    latest_summary: dict[str, Any] | None = None
    if isinstance(latest, dict):
        err = latest.get("error")
        es = str(err) if err is not None else ""
        latest_summary = {
            "run_id": latest.get("run_id") or latest.get("id"),
            "status": latest.get("status"),
            "graph_id": latest.get("graph_id"),
            "error_trunc": (es[:420] + "…") if len(es) > 420 else es or None,
            "recursion_limit": latest.get("recursion_limit_extracted") or _find_recursion_limit_nested(latest),
            "run_exec_ms": latest.get("run_exec_ms"),
            "run_completed_in_ms": latest.get("run_completed_in_ms"),
            "run_wait_time_ms": latest.get("run_wait_time_ms"),
        }
    return {
        "counts": {
            "lead_agent_round_rows": n_round,
            "model_request_payload_rows": n_model,
            "tool_call_io_rows": n_tool,
        },
        "langgraph_run_rows": len(runs),
        "langgraph_fetch_ok": bool(lg.get("ok")),
        "langgraph_fetch_error": lg.get("error"),
        "estimated_supersteps_lower_bound": lower_bound,
        "note_zh": ("LangGraph 的「递归上限」对应执行图中的超步（调度步数）；一次「调用模型→执行工具→再调模型」通常跨多步，因此与「工具输入输出」行数或「厂商请求」条数对不齐是正常的。此处「超步下界」仅按当前日志条数保守估算。"),
        "latest_run": latest_summary,
    }


def _epoch_ms_from_any(value: Any) -> float | None:
    """Normalize timestamps from epoch ms, unix seconds, or ISO-8601 strings."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        if n > 1e12:  # already ms
            return n
        if n > 1e9:  # seconds.millis
            return n * 1000.0
        return n * 1000.0
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            iso = s.replace("Z", "+00:00") if s.endswith("Z") else s
            dt = datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt.timestamp() * 1000.0
        except ValueError:
            pass
        try:
            return float(s) * 1000.0
        except ValueError:
            return None
    return None


def _model_payload_ts_ms(rec: dict[str, Any]) -> float | None:
    raw = rec.get("ts_ms")
    if isinstance(raw, (int, float)):
        return float(raw)
    return _epoch_ms_from_any(raw)


def _vendor_roundtrip_window_ms(row: dict[str, Any]) -> tuple[float, float] | None:
    """Return ``(start_ms, end_ms)`` for a vendor roundtrip row (end = ``ts_ms``)."""
    end = _epoch_ms_from_any(row.get("ts_ms"))
    if end is None:
        return None
    lat = row.get("latency_ms")
    if lat is not None:
        try:
            start = end - float(lat)
            return start, end
        except (TypeError, ValueError):
            pass
    return end, end


def _pair_vendor_rows_to_payloads(
    vendor_rows: list[dict[str, Any]],
    payload_rows: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], dict[str, Any] | None]]:
    """Greedy match vendor roundtrips to ``model_request_payload`` rows by time (same logic as inject)."""
    vr = [r for r in vendor_rows if isinstance(r, dict)]
    pr = [r for r in payload_rows if isinstance(r, dict)]
    if not vr:
        return []
    pr_sorted = sorted(pr, key=lambda r: int(r.get("ts_ms") or 0))
    vr_sorted = sorted(vr, key=lambda r: int(r.get("ts_ms") or 0))
    used: set[int] = set()
    out: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    for vrow in vr_sorted:
        t0 = int(vrow.get("ts_ms") or 0)
        best_i: int | None = None
        best_t1: int | None = None
        for i, prow in enumerate(pr_sorted):
            if i in used:
                continue
            t1 = int(prow.get("ts_ms") or 0)
            if t1 + 5000 < t0:
                continue
            if best_t1 is None or t1 < best_t1:
                best_i = i
                best_t1 = t1
        payload_match = pr_sorted[best_i] if best_i is not None else None
        if best_i is not None:
            used.add(best_i)
        out.append((vrow, payload_match))
    return out


def _collab_events_in_window(collab_rows: list[dict[str, Any]], start_ms: float, end_ms: float) -> dict[str, float]:
    """First occurrence timestamp (ms) per event name inside ``[start_ms, end_ms]``."""
    found: dict[str, float] = {}
    for row in collab_rows:
        if not isinstance(row, dict):
            continue
        ev = str(row.get("event") or "").strip()
        if not ev:
            continue
        ts = _epoch_ms_from_any(row.get("ts") or row.get("timestamp"))
        if ts is None or ts + 1e-6 < start_ms or ts > end_ms + 1e-6:
            continue
        if ev not in found:
            found[ev] = ts
    return found


def _round_ms(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 1)


def _ms_delta(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return _round_ms(b - a)


def _pick_latest_langgraph_run(runs: list[dict[str, Any]]) -> dict[str, Any] | None:
    """LangGraph ``/runs`` order is not guaranteed; pick max ``created_at``."""
    best: dict[str, Any] | None = None
    best_ms: float | None = None
    for r in runs:
        ms = _epoch_ms_from_any(r.get("created_at"))
        if ms is None:
            continue
        if best_ms is None or ms > best_ms:
            best_ms = ms
            best = r
    if best is not None:
        return best
    return runs[-1] if runs else None


def _build_wall_clock_for_run_window(
    *,
    run: dict[str, Any] | None,
    vendor_all: list[dict[str, Any]],
    payload_all: list[dict[str, Any]],
    collab_all: list[dict[str, Any]],
) -> dict[str, Any]:
    """Wall-clock segments for one LangGraph run window."""
    from evoflow.observability.invocation_kinds import (
        aggregate_vendor_latency_by_kind,
        hint_zh,
        label_zh,
        resolve_invocation_kind,
    )

    run_start = _epoch_ms_from_any((run or {}).get("created_at"))
    run_end = _epoch_ms_from_any((run or {}).get("updated_at"))

    vendor_in_run: list[dict[str, Any]] = []
    if run_start is not None and run_end is not None:
        for vrow in vendor_all:
            win = _vendor_roundtrip_window_ms(vrow)
            if win is None:
                continue
            vs, ve = win
            if ve + 50.0 < run_start or vs > run_end + 50.0:
                continue
            vendor_in_run.append(vrow)
    else:
        vendor_in_run = list(vendor_all)

    vendor_in_run.sort(key=lambda r: int(r.get("ts_ms") or 0))
    paired = _pair_vendor_rows_to_payloads(vendor_in_run, payload_all)

    vendor_calls: list[dict[str, Any]] = []
    vendor_sum = 0.0
    for i, (vrow, prow) in enumerate(paired):
        win = _vendor_roundtrip_window_ms(vrow)
        if win is None:
            continue
        vs, ve = win
        lat = float(vrow.get("latency_ms") or (ve - vs))
        vendor_sum += lat
        kind = resolve_invocation_kind(vendor_row=vrow, payload_row=prow)
        vendor_calls.append(
            {
                "index": i,
                "invocation_kind": kind,
                "role": kind,
                "label_zh": label_zh(kind),
                "role_hint_zh": hint_zh(kind),
                "provider": vrow.get("provider"),
                "model": vrow.get("model"),
                "latency_ms": _round_ms(lat),
                "start_ms": _round_ms(vs),
                "end_ms": _round_ms(ve),
            }
        )

    collab_ev: dict[str, float] = {}
    if run_start is not None and run_end is not None:
        collab_ev = _collab_events_in_window(collab_all, run_start, run_end)
    elif collab_all:
        collab_ev = _collab_events_in_window(collab_all, 0.0, float("inf"))

    run_wall = _ms_delta(run_start, run_end)
    first_vendor_start = vendor_calls[0]["start_ms"] if vendor_calls else None
    last_vendor_end = vendor_calls[-1]["end_ms"] if vendor_calls else None

    pre_first_model = _ms_delta(run_start, first_vendor_start)
    if pre_first_model is None and run_start is not None:
        anchor = collab_ev.get("before_model") or collab_ev.get("model_request")
        pre_first_model = _ms_delta(run_start, anchor)

    between_model_calls: float | None = None
    if len(vendor_calls) >= 2:
        between_model_calls = _ms_delta(vendor_calls[0]["end_ms"], vendor_calls[1]["start_ms"])

    post_last_model = _ms_delta(last_vendor_end, run_end)

    vendor_by_kind = aggregate_vendor_latency_by_kind(vendor_calls)
    main_vendor_ms = vendor_by_kind.get("main")
    non_main_vendor_ms: float | None = None
    if vendor_by_kind:
        non_main = sum(v for k, v in vendor_by_kind.items() if k != "main")
        non_main_vendor_ms = _round_ms(non_main) if non_main else None

    perceived_reply = _ms_delta(run_start, collab_ev.get("model_response"))

    collab_cycle_ms: dict[str, float | None] = {
        "before_model_to_model_request": _ms_delta(collab_ev.get("before_model"), collab_ev.get("model_request")),
        "model_request_to_model_response": _ms_delta(collab_ev.get("model_request"), collab_ev.get("model_response")),
        "model_response_to_after_model": _ms_delta(collab_ev.get("model_response"), collab_ev.get("after_model")),
    }

    non_vendor: float | None = None
    if run_wall is not None:
        non_vendor = _round_ms(max(0.0, float(run_wall) - vendor_sum))

    run_summary: dict[str, Any] | None = None
    if isinstance(run, dict):
        run_summary = {
            "run_id": run.get("run_id") or run.get("id"),
            "status": run.get("status"),
            "created_at": run.get("created_at"),
            "updated_at": run.get("updated_at"),
            "wall_ms": run_wall,
        }

    return {
        "run": run_summary,
        "segments_ms": {
            "langgraph_run_wall": run_wall,
            "pre_first_model": pre_first_model,
            "main_model_vendor": _round_ms(main_vendor_ms) if main_vendor_ms is not None else None,
            "non_main_model_vendor": non_main_vendor_ms,
            "between_model_calls": between_model_calls,
            "post_last_model_checkpoint": post_last_model,
            "vendor_sum": _round_ms(vendor_sum) if vendor_calls else None,
            "non_vendor_estimated": non_vendor,
        },
        "perceived_reply_ms": perceived_reply,
        "collab_first_cycle_ms": collab_cycle_ms,
        "collab_event_timestamps_ms": {k: _round_ms(v) for k, v in sorted(collab_ev.items())} if collab_ev else {},
        "vendor_calls": vendor_calls,
        "vendor_call_count": len(vendor_calls),
        "vendor_by_kind_ms": vendor_by_kind,
    }


def _load_first_token_trace_rows(tid: str) -> list[dict[str, Any]]:
    paths = _unique_paths(_paths_join_under_roots("logs", "debug", "first_token_trace.log"))
    rows, _ = _merge_jsonl_by_thread(paths, tid)
    rows.sort(key=lambda r: float(r.get("page_first_token_ts_ms") or r.get("ts_ms") or 0))
    return rows


def _pick_latest_run_latency_row(
    rows: list[dict[str, Any]],
    event: str,
    *,
    trace_id: str | None = None,
) -> dict[str, Any] | None:
    candidates = [r for r in rows if str(r.get("event") or "") == event]
    if trace_id:
        narrowed = [r for r in candidates if str(r.get("trace_id") or "") == trace_id]
        if narrowed:
            candidates = narrowed
    if not candidates:
        return None
    return max(candidates, key=lambda r: float(r.get("ts_ms") or 0))


def _resolve_latest_trace_id(
    run_latency_rows: list[dict[str, Any]],
    first_token_rows: list[dict[str, Any]],
) -> str | None:
    for ev in (
        "page_stream_end",
        "gateway_stream_end",
        "gateway_stream_post",
        "pre_model_breakdown",
        "run_cycle_start",
    ):
        row = _pick_latest_run_latency_row(run_latency_rows, ev)
        if row and row.get("trace_id"):
            tid = str(row["trace_id"]).strip()
            if tid:
                return tid
    if first_token_rows:
        row = max(first_token_rows, key=lambda r: float(r.get("page_first_token_ts_ms") or r.get("ts_ms") or 0))
        tid = str(row.get("trace_id") or "").strip()
        if tid:
            return tid
    return None


def _row_wall_ms(row: dict[str, Any] | None, *field_names: str) -> float | None:
    if not row:
        return None
    for name in field_names:
        raw = row.get(name)
        if raw is None:
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return _epoch_ms_from_any(row.get("ts"))


def _build_end_to_end_timing(
    payload: dict[str, Any],
    run_latency_rows: list[dict[str, Any]],
    first_token_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Whole request: user send → page stream end, with gateway and pre-model segments."""
    note_zh = (
        "end_to_end_timing：从用户发送（evf_user_input_ts_ms）到页面流结束（page_stream_end）的整段耗时。"
        "分段含客户端预检、Gateway POST→SSE 结束、pre_model 中间件明细（run_latency_trace）、首字时间戳。"
        "page_round_trip_ms 最接近 EvoPanel 气泡从发送到 final 的体感。"
    )
    trace_id = _resolve_latest_trace_id(run_latency_rows, first_token_rows)
    post = _pick_latest_run_latency_row(run_latency_rows, "gateway_stream_post", trace_id=trace_id)
    gw_end = _pick_latest_run_latency_row(run_latency_rows, "gateway_stream_end", trace_id=trace_id)
    page_end = _pick_latest_run_latency_row(run_latency_rows, "page_stream_end", trace_id=trace_id)
    pre_bd = _pick_latest_run_latency_row(run_latency_rows, "pre_model_breakdown", trace_id=trace_id)

    user_ms = _row_wall_ms(post, "user_input_ts_ms")
    if user_ms is None:
        for row in reversed(first_token_rows):
            user_ms = _row_wall_ms(row, "user_input_ts_ms")
            if user_ms is not None:
                break

    anchors: dict[str, int] = {}
    if user_ms is not None:
        anchors["user_input_ms"] = int(user_ms)
    for anchor_key, row, fields in (
        ("gateway_stream_post_ms", post, ("gateway_stream_post_ms", "ts_ms")),
        ("wrap_enter_ms", pre_bd, ("wrap_enter_wall_ms", "ts_ms")),
        ("gateway_stream_end_ms", gw_end, ("gateway_stream_end_ms", "ts_ms")),
        ("page_stream_end_ms", page_end, ("page_stream_end_ms", "ts_ms")),
    ):
        v = _row_wall_ms(row, *fields)
        if v is not None:
            anchors[anchor_key] = int(v)

    page_first_ms: float | None = None
    ft_candidates = first_token_rows
    if trace_id:
        ft_candidates = [r for r in first_token_rows if str(r.get("trace_id") or "") == trace_id] or first_token_rows
    for row in ft_candidates:
        v = _row_wall_ms(row, "page_first_token_ts_ms")
        if v is not None:
            page_first_ms = v
    if page_first_ms is not None:
        anchors["page_first_token_ms"] = int(page_first_ms)

    segments: dict[str, float] = {}
    gw_post = anchors.get("gateway_stream_post_ms")
    if user_ms is not None and gw_post is not None:
        delta = _ms_delta(user_ms, float(gw_post))
        if delta is not None and delta >= 0:
            segments["preflight_and_client_to_gateway_ms"] = round(delta, 2)

    wrap_ms = anchors.get("wrap_enter_ms")
    if gw_post is not None and wrap_ms is not None:
        delta = _ms_delta(float(gw_post), float(wrap_ms))
        if delta is not None and delta >= 0:
            segments["gateway_post_to_pre_model_wrap_ms"] = round(delta, 2)

    if pre_bd and pre_bd.get("after_before_model_ms") is not None:
        try:
            segments["pre_model_total_ms"] = round(float(pre_bd["after_before_model_ms"]), 2)
        except (TypeError, ValueError):
            pass

    gw_end_ms = anchors.get("gateway_stream_end_ms")
    if gw_post is not None and gw_end_ms is not None:
        delta = _ms_delta(float(gw_post), float(gw_end_ms))
        if delta is not None and delta >= 0:
            segments["gateway_stream_wall_ms"] = round(delta, 2)

    page_end_ms = anchors.get("page_stream_end_ms")
    if user_ms is not None and page_end_ms is not None:
        delta = _ms_delta(user_ms, float(page_end_ms))
        if delta is not None and delta >= 0:
            segments["page_round_trip_ms"] = round(delta, 2)
    if gw_end_ms is not None and page_end_ms is not None:
        delta = _ms_delta(float(gw_end_ms), float(page_end_ms))
        if delta is not None and delta >= 0:
            segments["page_after_gateway_stream_ms"] = round(delta, 2)
    if user_ms is not None and page_first_ms is not None:
        delta = _ms_delta(user_ms, page_first_ms)
        if delta is not None and delta >= 0:
            segments["page_time_to_first_token_ms"] = round(delta, 2)

    wb = payload.get("wall_clock_breakdown") if isinstance(payload.get("wall_clock_breakdown"), dict) else {}
    wb_segs = wb.get("segments_ms") if isinstance(wb.get("segments_ms"), dict) else {}
    main_vendor = wb_segs.get("main_model_vendor")
    if main_vendor is not None:
        try:
            segments["main_model_vendor_ms"] = round(float(main_vendor), 2)
        except (TypeError, ValueError):
            pass

    pre_model_breakdown: dict[str, float] | None = None
    if pre_bd and isinstance(pre_bd.get("phases_ms"), dict):
        pre_model_breakdown = {}
        for k, v in pre_bd["phases_ms"].items():
            try:
                pre_model_breakdown[str(k)] = round(float(v), 2)
            except (TypeError, ValueError):
                continue

    return {
        "schema": "evoflow.agent_trace.end_to_end.v1",
        "note_zh": note_zh,
        "trace_id": trace_id,
        "anchors_ms": anchors,
        "segments_ms": segments,
        "pre_model_breakdown_ms": pre_model_breakdown,
        "run_latency_event_count": len(run_latency_rows),
    }


def _enrich_wall_clock_with_run_latency(
    wall_clock: dict[str, Any],
    run_latency_rows: list[dict[str, Any]],
) -> None:
    pre_bd = _pick_latest_run_latency_row(run_latency_rows, "pre_model_breakdown")
    if not pre_bd:
        return
    phases = pre_bd.get("phases_ms")
    if isinstance(phases, dict):
        wall_clock["pre_model_breakdown_ms"] = phases
    abm = pre_bd.get("after_before_model_ms")
    if abm is not None:
        try:
            wall_clock["pre_model_measured_ms"] = round(float(abm), 2)
        except (TypeError, ValueError):
            pass


def _attach_run_latency_observability(payload: dict[str, Any], tid: str) -> list[str]:
    if observability_reads_primary():
        from evoflow.observability import agent_trace_load as atl

        run_latency_rows = atl.load_run_latency(tid)
        rl_src = [atl.sqlite_source_label()] if run_latency_rows else []
    else:
        latency_paths = _unique_paths(thread_log_paths(tid, "run_latency_trace.jsonl") + _paths_join_under_roots("logs", "debug", "run_latency_trace.jsonl"))
        run_latency_rows, rl_src = _merge_jsonl_by_thread(latency_paths, tid)
    run_latency_rows.sort(key=lambda r: float(r.get("ts_ms") or 0))
    payload["run_latency"] = run_latency_rows
    first_token_rows = _load_first_token_trace_rows(tid)
    payload["first_token_trace"] = first_token_rows
    payload["end_to_end_timing"] = _build_end_to_end_timing(payload, run_latency_rows, first_token_rows)
    wb = payload.get("wall_clock_breakdown")
    if isinstance(wb, dict):
        _enrich_wall_clock_with_run_latency(wb, run_latency_rows)
    return rl_src


def _build_wall_clock_breakdown(payload: dict[str, Any]) -> dict[str, Any]:
    """Estimate where wall time goes for the latest LangGraph run vs vendor HTTP latency."""
    from evoflow.observability.invocation_kinds import invocation_kind_catalog

    note_zh = (
        "wall_clock_breakdown：latest_run 取 created_at 最新的一次 LangGraph run（API 返回顺序不固定）。"
        "vendor_latency_ms 为单次 HTTP/SDK 整段流式耗时（非 TTFT）。"
        "pre_first_model 含构图、checkpoint、before_model 中间件。"
        "per_run 列出本会话每次 run；inter_run_gaps_ms 为上一轮 updated_at → 下一轮 created_at（用户体感「发消息后等很久才开跑」常看这里）。"
        "perceived_reply_ms ≈ run 起点到 collab 首次 model_response（非页面首字）。"
    )
    lg = payload.get("langgraph") if isinstance(payload.get("langgraph"), dict) else {}
    runs_raw = [r for r in (lg.get("runs") or []) if isinstance(r, dict)]
    runs_sorted = sorted(
        runs_raw,
        key=lambda r: (_epoch_ms_from_any(r.get("created_at")) is None, _epoch_ms_from_any(r.get("created_at")) or 0.0),
    )

    vendor_all = [r for r in (payload.get("model_vendor_roundtrip") or []) if isinstance(r, dict)]
    payload_all = [r for r in (payload.get("model_request_payloads") or []) if isinstance(r, dict)]
    collab_all = [r for r in (payload.get("collab_cycle") or []) if isinstance(r, dict)]

    per_run: list[dict[str, Any]] = []
    for i, run in enumerate(runs_sorted):
        one = _build_wall_clock_for_run_window(
            run=run,
            vendor_all=vendor_all,
            payload_all=payload_all,
            collab_all=collab_all,
        )
        per_run.append({"run_index": i, "turn_label_zh": f"LangGraph 第 {i + 1} 次 run", **one})

    inter_run_gaps: list[dict[str, Any]] = []
    for i in range(1, len(runs_sorted)):
        prev_end = _epoch_ms_from_any(runs_sorted[i - 1].get("updated_at"))
        nxt_start = _epoch_ms_from_any(runs_sorted[i].get("created_at"))
        gap = _ms_delta(prev_end, nxt_start)
        if gap is not None and gap >= 0:
            inter_run_gaps.append(
                {
                    "after_run_index": i - 1,
                    "before_run_index": i,
                    "gap_ms": gap,
                    "note_zh": "上一轮 run 已结束 → 下一轮 run 才开始（Gateway/排队/前端/异步任务；不含在 vendor_latency 内）",
                }
            )

    latest_run = _pick_latest_langgraph_run(runs_raw)
    latest_body = _build_wall_clock_for_run_window(
        run=latest_run,
        vendor_all=vendor_all,
        payload_all=payload_all,
        collab_all=collab_all,
    )

    return {
        "schema": "evoflow.agent_trace.wall_clock.v2",
        "note_zh": note_zh,
        "latest_run": latest_body.get("run"),
        "segments_ms": latest_body.get("segments_ms"),
        "perceived_reply_ms": latest_body.get("perceived_reply_ms"),
        "collab_first_cycle_ms": latest_body.get("collab_first_cycle_ms"),
        "collab_event_timestamps_ms": latest_body.get("collab_event_timestamps_ms"),
        "vendor_calls": latest_body.get("vendor_calls"),
        "vendor_call_count": latest_body.get("vendor_call_count"),
        "vendor_by_kind_ms": latest_body.get("vendor_by_kind_ms"),
        "per_run": per_run,
        "inter_run_gaps_ms": inter_run_gaps,
        "invocation_kind_catalog": invocation_kind_catalog(),
        "langgraph_fetch_ok": bool(lg.get("ok")),
    }


def _slim_tool_row(tool_rows: list[dict[str, Any]], idx: int) -> dict[str, Any]:
    r = tool_rows[idx]
    raw_out = str(r.get("output") or "")
    op = raw_out[:400] + ("…" if len(raw_out) > 400 else "")
    out = {
        "index": idx,
        "timestamp": r.get("timestamp"),
        "tool_name": r.get("tool_name"),
        "tool_call_id": r.get("tool_call_id"),
        "status": r.get("status"),
        "duration_ms": r.get("duration_ms"),
        "input": r.get("input") if isinstance(r.get("input"), dict) else None,
        "output_preview": op or None,
    }
    return out


def _slim_model_payload_row(model_rows: list[dict[str, Any]], idx: int) -> dict[str, Any]:
    m = model_rows[idx]
    pl = m.get("payload") if isinstance(m.get("payload"), dict) else {}
    msg_len: int | None = None
    if isinstance(pl.get("messages"), list):
        msg_len = len(pl["messages"])
    prev = m.get("system_prompt_preview")
    sp = str(prev) if prev is not None else ""
    if len(sp) > 480:
        sp = sp[:477] + "…"
    user_preview = ""
    if isinstance(pl.get("messages"), list):
        for msg in reversed(pl["messages"]):
            if not isinstance(msg, dict):
                continue
            if str(msg.get("role") or "").strip().lower() != "user":
                continue
            c = msg.get("content")
            if isinstance(c, str) and c.strip():
                user_preview = c.strip()
                break
            if isinstance(c, list):
                parts: list[str] = []
                for block in c:
                    if isinstance(block, dict) and str(block.get("type") or "") == "text":
                        t = block.get("text")
                        if isinstance(t, str) and t.strip():
                            parts.append(t.strip())
                user_preview = " ".join(parts).strip()
                break
        if len(user_preview) > 200:
            user_preview = user_preview[:197] + "…"
    ik = str(m.get("invocation_kind") or "").strip() or None

    return {
        "index": idx,
        "ts_ms": m.get("ts_ms"),
        "provider": m.get("provider"),
        "model": m.get("model"),
        "stage": m.get("stage"),
        "invocation_kind": ik,
        "invocation_kind_label_zh": invocation_kind_label_zh(ik) if ik else None,
        "trace_id": m.get("trace_id"),
        "system_prompt_detected": m.get("system_prompt_detected"),
        "system_prompt_preview": sp or None,
        "payload_messages_len": msg_len,
        "last_user_message_preview": user_preview or None,
    }


def _build_conversation_turns(payload: dict[str, Any]) -> dict[str, Any]:
    """Group round_trace / model HTTP / tool I/O by user turn and model-call cycle.

    Uses ``turn_snapshot`` rows from ``lead_agent_round_trace`` as turn boundaries;
    ``model_call_tools`` rows (with ``model_call_seq``) define cycles inside a turn.
    Model payloads and tool rows are matched by timestamp windows (best-effort).
    """
    rounds_raw = payload.get("lead_agent_round") or []
    rounds: list[dict[str, Any]] = [r for r in rounds_raw if isinstance(r, dict)]
    rounds.sort(key=lambda r: (_epoch_ms_from_any(r.get("timestamp")) is None, _epoch_ms_from_any(r.get("timestamp")) or 0.0))

    models = payload.get("model_request_payloads") or []
    model_rows: list[dict[str, Any]] = [m for m in models if isinstance(m, dict)]

    tools_raw = payload.get("tool_call_io") or []
    tool_rows: list[dict[str, Any]] = [t for t in tools_raw if isinstance(t, dict)]

    collab_raw = payload.get("collab_cycle") or []
    collab_rows: list[dict[str, Any]] = [c for c in collab_raw if isinstance(c, dict)]

    snapshot_rows: list[dict[str, Any]] = [r for r in rounds if str(r.get("event") or "") == "turn_snapshot"]
    model_call_rows: list[dict[str, Any]] = [r for r in rounds if str(r.get("event") or "") == "model_call_tools"]

    note_zh = (
        "conversation_turns：按 turn_snapshot 划分用户轮次，轮次内含 model_call_seq 周期；"
        "各周期含 activated_scenarios（该次调用模型时点的激活场景，可与 turn 级 turn_snapshot 不同）、"
        "model_request_payload_indices / tool_call_io_indices 及摘要。"
        "若缺少用户轮次快照，较早的 model_call_tools 会落在「未归属 turn_snapshot（前置）」。"
    )

    if not snapshot_rows and not model_call_rows:
        return {
            "schema": "evoflow.agent_trace.turns.v1",
            "note_zh": note_zh,
            "turns": [],
            "counts": {"turns": 0, "model_cycles": 0},
        }

    # Turn boundaries: each turn_snapshot starts a turn at its timestamp; next turn ends before following snapshot.
    turn_starts: list[tuple[float, dict[str, Any]]] = []
    for s in snapshot_rows:
        ms = _epoch_ms_from_any(s.get("timestamp"))
        if ms is None:
            continue
        turn_starts.append((ms, s))
    turn_starts.sort(key=lambda x: x[0])

    first_model_ms = None
    if model_call_rows:
        for r in model_call_rows:
            m = _epoch_ms_from_any(r.get("timestamp"))
            if m is None:
                continue
            first_model_ms = m if first_model_ms is None else min(first_model_ms, m)

    synthetic_prefix = False
    if first_model_ms is not None:
        if not turn_starts or first_model_ms < turn_starts[0][0] - 1e-6:
            synthetic_prefix = True

    turns_out: list[dict[str, Any]] = []
    turn_index = 0

    def _append_turn(
        start_ms: float,
        end_ms: float | None,
        snap: dict[str, Any] | None,
        *,
        explicit_label: str | None = None,
    ) -> None:
        nonlocal turn_index
        cycles = []
        for mc in model_call_rows:
            tmc = _epoch_ms_from_any(mc.get("timestamp"))
            if tmc is None:
                continue
            if tmc + 1e-6 < start_ms:
                continue
            if end_ms is not None and tmc >= end_ms - 1e-6:
                continue
            cycles.append(mc)
        cycles.sort(key=lambda r: (_epoch_ms_from_any(r.get("timestamp")) or 0, int(r.get("model_call_seq") or 0)))

        collab_refs: list[int] = []
        for ci, crow in enumerate(collab_rows):
            cts = crow.get("ts") or crow.get("timestamp")
            cms = _epoch_ms_from_any(cts)
            if cms is None:
                continue
            if cms + 1e-6 < start_ms:
                continue
            if end_ms is not None and cms >= end_ms - 1e-6:
                continue
            collab_refs.append(ci)

        cycle_dicts: list[dict[str, Any]] = []
        for j, mc in enumerate(cycles):
            t0 = _epoch_ms_from_any(mc.get("timestamp"))
            if t0 is None:
                t0 = start_ms
            t1 = _epoch_ms_from_any(cycles[j + 1].get("timestamp")) if j + 1 < len(cycles) else end_ms
            if t1 is not None and t1 < t0:
                t1 = t0

            payload_indices: list[int] = []
            for mi, mrec in enumerate(model_rows):
                mts = _model_payload_ts_ms(mrec)
                if mts is None:
                    continue
                if mts + 1e-6 < t0:
                    continue
                if t1 is not None and mts >= t1 - 1e-6:
                    continue
                payload_indices.append(mi)

            tool_indices: list[int] = []
            for ti, trec in enumerate(tool_rows):
                tt = _epoch_ms_from_any(trec.get("timestamp"))
                if tt is None:
                    continue
                if tt + 1e-6 < t0:
                    continue
                if t1 is not None and tt >= t1 - 1e-6:
                    continue
                tool_indices.append(ti)

            payload_indices.sort(key=lambda i: (_model_payload_ts_ms(model_rows[i]) or 0, i))
            tool_indices.sort(key=lambda i: (_epoch_ms_from_any(tool_rows[i].get("timestamp")) or 0, i))

            cycle_dicts.append(
                {
                    "model_call_seq": mc.get("model_call_seq"),
                    "timestamp": mc.get("timestamp"),
                    "timestamp_ms": t0,
                    # 与 turn_snapshot 不同：每次 model_call_tools 时点的激活场景（同轮内可随 scenario 工具变化）
                    "activated_scenarios": mc.get("activated_scenarios"),
                    "model_request_tools_count": mc.get("model_request_tools_count"),
                    "model_request_tools": mc.get("model_request_tools"),
                    "loaded_deferred_tools": mc.get("loaded_deferred_tools"),
                    "model_request_payload_indices": payload_indices,
                    "model_request_payload_summaries": [_slim_model_payload_row(model_rows, i) for i in payload_indices],
                    "tool_call_io_indices": tool_indices,
                    "tool_call_io_summaries": [_slim_tool_row(tool_rows, i) for i in tool_indices],
                }
            )

        snap_payload = snap if isinstance(snap, dict) else None
        label = explicit_label if explicit_label else f"用户第 {turn_index + 1} 轮"
        turns_out.append(
            {
                "turn_index": turn_index,
                "label": label,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "user_input": (snap_payload or {}).get("user_input") if snap_payload else "",
                "activated_scenarios": (snap_payload or {}).get("activated_scenarios"),
                "turn_snapshot": snap_payload,
                "collab_cycle_indices": collab_refs,
                "model_cycles": cycle_dicts,
            }
        )
        turn_index += 1

    if synthetic_prefix:
        end0 = turn_starts[0][0] if turn_starts else None
        placeholder = {
            "event": "turn_snapshot",
            "timestamp": datetime.fromtimestamp((first_model_ms or 0) / 1000, tz=UTC).isoformat(),
            "thread_id": payload.get("thread_id"),
            "user_input": "",
            "activated_scenarios": [],
            "_synthetic": True,
            "_note_zh": "此轮之前发生的 model_call_tools 无对应 turn_snapshot（日志缺失或旧版）。",
        }
        _append_turn(
            first_model_ms or 0.0,
            end0,
            placeholder,
            explicit_label="未归属 turn_snapshot（前置）",
        )

    for i, (sm, snap) in enumerate(turn_starts):
        nxt = turn_starts[i + 1][0] if i + 1 < len(turn_starts) else None
        _append_turn(sm, nxt, snap)

    total_cycles = sum(len(t.get("model_cycles") or []) for t in turns_out)
    return {
        "schema": "evoflow.agent_trace.turns.v1",
        "note_zh": note_zh + " 每轮 ``timing`` 含墙钟分段、厂商耗时、进模型前明细（与 Agent Trace UI 对齐）。",
        "turns": turns_out,
        "counts": {"turns": len(turns_out), "model_cycles": total_cycles},
    }


def _vendor_by_kind_for_turn(turn: dict[str, Any], payload: dict[str, Any]) -> dict[str, float]:
    """Sum vendor latency by invocation_kind for all model HTTP rows in this turn's cycles."""
    from evoflow.observability.invocation_kinds import resolve_invocation_kind

    models = [m for m in (payload.get("model_request_payloads") or []) if isinstance(m, dict)]
    out: dict[str, float] = {}
    seen: set[int] = set()
    for cy in turn.get("model_cycles") or []:
        if not isinstance(cy, dict):
            continue
        for raw_i in cy.get("model_request_payload_indices") or []:
            try:
                i = int(raw_i)
            except (TypeError, ValueError):
                continue
            if i < 0 or i >= len(models) or i in seen:
                continue
            seen.add(i)
            rec = models[i]
            lat = rec.get("vendor_latency_ms")
            if lat is None:
                continue
            try:
                ms = float(lat)
            except (TypeError, ValueError):
                continue
            kind = resolve_invocation_kind(payload_row=rec)
            out[kind] = out.get(kind, 0.0) + ms
    return {k: round(v, 2) for k, v in out.items()}


def _enrich_per_run_row(pr: dict[str, Any], *, turn_start: float | None, turn_end: float | None) -> dict[str, Any]:
    run = pr.get("run") if isinstance(pr.get("run"), dict) else {}
    rs = _epoch_ms_from_any(run.get("created_at"))
    re = _epoch_ms_from_any(run.get("updated_at"))
    if re is None:
        re = rs
    wall = run.get("wall_ms")
    if wall is None:
        wall = _ms_delta(rs, re)
    overlap = 0.0
    if rs is not None and turn_start is not None:
        o0 = max(float(turn_start), float(rs))
        o1 = min(float(turn_end) if turn_end is not None else float(re) + 1e9, float(re))
        overlap = max(0.0, o1 - o0)
    return {
        **pr,
        "overlap_ms": round(overlap, 2),
        "run_wall_ms": wall,
        "run_id": run.get("run_id"),
    }


def _run_turn_overlap_ms(
    turn: dict[str, Any],
    run: dict[str, Any],
) -> float:
    start = _epoch_ms_from_any(turn.get("start_ms"))
    end = _epoch_ms_from_any(turn.get("end_ms"))
    rs = _epoch_ms_from_any(run.get("created_at"))
    re = _epoch_ms_from_any(run.get("updated_at"))
    if start is None or rs is None:
        return 0.0
    if re is None:
        re = rs
    o0 = max(float(start), float(rs))
    o1 = min(float(end) if end is not None else float(re) + 1e9, float(re))
    return max(0.0, o1 - o0)


def _assign_per_run_rows_to_turns(
    turns: list[dict[str, Any]],
    per_run: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Assign each LangGraph ``per_run`` row to exactly one user turn."""
    buckets: list[list[dict[str, Any]]] = [[] for _ in turns]
    slack_ms = 50.0
    pending: list[dict[str, Any]] = [pr for pr in per_run if isinstance(pr, dict)]

    def _append(i: int, pr: dict[str, Any]) -> None:
        turn = turns[i] if 0 <= i < len(turns) else {}
        start = _epoch_ms_from_any(turn.get("start_ms")) if isinstance(turn, dict) else None
        end = _epoch_ms_from_any(turn.get("end_ms")) if isinstance(turn, dict) else None
        buckets[i].append(_enrich_per_run_row(pr, turn_start=start, turn_end=end))

    # Pass 1: run.created_at inside user-turn window (canonical).
    still: list[dict[str, Any]] = []
    for pr in pending:
        run = pr.get("run") if isinstance(pr.get("run"), dict) else {}
        rs = _epoch_ms_from_any(run.get("created_at"))
        if rs is None:
            still.append(pr)
            continue
        best_i: int | None = None
        best_dist = float("inf")
        for i, turn in enumerate(turns):
            if not isinstance(turn, dict):
                continue
            start = _epoch_ms_from_any(turn.get("start_ms"))
            end = _epoch_ms_from_any(turn.get("end_ms"))
            if start is None:
                continue
            if float(rs) + slack_ms < float(start):
                continue
            if end is not None and float(rs) >= float(end) - slack_ms:
                continue
            dist = float(rs) - float(start)
            if dist < best_dist:
                best_dist = dist
                best_i = i
        if best_i is None:
            still.append(pr)
        else:
            _append(best_i, pr)

    # Pass 2: runs that started slightly before turn_snapshot (race) — overlap only if still inside turn end.
    for pr in still:
        run = pr.get("run") if isinstance(pr.get("run"), dict) else {}
        rs = _epoch_ms_from_any(run.get("created_at"))
        best_i: int | None = None
        best_overlap = -1.0
        for i, turn in enumerate(turns):
            if not isinstance(turn, dict):
                continue
            start = _epoch_ms_from_any(turn.get("start_ms"))
            end = _epoch_ms_from_any(turn.get("end_ms"))
            if rs is not None and start is not None and float(rs) + slack_ms < float(start):
                continue
            if rs is not None and end is not None and float(rs) >= float(end) - slack_ms:
                continue
            ov = _run_turn_overlap_ms(turn, run)
            if ov > best_overlap:
                best_overlap = ov
                best_i = i
        if best_i is None or best_overlap <= 0:
            continue
        _append(best_i, pr)

    for bucket in buckets:
        bucket.sort(
            key=lambda r: _epoch_ms_from_any((r.get("run") or {}).get("created_at")) or 0.0,
        )
    return buckets


def _list_per_runs_for_turn(
    turn: dict[str, Any],
    per_run: list[dict[str, Any]],
    *,
    assigned: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """LangGraph runs for this user turn (prefer pre-assigned bucket)."""
    if assigned is not None:
        return list(assigned)
    start = _epoch_ms_from_any(turn.get("start_ms"))
    end = _epoch_ms_from_any(turn.get("end_ms"))
    if start is None:
        return [_enrich_per_run_row(per_run[-1], turn_start=None, turn_end=None)] if per_run else []
    matched: list[dict[str, Any]] = []
    slack_ms = 50.0
    for pr in per_run:
        if not isinstance(pr, dict):
            continue
        run = pr.get("run") if isinstance(pr.get("run"), dict) else {}
        rs = _epoch_ms_from_any(run.get("created_at"))
        if rs is None:
            continue
        if float(rs) + slack_ms < float(start):
            continue
        if end is not None and float(rs) >= float(end) - slack_ms:
            continue
        matched.append(_enrich_per_run_row(pr, turn_start=start, turn_end=end))
    return matched


def _run_setup_phases_for_turn_window(
    rows: list[dict[str, Any]],
    start_ms: float | None,
    end_ms: float | None,
) -> dict[str, float]:
    """Aggregate ``run_setup_phase`` rows (from ``make_lead_agent``) into one map."""
    out: dict[str, float] = {}
    if start_ms is None:
        return out
    for row in rows:
        if not isinstance(row, dict) or str(row.get("event") or "") != "run_setup_phase":
            continue
        ts = _epoch_ms_from_any(row.get("ts_ms") or row.get("ts"))
        if ts is None or ts + 1e-6 < float(start_ms):
            continue
        if end_ms is not None and ts >= float(end_ms) - 1e-6:
            continue
        phase = str(row.get("phase") or "").strip()
        if not phase:
            continue
        try:
            ms = float(row.get("duration_ms") or 0)
        except (TypeError, ValueError):
            continue
        out[phase] = round(out.get(phase, 0.0) + ms, 2)
    return out


def _idle_before_first_run_ms(turn: dict[str, Any], runs_in_turn: list[dict[str, Any]]) -> float | None:
    start = _epoch_ms_from_any(turn.get("start_ms"))
    if start is None or not runs_in_turn:
        return None
    first_rs: float | None = None
    for r in runs_in_turn:
        run = r.get("run") if isinstance(r.get("run"), dict) else {}
        rs = _epoch_ms_from_any(run.get("created_at"))
        if rs is None:
            continue
        if first_rs is None or float(rs) < first_rs:
            first_rs = float(rs)
    if first_rs is None:
        return None
    delta = _ms_delta(float(start), first_rs)
    if delta is None or delta < 0:
        return None
    return round(delta, 2)


def _inter_run_gaps_in_turn(runs_in_turn: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Gaps between consecutive LangGraph runs inside one user turn."""
    if len(runs_in_turn) < 2:
        return []
    ordered = sorted(
        runs_in_turn,
        key=lambda r: _epoch_ms_from_any((r.get("run") or {}).get("created_at")) or 0.0,
    )
    gaps: list[dict[str, Any]] = []
    for i in range(1, len(ordered)):
        prev_run = ordered[i - 1].get("run") if isinstance(ordered[i - 1].get("run"), dict) else {}
        nxt_run = ordered[i].get("run") if isinstance(ordered[i].get("run"), dict) else {}
        prev_end = _epoch_ms_from_any(prev_run.get("updated_at"))
        nxt_start = _epoch_ms_from_any(nxt_run.get("created_at"))
        gap = _ms_delta(prev_end, nxt_start)
        if gap is not None and gap >= 0:
            gaps.append(
                {
                    "after_run_index": ordered[i - 1].get("run_index"),
                    "before_run_index": ordered[i].get("run_index"),
                    "gap_ms": round(gap, 2),
                    "note_zh": "本轮内两次 LangGraph run 之间的空档（排队/前端/异步任务）",
                }
            )
    return gaps


def _pick_per_run_for_turn(
    turn: dict[str, Any],
    per_run: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Best-matching ``wall_clock_breakdown.per_run`` row for a conversation turn window."""
    if not per_run:
        return None
    start = _epoch_ms_from_any(turn.get("start_ms"))
    end = _epoch_ms_from_any(turn.get("end_ms"))
    if start is None:
        return per_run[-1]
    _best: dict[str, Any] | None = None
    best_overlap = -1.0
    best_dist = float("inf")
    for pr in per_run:
        if not isinstance(pr, dict):
            continue
        run = pr.get("run") if isinstance(pr.get("run"), dict) else {}
        rs = _epoch_ms_from_any(run.get("created_at"))
        re = _epoch_ms_from_any(run.get("updated_at"))
        if rs is None:
            continue
        if re is None:
            re = rs
        o0 = max(float(start), float(rs))
        o1 = min(float(end) if end is not None else float(re) + 1e9, float(re))
        overlap = max(0.0, o1 - o0)
        dist = abs(float(rs) - float(start))
        if overlap > best_overlap or (overlap == best_overlap and dist < best_dist):
            best_overlap = overlap
            best_dist = dist
            _best = pr
    runs = _list_per_runs_for_turn(turn, per_run)
    return runs[0] if runs else None


def _collab_phase_timing_per_model_cycle(
    turn: dict[str, Any],
    collab_rows: list[dict[str, Any]],
) -> dict[str, float]:
    """Collab deltas scoped to each model_call cycle (avoids misleading multi-second cross-cycle gaps)."""
    core = ("before_model", "model_request", "model_response", "after_model")
    _turn_start = _epoch_ms_from_any(turn.get("start_ms"))
    turn_end = _epoch_ms_from_any(turn.get("end_ms"))
    cycles = [c for c in (turn.get("model_cycles") or []) if isinstance(c, dict)]
    if not cycles:
        return _collab_phase_timing_for_turn(turn, collab_rows)

    out: dict[str, float] = {}

    def _events_in_window(t0: float, t1: float | None) -> list[tuple[float, str]]:
        evs: list[tuple[float, str]] = []
        for ci in turn.get("collab_cycle_indices") or []:
            try:
                idx = int(ci)
            except (TypeError, ValueError):
                continue
            if idx < 0 or idx >= len(collab_rows):
                continue
            row = collab_rows[idx]
            if not isinstance(row, dict):
                continue
            name = str(row.get("event") or "").strip().lower()
            if name not in core:
                continue
            ts = _epoch_ms_from_any(row.get("ts") or row.get("timestamp"))
            if ts is None:
                continue
            if ts + 1e-6 < t0:
                continue
            if t1 is not None and ts >= t1 - 1e-6:
                continue
            evs.append((float(ts), name))
        evs.sort(key=lambda x: x[0])
        return evs

    prev_cycle_last: tuple[float, str] | None = None
    for j, cy in enumerate(cycles):
        t0 = _epoch_ms_from_any(cy.get("timestamp_ms") or cy.get("timestamp"))
        if t0 is None:
            continue
        t1 = None
        if j + 1 < len(cycles):
            t1 = _epoch_ms_from_any(cycles[j + 1].get("timestamp_ms") or cycles[j + 1].get("timestamp"))
        elif turn_end is not None:
            t1 = float(turn_end)
        evs = _events_in_window(float(t0), t1)
        prev_ts: float | None = None
        prev_ev: str | None = None
        prefix = f"cycle_{j + 1}_"
        for ts, ev in evs:
            if prev_ts is not None and prev_ev:
                key = f"{prefix}{prev_ev}_to_{ev}_ms"
                delta = _ms_delta(prev_ts, ts)
                if delta is not None and delta >= 0:
                    if delta > 10000.0:
                        out[f"{prefix}long_idle_gap_ms"] = round(delta, 2)
                    else:
                        out[key] = round(delta, 2)
            prev_ts, prev_ev = ts, ev
        if evs:
            prev_cycle_last = evs[-1]

        if prev_cycle_last and j + 1 < len(cycles):
            nxt_t0 = _epoch_ms_from_any(cycles[j + 1].get("timestamp_ms") or cycles[j + 1].get("timestamp"))
            nxt_evs = _events_in_window(float(nxt_t0) if nxt_t0 is not None else 0.0, t1)
            if nxt_evs:
                gap = _ms_delta(prev_cycle_last[0], nxt_evs[0][0])
                if gap is not None and gap >= 0:
                    out[f"between_cycle_{j + 1}_and_{j + 2}_ms"] = round(gap, 2)

    return out


def _run_latency_rows_in_turn_window(
    rows: list[dict[str, Any]],
    start_ms: float | None,
    end_ms: float | None,
) -> list[dict[str, Any]]:
    if start_ms is None:
        return list(rows)
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ts = _epoch_ms_from_any(row.get("ts_ms") or row.get("ts"))
        if ts is None:
            continue
        if ts + 1e-6 < float(start_ms):
            continue
        if end_ms is not None and ts >= float(end_ms) - 1e-6:
            continue
        out.append(row)
    return out


def _collab_phase_timing_for_turn(
    turn: dict[str, Any],
    collab_rows: list[dict[str, Any]],
) -> dict[str, float]:
    """Deltas between collab_cycle core events inside one user turn."""
    core = ("before_model", "model_request", "model_response", "after_model")
    events: list[tuple[float, str]] = []
    for ci in turn.get("collab_cycle_indices") or []:
        try:
            idx = int(ci)
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(collab_rows):
            continue
        row = collab_rows[idx]
        if not isinstance(row, dict):
            continue
        ev = str(row.get("event") or "").strip().lower()
        if ev not in core:
            continue
        ts = _epoch_ms_from_any(row.get("ts") or row.get("timestamp"))
        if ts is None:
            continue
        turn_start = _epoch_ms_from_any(turn.get("start_ms"))
        turn_end = _epoch_ms_from_any(turn.get("end_ms"))
        if turn_start is not None and ts + 1e-6 < float(turn_start):
            continue
        if turn_end is not None and ts >= float(turn_end) - 1e-6:
            continue
        events.append((float(ts), ev))
    events.sort(key=lambda x: x[0])
    out: dict[str, float] = {}
    start = _epoch_ms_from_any(turn.get("start_ms"))
    prev_ts: float | None = None
    prev_ev: str | None = None
    for ts, ev in events:
        if start is not None and prev_ts is None and ev == "before_model":
            delta = _ms_delta(float(start), ts)
            if delta is not None and delta >= 0:
                out["turn_start_to_before_model_ms"] = round(delta, 2)
        if prev_ts is not None and prev_ev:
            key = f"{prev_ev}_to_{ev}_ms"
            delta = _ms_delta(prev_ts, ts)
            if delta is not None and delta >= 0:
                out[key] = round(delta, 2)
        prev_ts, prev_ev = ts, ev
    return out


def _attach_timing_to_conversation_turns(payload: dict[str, Any]) -> None:
    """Attach per-turn ``timing`` for Agent Trace UI (summary + timeline)."""
    ct = payload.get("conversation_turns")
    if not isinstance(ct, dict):
        return
    turns = ct.get("turns")
    if not isinstance(turns, list):
        return
    wb = payload.get("wall_clock_breakdown") if isinstance(payload.get("wall_clock_breakdown"), dict) else {}
    per_run = [r for r in (wb.get("per_run") or []) if isinstance(r, dict)]
    e2e = payload.get("end_to_end_timing") if isinstance(payload.get("end_to_end_timing"), dict) else {}
    e2e_segs = e2e.get("segments_ms") if isinstance(e2e.get("segments_ms"), dict) else {}
    run_latency_rows = [r for r in (payload.get("run_latency") or []) if isinstance(r, dict)]
    collab_rows = [r for r in (payload.get("collab_cycle") or []) if isinstance(r, dict)]
    n_turns = len(turns)
    turn_list = [t for t in turns if isinstance(t, dict)]
    run_buckets = _assign_per_run_rows_to_turns(turn_list, per_run)
    dict_turn_idx = 0

    for i, turn in enumerate(turns):
        if not isinstance(turn, dict):
            continue
        start = _epoch_ms_from_any(turn.get("start_ms"))
        end = _epoch_ms_from_any(turn.get("end_ms"))
        assigned = run_buckets[dict_turn_idx] if dict_turn_idx < len(run_buckets) else []
        dict_turn_idx += 1
        runs_in_turn = _list_per_runs_for_turn(turn, per_run, assigned=assigned)
        pr = runs_in_turn[0] if runs_in_turn else None
        seg = pr.get("segments_ms") if isinstance(pr, dict) and isinstance(pr.get("segments_ms"), dict) else {}
        vendor_by_kind = _vendor_by_kind_for_turn(turn, payload)
        vendor_sum = round(sum(vendor_by_kind.values()), 2) if vendor_by_kind else seg.get("vendor_sum")
        main_vendor = vendor_by_kind.get("main")
        if main_vendor is None:
            main_vendor = seg.get("main_model_vendor")
        runs_wall_sum = round(
            sum(float(r.get("run_wall_ms") or 0) for r in runs_in_turn if r.get("run_wall_ms") is not None),
            2,
        )
        primary_wall = None
        if runs_in_turn:
            primary_wall = runs_in_turn[0].get("run_wall_ms")
        langgraph_wall = primary_wall if primary_wall is not None else (runs_wall_sum if runs_in_turn else seg.get("langgraph_run_wall"))
        rl_window = _run_latency_rows_in_turn_window(run_latency_rows, start, end)
        pre_bd = _pick_latest_run_latency_row(rl_window, "pre_model_breakdown")
        pre_phases: dict[str, float] | None = None
        setup_phases = _run_setup_phases_for_turn_window(rl_window, start, end)
        if pre_bd and isinstance(pre_bd.get("phases_ms"), dict):
            pre_phases = {}
            for k, v in pre_bd["phases_ms"].items():
                try:
                    pre_phases[str(k)] = round(float(v), 2)
                except (TypeError, ValueError):
                    continue
        if setup_phases:
            pre_phases = {**(pre_phases or {}), **setup_phases}
        gaps = _inter_run_gaps_in_turn(runs_in_turn)
        max_inter_run_gap = max((float(g.get("gap_ms") or 0) for g in gaps), default=0.0)
        non_vendor = None
        if langgraph_wall is not None and vendor_sum is not None:
            try:
                non_vendor = round(max(0.0, float(langgraph_wall) - float(vendor_sum)), 2)
            except (TypeError, ValueError):
                non_vendor = seg.get("non_vendor_estimated")
        timing: dict[str, Any] = {
            "turn_index": i,
            "turn_label": str(turn.get("label") or "").strip() or f"用户第 {i + 1} 轮",
            "turn_wall_ms": _ms_delta(start, end),
            "langgraph_run_wall_ms": langgraph_wall,
            "langgraph_run_wall_sum_ms": runs_wall_sum if len(runs_in_turn) > 1 else None,
            "idle_before_first_run_ms": _idle_before_first_run_ms(turn, runs_in_turn),
            "max_inter_run_gap_ms": round(max_inter_run_gap, 2) if max_inter_run_gap > 0 else None,
            "langgraph_run_count": len(runs_in_turn),
            "langgraph_runs_in_turn": [
                {
                    "run_index": r.get("run_index"),
                    "run_id": r.get("run_id"),
                    "wall_ms": r.get("run_wall_ms"),
                    "overlap_ms": r.get("overlap_ms"),
                }
                for r in runs_in_turn
            ],
            "inter_run_gaps_in_turn_ms": gaps,
            "pre_first_model_ms": seg.get("pre_first_model"),
            "post_last_model_ms": seg.get("post_last_model_checkpoint"),
            "main_model_vendor_ms": main_vendor,
            "vendor_sum_ms": vendor_sum,
            "non_vendor_estimated_ms": non_vendor,
            "vendor_by_kind_ms": vendor_by_kind,
            "pre_model_measured_ms": pre_bd.get("after_before_model_ms") if pre_bd else None,
            "pre_model_breakdown_ms": pre_phases,
            "collab_phase_ms": _collab_phase_timing_per_model_cycle(turn, collab_rows),
            "perceived_reply_ms": pr.get("perceived_reply_ms") if isinstance(pr, dict) else None,
            "note_zh": ("langgraph_run_wall_ms：本轮主 run（第一次开跑）墙钟；多 run 时看 langgraph_run_wall_sum_ms 与 run 间空档。厂商 HTTP 仅含模型调用；其余为 EvoFlow 进模型前/工具/checkpoint/排队。page_round_trip_ms 仅最后一轮有。"),
        }
        if i == n_turns - 1 and e2e_segs:
            timing["page_round_trip_ms"] = e2e_segs.get("page_round_trip_ms")
            timing["page_time_to_first_token_ms"] = e2e_segs.get("page_time_to_first_token_ms")
            timing["gateway_stream_wall_ms"] = e2e_segs.get("gateway_stream_wall_ms")
            timing["preflight_and_client_to_gateway_ms"] = e2e_segs.get("preflight_and_client_to_gateway_ms")
            timing["pre_model_total_ms"] = e2e_segs.get("pre_model_total_ms")
            timing["page_after_gateway_stream_ms"] = e2e_segs.get("page_after_gateway_stream_ms")
        turn["timing"] = timing


def _build_task_progress_snapshot_for_trace(thread_id: str) -> dict[str, Any]:
    """Disk-ground-truth main/subtask status (same source as EvoPanel sidebar).

    Export otherwise only reflects append-only logs; the last ``supervisor`` tool row can lag
    if a subtask completes without another supervisor call.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return {"ok": False, "error": "empty_thread_id"}
    try:
        from evoflow.collab.task_progress_snapshot import build_task_progress_snapshot

        snap = build_task_progress_snapshot(get_paths(), tid)
        subs_raw = snap.get("subtasks") or []
        subs = [s for s in subs_raw if isinstance(s, dict)]
        status_counts: dict[str, int] = {}
        for s in subs:
            st = str(s.get("status") or "").strip().lower() or "unknown"
            status_counts[st] = status_counts.get(st, 0) + 1
        note_zh = "与 EvoPanel 侧边栏同源：当前项目存储中的主任务与子任务状态。若与「工具记录」里最后一次 supervisor 返回不一致，多为子任务已在后台完成但未再次调用 supervisor，日志仍停留在较早一轮的返回值。"
        out: dict[str, Any] = {"ok": True, "note_zh": note_zh, "subtask_status_counts": status_counts}
        out.update(snap)
        return out
    except Exception as e:
        return {"ok": False, "error": str(e), "error_type": type(e).__name__, "thread_id": tid}


_SESSION_ID_SAFE = re.compile(r"^[a-zA-Z0-9._-]{1,160}$")


def _safe_claude_session_id(raw: Any) -> str | None:
    s = str(raw or "").strip()
    if not s or not _SESSION_ID_SAFE.fullmatch(s):
        return None
    return s


def _extract_claude_session_ids_from_tool_row(row: dict[str, Any]) -> list[str]:
    out: list[str] = []
    if str(row.get("tool_name") or "").strip().lower() != "claude-code":
        return out
    inp = row.get("input")
    if isinstance(inp, dict):
        sid = _safe_claude_session_id(inp.get("session_id"))
        if sid:
            out.append(sid)
    outp = row.get("output")
    if isinstance(outp, dict):
        sid = _safe_claude_session_id(outp.get("session_id"))
        if sid:
            out.append(sid)
        lp = str(outp.get("log_path") or "").strip()
        if lp:
            try:
                name = Path(lp).name
                pref, suf = "claude_session_", ".jsonl"
                if name.startswith(pref) and name.endswith(suf):
                    inner = name[len(pref) : -len(suf)]
                    ss = _safe_claude_session_id(inner)
                    if ss:
                        out.append(ss)
            except Exception:
                pass
    elif isinstance(outp, str):
        s = outp.strip()
        if s.startswith("{"):
            try:
                obj = json.loads(s)
                if isinstance(obj, dict):
                    sid = _safe_claude_session_id(obj.get("session_id"))
                    if sid:
                        out.append(sid)
                    lp = str(obj.get("log_path") or "").strip()
                    if lp:
                        try:
                            name = Path(lp).name
                            pref, suf = "claude_session_", ".jsonl"
                            if name.startswith(pref) and name.endswith(suf):
                                inner = name[len(pref) : -len(suf)]
                                ss = _safe_claude_session_id(inner)
                                if ss:
                                    out.append(ss)
                        except Exception:
                            pass
            except Exception:
                pass
    return out


def _collect_claude_session_ids_from_snapshot(snap: dict[str, Any]) -> list[str]:
    out: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k, v in x.items():
                lk = str(k).lower()
                if lk in ("claude_session_id", "external_session_id", "claudesessionid") and isinstance(v, str):
                    sid = _safe_claude_session_id(v)
                    if sid:
                        out.append(sid)
                else:
                    walk(v)
        elif isinstance(x, list):
            for it in x:
                walk(it)

    walk(snap)
    return out


def _read_claude_session_jsonl_tail(path: Path, *, max_bytes: int, max_objects: int) -> tuple[list[dict[str, Any]], bool, int]:
    if not path.is_file():
        return [], False, 0
    text = _read_tail_text(path, max_bytes=max_bytes)
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    events: list[dict[str, Any]] = []
    truncated = False
    for line in lines:
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                events.append(obj)
            else:
                events.append({"_value": obj})
        except Exception:
            events.append({"_parse_error": True, "_raw": line[:500]})
        if len(events) >= max_objects:
            truncated = True
            break
    return events, truncated, len(lines)


def _build_claude_sessions_debug(thread_id: str, tool_rows: list[Any], task_snap: dict[str, Any]) -> dict[str, Any]:
    """Index ``claude_session_*.jsonl`` logs for this chat thread (supervisor / task_tool paths)."""
    note_zh = (
        "Claude Agent SDK 会话日志：``<base>/logs/claude/claude_session_<id>.jsonl``。"
        "session_id 来自本 thread 的 ``tool_call_io``（``claude_session`` 工具）及任务快照中的 ``claude_session_id``。"
        "多个子任务可绑定多个 session；正文为 JSONL 尾窗解析（大文件会裁剪）。"
    )
    ids_sources: dict[str, set[str]] = {}
    for row in tool_rows or []:
        if not isinstance(row, dict):
            continue
        for sid in _extract_claude_session_ids_from_tool_row(row):
            ids_sources.setdefault(sid, set()).add("tool_call_io")
    if isinstance(task_snap, dict) and task_snap.get("ok"):
        for sid in _collect_claude_session_ids_from_snapshot(task_snap):
            ids_sources.setdefault(sid, set()).add("task_progress_snapshot")

    try:
        from evoflow.config.paths import get_paths

        base_dir = get_paths().claude_session_logs_dir.resolve()
    except Exception:
        base_dir = (Path.cwd() / "logs" / "claude").resolve()

    sessions: list[dict[str, Any]] = []
    try:
        base_resolved = base_dir.resolve()
    except Exception:
        base_resolved = base_dir

    for sid in sorted(ids_sources.keys(), key=lambda x: x.lower()):
        try:
            path = (base_resolved / f"claude_session_{sid}.jsonl").resolve()
            if str(path.parent.resolve()) != str(base_resolved.resolve()):
                continue
        except Exception:
            continue
        if not path.is_file():
            sessions.append(
                {
                    "session_id": sid,
                    "log_path": str(path),
                    "found": False,
                    "sources": sorted(ids_sources.get(sid, ())),
                    "events": [],
                }
            )
            continue
        try:
            st = path.stat()
            mtime_ms = int(st.st_mtime * 1000)
            sz = int(st.st_size)
        except OSError:
            mtime_ms, sz = 0, 0
        events, truncated, approx_lines = _read_claude_session_jsonl_tail(path, max_bytes=1_400_000, max_objects=1000)
        sessions.append(
            {
                "session_id": sid,
                "log_path": str(path),
                "found": True,
                "byte_size": sz,
                "mtime_ms": mtime_ms,
                "sources": sorted(ids_sources.get(sid, ())),
                "tail_line_count_approx": approx_lines,
                "events_truncated": truncated,
                "events": events,
            }
        )

    sessions.sort(key=lambda s: int(s.get("mtime_ms") or 0), reverse=True)
    return {
        "note_zh": note_zh,
        "logs_dir": str(base_resolved),
        "thread_id": thread_id,
        "sessions": sessions,
    }


def _gather_agent_trace_payload(thread_id: str) -> dict[str, Any]:
    """Merge per-thread debug artifacts (same shape as ``/data``)."""
    tid = _normalize_thread_id(thread_id)
    sources: list[str] = []

    def _extend_sources(paths: list[str]) -> None:
        for s in paths:
            if s not in sources:
                sources.append(s)

    if observability_reads_primary():
        from evoflow.observability import agent_trace_load as atl

        sql_label = atl.sqlite_source_label()
        collab_rows = atl.load_collab_cycle(tid)
        round_rows = atl.load_lead_agent_round(tid)
        tool_rows = atl.load_tool_call_io(tid)
        lifecycle_rows = atl.load_task_lifecycle_trace(tid)
        im_err_rows = atl.load_im_channel_errors(tid)
        payload_rows, roundtrip_rows = atl.load_model_sections(tid)
        _inject_vendor_response_into_model_payloads(payload_rows, roundtrip_rows)
        if sql_label:
            _extend_sources([sql_label])
    else:
        collab_paths = _unique_paths(thread_log_paths(tid, "collab_cycle_trace.log") + _paths_join_under_roots("logs", "debug", "collab_cycle_trace.log"))
        collab_rows, collab_src = _merge_jsonl_by_thread(collab_paths, tid)
        _extend_sources(collab_src)

        model_paths = _unique_paths(thread_log_paths(tid, "model_request_payload.log") + _paths_join_under_roots("logs", "debug", "model_request_payload.log"))
        payload_rows, model_src = _merge_model_payloads_for_thread(model_paths, tid)
        _extend_sources(model_src)

        roundtrip_paths = _unique_paths(thread_log_paths(tid, "model_vendor_roundtrip.jsonl") + _paths_join_under_roots("logs", "debug", "model_vendor_roundtrip.jsonl"))
        roundtrip_rows, rt_src = _merge_jsonl_by_thread(roundtrip_paths, tid)
        _extend_sources(rt_src)
        _inject_vendor_response_into_model_payloads(payload_rows, roundtrip_rows)

        round_paths = _unique_paths(thread_log_paths(tid, "lead_agent_round_trace.log") + _paths_join_under_roots("logs", "debug", "lead_agent_round_trace.log"))
        round_rows, round_src = _merge_jsonl_by_thread(round_paths, tid)
        _extend_sources(round_src)

        tool_paths = _unique_paths(thread_log_paths(tid, "tool_call_io.log") + _paths_join_under_roots("temp", "logs", "tool_call_io.log"))
        tool_rows, tool_src = _merge_jsonl_by_thread(tool_paths, tid)
        _extend_sources(tool_src)

        lifecycle_paths = _unique_paths(thread_log_paths(tid, "task_lifecycle_trace.log") + _paths_join_under_roots("logs", "debug", "task_lifecycle_trace.log"))
        lifecycle_rows, lifecycle_src = _merge_jsonl_by_thread(lifecycle_paths, tid)
        _extend_sources(lifecycle_src)

        im_err_paths = _unique_paths(thread_log_paths(tid, "im_channel_error.log") + _paths_join_under_roots("logs", "debug", "im_channel_error.log"))
        im_err_rows, im_err_src = _merge_jsonl_by_thread(im_err_paths, tid)
        _extend_sources(im_err_src)

    collab_rows.sort(key=lambda r: str(r.get("ts") or r.get("timestamp") or ""))
    lifecycle_rows.sort(key=lambda r: str(r.get("ts") or r.get("timestamp") or ""))

    langgraph_digest = _fetch_langgraph_runs_sync(tid)
    if langgraph_digest.get("ok"):
        _extend_sources([f"langgraph_runs:{langgraph_digest.get('url') or ''}"])

    payload: dict[str, Any] = {
        "thread_id": tid,
        "sources": sources,
        "collab_cycle": collab_rows,
        "model_request_payloads": payload_rows,
        "model_vendor_roundtrip": roundtrip_rows,
        "lead_agent_round": round_rows,
        "tool_call_io": tool_rows,
        "task_lifecycle_trace": lifecycle_rows,
        "im_channel_errors": im_err_rows,
        "langgraph": langgraph_digest,
    }
    payload["graph_execution"] = _build_graph_execution(payload)
    payload["wall_clock_breakdown"] = _build_wall_clock_breakdown(payload)
    payload["conversation_turns"] = _build_conversation_turns(payload)
    ct0 = payload.get("conversation_turns") if isinstance(payload.get("conversation_turns"), dict) else {}
    ct_counts = ct0.get("counts") if isinstance(ct0.get("counts"), dict) else {}
    if int(ct_counts.get("turns") or 0) == 0:
        fetch_ck = _fetch_langgraph_thread_state_sync(tid)
        fb_turns = _conversation_turns_from_langgraph_checkpoint_fetch(fetch_ck)
        if fb_turns:
            payload["conversation_turns"] = fb_turns

    tps = _build_task_progress_snapshot_for_trace(tid)
    payload["task_progress_snapshot"] = tps
    if tps.get("ok"):
        _extend_sources(["project:task_progress_snapshot"])

    payload["claude_sessions_debug"] = _build_claude_sessions_debug(tid, tool_rows, tps)
    if payload.get("claude_sessions_debug") and (payload["claude_sessions_debug"].get("sessions") or []):
        _extend_sources(["claude_session:jsonl"])

    token_usage_debug = _build_token_usage_debug(tid)
    payload["token_usage_debug"] = token_usage_debug
    su = token_usage_debug.get("state_url") if isinstance(token_usage_debug.get("state_url"), str) else ""
    if su:
        _extend_sources([f"langgraph_state:{su}"])

    rl_src = _attach_run_latency_observability(payload, tid)
    _extend_sources(rl_src)
    _attach_timing_to_conversation_turns(payload)

    return payload


def _summarize_agent_trace(payload: dict[str, Any]) -> dict[str, Any]:
    """Small derived index so remote helpers can scan without reading full arrays."""
    collab = payload.get("collab_cycle") or []
    lifecycle = payload.get("task_lifecycle_trace") or []
    tools = payload.get("tool_call_io") or []
    rounds = payload.get("lead_agent_round") or []

    def _collab_one_line(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "event": str(row.get("event") or ""),
            "ts": str(row.get("ts") or row.get("timestamp") or ""),
        }

    plan_guard: list[dict[str, Any]] = []
    for row in collab:
        if isinstance(row, dict) and "plan_guard" in str(row.get("event") or ""):
            plan_guard.append(_collab_one_line(row))

    collab_tail = [_collab_one_line(r) for r in collab[-18:] if isinstance(r, dict)]

    tools_tail: list[dict[str, Any]] = []
    for row in tools[-14:]:
        if not isinstance(row, dict):
            continue
        tools_tail.append(
            {
                "tool_name": row.get("tool_name"),
                "status": row.get("status"),
                "timestamp": row.get("timestamp"),
                "tool_call_id": row.get("tool_call_id"),
            }
        )

    automation_tail: list[dict[str, Any]] = []
    for row in tools[-80:]:
        if not isinstance(row, dict):
            continue
        if row.get("tool_name") != "automation":
            continue
        inp = row.get("input") if isinstance(row.get("input"), dict) else {}
        out = str(row.get("output") or "")
        automation_tail.append(
            {
                "timestamp": row.get("timestamp"),
                "status": row.get("status"),
                "action": inp.get("action"),
                "id": inp.get("id") or inp.get("task_id"),
                "output_preview": out[:400],
                "looks_like_error": out.startswith("Error") or "Error:" in out[:120] or row.get("status") == "error",
            }
        )
    automation_tail = automation_tail[-12:]

    lifecycle_tail: list[dict[str, Any]] = []
    for row in lifecycle[-24:]:
        if not isinstance(row, dict):
            continue
        lifecycle_tail.append(
            {
                "ts": str(row.get("ts") or ""),
                "event": str(row.get("event") or ""),
                "main_task_id": row.get("main_task_id"),
                "subtask_id": row.get("subtask_id"),
                "status": row.get("status"),
            }
        )

    ge = payload.get("graph_execution") if isinstance(payload.get("graph_execution"), dict) else {}

    ct = payload.get("conversation_turns") if isinstance(payload.get("conversation_turns"), dict) else {}
    ct_counts = ct.get("counts") if isinstance(ct.get("counts"), dict) else {}

    csd = payload.get("claude_sessions_debug") if isinstance(payload.get("claude_sessions_debug"), dict) else {}
    csd_sessions = [s for s in (csd.get("sessions") or []) if isinstance(s, dict)]

    tu = payload.get("token_usage_debug") if isinstance(payload.get("token_usage_debug"), dict) else {}
    tu_tot = tu.get("totals") if isinstance(tu.get("totals"), dict) else {}
    err_tu = str(tu.get("error") or "").strip()
    token_usage_summary = {
        "fetch_ok": bool(tu.get("fetch_ok")),
        "http_status": tu.get("http_status"),
        "error_trunc": (err_tu[:280] + "…") if len(err_tu) > 280 else (err_tu or None),
        "messages_ai_count": tu_tot.get("messages_ai_count"),
        "ui_messages_ai_count": tu_tot.get("ui_messages_ai_count"),
        "ui_with_raw_usage_metadata": tu_tot.get("ui_messages_with_raw_usage_metadata"),
        "ui_with_inferred_usage": tu_tot.get("ui_messages_with_inferred"),
        "ui_sum_inferred_total_tokens": tu_tot.get("sum_inferred_ui_total"),
    }

    tps = payload.get("task_progress_snapshot") if isinstance(payload.get("task_progress_snapshot"), dict) else {}
    task_truth_summary: dict[str, Any] | None = None
    if tps.get("ok"):
        mt = tps.get("main_task") if isinstance(tps.get("main_task"), dict) else {}
        subs = [s for s in (tps.get("subtasks") or []) if isinstance(s, dict)]
        task_truth_summary = {
            "main_status": mt.get("status"),
            "subtask_count": len(subs),
            "subtask_status_counts": tps.get("subtask_status_counts"),
            "subtasks_brief": [{"subtaskId": s.get("subtaskId"), "name": s.get("name"), "status": s.get("status")} for s in subs[:24]],
        }
    elif tps:
        task_truth_summary = {
            "ok": False,
            "error": tps.get("error"),
            "error_type": tps.get("error_type"),
        }

    im_err = payload.get("im_channel_errors") or []
    im_err_list = [r for r in im_err if isinstance(r, dict)]
    im_err_tail: list[dict[str, Any]] = []
    for row in im_err_list[-12:]:
        em = str(row.get("error_message") or "")
        im_err_tail.append(
            {
                "exception_type": row.get("exception_type"),
                "channel": row.get("channel"),
                "error_message_trunc": (em[:380] + "…") if len(em) > 380 else em,
            }
        )

    return {
        "counts": {
            "collab_cycle": len(collab),
            "task_lifecycle_trace": len(lifecycle),
            "im_channel_errors": len(im_err_list),
            "model_request_payloads": len(payload.get("model_request_payloads") or []),
            "model_vendor_roundtrip": len(payload.get("model_vendor_roundtrip") or []),
            "lead_agent_round": len(rounds),
            "tool_call_io": len(tools),
            "langgraph_runs": int(ge.get("langgraph_run_rows") or 0),
            "automation_tool_calls": sum(1 for r in tools if isinstance(r, dict) and r.get("tool_name") == "automation"),
            "conversation_turns": int(ct_counts.get("turns") or 0),
            "conversation_model_cycles": int(ct_counts.get("model_cycles") or 0),
            "claude_sessions": len(csd_sessions),
            "claude_sessions_with_file": sum(1 for s in csd_sessions if s.get("found")),
        },
        "conversation_turns_note_zh": ct.get("note_zh") if isinstance(ct.get("note_zh"), str) else None,
        "graph_execution": ge,
        "wall_clock_breakdown": payload.get("wall_clock_breakdown") if isinstance(payload.get("wall_clock_breakdown"), dict) else _build_wall_clock_breakdown(payload),
        "end_to_end_timing": payload.get("end_to_end_timing") if isinstance(payload.get("end_to_end_timing"), dict) else None,
        "pre_model_breakdown_ms": ((payload.get("wall_clock_breakdown") or {}).get("pre_model_breakdown_ms") if isinstance(payload.get("wall_clock_breakdown"), dict) else None),
        "token_usage": token_usage_summary,
        "task_progress_snapshot": task_truth_summary,
        "collab_tail": collab_tail,
        "plan_guard_events": plan_guard[-30:],
        "task_lifecycle_tail": lifecycle_tail,
        "im_channel_errors_tail": im_err_tail,
        "tools_tail": tools_tail,
        "automation_tool_tail": automation_tail,
    }


def _row_in_turn_window(row: dict[str, Any], *, start_ms: float | None, end_ms: float | None) -> bool:
    ts = _epoch_ms_from_any(row.get("timestamp") or row.get("ts") or row.get("ts_ms"))
    if ts is None:
        return start_ms is None
    if start_ms is not None and ts + 1e-6 < float(start_ms):
        return False
    if end_ms is not None and ts >= float(end_ms) - 1e-6:
        return False
    return True


def _build_thread_analysis(payload: dict[str, Any], *, turn: int | None = None, limit: int = 10) -> dict[str, Any]:
    """Ranked slow/error/token rows for one thread (and optional user turn index, 1-based)."""
    lim = min(50, max(1, int(limit or 10)))
    tid = str(payload.get("thread_id") or "")
    ct = payload.get("conversation_turns") if isinstance(payload.get("conversation_turns"), dict) else {}
    turns = [t for t in (ct.get("turns") or []) if isinstance(t, dict)]
    turn_idx: int | None = None
    start_ms: float | None = None
    end_ms: float | None = None
    if turn is not None and turns:
        try:
            turn_idx = max(0, min(len(turns) - 1, int(turn) - 1))
        except (TypeError, ValueError):
            turn_idx = None
        if turn_idx is not None:
            trow = turns[turn_idx]
            start_ms = _epoch_ms_from_any(trow.get("start_ms"))
            end_ms = _epoch_ms_from_any(trow.get("end_ms"))

    tools_all = [r for r in (payload.get("tool_call_io") or []) if isinstance(r, dict)]
    tools = [r for r in tools_all if _row_in_turn_window(r, start_ms=start_ms, end_ms=end_ms)]

    def _tool_rank(row: dict[str, Any]) -> dict[str, Any]:
        out = str(row.get("output") or "")
        return {
            "tool_name": row.get("tool_name"),
            "tool_call_id": row.get("tool_call_id"),
            "timestamp": row.get("timestamp"),
            "status": row.get("status"),
            "duration_ms": row.get("duration_ms"),
            "output_preview": (out[:480] + "…") if len(out) > 480 else (out or None),
        }

    slow_tools = sorted(
        tools,
        key=lambda r: float(r.get("duration_ms") or 0),
        reverse=True,
    )[:lim]
    tool_errors = [r for r in tools if str(r.get("status") or "").lower() == "error"]
    tool_errors.sort(key=lambda r: str(r.get("timestamp") or ""), reverse=True)

    collab_all = [r for r in (payload.get("collab_cycle") or []) if isinstance(r, dict)]
    collab = [r for r in collab_all if _row_in_turn_window(r, start_ms=start_ms, end_ms=end_ms)]
    slow_model_responses: list[dict[str, Any]] = []
    for row in collab:
        if str(row.get("event") or "") != "model_response":
            continue
        try:
            ms = float(row.get("elapsed_ms") or 0)
        except (TypeError, ValueError):
            continue
        slow_model_responses.append(
            {
                "event": "model_response",
                "elapsed_ms": ms,
                "ts": row.get("ts") or row.get("timestamp"),
                "collab_phase": row.get("collab_phase"),
                "ai_preview": (str(row.get("ai_preview") or ""))[:240] or None,
            }
        )
    slow_model_responses.sort(key=lambda r: float(r.get("elapsed_ms") or 0), reverse=True)

    vendor_all = [r for r in (payload.get("model_vendor_roundtrip") or []) if isinstance(r, dict)]
    vendor = [r for r in vendor_all if _row_in_turn_window(r, start_ms=start_ms, end_ms=end_ms)]
    slow_vendor: list[dict[str, Any]] = []
    for row in vendor:
        try:
            lat = float(row.get("latency_ms") or row.get("vendor_latency_ms") or 0)
        except (TypeError, ValueError):
            lat = 0.0
        if lat <= 0:
            continue
        slow_vendor.append(
            {
                "provider": row.get("provider"),
                "model": row.get("model"),
                "invocation_kind": row.get("invocation_kind"),
                "latency_ms": lat,
                "ts_ms": row.get("ts_ms"),
                "trace_id": row.get("trace_id"),
                "error": str(row.get("error") or "")[:280] or None,
            }
        )
    slow_vendor.sort(key=lambda r: float(r.get("latency_ms") or 0), reverse=True)

    turn_timing: dict[str, Any] | None = None
    if turn_idx is not None and turn_idx < len(turns):
        trow = turns[turn_idx]
        timing = trow.get("timing") if isinstance(trow.get("timing"), dict) else {}
        turn_timing = {
            "turn_index": turn_idx + 1,
            "label": trow.get("label"),
            "start_ms": trow.get("start_ms"),
            "end_ms": trow.get("end_ms"),
            "timing": timing,
        }

    return {
        "schema": "evoflow.agent_trace.analysis.v1",
        "thread_id": tid,
        "turn_filter": turn_idx + 1 if turn_idx is not None else None,
        "turn_count": len(turns),
        "limit": lim,
        "turn_timing": turn_timing,
        "slowest_tool_calls": [_tool_rank(r) for r in slow_tools],
        "tool_errors": [_tool_rank(r) for r in tool_errors[:lim]],
        "slowest_collab_model_responses": slow_model_responses[:lim],
        "slowest_vendor_http_calls": slow_vendor[:lim],
        "summary": _summarize_agent_trace(payload),
        "notes_zh": [
            "工具耗时来自 tool_call_io.duration_ms；模型整轮耗时来自 collab_cycle.model_response.elapsed_ms。",
            "厂商 HTTP 耗时来自 model_vendor_roundtrip.latency_ms（与中间件 model_response 可能略有差异）。",
            "Token 汇总见 summary.token_usage；按轮次 UI 汇总需用 export 全量 JSON 或页面「Token」标签。",
            "全局跨会话排行请用 GET /api/observability/insights。",
        ],
    }


def _max_mtime_in_tree(dir_path: Path) -> float | None:
    """Latest file mtime under ``dir_path`` (recursive)."""
    if not dir_path.is_dir():
        return None
    mt = 0.0
    try:
        for p in dir_path.rglob("*"):
            if p.is_file():
                try:
                    mt = max(mt, p.stat().st_mtime)
                except OSError:
                    continue
    except OSError:
        return None
    return mt if mt > 0 else None


def collect_recent_threads(*, limit: int = 50) -> list[dict[str, Any]]:
    """Recent threads from SQLite when observability is on, else scan ``logs/debug/threads/``."""
    if observability_reads_primary():
        from evoflow.observability import agent_trace_load as atl

        rows = atl.list_recent_threads(limit=limit)
        if rows:
            return rows

    merged: dict[str, float] = {}
    for root in _debug_scan_roots():
        td = root / "logs" / "debug" / "threads"
        if not td.is_dir():
            continue
        try:
            for child in td.iterdir():
                if not child.is_dir():
                    continue
                tid = child.name
                if not re.fullmatch(r"[a-zA-Z0-9._-]+", tid):
                    continue
                m = _max_mtime_in_tree(child)
                if m is None:
                    continue
                merged[tid] = max(merged.get(tid, 0.0), m)
        except OSError:
            continue
    items = sorted(merged.items(), key=lambda x: -x[1])[: max(1, limit)]
    out: list[dict[str, Any]] = []
    for tid, mtime in items:
        out.append({"thread_id": tid, "updated_at_ms": int(mtime * 1000)})
    return out


@router.get("/data", include_in_schema=False)
async def agent_trace_data(thread_id: str = Query(..., min_length=8, max_length=128)) -> JSONResponse:
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled (EVOFLOW_DEBUG_TRACE_UI=0).")

    payload = await asyncio.to_thread(_gather_agent_trace_payload, thread_id)
    return JSONResponse(payload)


@router.get("/analysis", include_in_schema=False)
async def agent_trace_analysis(
    thread_id: str = Query(..., min_length=8, max_length=128),
    turn: int | None = Query(
        None,
        ge=1,
        description="Optional 1-based user turn index (matches agent-trace UI ?turn=)",
    ),
    limit: int = Query(10, ge=1, le=50),
) -> JSONResponse:
    """Lightweight rankings for one thread (slow tools, errors, model/vendor latency)."""
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled (EVOFLOW_DEBUG_TRACE_UI=0).")

    payload = await asyncio.to_thread(_gather_agent_trace_payload, thread_id)
    body = _build_thread_analysis(payload, turn=turn, limit=limit)
    return JSONResponse(body)


@router.get("/export", include_in_schema=False)
async def agent_trace_export(
    thread_id: str = Query(..., min_length=8, max_length=128),
    omit_model_payloads: bool = Query(
        False,
        description="If true, omits model_request_payloads body (large) but keeps counts in summary.",
    ),
) -> JSONResponse:
    """Single GET bundle for sharing with collaborators / AI assistants.

    Same log merge as ``/data``, plus ``summary`` and paste hints. Remote assistants often
    cannot reach ``127.0.0.1`` on your machine — use a tunnel or paste this JSON.
    """
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled (EVOFLOW_DEBUG_TRACE_UI=0).")

    payload = await asyncio.to_thread(_gather_agent_trace_payload, thread_id)
    summary = _summarize_agent_trace(payload)
    if omit_model_payloads:
        n = len(payload.get("model_request_payloads") or [])
        payload = {
            **payload,
            "model_request_payloads": [],
            "model_request_payloads_omitted": True,
            "model_request_payloads_omitted_count": n,
        }
    rel_export = f"/api/debug/agent-trace/export?thread_id={payload['thread_id']}"
    rel_omit = rel_export + "&omit_model_payloads=1"
    bundle: dict[str, Any] = {
        "schema": "evoflow.agent_trace.export.v1",
        "exported_at": datetime.now(UTC).isoformat(),
        "summary": summary,
        "endpoints": {
            "data": f"/api/debug/agent-trace/data?thread_id={payload['thread_id']}",
            "export": rel_export,
            "export_without_model_payloads": rel_omit,
        },
        "paste_hint_zh": (
            "若助手无法访问你电脑上的 127.0.0.1：请在本机浏览器打开 export 链接后全选复制 JSON，"
            "或配置内网穿透/临时公网 URL 再把该 URL 发给助手。摘要字段 summary 便于快速扫 plan_guard / 工具尾部 / wall_clock_breakdown（墙钟分段）。"
            "嵌套结构：顶层 conversation_turns（用户轮次 → model_call_seq → 请求/工具索引与摘要）。"
            "Token 用量调试：见顶层的 token_usage_debug（LangGraph state 里 messages / ui_messages 的 AI 条对照）"
            "与 summary.token_usage 计数摘要。"
        ),
        **payload,
    }
    return JSONResponse(bundle)


@router.get("/recent-threads", include_in_schema=False)
async def agent_trace_recent_threads(limit: int = Query(50, ge=1, le=200)) -> JSONResponse:
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled (EVOFLOW_DEBUG_TRACE_UI=0).")
    return JSONResponse({"threads": collect_recent_threads(limit=limit)})


# ── Turn message trace (per-turn forensic replay) ──

@router.get("/turns", include_in_schema=False)
async def turn_trace_list(limit: int = Query(80, ge=1, le=200)) -> JSONResponse:
    """List recent turn traces (summary, no full messages)."""
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled.")
    try:
        from evoflow.debug.turn_message_trace import get_turn_tracer

        tracer = get_turn_tracer()
        return JSONResponse({"turns": tracer.list_turns(limit=limit)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/turns/{turn_id}", include_in_schema=False)
async def turn_trace_detail(turn_id: str) -> JSONResponse:
    """Get full turn trace with messages, rounds, and role_ribbon."""
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled.")
    try:
        from evoflow.debug.turn_message_trace import get_turn_tracer

        tracer = get_turn_tracer()
        trace = tracer.get_turn(turn_id)
        if trace is None:
            raise HTTPException(status_code=404, detail=f"Turn {turn_id} not found")
        return JSONResponse(trace)
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.delete("/turns", include_in_schema=False)
async def turn_trace_clear() -> JSONResponse:
    """Clear all turn traces."""
    if not _debug_ui_enabled():
        raise HTTPException(status_code=404, detail="Agent trace debug API is disabled.")
    try:
        from evoflow.debug.turn_message_trace import get_turn_tracer

        tracer = get_turn_tracer()
        tracer.clear()
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
