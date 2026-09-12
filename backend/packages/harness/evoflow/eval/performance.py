"""性能评测器 —— 基于 ``evoflow_chat_messages`` 的响应延迟与错误统计。

约定：
- 响应时间 = 一条 ``user`` 消息与同一会话中下一条 ``assistant`` 消息的
  ``created_at_ms`` 时间差。
- 数据为空返回空结构；表缺失标注 ``_table_missing: true``。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.eval.data_sources import _columns, _missing, _percentiles, _table_exists
from evoflow.persistence.db import get_db

logger = logging.getLogger(__name__)


def _since_ms(days: int) -> int:
    from evoflow.eval.data_sources import _since_ms as _src

    return _src(days)


def _iter_response_latencies(db: Any, since_ms: int, max_messages: int = 5000) -> list[float]:
    """抽取响应延迟（秒）列表。

    按会话内按 ``created_at_ms`` 排序，对每条 user 消息取其后最近的
    assistant 消息，以两者时间差作为响应时间。
    """
    if not _table_exists(db, "evoflow_chat_messages"):
        return []
    cols = _columns(db, "evoflow_chat_messages")
    if "role" not in cols or "created_at_ms" not in cols or "session_key" not in cols:
        return []

    try:
        rows = db.execute(
            """
            SELECT session_key, role, created_at_ms
            FROM evoflow_chat_messages
            WHERE created_at_ms >= ?
            ORDER BY session_key, created_at_ms ASC, id ASC
            LIMIT ?
            """,
            (since_ms, max(1, min(int(max_messages), 20000))),
        ).fetchall()
    except Exception:  # noqa: BLE001
        return []

    latencies: list[float] = []
    pending_user_ts: dict[str, int] = {}
    for r in rows:
        sk = str(r["session_key"] or "")
        role = str(r["role"] or "").strip().lower()
        ts = int(r["created_at_ms"] or 0)
        if not sk or not ts:
            continue
        if role == "user":
            pending_user_ts[sk] = ts
        elif role == "assistant" and sk in pending_user_ts:
            start = pending_user_ts.pop(sk)
            diff_s = (ts - start) / 1000.0
            if diff_s >= 0:
                latencies.append(diff_s)
    return latencies


def _count_messages_by_role(db: Any, since_ms: int) -> dict[str, int]:
    """按 role 统计消息数。"""
    out: dict[str, int] = {}
    if not _table_exists(db, "evoflow_chat_messages"):
        return out
    cols = _columns(db, "evoflow_chat_messages")
    if "role" not in cols:
        return out
    try:
        rows = db.execute(
            "SELECT role, COUNT(*) AS cnt FROM evoflow_chat_messages "
            "WHERE created_at_ms >= ? GROUP BY role",
            (since_ms,),
        ).fetchall()
        out = {str(r["role"] or "unknown"): int(r["cnt"] or 0) for r in rows}
    except Exception:  # noqa: BLE001
        pass
    return out


def get_performance_summary(days: int = 7) -> dict[str, Any]:
    """性能总览：P50/P95/P99 延迟、QPS、错误率。"""
    db = get_db()
    since = _since_ms(days)
    latencies = _iter_response_latencies(db, since)

    dist = _percentiles(latencies)
    count = int(dist.get("count") or 0)
    avg = float(dist.get("avg") or 0.0)

    # QPS：以最近 days 天内的 assistant 消息数估算请求量
    roles = _count_messages_by_role(db, since)
    request_count = int(roles.get("assistant") or 0)
    window_s = max(1, days * 24 * 3600)
    qps = round(request_count / window_s, 4)

    # 错误率：从消息内容中粗略统计错误/失败标记
    error_count, error_by_kind = _count_errors(db, since)
    error_rate = round(error_count / request_count, 4) if request_count else 0.0

    result: dict[str, Any] = {
        "days": days,
        "request_count": request_count,
        "qps": qps,
        "latency": {
            "p50": dist.get("p50", 0.0),
            "p95": dist.get("p95", 0.0),
            "p99": dist.get("p99", 0.0),
            "avg": avg,
            "sample_count": count,
        },
        "error": {
            "count": error_count,
            "rate": error_rate,
            "by_kind": error_by_kind,
        },
        "roles": roles,
    }
    if not _table_exists(db, "evoflow_chat_messages"):
        result.update(_missing("evoflow_chat_messages"))
    return result


def get_latency_distribution(days: int = 7) -> dict[str, Any]:
    """延迟分布直方图。

    区间：0-1s, 1-2s, 2-3s, 3-5s, 5-10s, 10s+
    """
    db = get_db()
    since = _since_ms(days)
    latencies = _iter_response_latencies(db, since)

    buckets = [
        ("0-1s", 0, 1.0),
        ("1-2s", 1.0, 2.0),
        ("2-3s", 2.0, 3.0),
        ("3-5s", 3.0, 5.0),
        ("5-10s", 5.0, 10.0),
        ("10s+", 10.0, None),
    ]
    counts = [0] * len(buckets)
    for v in latencies:
        for i, (_label, lo, hi) in enumerate(buckets):
            if hi is None:
                if v >= lo:
                    counts[i] += 1
                continue
            if lo <= v < hi:
                counts[i] += 1
                break

    distribution = [
        {"bucket": label, "count": counts[i], "label": label}
        for i, (label, _lo, _hi) in enumerate(buckets)
    ]
    result: dict[str, Any] = {
        "days": days,
        "total": len(latencies),
        "distribution": distribution,
    }
    if not _table_exists(db, "evoflow_chat_messages"):
        result.update(_missing("evoflow_chat_messages"))
    return result


def _day_key_for_ms(ts: int) -> str:
    import time as _t

    lt = _t.localtime(ts / 1000.0)
    return _t.strftime("%Y-%m-%d", lt)


def get_latency_trend(days: int = 7, percentile: str = "p95") -> dict[str, Any]:
    """延迟趋势（按天）：每日 P50/P95/P99。"""
    db = get_db()
    since = _since_ms(days)
    if not _table_exists(db, "evoflow_chat_messages"):
        return {"days": days, "percentile": percentile, "series": [], **_missing("evoflow_chat_messages")}

    cols = _columns(db, "evoflow_chat_messages")
    if "role" not in cols or "created_at_ms" not in cols or "session_key" not in cols:
        return {"days": days, "percentile": percentile, "series": []}

    try:
        rows = db.execute(
            """
            SELECT session_key, role, created_at_ms
            FROM evoflow_chat_messages
            WHERE created_at_ms >= ?
            ORDER BY session_key, created_at_ms ASC, id ASC
            LIMIT 20000
            """,
            (since,),
        ).fetchall()
    except Exception:  # noqa: BLE001
        return {"days": days, "percentile": percentile, "series": []}

    # 按天收集响应延迟
    daily: dict[str, list[float]] = {}
    pending_user_ts: dict[str, tuple[str, int]] = {}
    for r in rows:
        sk = str(r["session_key"] or "")
        role = str(r["role"] or "").strip().lower()
        ts = int(r["created_at_ms"] or 0)
        if not sk or not ts:
            continue
        if role == "user":
            pending_user_ts[sk] = (_day_key_for_ms(ts), ts)
        elif role == "assistant" and sk in pending_user_ts:
            day, start = pending_user_ts.pop(sk)
            diff_s = (ts - start) / 1000.0
            if diff_s >= 0:
                daily.setdefault(day, []).append(diff_s)

    series = []
    for day in sorted(daily.keys()):
        d = _percentiles(daily[day])
        series.append(
            {
                "date": day,
                "p50": d.get("p50", 0.0),
                "p95": d.get("p95", 0.0),
                "p99": d.get("p99", 0.0),
                "avg": d.get("avg", 0.0),
                "count": d.get("count", 0),
            }
        )
    return {"days": days, "percentile": percentile, "series": series}


def get_module_latency_breakdown(days: int = 7) -> dict[str, Any]:
    """各模块延迟对比：工具调用延迟与对话生成延迟。

    工具调用延迟来自 ``tool_name`` 消息；对话生成延迟近似为整体响应延迟。
    """
    db = get_db()
    since = _since_ms(days)
    result: dict[str, Any] = {
        "days": days,
        "modules": [],
    }
    if not _table_exists(db, "evoflow_chat_messages"):
        result.update(_missing("evoflow_chat_messages"))
        return result

    # 工具调用延迟：基于 tool 消息的 created_at 间隔估算（简化）
    cols = _columns(db, "evoflow_chat_messages")
    tool_latencies: list[float] = []
    if "tool_name" in cols and "created_at_ms" in cols:
        try:
            rows = db.execute(
                "SELECT created_at_ms FROM evoflow_chat_messages "
                "WHERE tool_name IS NOT NULL AND tool_name <> '' AND created_at_ms >= ? "
                "ORDER BY created_at_ms ASC LIMIT 20000",
                (since,),
            ).fetchall()
            ts_list = [int(r["created_at_ms"] or 0) for r in rows if r["created_at_ms"]]
            for i in range(1, len(ts_list)):
                diff = (ts_list[i] - ts_list[i - 1]) / 1000.0
                if 0 < diff < 60:
                    tool_latencies.append(diff)
        except Exception:  # noqa: BLE001
            pass

    gen_latencies = _iter_response_latencies(db, since)

    modules: list[dict[str, Any]] = []
    if tool_latencies:
        td = _percentiles(tool_latencies)
        modules.append(
            {
                "module": "tool_call",
                "label": "工具调用",
                "avg_ms": round(float(td.get("avg", 0)) * 1000, 2),
                "p50_ms": round(float(td.get("p50", 0)) * 1000, 2),
                "p95_ms": round(float(td.get("p95", 0)) * 1000, 2),
                "count": td.get("count", 0),
            }
        )
    if gen_latencies:
        gd = _percentiles(gen_latencies)
        modules.append(
            {
                "module": "generation",
                "label": "对话生成",
                "avg_ms": round(float(gd.get("avg", 0)) * 1000, 2),
                "p50_ms": round(float(gd.get("p50", 0)) * 1000, 2),
                "p95_ms": round(float(gd.get("p95", 0)) * 1000, 2),
                "count": gd.get("count", 0),
            }
        )
    result["modules"] = modules
    return result


def _count_errors(db: Any, since_ms: int) -> tuple[int, dict[str, int]]:
    """粗略统计消息中的错误/失败数量与类型。"""
    if not _table_exists(db, "evoflow_chat_messages"):
        return 0, {}
    cols = _columns(db, "evoflow_chat_messages")
    sel = []
    if "content_text" in cols:
        sel.append("content_text")
    if "content_json" in cols:
        sel.append("content_json")
    if not sel:
        return 0, {}
    try:
        rows = db.execute(
            f"SELECT {', '.join(sel)} FROM evoflow_chat_messages WHERE created_at_ms >= ? LIMIT 20000",
            (since_ms,),
        ).fetchall()
    except Exception:  # noqa: BLE001
        return 0, {}

    error_keywords = {
        "timeout": ("timeout", "超时"),
        "error": ("error", "错误"),
        "failed": ("failed", "failed"),
        "exception": ("exception", "exception"),
        "denied": ("denied", "拒绝", "forbidden"),
    }
    count = 0
    by_kind: dict[str, int] = {}
    for r in rows:
        text_parts = []
        for i in range(len(sel)):
            v = r[i] if i < len(r) else None
            if isinstance(v, (dict, list)):
                try:
                    v = json.dumps(v, ensure_ascii=False)
                except (TypeError, ValueError):
                    v = ""
            text_parts.append(str(v or ""))
        joined = " ".join(text_parts).lower()
        if not joined:
            continue
        for kind, keywords in error_keywords.items():
            if any(k.lower() in joined for k in keywords):
                count += 1
                by_kind[kind] = by_kind.get(kind, 0) + 1
                break
    return count, by_kind


def get_error_stats(days: int = 7) -> dict[str, Any]:
    """错误统计：从消息中统计错误/失败的数量和类型。"""
    db = get_db()
    since = _since_ms(days)
    count, by_kind = _count_errors(db, since)
    roles = _count_messages_by_role(db, since)
    request_count = int(roles.get("assistant") or 0)

    result: dict[str, Any] = {
        "days": days,
        "total": count,
        "rate": round(count / request_count, 4) if request_count else 0.0,
        "by_kind": by_kind,
    }
    if not _table_exists(db, "evoflow_chat_messages"):
        result.update(_missing("evoflow_chat_messages"))
    return result
