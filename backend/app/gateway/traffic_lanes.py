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
    # 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
    # True = 该路径在 handler 内已有专属并发槽，中间件通用 DATA 闸必须让路。
    # 刻意做成显式字段而不是只在 reason 里写一句话：reason 是给人读的，
    # 中间件读不到它 —— 「注释写了豁免但实际照旧拦截」正是本岗踩过的坑。
    own_slot_gate: bool = False


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
    # live-run 已降为 BEST_EFFORT（见下方 METHODS_PATHS）：后台轮询不能堵切会话。
    "/cancel",
    "/interrupt",
    # 切会话首帧：用户盯着空白遮罩等 ACK；勿进 DATA 与并发流式抢槽
    # （正式包：subscribe 卡到旧回合 sse_final → 空白数十秒）。
    "/conversation/subscribe",
    "/conversation/unsubscribe",
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
    # Path heal can os.walk large media trees (65s+ observed); shed/isolate so
    # chat subscribe on CONTROL/DATA is not wedged behind a stuck resolve.
    "/workspaces/resolve-target",
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
    "/speech/log",  # voice debug append — high volume, never block chat
    "/plugins/overview",
    "/skills",  # catalog list used by idle panels
    "/subagent/",  # transcript polls every few seconds while a run is open
    "/transcript",
    "/execution-history",  # task-detail poll; also matched by METHODS_PATHS
    "/execution/state",  # history-watch / gear poll; must shed under lag (2026-11-17)
    "/runtime-status",  # deprecated alias of execution/state
    "/workspaces/index-status",  # code-index poll while rebuild runs
    "/workspaces/index-warm",
    # Settings「代码索引图谱」默认 q=class；FTS/语义/建库锁可卡 60–100s+（2026-11-23 16:55）。
    "/workspaces/search",
)

_BEST_EFFORT_EXACT = frozenset(
    {
        "/api/tasks",  # full catalog — assistants poll; detail is /api/tasks/{id}
    }
)

_BEST_EFFORT_METHODS_PATHS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # Idle dashboard / role boards that can soft-fail under overload
    ("GET", re.compile(r"^/api/proactive/roles/?$")),
    # Single-role detail (sidebar / voice fan-out); shed beats clogging DATA
    ("GET", re.compile(r"^/api/proactive/roles/[^/]+/?$")),
    ("GET", re.compile(r"^/api/proactive/roles/[^/]+/busy/?$")),
    # Background live-run upserts (selected 2s / bg 10s). Under lag shed 503 —
    # must not sit on CONTROL and block subscribe (2026-11-13 12:01: live-run 21s).
    ("PUT", re.compile(r"^/api/chat/sessions/.+/live-run/?$")),
    ("GET", re.compile(r"^/api/chat/sessions/.+/live-run/?$")),
    ("DELETE", re.compile(r"^/api/chat/sessions/.+/live-run/?$")),
    # Task detail history poll — was DATA + full project scan; under lag shed so
    # chat open/send stay responsive (2026-11-14 17:06 hang: 8.6s inflight).
    ("GET", re.compile(r"^/api/tasks/[^/]+/execution-history/?$")),
    # Session run-status poll — was DATA and sat 200s+ while code-index imported
    # sklearn (2026-11-17 09:08). Shed under lag so other pages stay reachable.
    ("GET", re.compile(r"^/api/chat/sessions/.+/execution/state/?$")),
    ("GET", re.compile(r"^/api/chat/sessions/.+/runtime-status/?$")),
)

# Must run BEFORE ``/api/models`` CONTROL prefix — otherwise local embedding
# probes (torch/scipy first import) sit on CONTROL for minutes and freeze the
# whole desktop (2026-11-19 11:35: embedding-probe 200s+ blocked knowledge).
_BEST_EFFORT_BEFORE_CONTROL: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("POST", re.compile(r"^/api/models/embedding-probe/?$")),
    ("POST", re.compile(r"^/api/models/local-embedding/download/?$")),
    ("GET", re.compile(r"^/api/models/local-embedding/cache-status/?$")),
    ("GET", re.compile(r"^/api/models/local-embedding/runtime/?$")),
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

    for meth, pat in _BEST_EFFORT_BEFORE_CONTROL:
        if m == meth and pat.search(p):
            return LaneDecision(Lane.BEST_EFFORT, "best_model_probe")

    for pref in _CONTROL_PREFIXES:
        if p == pref or p.startswith(pref + "/"):
            return LaneDecision(Lane.CONTROL, f"control_prefix:{pref}")

    for part in _CONTROL_CONTAINS:
        if part in p:
            return LaneDecision(Lane.CONTROL, f"control_contains:{part}")

    # Best-effort method/path pairs BEFORE chat mutation — otherwise PUT
    # /api/chat/.../live-run is swallowed by CONTROL and cannot shed under lag.
    for meth, pat in _BEST_EFFORT_METHODS_PATHS:
        if m == meth and pat.search(p):
            return LaneDecision(Lane.BEST_EFFORT, "best_method_path")

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

    # 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
    # 「自带专属闸」的路径必须豁免通用 DATA 闸，否则两层串联：
    #   GET /api/chat/sessions 在 handler 里已有 sessions_list_slot(2)，
    #   拿不到槽会自己等 3s 再 503。若外面再套 DATA 闸(6)，慢请求会
    #   在两个闸之间同时占位 —— 一条路径就能把整个 DATA 车道堵死。
    # 判据：专属闸比通用闸更贴合该路径，通用闸在这里只增加排队不做保护。
    if m == "GET" and p.rstrip("/") == "/api/chat/sessions":
        return LaneDecision(Lane.DATA, "data_own_slot_gate", own_slot_gate=True)

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

