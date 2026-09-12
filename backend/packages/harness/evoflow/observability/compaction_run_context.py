"""Per model-call compaction metadata for observability (ContextVar, main + compress)."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

_compaction_snapshot: ContextVar[dict[str, Any] | None] = ContextVar(
    "evoflow_compaction_snapshot",
    default=None,
)
_compress_pass_label: ContextVar[str | None] = ContextVar(
    "evoflow_compress_pass_label",
    default=None,
)


@dataclass(frozen=True)
class CompactionRunSnapshot:
    before_gate_tokens: int
    after_gate_tokens: int
    before_message_count: int
    after_message_count: int
    passes: tuple[str, ...]
    note: str
    compacted: bool

    def to_usage_fields(self) -> dict[str, Any]:
        saved = max(0, self.before_gate_tokens - self.after_gate_tokens)
        out: dict[str, Any] = {
            "compaction_before_gate_tokens": self.before_gate_tokens,
            "compaction_after_gate_tokens": self.after_gate_tokens,
            "compaction_saved_gate_tokens": saved,
            "compaction_before_message_count": self.before_message_count,
            "compaction_after_message_count": self.after_message_count,
            "compaction_passes": list(self.passes),
            "compaction_note": self.note or "",
            "compaction_applied": bool(self.compacted and saved > 0),
        }
        if saved > 0 and self.before_gate_tokens > 0:
            out["compaction_saved_pct"] = round(saved / self.before_gate_tokens * 100.0, 1)
        return out


def set_compaction_snapshot_for_main_call(
    *,
    before_gate_tokens: int,
    after_gate_tokens: int,
    before_message_count: int,
    after_message_count: int,
    passes: list[str] | None = None,
    note: str = "",
    compacted: bool = False,
) -> None:
    snap = CompactionRunSnapshot(
        before_gate_tokens=max(0, int(before_gate_tokens)),
        after_gate_tokens=max(0, int(after_gate_tokens)),
        before_message_count=max(0, int(before_message_count)),
        after_message_count=max(0, int(after_message_count)),
        passes=tuple(passes or ()),
        note=str(note or "").strip(),
        compacted=bool(compacted),
    )
    _compaction_snapshot.set(snap.to_usage_fields())


def clear_compaction_snapshot() -> None:
    _compaction_snapshot.set(None)


def take_compaction_snapshot() -> dict[str, Any] | None:
    snap = _compaction_snapshot.get()
    _compaction_snapshot.set(None)
    return snap


def set_compress_pass_label(label: str) -> None:
    text = str(label or "").strip()
    _compress_pass_label.set(text or None)


def take_compress_pass_label() -> str | None:
    label = _compress_pass_label.get()
    _compress_pass_label.set(None)
    return label


def merge_compaction_into_usage(
    usage_blob: dict[str, Any] | None,
    *,
    invocation_kind: str | None,
) -> dict[str, Any] | None:
    """Attach compaction snapshot / compress pass label to usage_json for SQLite observability."""
    ik = str(invocation_kind or "main").strip().lower() or "main"
    base: dict[str, Any] = dict(usage_blob) if isinstance(usage_blob, dict) else {}

    if ik == "compress":
        pass_label = take_compress_pass_label()
        if pass_label:
            base["compaction_pass"] = pass_label
        return base or None

    if ik not in ("main", ""):
        take_compaction_snapshot()
        take_compress_pass_label()
        return base or None

    snap = take_compaction_snapshot()
    if snap:
        base["compaction"] = snap
    take_compress_pass_label()
    return base or None
