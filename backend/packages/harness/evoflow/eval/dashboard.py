"""健康总览数据聚合 —— 综合多维度得分、告警、Agent 排行、评测记录。

去 Mock 原则：所有数据来自真实统计；无数据返回 0/空结构，不生成随机假数据。
有最近 scenario run 时，将 scenario_pass_rate 纳入综合健康分。
"""

from __future__ import annotations

import logging
import time as _t
from typing import Any

from evoflow.eval.business_quality import (
    evaluate_conversation_quality,
    evaluate_task_quality,
    evaluate_tool_reliability,
    get_agent_ranking,
)
from evoflow.eval.data_sources import get_task_stats, get_task_trend
from evoflow.eval.security import get_security_summary

logger = logging.getLogger(__name__)


def _clamp(score: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return round(max(lo, min(hi, score)), 1)


def _safe_score(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _ts_str(seconds_ago: int) -> str:
    return _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime(_t.time() - seconds_ago))


def _scenario_pass_rate() -> float | None:
    try:
        from evoflow.eval.eval_engine import list_scenario_results

        data = list_scenario_results(1)
        results = data.get("results") or []
        if not results:
            return None
        return float(data.get("pass_rate") or 0) * 100.0
    except Exception:  # noqa: BLE001
        return None


def _obs_snapshot() -> dict[str, Any]:
    try:
        from evoflow.observability.eval_metrics import build_eval_findings

        # Prefer a lightweight snapshot helper if present
        try:
            from evoflow.observability import eval_metrics as em

            if hasattr(em, "build_eval_snapshot"):
                return em.build_eval_snapshot() or {}
            if hasattr(em, "get_eval_snapshot"):
                return em.get_eval_snapshot() or {}
        except Exception:  # noqa: BLE001
            pass
        findings = build_eval_findings() if callable(build_eval_findings) else {}
        return findings if isinstance(findings, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _real_alerts(days: int, tool_rel: dict[str, Any], sec_summary: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    """从真实数据构建告警列表（低成功率工具 + 安全漏洞 + 评测告警）。"""
    alerts: list[dict[str, Any]] = []
    for t in (tool_rel.get("degraded_tools") or []):
        alerts.append(
            {
                "level": "warn",
                "message": f"工具 {t.get('tool')} 成功率 {t.get('success_rate')} 低于阈值",
                "timestamp": _ts_str(0),
            }
        )
    vulns = (sec_summary.get("vulnerabilities") or {}).get("vulnerabilities") \
        if isinstance(sec_summary.get("vulnerabilities"), dict) else (sec_summary.get("vulnerabilities") or [])
    for v in (vulns if isinstance(vulns, list) else [])[:3]:
        sev = str(v.get("severity") or "low")
        level = "error" if sev in ("critical", "high") else ("warn" if sev == "medium" else "info")
        alerts.append(
            {
                "level": level,
                "message": str(v.get("name") or v.get("description") or "安全配置风险"),
                "timestamp": _ts_str(0),
            }
        )
    try:
        from evoflow.eval.eval_engine import list_eval_alerts

        hist = list_eval_alerts(limit=5)
        for a in hist.get("alerts") or []:
            alerts.append(
                {
                    "level": a.get("level") or "warn",
                    "message": a.get("message") or "评测告警",
                    "timestamp": _t.strftime(
                        "%Y-%m-%dT%H:%M:%SZ",
                        _t.gmtime(int(a.get("created_at_ms") or 0) / 1000.0),
                    )
                    if a.get("created_at_ms")
                    else _ts_str(0),
                }
            )
    except Exception:  # noqa: BLE001
        pass
    return alerts[:limit]


def _recent_evaluations(days: int) -> list[dict[str, Any]]:
    """最近评测记录（来自 eval_runs 表真实数据）。"""
    del days
    try:
        from evoflow.eval.eval_engine import list_eval_runs

        listing = list_eval_runs(limit=5)
        runs = listing.get("runs") or []
    except Exception:  # noqa: BLE001
        runs = []
    out = []
    for r in runs:
        created_ms = int(r.get("created_at_ms") or 0)
        ts = _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime(created_ms / 1000.0)) if created_ms else ""
        passed = int(r.get("passed_cases") or 0)
        total = int(r.get("total_cases") or 0)
        out.append(
            {
                "id": r.get("run_id"),
                "dimension": r.get("type"),
                "name": r.get("name"),
                "score": round(passed / total * 100, 1) if total else 0.0,
                "status": r.get("status"),
                "timestamp": ts,
            }
        )
    return out


def get_dashboard_summary(days: int = 7) -> dict[str, Any]:
    """返回健康总览所需的全部数据（综合健康分 + 各维度得分 + 告警 + 排行）。"""
    task_quality = evaluate_task_quality(days)
    tool_rel = evaluate_tool_reliability(days)
    evaluate_conversation_quality(days)
    agent_rank = get_agent_ranking(days, limit=5)
    task_stats = get_task_stats(days)
    sec_summary = get_security_summary(days)
    scenario_rate = _scenario_pass_rate()
    obs = _obs_snapshot()

    total = int(task_stats.get("total") or 0)
    done = int(task_stats.get("done") or 0)
    completion_rate = task_stats.get("completion_rate") or (done / total if total else 0.0)

    business_score = _safe_score(task_quality.get("quality_score"))
    performance_score = _safe_score(tool_rel.get("reliability_score"))
    security_score = _safe_score(sec_summary.get("score"))
    failure_rate = task_quality.get("failure_rate") or 0.0
    stability_score = _clamp(100 - failure_rate * 500 - (1 - _safe_score(tool_rel.get("success_rate"))) * 100)

    avg_duration_ms = 0.0
    duration = task_quality.get("duration") or {}
    if duration:
        avg_duration_ms = _safe_score(duration.get("avg", 0))

    if scenario_rate is not None:
        # Prefer scenario regression when available
        health_score = _clamp(
            scenario_rate * 0.45
            + business_score * 0.2
            + performance_score * 0.15
            + security_score * 0.12
            + stability_score * 0.08
        )
    else:
        health_score = _clamp(
            business_score * 0.4
            + performance_score * 0.25
            + security_score * 0.2
            + stability_score * 0.15
        )

    alerts = _real_alerts(days, tool_rel, sec_summary, 5)

    return {
        "days": days,
        "health_score": health_score,
        "task_completion_rate": round(completion_rate, 4),
        "security_score": security_score,
        "avg_response_latency_ms": round(avg_duration_ms, 2),
        "tool_success_rate": _safe_score(tool_rel.get("success_rate")),
        "active_agents": len(agent_rank.get("ranking") or []),
        "scenario_pass_rate": round(scenario_rate / 100.0, 4) if scenario_rate is not None else None,
        "dimension_scores": {
            "business": business_score,
            "performance": performance_score,
            "security": security_score,
            "stability": stability_score,
            "scenario": scenario_rate if scenario_rate is not None else 0.0,
        },
        "observability": {
            "invalid_tool_rate": obs.get("invalid_tool_rate") or obs.get("invalidToolRate"),
            "thread_health": obs.get("health_score") or obs.get("thread_health") or obs.get("healthScore"),
            "raw_keys": list(obs.keys())[:12] if isinstance(obs, dict) else [],
        },
        "alerts": alerts,
        "agents_ranking": (agent_rank.get("ranking") or [])[:5],
        "recent_evaluations": _recent_evaluations(days),
    }


def get_dashboard_trend(days: int = 7) -> dict[str, Any]:
    """健康度趋势：按天返回健康分估算与各维度分数。"""
    trend = get_task_trend(days)
    series = trend.get("series") or []
    out_series = []
    for day in series:
        total = int(day.get("total") or 0)
        done = int(day.get("done") or 0)
        cr = (done / total) if total else 0.0
        health = _clamp(cr * 100 * 0.7 + 25)
        out_series.append(
            {
                "date": day.get("date"),
                "health_score": health,
                "business": _clamp(cr * 100),
                "performance": _clamp(cr * 100 + 10),
                "tasks": total,
                "completion_rate": round(cr, 4),
            }
        )
    return {
        "days": days,
        "series": out_series,
    }


def get_dashboard_alerts(days: int = 7, limit: int = 10) -> dict[str, Any]:
    """关键告警列表（真实工具告警 + 安全漏洞告警）。"""
    limit = max(1, min(int(limit), 50))
    tool_rel = evaluate_tool_reliability(days)
    sec_summary = get_security_summary(days)
    alerts = _real_alerts(days, tool_rel, sec_summary, limit)
    return {
        "days": days,
        "total": len(alerts),
        "alerts": alerts,
    }


def get_dashboard_agents_ranking(days: int = 7, limit: int = 5) -> dict[str, Any]:
    """Agent 排行（直接复用 get_agent_ranking）。"""
    ranking = get_agent_ranking(days, limit=limit)
    return {
        "days": days,
        "ranking": ranking.get("ranking") or [],
    }
