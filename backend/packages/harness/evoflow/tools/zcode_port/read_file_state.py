"""Track files the Read tool has shown the model (ZCode readFileState).

Two consumers:
- ``stale_read_hint`` — paths whose mtime moved since Read (edit-before-read guard).
- ``unchanged_since_last_read`` — ZCode-style ``file_unchanged`` short-circuit:
  a re-read of an unchanged full-text file returns a one-line marker instead of
  resending the content (token saving). Partial views (offset/limit/symbol)
  never qualify, matching ZCode's ``isPartialView`` rule.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

_LOCK = threading.Lock()
_MAX_HINT_PATHS = 5


@dataclass(frozen=True)
class _ReadEntry:
    mtime: float
    size: int
    full_read: bool


# resolved path -> last model-visible read
_SEEN: dict[str, _ReadEntry] = {}


def reset_read_state() -> None:
    """清空已读状态（测试隔离 / 诊断用；进程内全局注册表）。"""
    with _LOCK:
        _SEEN.clear()


def note_read(path: str, *, full_read: bool = True) -> None:
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
        _SEEN[resolved] = _ReadEntry(mtime=stat.st_mtime, size=stat.st_size, full_read=full_read)


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
    return abs(stat.st_mtime - entry.mtime) <= 1e-6 and stat.st_size == entry.size


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
