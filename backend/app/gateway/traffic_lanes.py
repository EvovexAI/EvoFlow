"""Gateway traffic lanes — isolate Control / Data / Best-effort so one slow path cannot wedge all.

Design (desktop single-process):
- **Unknown routes default to DATA**, never Control. New endpoints are isolated until
  explicitly promoted — this is what stops "we only patched the two hotspots we saw".
- **Best-effort** is shed first under overload (503 soft).
- **Data** is clamped (concurrency + optional query hints via scope state).
- **Control** is never shed (liveness, stream, send, tool-approval).

Consumers: middleware (early shed), hang dumps (lane tag), handlers (optional slot).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class Lane(str, Enum):
    CONTROL = "control"
    DATA = "data"
    BEST_EFFORT = "best_effort"
    STREAM = "stream"  # long-lived; not shed, not in REST inflight budget


@dataclass(frozen=True)
class LaneDecision:
    lane: Lane
    reason: str


# --- path rules (first match wins among category lists; CONTROL checked first) ---

_CONTROL_EXACT = frozenset(
    {
        "/health",
        "/health/liveness",
        "/health/ready",
        "/api/health",
        "/api/health/liveness",
        "/api/health/ready",
    }
)

_CONTROL_PREFIXES = (
    "/api/models",  # model list for composer — keep snappy
)

_CONTROL_SUFFIXES = (
    "/tool-approval",
    "/live-run",
    "/cancel",
    "/interrupt",
)

_CONTROL_CONTAINS = (
    "/runs/wait",  # short control wait variants if any
)

# Long-lived streams (also detected by middleware._is_streaming_request_path)
_STREAM_MARKERS = (
    "/runs/stream",
    "/resume-stream",
    "/panel-stream",
    "/conversation/frames",
)

# Explicit best-effort — polls, probes, large media, background consolidate
_BEST_EFFORT_CONTAINS = (
    "/workspaces/serve-file",
    "/workspaces/git_status",
    "/workspaces/git-status",
    "/git_status",
    "/git-status",
    "/git_ignored",
    "/git-ignored",
    "/ignored_paths",
    "/assets/phase2",
    "/assets/consolidate",
    "/observability",
    "/browser/log",
    "/browser-log",
    "/plugins/overview",
    "/skills",  # catalog list used by idle panels
    "/subagent/",  # transcript polls every few seconds while a run is open
    "/transcript",
)

_BEST_EFFORT_EXACT = frozenset(
    {
        "/api/tasks",  # full catalog — assistants poll; detail is /api/tasks/{id}
    }
)

_BEST_EFFORT_METHODS_PATHS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # Idle dashboard / role boards that can soft-fail
    ("GET", re.compile(r"^/api/proactive/roles/?$")),
    ("GET", re.compile(r"^/api/proactive/roles/[^/]+/busy/?$")),
)


def _env_int(name: str, default: int, *, minimum: int = 1, maximum: int = 64) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(minimum, min(maximum, int(raw)))
    except ValueError:
        return default


def classify_path(path: str, *, method: str = "GET") -> LaneDecision:
    """Classify an HTTP path into a traffic lane.

    Default for unknown API paths: **DATA** (never Control). That is the coverage
    guarantee: future slow endpoints are isolated until allow-listed as Control.
    """
    p = str(path or "") or "/"
    m = str(method or "GET").upper()

    if p in _CONTROL_EXACT or p.rstrip("/") in {x.rstrip("/") for x in _CONTROL_EXACT}:
        return LaneDecision(Lane.CONTROL, "health_or_exact_control")

    for marker in _STREAM_MARKERS:
        if marker in p:
            return LaneDecision(Lane.STREAM, f"stream:{marker}")
    if p.endswith("/stream") or "/stream?" in p:
        if "/api/events/" in p or "/api/v4/" in p or "/api/langgraph/" in p:
            return LaneDecision(Lane.STREAM, "stream:sse_family")

    for suf in _CONTROL_SUFFIXES:
        if p.endswith(suf) or f"{suf}/" in p:
            return LaneDecision(Lane.CONTROL, f"control_suffix:{suf}")

    for pref in _CONTROL_PREFIXES:
        if p == pref or p.startswith(pref + "/"):
            return LaneDecision(Lane.CONTROL, f"control_prefix:{pref}")

    for part in _CONTROL_CONTAINS:
        if part in p:
            return LaneDecision(Lane.CONTROL, f"control_contains:{part}")

    # Chat send / session mutation — control (user is waiting)
    if m in {"POST", "PUT", "PATCH", "DELETE"}:
        if "/api/chat/" in p or "/api/threads/" in p:
            if "/browser-embed/" in p or "/browser/" in p:
                return LaneDecision(Lane.BEST_EFFORT, "browser_sidechannel")
            return LaneDecision(Lane.CONTROL, "chat_or_thread_mutation")

    for exact in _BEST_EFFORT_EXACT:
        if p == exact or p.rstrip("/") == exact.rstrip("/"):
            # Allow filtered single-row lookups to stay DATA (query has thread_id/session_key)
            return LaneDecision(Lane.BEST_EFFORT, "best_exact_catalog")

    for part in _BEST_EFFORT_CONTAINS:
        if part in p:
            return LaneDecision(Lane.BEST_EFFORT, f"best_contains:{part}")

    for meth, pat in _BEST_EFFORT_METHODS_PATHS:
        if m == meth and pat.search(p):
            return LaneDecision(Lane.BEST_EFFORT, "best_method_path")

    # GET chat sessions list / messages → DATA (needed for UI but isolatable)
    if p.startswith("/api/"):
        return LaneDecision(Lane.DATA, "default_api_data")

    return LaneDecision(Lane.DATA, "default_unknown_data")


def refine_tasks_list_lane(*, path: str, query: str | None) -> LaneDecision | None:
    """``GET /api/tasks`` with thread_id/session_key is a point lookup → DATA, not catalog."""
    p = str(path or "")
    if p.rstrip("/") != "/api/tasks":
        return None
    q = str(query or "")
    if "thread_id=" in q or "session_key=" in q:
        return LaneDecision(Lane.DATA, "tasks_point_lookup")
    return None


# --- concurrency slots (lazy, bound to running loop) ---

_data_slot: asyncio.Semaphore | None = None
_best_slot: asyncio.Semaphore | None = None
_sessions_list_slot: asyncio.Semaphore | None = None
_transcript_slot: asyncio.Semaphore | None = None
_tasks_catalog_slot: asyncio.Semaphore | None = None


def data_lane_slot() -> asyncio.Semaphore:
    global _data_slot
    if _data_slot is None:
        _data_slot = asyncio.Semaphore(_env_int("EVOFLOW_LANE_DATA_CONCURRENCY", 6))
    return _data_slot


def best_effort_lane_slot() -> asyncio.Semaphore:
    global _best_slot
    if _best_slot is None:
        _best_slot = asyncio.Semaphore(_env_int("EVOFLOW_LANE_BEST_CONCURRENCY", 2))
    return _best_slot


def sessions_list_slot() -> asyncio.Semaphore:
    """Cap concurrent ``GET /api/chat/sessions`` (workspace fan-out) so SQLite + DB
    thread pool stay responsive for control-plane chat/stream work.
    """
    global _sessions_list_slot
    if _sessions_list_slot is None:
        _sessions_list_slot = asyncio.Semaphore(
            _env_int("EVOFLOW_SESSIONS_LIST_CONCURRENCY", 2, maximum=8)
        )
    return _sessions_list_slot


def tasks_catalog_slot() -> asyncio.Semaphore:
    """Cap concurrent Task Center ``GET /api/tasks`` catalogs (not point lookups)."""
    global _tasks_catalog_slot
    if _tasks_catalog_slot is None:
        _tasks_catalog_slot = asyncio.Semaphore(
            _env_int("EVOFLOW_TASKS_CATALOG_CONCURRENCY", 2, maximum=6)
        )
    return _tasks_catalog_slot


def transcript_slot() -> asyncio.Semaphore:
    """Cap subagent transcript polls — must NOT share the catalog slot or Task
    Center open waits behind 2–5s transcript polls (and vice versa).
    """
    global _transcript_slot
    if _transcript_slot is None:
        _transcript_slot = asyncio.Semaphore(
            _env_int("EVOFLOW_TRANSCRIPT_CONCURRENCY", 2, maximum=6)
        )
    return _transcript_slot


def overload_action(lane: Lane) -> str:
    """What OverloadGate should do for this lane: allow | clamp | shed."""
    from app.gateway.hang_diagnostics import should_shed_best_effort

    if lane in (Lane.CONTROL, Lane.STREAM):
        return "allow"
    if not should_shed_best_effort():
        return "allow"
    if lane == Lane.BEST_EFFORT:
        return "shed"
    if lane == Lane.DATA:
        return "clamp"
    return "allow"


def shed_response_body(*, lane: Lane, path: str) -> dict[str, Any]:
    return {
        "success": False,
        "shed": True,
        "lane": lane.value,
        "path": path,
        "detail": "gateway overloaded — best-effort request shed to protect control plane",
        "error": {
            "code": "GATEWAY_OVERLOAD_SHED",
            "message": "Gateway overloaded; retry shortly",
        },
    }


__all__ = [
    "Lane",
    "LaneDecision",
    "best_effort_lane_slot",
    "classify_path",
    "data_lane_slot",
    "overload_action",
    "refine_tasks_list_lane",
    "sessions_list_slot",
    "shed_response_body",
    "tasks_catalog_slot",
    "transcript_slot",
]
