"""Durable inbound media under the user data home (EVOFLOW_HOME).

Layout::

    {EVOFLOW_HOME}/channel-messages/
      └── {channel}/          # feishu | wecom | weixin | …
            └── {YYYY}/
                  └── {MM}/
                        └── {filename}

Dev (``EVOFLOW_HOME=~/.evoflow-dev``) and prod share the same relative layout;
only the home root changes.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

CHANNEL_MESSAGES_DIRNAME = "channel-messages"
_SAFE_CHANNEL_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_SAFE_FILENAME_RE = re.compile(r"[^\w.\-()+@\u4e00-\u9fff]+", re.UNICODE)


def channel_messages_root() -> Path:
    """``{EVOFLOW_HOME}/channel-messages`` (creates parents as needed)."""
    try:
        from evoflow.config.paths import get_paths

        root = get_paths().base_dir / CHANNEL_MESSAGES_DIRNAME
    except Exception:
        # Last-resort fallback so downloads never crash the inbound path.
        import os

        home = (os.getenv("EVOFLOW_HOME") or "").strip()
        base = Path(home) if home else Path.home() / ".evoflow"
        root = base / CHANNEL_MESSAGES_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def is_under_channel_messages(path: str | Path) -> bool:
    """True when *path* lives under the durable channel-messages tree."""
    try:
        p = Path(path).resolve()
        root = channel_messages_root()
        p.relative_to(root)
        return True
    except Exception:
        return False


def _safe_channel(channel: str) -> str:
    raw = str(channel or "").strip().lower() or "im"
    cleaned = _SAFE_CHANNEL_RE.sub("-", raw).strip("-._") or "im"
    return cleaned[:64]


def _safe_filename(filename: str) -> str:
    name = Path(str(filename or "").strip() or "attachment").name
    stem = Path(name).stem or "attachment"
    suffix = Path(name).suffix[:32]
    stem = _SAFE_FILENAME_RE.sub("_", stem).strip("._") or "attachment"
    stem = stem[:120]
    return f"{stem}{suffix}"


def channel_inbound_media_dir(
    channel: str,
    *,
    when: datetime | None = None,
) -> Path:
    """``…/channel-messages/{channel}/{YYYY}/{MM}/``."""
    now = when or datetime.now().astimezone()
    folder = (
        channel_messages_root()
        / _safe_channel(channel)
        / f"{now.year:04d}"
        / f"{now.month:02d}"
    )
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def allocate_inbound_media_path(
    channel: str,
    filename: str,
    *,
    unique_hint: str = "",
    when: datetime | None = None,
) -> Path:
    """Pick a non-colliding path under the channel/year/month folder."""
    folder = channel_inbound_media_dir(channel, when=when)
    safe = _safe_filename(filename)
    stem = Path(safe).stem
    suffix = Path(safe).suffix
    hint = _SAFE_FILENAME_RE.sub("_", str(unique_hint or "").strip())[:48].strip("._")
    if hint:
        candidate = folder / f"{stem}__{hint}{suffix}"
    else:
        candidate = folder / safe
    if not candidate.exists():
        return candidate
    for i in range(2, 1000):
        alt = folder / f"{stem}__{hint}_{i}{suffix}" if hint else folder / f"{stem}_{i}{suffix}"
        if not alt.exists():
            return alt
    # Extremely unlikely; fall through with timestamp.
    stamp = datetime.now().strftime("%H%M%S%f")
    return folder / f"{stem}__{hint}_{stamp}{suffix}"


def write_inbound_media_bytes(
    data: bytes,
    *,
    channel: str,
    filename: str,
    unique_hint: str = "",
    when: datetime | None = None,
) -> str:
    """Write bytes to the durable layout; return absolute path string."""
    path = allocate_inbound_media_path(
        channel,
        filename,
        unique_hint=unique_hint,
        when=when,
    )
    path.write_bytes(data)
    logger.info(
        "[InboundMediaStore] saved channel=%s bytes=%d path=%s",
        _safe_channel(channel),
        len(data),
        path,
    )
    return str(path)
