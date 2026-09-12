"""Stable short machine id for license binding."""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import re
from functools import lru_cache

logger = logging.getLogger(__name__)

_MACHINE_ID_LEN = 16
_HEX = re.compile(r"^[0-9A-F]+$")


def normalize_machine_id(raw: str) -> str:
    """Normalize operator/user input to canonical 16-char uppercase hex."""
    s = re.sub(r"[^0-9A-Fa-f]", "", str(raw or "").strip()).upper()
    if len(s) >= _MACHINE_ID_LEN:
        return s[:_MACHINE_ID_LEN]
    return s


def _fingerprint_bytes() -> bytes:
    parts: list[str] = []
    if platform.system() == "Windows":
        guid = _windows_machine_guid()
        if guid:
            parts.append(f"win:{guid}")
    if not parts:
        parts.append(f"host:{platform.node() or 'unknown'}")
        parts.append(f"home:{os.path.expanduser('~')}")
        parts.append(f"sys:{platform.system()}:{platform.machine()}")
    return "|".join(parts).encode("utf-8", errors="replace")


def _windows_machine_guid() -> str | None:
    try:
        import winreg  # type: ignore[import-not-found]

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "MachineGuid")
            text = str(value or "").strip()
            return text or None
    except Exception:
        logger.debug("MachineGuid unavailable", exc_info=True)
        return None


@lru_cache(maxsize=1)
def get_machine_id() -> str:
    """Return a stable 16-char uppercase hex machine id for this host."""
    digest = hashlib.sha256(_fingerprint_bytes()).hexdigest().upper()
    return digest[:_MACHINE_ID_LEN]


def clear_machine_id_cache() -> None:
    """Test helper: drop cached machine id."""
    get_machine_id.cache_clear()
