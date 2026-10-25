"""Per-path in-process locks + atomic text write helpers for the asset vault.

The vault is Markdown on disk with several concurrent in-process writers
(panel HTTP API, dialogue ``assets`` tool, Phase2 consolidation, legacy
mirror). A single full-file ``tmp → os.replace`` is atomic by itself, but
read-modify-write sequences (journal append, frontmatter merge) and the old
shared ``{name}.tmp`` path raced: last writer silently dropped the other's
content. These helpers give every writer:

- ``lock_for(path)`` — one ``threading.Lock`` per resolved file path, so
  read-modify-write sequences can hold the lock across the whole sequence.
- ``atomic_write_text(path, text)`` — unique tmp name (concurrent writers no
  longer stomp the same tmp), ``fsync`` before replace.

Locks are process-local: the gateway hosts both the panel API and the agent
runtime in one process, which covers the real writer set. Cross-process
safety still relies on ``os.replace`` being atomic per write.
"""

from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path

_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def lock_for(path: Path) -> threading.Lock:
    """One lock per resolved file path (Windows: case-insensitive key)."""
    key = str(Path(path).resolve()).lower()
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[key] = lock
        return lock


def atomic_write_text(path: Path, text: str, *, fsync: bool = True) -> None:
    """Write via a unique tmp file + ``os.replace`` (durable, race-free tmp)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            if fsync:
                f.flush()
                os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def read_modify_write(path: Path, transform):
    """Run ``transform(text) -> text`` under the path lock, write atomically.

    Returns the transformed text (empty string when the file does not exist).
    """
    path = Path(path)
    with lock_for(path):
        text = ""
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                text = ""
        updated = transform(text)
        if updated != text:
            atomic_write_text(path, updated)
        return updated
