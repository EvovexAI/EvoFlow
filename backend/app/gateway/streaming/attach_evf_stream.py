"""Convert LangGraph state polls into ``evf`` SSE frames for attach/resume streams."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.gateway.sse_ui_normalize import (
    _collect_assistant_texts_after_human,
    _encode_evf,
    _find_last_real_human_idx,
    _merge_turn_assistant_texts,
)


def _values_messages_from_state(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    values = data.get("values") if "values" in data else data
    if not isinstance(values, dict):
        return []
    messages = values.get("messages")
    return messages if isinstance(messages, list) else []


def _current_turn_assistant_text(messages: list[dict[str, Any]], *, prior_prefix: str = "") -> str:
    hidx = _find_last_real_human_idx(messages)
    if hidx < 0:
        return ""
    return _merge_turn_assistant_texts(
        _collect_assistant_texts_after_human(messages, hidx, prior_prefix)
    )


@dataclass
class AttachEvfDiffEmitter:
    """Emit incremental ``evf`` deltas when attach poll sees new assistant text."""

    prior_assistant_prefix: str = ""
    last_emitted_text: str = ""
    baseline_text: str = ""
    baseline_locked: bool = False
    evf_run_end_seen: bool = False

    def frames_for_state(self, state_data: Any) -> list[str]:
        if self.evf_run_end_seen:
            return []
        messages = _values_messages_from_state(state_data)
        if not messages:
            return []
        full_text = str(
            _current_turn_assistant_text(messages, prior_prefix=self.prior_assistant_prefix) or ""
        )
        if not full_text:
            return []

        out: list[str] = []
        if not self.baseline_locked:
            self.baseline_locked = True
            self.baseline_text = full_text
            self.last_emitted_text = full_text
            out.append(_encode_evf({"type": "thread_state", "anchored": True}).decode("utf-8"))
            return out

        delta = full_text
        if self.baseline_text and full_text.startswith(self.baseline_text):
            delta = full_text[len(self.baseline_text) :]
        elif self.last_emitted_text and full_text.startswith(self.last_emitted_text):
            delta = full_text[len(self.last_emitted_text) :]
        elif full_text == self.last_emitted_text:
            return []

        if delta:
            self.last_emitted_text = full_text
            out.append(_encode_evf({"type": "delta", "text": delta, "delta_kind": "append"}).decode("utf-8"))
        return out

    def finish_frames(self, *, final_text: str = "") -> list[str]:
        if self.evf_run_end_seen:
            return []
        self.evf_run_end_seen = True
        text = str(final_text or self.last_emitted_text or "").strip()
        out = [_encode_evf({"type": "run_end", "text": text}).decode("utf-8")]
        return out


def format_evf_sse_frame(payload: dict[str, Any]) -> str:
    return _encode_evf(payload).decode("utf-8")