_best_slot: asyncio.Semaphore | None = None
_sessions_list_slot: asyncio.Semaphore | None = None
_transcript_slot: asyncio.Semaphore | None = None
_tasks_catalog_slot: asyncio.Semaphore | None = None


# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# DATA 车道并发闸（此前 `data_lane_slot()` 全仓**零调用点**，等于设计从未生效）。
#
# 为什么必须补：`classify_path` 把**所有未知 /api/* 默认落 DATA**，
# 而 `overload_action(DATA)` 只返回 "clamp" 且仅设一个 scope 标志，
# 全仓只有 chat_sessions.py / tasks.py 两处读它 → 新接口既不被统计口径覆盖、
# 也没有任何并发上限。这正是用户报的「莫名被调用把系统拖垮」的结构成因。
#
# 现网实测（2026-11-19，208,697 行 / 14 小时，按真区间算并发）：
#   DATA 车道 **最大并发 10**，P50=1 / P95=2 / P99=3~4；
#   单请求 >1s 仅 55 行、>10s 仅 12 行。⇒ 上限 6 只削最极端时段。
#
# 语义（关键，别改成别的）：
# ① **有界等待后放行**，绝不返回 503 —— 前端 `gatewayProxyWithRetry` 对 503
#    会带退避重试最多 3 次，对一个已经在洪泛的路由卸载 = 请求量 ×3。
# ② 拿不到槽就**照常放行并记一笔**（lane_clamp_overflow），宁可漏保护也不放大故障。
# ③ 只用普通计数器 + 截止时间轮询，不用 `asyncio.wait_for(sem.acquire())`：
#    后者在超时取消与「刚好被唤醒」之间可能漏还许可，造成闸门永久缺额。
_data_inflight = 0
_data_overflow = 0
_DATA_POLL_S = 0.01
# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# `_data_overflow` 加了却没人能看见 = 等于没加（本岗反复踩的「检测器不接出口」）。
# 溢出按 60s 窗口节流告警一次，附 snapshot，落 gateway 日志可 grep `[lane-clamp]`。
_DATA_OVERFLOW_WARN_S = 60.0
_data_overflow_last_warn = 0.0


def data_lane_limit() -> int:
    return _env_int("EVOFLOW_LANE_DATA_CONCURRENCY", 6)


def data_lane_wait_s() -> float:
    """排队预算是上限的从属参数：默认 800ms，远大于热点路径 p95（4~7ms）。"""
    raw = (os.getenv("EVOFLOW_LANE_DATA_WAIT_MS") or "").strip()
    try:
        ms = float(raw) if raw else 800.0
    except ValueError:
        ms = 800.0
    return max(0.0, min(ms, 10_000.0)) / 1000.0


async def enter_data_lane() -> bool:
    """占一个 DATA 槽；返回 False 表示「没占到但已放行」（不要因此拒绝请求）。"""
    global _data_inflight, _data_overflow
    limit = data_lane_limit()
    if limit <= 0:
        return True
    if _data_inflight < limit:
        _data_inflight += 1
        return True
    loop = asyncio.get_running_loop()
    deadline = loop.time() + data_lane_wait_s()
    while loop.time() < deadline:
        await asyncio.sleep(_DATA_POLL_S)
        if _data_inflight < limit:
            _data_inflight += 1
            return True
    _data_overflow += 1
    _warn_data_overflow(limit=limit)
    return False


def _warn_data_overflow(*, limit: int) -> None:
    """溢出告警（60s 节流）。没有出口的计数器等于没加。"""
    global _data_overflow_last_warn
    import time as _time

    now = _time.monotonic()
    if now - _data_overflow_last_warn < _DATA_OVERFLOW_WARN_S:
        return
    _data_overflow_last_warn = now
    logger.warning(
        "[lane-clamp] DATA lane saturated: inflight=%d limit=%d wait=%.0fms overflow_total=%d "
        "(request passed through, NOT rejected)",
        _data_inflight,
        limit,
        data_lane_wait_s() * 1000.0,
        _data_overflow,
    )


def exit_data_lane() -> None:
    global _data_inflight
    if _data_inflight > 0:
        _data_inflight -= 1


def data_lane_snapshot() -> dict[str, int]:
    """验收/告警用：当前占用、上限、累计溢出次数。"""
    return {
        "inflight": _data_inflight,
        "limit": data_lane_limit(),
        "overflow": _data_overflow,
    }


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
    "enter_data_lane",
    "exit_data_lane",
    "data_lane_limit",
    "data_lane_snapshot",
    "data_lane_wait_s",
    "overload_action",
    "refine_tasks_list_lane",
    "sessions_list_slot",
    "shed_response_body",
    "tasks_catalog_slot",
    "transcript_slot",
]
