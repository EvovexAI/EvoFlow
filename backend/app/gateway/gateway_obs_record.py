"""Shared Gateway HTTP observability recording (REST middleware + LangGraph ASGI wrapper)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Any

from evoflow.observability.gateway_paths import normalize_gateway_obs_path

logger = logging.getLogger(__name__)

# In-memory spike detection: (method, normalized_path) -> (window_start, count)
_SPIKE_WINDOW_S = 60.0
_SPIKE_WARN_THRESHOLD = 30
# 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
# 现在**每一个到达的请求**都会进这里（含被排除落库的路径），所以必须封顶。
# 键含具体 path，若某客户端用带随机 id 的 URL 刷，字典会无界增长 ——
# 这本身就能把内存吃掉，正好对应用户报的「被频繁调用拖垮」。
_SPIKE_MAX_KEYS = 512
_spike_buckets: dict[tuple[str, str], tuple[float, int]] = defaultdict(lambda: (0.0, 0))
_spike_warned: dict[tuple[str, str], float] = {}

# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# 「重复失败 / 一直很慢」发现器 —— 与上面的「高频率」发现器是**两个不同信号**。
# 现网实证：一个已删除的会话 UUID 被轮询了 **4 小时 53 分**、5,685 次全部 404，
# 速率仅 ~19 次/分钟，远低于 _SPIKE_WARN_THRESHOLD=30/60s，所以**一次都没报警**。
# 结论：只看「快不快」永远抓不到「一直错」，必须按**失败率与慢调用占比**单独判。
_OUTCOME_WINDOW_S = 300.0        # 5 分钟滚动窗
_OUTCOME_MIN_CALLS = 20          # 样本太少不下结论
_OUTCOME_ERROR_RATIO = 0.5       # 失败占比 ≥50% 判为「持续失败」
_OUTCOME_SLOW_MS = 3000.0        # 单次 ≥3s 判慢
_OUTCOME_SLOW_MIN = 5            # 窗口内 ≥5 次慢调用判为「持续慢」
_OUTCOME_MAX_KEYS = 512          # 与 spike 同口径封顶，防随机 path 撑爆内存
_outcome_buckets: dict[tuple[str, str], dict[str, float]] = {}
_outcome_warned: dict[tuple[str, str], float] = {}


def _outcome_prune(now: float) -> None:
    stale = [k for k, b in _outcome_buckets.items() if now - b["start"] >= _OUTCOME_WINDOW_S]
    for k in stale:
        _outcome_buckets.pop(k, None)
        _outcome_warned.pop(k, None)
    if len(_outcome_buckets) > _OUTCOME_MAX_KEYS:
        _outcome_buckets.clear()
        _outcome_warned.clear()


def note_gateway_outcome(
    *,
    method: str,
    path: str,
    status_code: int | None,
    duration_ms: float,
    response_content_type: str | None = None,
) -> None:
    """Rolling per-route detector for「一直错」与「一直慢」；只报警，不改行为。

    【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
    用户诉求：「有些接口乱调用、莫名其妙调用，有些耗时太长甚至拖垮系统」。
    现有两层都抓不到本次实证的两类事故：
    - ``_maybe_log_request_spike`` 只看频率 → 19 次/分钟的死会话 404 漏报；
    - 慢日志 ``http_done`` 只记单次 ≥1s → 看不到「同一路由反复 3s+」。

    判据取**占比**而不是绝对次数：失败率 ≥50% 或慢调用 ≥5 次即点名，
    并在同一个窗口内只报一次（``_outcome_warned``），避免自己刷日志。
    """
    # 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
    # SSE / 事件流长连接**天然**就是「慢」：实测 panel-stream 平均挂 13.8s、
    # 最长 562s，错误率 0%。算进「持续慢」会让检测器每 5 分钟误报一次
    # （今天下午 16:46~17:25 连报 8 条，全指向同一条 SSE）。这是误判，不是缺陷。
    # 判据用响应头 content-type —— 路径可以配，content-type 是结果。
    ctype = str(response_content_type or "").lower()
    if "text/event-stream" in ctype or "application/x-ndjson" in ctype:
        return
    key = (str(method or "").upper(), normalize_gateway_obs_path(path))
    now = time.monotonic()
    _outcome_prune(now)
    bucket = _outcome_buckets.get(key)
    if bucket is None or now - bucket["start"] >= _OUTCOME_WINDOW_S:
        bucket = {"start": now, "calls": 0.0, "errors": 0.0, "slow": 0.0, "max_ms": 0.0}
        # 归一化后的 key 会把不同会话的 UUID 折成同一个 ``{id}``（内存有界，但也丢了
        # 「是谁在刷」）。所以另存一条**原始 path** 作样本，告警里带上，否则只告诉你
        # 「这个路由在挨打」却指不出具体是哪个死会话 —— 用户还是得回去 grep 日志。
        bucket["sample"] = str(path or "")[:160]
        _outcome_buckets[key] = bucket
    bucket["calls"] += 1
    code = int(status_code or 0)
    if code >= 400:
        bucket["errors"] += 1
    ms = float(duration_ms or 0.0)
    if ms >= _OUTCOME_SLOW_MS:
        bucket["slow"] += 1
    if ms > bucket["max_ms"]:
        bucket["max_ms"] = ms

    calls = bucket["calls"]
    err_ratio = (bucket["errors"] / calls) if calls else 0.0
    # 两条判据的样本门槛**不同**，别用一个数字套两边：
    # - 失败率是比例，样本太少没有意义（2 次里 1 次失败 ≠ 坏了）→ 要 ≥_OUTCOME_MIN_CALLS；
    # - 慢调用是绝对计数，「同一个路由已经 5 次 3s+」本身就是确证，与总量无关。
    #   （我第一版把这俩都卡在 calls>=10 上，结果一个只被调 6 次却次次 16 秒的路由静默通过。）
    stuck_errors = calls >= _OUTCOME_MIN_CALLS and err_ratio >= _OUTCOME_ERROR_RATIO
    stuck_slow = bucket["slow"] >= _OUTCOME_SLOW_MIN
    if not (stuck_errors or stuck_slow):
        return
    last = _outcome_warned.get(key, 0.0)
    if now - last < _OUTCOME_WINDOW_S:
        return
    _outcome_warned[key] = now
    logger.warning(
        "gateway route degraded: %s %s — %d calls in %.0fs, errors=%d (%.0f%%), "
        "slow(>=%.0fms)=%d, max=%.0fms [%s] sample=%s "
        "(a stale client keeps retrying, or this route needs a timeout/budget)",
        key[0],
        key[1],
        int(calls),
        _OUTCOME_WINDOW_S,
        int(bucket["errors"]),
        err_ratio * 100.0,
        _OUTCOME_SLOW_MS,
        int(bucket["slow"]),
        bucket["max_ms"],
        "errors" if stuck_errors else "slow",
        bucket.get("sample") or "",
    )


def _spike_prune(now: float) -> None:
    """丢出窗口外的桶；超容时整体清空（宁可漏报一轮，也不让字典无界长）。"""
    if len(_spike_buckets) <= _SPIKE_MAX_KEYS:
        return
    stale = [k for k, (start, _c) in _spike_buckets.items() if now - start >= _SPIKE_WINDOW_S]
    for k in stale:
        _spike_buckets.pop(k, None)
        _spike_warned.pop(k, None)
    if len(_spike_buckets) > _SPIKE_MAX_KEYS:
        _spike_buckets.clear()
        _spike_warned.clear()


def _occurred_at() -> str:
    try:
        from evoflow.timeutil import beijing_now_iso

        return beijing_now_iso()
    except Exception:
        return ""


def _maybe_log_request_spike(*, method: str, path: str) -> None:
    key = (str(method or "").upper(), normalize_gateway_obs_path(path))
    now = time.monotonic()
    _spike_prune(now)
    window_start, count = _spike_buckets[key]
    if now - window_start >= _SPIKE_WINDOW_S:
        window_start, count = now, 0
    count += 1
    _spike_buckets[key] = (window_start, count)
    if count < _SPIKE_WARN_THRESHOLD:
        return
    last_warn = _spike_warned.get(key, 0.0)
    if now - last_warn < _SPIKE_WINDOW_S:
        return
    _spike_warned[key] = now
    # 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    # 带上在途请求数：光看到"某路径 60s 内 40 次"还不够判断它是不是把系统拖住了，
    # 与 inflight 同屏才能一眼分开"是它自己刷"还是"它把别人堵死"。
    inflight = -1
    try:
        from app.gateway.hang_diagnostics import snapshot_inflight_requests

        inflight = int(snapshot_inflight_requests().get("count") or 0)
    except Exception:
        pass
    logger.warning(
        "gateway request spike: %s %s — %d hits in %.0fs inflight=%d "
        "(check client retries or stale-thread rebuild)",
        key[0],
        key[1],
        count,
        _SPIKE_WINDOW_S,
        inflight,
    )


def note_gateway_request_arrival(*, method: str, path: str) -> None:
    """Count EVERY http arrival, including paths excluded from row storage.

    【self-evolution-bot · 2026-11-19 · 第68轮】
    用户报的症状：「莫名其妙被一些没被统计到的接口频繁调用，把整个系统拖垮了」。
    根因：``_EXCLUDED_OBS_PATHS``（/api/observability、/health、/api/session-notifications…）
    在 ``GatewayRequestLoggingMiddleware`` 里**先 return**，连 ``_maybe_log_request_spike``
    都跑不到 —— 这些路径的洪泛既不入库、也不告警，完全不可见。

    现在把「计数与洪泛告警」提到排除判断之前：被排除的路径仍然不落行（避免
    /api/observability 自己查自己造成反馈环），但**高频调用会在日志里点名**。
    这就是"没被统计的接口"的兜底可见性。
    """
    _maybe_log_request_spike(method=method, path=path)


def schedule_gateway_observability_record(payload: dict[str, Any]) -> None:
    """Best-effort async write to evoflow_obs_gateway_requests; never raises."""
    async def runner() -> None:
        try:
            from evoflow.observability.recorder import get_observability_recorder

            await asyncio.to_thread(get_observability_recorder().record_gateway_request, **payload)
        except Exception:
            logger.debug("gateway observability record task failed", exc_info=True)

    try:
        asyncio.create_task(runner())
    except RuntimeError:
        logger.debug("gateway observability record task could not be scheduled", exc_info=True)


def build_gateway_obs_payload(
    *,
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    query_string: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    meta = dict(metadata or {})
    meta.setdefault("source", "gateway")
    return {
        "occurred_at": _occurred_at(),
        "method": method,
        "path": normalize_gateway_obs_path(path),
        "query_string": query_string or None,
        "client_ip": None,
        "user_agent": None,
        "request_content_type": None,
        "response_content_type": None,
        "status_code": int(status_code),
        "duration_ms": round(float(duration_ms), 2),
        "request_headers": None,
        "response_headers": None,
        "request_body_sample": None,
        "response_body_sample": None,
        "request_body_truncated": False,
        "response_body_truncated": False,
        "error_type": None,
        "metadata": meta,
    }
