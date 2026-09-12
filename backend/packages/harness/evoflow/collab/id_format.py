"""Unified human-readable ID generation for collaboration entities."""

from __future__ import annotations

import random
import re
import uuid
from datetime import UTC, datetime

# Legacy: Task_YYYYMMDDHHMMSS_XXXXXX
# New (short, no Task_ prefix): YYMMDDHHMM_xxxx  e.g. 2607250830_a3f9
_TASK_ID_LEGACY_RE = re.compile(r"Task_[A-Za-z0-9_]+")
_TASK_ID_SHORT_RE = re.compile(r"\b\d{10}_[0-9a-f]{4}\b", re.IGNORECASE)
_TASK_ID_SHORT_FULL = re.compile(r"^\d{10}_[0-9a-f]{4}$", re.IGNORECASE)
# Combined for scanning free text (legacy first so Task_… wins over embedded digits).
TASK_ID_FINDALL_RE = re.compile(
    r"(?:Task_[A-Za-z0-9_]+|\b\d{10}_[0-9a-f]{4}\b)",
    re.IGNORECASE,
)


def _ts_compact() -> str:
    # YYYYMMDDHHMMSS
    return datetime.now(UTC).strftime("%Y%m%d%H%M%S")


def _ts_short() -> str:
    # YYMMDDHHMM (UTC)
    return datetime.now(UTC).strftime("%y%m%d%H%M")


def _rand6() -> str:
    return f"{random.randint(0, 999999):06d}"


def _rand4_hex() -> str:
    return uuid.uuid4().hex[:4]


def make_formatted_id(prefix: str) -> str:
    """Return `{Prefix}_YYYYMMDDHHMMSS_XXXXXX`."""
    p = str(prefix or "").strip() or "ID"
    return f"{p}_{_ts_compact()}_{_rand6()}"


def make_project_id() -> str:
    return make_formatted_id("Project")


def make_task_id() -> str:
    """Short task id without ``Task_`` prefix: ``YYMMDDHHMM_xxxx``.

    Example: ``2607250830_a3f9``. Legacy ``Task_…`` ids remain valid in parsers.
    """
    return f"{_ts_short()}_{_rand4_hex()}"


def is_task_id(value: str) -> bool:
    """True for legacy ``Task_…`` or short ``YYMMDDHHMM_xxxx`` ids."""
    s = str(value or "").strip()
    if not s:
        return False
    if s.startswith("Task_") or s.startswith("task_"):
        return True
    return bool(_TASK_ID_SHORT_FULL.match(s))


def make_subtask_id() -> str:
    return make_formatted_id("Subtask")


def make_thread_id() -> str:
    return make_formatted_id("Thread")


def make_trace_id() -> str:
    return make_formatted_id("Trace")


def make_fact_id() -> str:
    return make_formatted_id("Fact")


def make_todo_id() -> str:
    return make_formatted_id("Todo")


def make_memory_id() -> str:
    return make_formatted_id("Memory")


def make_automation_id() -> str:
    return make_formatted_id("Automation")
