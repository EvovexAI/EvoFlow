"""Canonical DB/API timestamp helpers (Beijing ISO in SQLite, epoch ms at API edges)."""

from __future__ import annotations

from typing import Any

from evoflow.timeutil import (
    beijing_now_iso,
    instant_to_beijing_iso,
    parse_iso_to_ms,
    parse_iso_to_unix,
    unix_to_beijing_iso,
)


def ms_to_iso_z(value: int | float | None) -> str:
    return instant_to_beijing_iso(value)


def unix_to_iso_z(value: float | int | None) -> str:
    return unix_to_beijing_iso(value)


def iso_z_to_ms(value: str | None) -> int:
    return parse_iso_to_ms(value)


def iso_z_to_unix(value: str | None) -> float:
    return parse_iso_to_unix(value)


def coerce_to_epoch_ms(value: Any, *, default_ms: int = 0) -> int:
    """Normalize SQLite ISO ``created_at``, unix seconds, or epoch ms → milliseconds."""
    if value is None or value == "":
        return default_ms
    if isinstance(value, (int, float)):
        iv = int(value)
        if iv <= 0:
            return default_ms
        if iv < 1_000_000_000_000:
            return iv * 1000
        return iv
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return default_ms
        if s.isdigit():
            iv = int(s)
            if iv <= 0:
                return default_ms
            if iv < 1_000_000_000_000:
                return iv * 1000
            return iv
        ms = parse_iso_to_ms(s)
        return ms if ms > 0 else default_ms
    return default_ms


def coerce_iso_z(value: str | int | float | None, *, now_if_empty: bool = False) -> str:
    """Normalize mixed legacy values (ms, unix, UTC ``Z``, ``+08:00``) to Beijing ISO."""
    if value is None or value == "":
        return beijing_now_iso() if now_if_empty else ""
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return beijing_now_iso() if now_if_empty else ""
        if "T" in s or s.endswith("Z") or "+" in s or s.endswith("00:00"):
            ms = parse_iso_to_ms(s)
            return instant_to_beijing_iso(ms) if ms > 0 else s
        if s.isdigit():
            return instant_to_beijing_iso(int(s))
        return s
    if isinstance(value, (int, float)):
        iv = int(value)
        if iv > 1_000_000_000_000:
            return instant_to_beijing_iso(iv)
        if iv > 1_000_000_000:
            return unix_to_beijing_iso(iv)
        return instant_to_beijing_iso(iv)
    return beijing_now_iso() if now_if_empty else ""


def now_iso_z() -> str:
    return beijing_now_iso()
