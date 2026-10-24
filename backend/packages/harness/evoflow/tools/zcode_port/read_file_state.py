"""Track files the Read tool has shown the model (ZCode readFileState).

Consumers:
- ``stale_read_hint`` — paths whose mtime moved since Read (edit-before-read guard).
- ``unchanged_since_last_read`` — ZCode-style ``file_unchanged`` short-circuit:
  a re-read of an unchanged full-text file returns a one-line marker instead of
  resending the content (token saving). Partial views (offset/limit/symbol)
  never qualify, matching ZCode's ``isPartialView`` rule.
- ``edit_guard_failure`` — ZCode Edit guard (EDIT_NOT_READ / EDIT_STALE):
  str_replace/write must have a full Read on record, and the file must not
  have changed on disk since that Read; ``note_write`` refreshes the state
  after a successful edit so consecutive edits need no re-Read.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from pathlib import Path

_LOCK = threading.Lock()
_MAX_HINT_PATHS = 5

# zcode edit.ts EDIT_NOT_READ_MESSAGE / EDIT_STALE_MESSAGE (verbatim alignment).
EDIT_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it."
EDIT_STALE_MESSAGE = (
    "File has been modified since read, either by the user or by a linter. "
    "Read it again before attempting to write it."
)


@dataclass(frozen=True)
class _ReadEntry:
    mtime: float
    size: int
    full_read: bool
    content_hash: str | None = None


# resolved path -> last model-visible read
_SEEN: dict[str, _ReadEntry] = {}


def reset_read_state() -> None:
    """清空已读状态（测试隔离 / 诊断用；进程内全局注册表）。"""
    with _LOCK:
        _SEEN.clear()


def _content_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()


def note_read(path: str, *, full_read: bool = True, content_hash: str | None = None) -> None:
    raw = str(path or "").strip()
    if not raw:
        return
    file_path = Path(raw)
    try:
        resolved = str(file_path.resolve())
        stat = file_path.stat()
    except OSError:
        return
    with _LOCK:
        _SEEN[resolved] = _ReadEntry(
            mtime=stat.st_mtime,
            size=stat.st_size,
            full_read=full_read,
            content_hash=content_hash,
        )


def note_write(path: str, *, content: str | None = None) -> None:
    """Refresh state after a successful edit/write (zcode recordEditedReadState).

    Records the new mtime as a full view so consecutive edits need no re-Read.
    """
    raw = str(path or "").strip()
    if not raw:
        return
    file_path = Path(raw)
    try:
        resolved = str(file_path.resolve())
        stat = file_path.stat()
    except OSError:
        return
    with _LOCK:
        _SEEN[resolved] = _ReadEntry(
            mtime=stat.st_mtime,
            size=stat.st_size,
            full_read=True,
            content_hash=_content_hash(content) if content is not None else None,
        )


def _stat_same(entry: _ReadEntry, stat: object) -> bool:
    return abs(stat.st_mtime - entry.mtime) <= 1e-6 and stat.st_size == entry.size


def unchanged_since_last_read(path: str | Path) -> bool:
    """True when *path* was fully read before and mtime + size are unchanged."""
    try:
        resolved = str(Path(path).resolve())
        stat = Path(path).stat()
    except OSError:
        return False
    with _LOCK:
        entry = _SEEN.get(resolved)
    if entry is None or not entry.full_read:
        return False
    return _stat_same(entry, stat)


def edit_guard_failure(path: str | Path) -> str | None:
    """ZCode ``getEditableReadStateFailure`` alignment for str_replace/write.

    Returns an error message when the edit must be refused, or ``None`` when
    it may proceed:

    - no full Read on record → EDIT_NOT_READ (partial views never qualify);
    - mtime/size moved since that Read → EDIT_STALE, except when the content
      hash still matches (mtime-only touches don't force a re-Read).
    """
    file_path = Path(path)
    try:
        resolved = str(file_path.resolve())
    except OSError:
        return None
    with _LOCK:
        entry = _SEEN.get(resolved)
    if entry is None or not entry.full_read:
        return f"Error: {EDIT_NOT_READ_MESSAGE}"
    try:
        stat = file_path.stat()
    except OSError:
        return None  # vanished → let the write path produce its own error
    if _stat_same(entry, stat):
        return None
    if entry.content_hash is not None:
        try:
            current = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            current = None
        if current is not None and _content_hash(current) == entry.content_hash:
            return None
    return f"Error: {EDIT_STALE_MESSAGE}"


def stale_read_hint() -> str:
    """Paths whose mtime moved since Read. Empty when nothing changed."""
    with _LOCK:
        snapshot = list(_SEEN.items())
    changed: list[str] = []
    for path, entry in snapshot:
        try:
            current = Path(path).stat().st_mtime
        except OSError:
            continue
        if abs(current - entry.mtime) > 1e-6:
            changed.append(path)
    if not changed:
        return ""
    shown = changed[:_MAX_HINT_PATHS]
    extra = len(changed) - len(shown)
    more = f"\n(+{extra} more)" if extra else ""
    body = "\n".join(shown)
    return (
        "<system-reminder>Files you previously read changed on disk. "
        "Re-read them with the Read tool before editing:\n"
        f"{body}{more}</system-reminder>"
    )
