"""
Turn message trace — captures per-turn complete message snapshots.

Records what the LLM *actually saw* at each model call: the full messages[]
slice, input offset, model output, tool calls, and reasoning content.

Persisted as JSONL with ring buffer (last N turns), surfaced via debug API.

Design adapted from the legacy voice module turn-trace.js.

When to use:
    Every turn is auto-captured (no config needed).
    Open Agent Trace → Turn Messages panel to replay any turn frame-by-frame.
    Look for: role confusion, context pollution, unexpected message ordering.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

MAX_TURNS = 80
FILE_MAX_BYTES = 12 * 1024 * 1024


@dataclass
class TurnTrace:
    """One complete turn: begin → rounds → end → messages snapshot."""

    id: str
    seq: int
    thread_id: str
    started_at: str
    finished_at: str = ""
    meta: dict[str, Any] = field(default_factory=dict)
    rounds: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    delivered: bool = False
    aborted: bool = False
    error: str = ""


class TurnMessageTracer:
    """Ring-buffered turn trace store, persisted as JSONL."""

    def __init__(self, data_dir: Path, max_turns: int = MAX_TURNS):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.max_turns = max_turns
        self.traces: list[TurnTrace] = []
        self._next_seq = 1
        self._file = self.data_dir / "turn-traces.jsonl"
        self._ensure_loaded()

    # ── Lifecycle ──

    def begin_turn(
        self,
        thread_id: str,
        *,
        user_message: str = "",
        channel: str = "",
        meta: dict[str, Any] | None = None,
    ) -> TurnTrace:
        """Start a new turn. Returns the trace handle."""
        tid = _turn_id()
        trace = TurnTrace(
            id=tid,
            seq=self._next_seq,
            thread_id=thread_id,
            started_at=_now_iso(),
            meta={"user_message": user_message, "channel": channel, **(meta or {})},
        )
        self._next_seq += 1
        self.traces.append(trace)
        self._trim()
        return trace

    def record_round(
        self,
        trace: TurnTrace,
        *,
        round_num: int,
        input_offset: int,  # messages length before this model call
        content: str = "",
        reasoning_content: str = "",
        tool_calls: list[dict[str, Any]] | None = None,
        aborted: bool = False,
    ):
        """Record one model call round within a turn."""
        trace.rounds.append({
            "round": round_num,
            "input_offset": input_offset,
            "content": _cap_text(content),
            "reasoning_content": _cap_text(reasoning_content),
            "tool_calls": tool_calls or [],
            "aborted": aborted,
        })

    def end_turn(
        self,
        trace: TurnTrace,
        *,
        messages: list[dict[str, Any]],
        delivered: bool = True,
        aborted: bool = False,
        error: str = "",
    ):
        """Finish the turn: snapshot messages and persist."""
        trace.finished_at = _now_iso()
        trace.delivered = delivered
        trace.aborted = aborted
        trace.error = error
        trace.messages = [_snapshot_message(m) for m in messages]
        self._persist(trace)

    # ── Query ──

    def list_turns(self, limit: int = 80) -> list[dict[str, Any]]:
        """Return summary list (no full messages)."""
        result = []
        for t in reversed(self.traces[-limit:]):
            result.append({
                "id": t.id,
                "seq": t.seq,
                "thread_id": t.thread_id,
                "started_at": t.started_at,
                "finished_at": t.finished_at,
                "meta": t.meta,
                "round_count": len(t.rounds),
                "message_count": len(t.messages),
                "delivered": t.delivered,
                "aborted": t.aborted,
                "error": t.error,
                "role_ribbon": _role_ribbon(t.messages),
                "preview": _cap_text(t.meta.get("user_message", ""), 120),
            })
        return result

    def get_turn(self, turn_id: str) -> dict[str, Any] | None:
        """Return full trace with messages."""
        for t in self.traces:
            if t.id == turn_id:
                return {
                    "id": t.id,
                    "seq": t.seq,
                    "thread_id": t.thread_id,
                    "started_at": t.started_at,
                    "finished_at": t.finished_at,
                    "meta": t.meta,
                    "rounds": t.rounds,
                    "messages": t.messages,
                    "delivered": t.delivered,
                    "aborted": t.aborted,
                    "error": t.error,
                }
        return None

    def clear(self):
        """Clear all traces (memory + disk)."""
        self.traces.clear()
        try:
            self._file.unlink(missing_ok=True)
        except Exception:
            pass

    # ── Persistence ──

    def _ensure_loaded(self):
        if not self._file.exists():
            return
        try:
            lines = self._file.read_text(encoding="utf-8").strip().split("\n")
            tail = lines[-self.max_turns:]
            for line in tail:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    trace = TurnTrace(**data)
                    self.traces.append(trace)
                    if trace.seq >= self._next_seq:
                        self._next_seq = trace.seq + 1
                except Exception:
                    pass
        except Exception as e:
            logger.warning("[turn-trace] load failed: %s", e)

    def _persist(self, trace: TurnTrace):
        """Append to JSONL, rewrite if file too large."""
        try:
            line = json.dumps(_trace_to_dict(trace), ensure_ascii=False) + "\n"
            with open(self._file, "a", encoding="utf-8") as f:
                f.write(line)

            if self._file.stat().st_size > FILE_MAX_BYTES:
                self._compact()
        except Exception as e:
            logger.debug("[turn-trace] persist failed: %s", e)

    def _compact(self):
        """Rewrite file with only last max_turns traces."""
        recent = [json.dumps(_trace_to_dict(t), ensure_ascii=False) for t in self.traces[-self.max_turns:]]
        self._file.write_text("\n".join(recent) + "\n", encoding="utf-8")

    def _trim(self):
        if len(self.traces) > self.max_turns:
            self.traces = self.traces[-self.max_turns:]


# ── Singleton ──

_tracer: TurnMessageTracer | None = None


def get_turn_tracer(data_dir: Path | None = None) -> TurnMessageTracer:
    global _tracer
    if _tracer is None:
        from evoflow.config.paths import get_paths

        d = data_dir or get_paths().data_dir
        _tracer = TurnMessageTracer(d)
    return _tracer


# ── Helpers ──

def _now_iso() -> str:
    from datetime import datetime, timezone, timedelta

    return datetime.now(timezone(timedelta(hours=8))).isoformat()


def _turn_id() -> str:
    return f"t{int(time.time() * 1000)}_{os.urandom(3).hex()}"


def _cap_text(text: str | None, max_len: int = 8000) -> str:
    s = str(text or "")[:max_len]
    truncated = len(str(text or "")) - max_len
    return s + (f"...[+{truncated}B]" if truncated > 0 else "")


def _snapshot_message(m: Any) -> dict[str, Any]:
    """Deep-copy one message, keeping role/content/name/tool_call_id."""
    out = {"role": str(getattr(m, "role", getattr(m, "type", "unknown")))}

    if hasattr(m, "name") and m.name:
        out["name"] = str(m.name)
    if hasattr(m, "tool_call_id") and m.tool_call_id:
        out["tool_call_id"] = str(m.tool_call_id)

    content = getattr(m, "content", "")
    if isinstance(content, list):
        out["content"] = json.dumps(content, ensure_ascii=False)
    else:
        out["content"] = _cap_text(str(content))

    # reasoning_content (DeepSeek / Claude thinking)
    rc = getattr(m, "reasoning_content", None) or (
        getattr(m, "additional_kwargs", {}) or {}
    ).get("reasoning_content")
    if rc:
        out["reasoning_content"] = _cap_text(str(rc))

    # tool_calls
    tcs = getattr(m, "tool_calls", None)
    if tcs:
        out["tool_calls"] = [
            {"name": tc.get("name", ""), "args": tc.get("args", {})} for tc in tcs
        ]

    return out


def _role_ribbon(messages: list[dict[str, Any]]) -> str:
    """Compact role visualization: S=system, U=user, A=assistant, T=tool."""
    chars = {"system": "S", "user": "U", "human": "U",
             "assistant": "A", "ai": "A", "tool": "T"}
    return "".join(chars.get(m.get("role", "?"), "?") for m in messages)


def _trace_to_dict(t: TurnTrace) -> dict[str, Any]:
    return {
        "id": t.id,
        "seq": t.seq,
        "thread_id": t.thread_id,
        "started_at": t.started_at,
        "finished_at": t.finished_at,
        "meta": t.meta,
        "rounds": t.rounds,
        "messages": t.messages,
        "delivered": t.delivered,
        "aborted": t.aborted,
        "error": t.error,
    }
