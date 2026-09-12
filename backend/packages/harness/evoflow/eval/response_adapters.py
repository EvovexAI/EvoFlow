"""
评估中心响应适配层
====================
将各评估模块的原生输出（snake_case、嵌套结构）转换为前端类型定义
期望的 camelCase 格式，确保前后端字段名完全对齐。

前端类型定义见：evopanel/.../src/types/index.ts
"""
from __future__ import annotations

import json
import time
from typing import Any


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _ms_to_s(ms: float | None) -> float:
    """毫秒转秒，保留 2 位小数。"""
    if not ms:
        return 0.0
    return round(ms / 1000, 2)


def _fmt_duration_ms(ms: float | None) -> str:
    """毫秒格式化成易读字符串。"""
    if not ms:
        return "0s"
    if ms < 1000:
        return f"{int(ms)}ms"
    if ms < 60_000:
        return f"{ms / 1000:.1f}s"
    return f"{ms / 60_000:.1f}min"


def _iso_now() -> str:
    """当前 UTC ISO 时间字符串。"""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Dashboard 适配
# ---------------------------------------------------------------------------

def adapt_dashboard_summary(raw: dict[str, Any]) -> dict[str, Any]:
    """适配健康总览 → 前端 DashboardSummary 类型。"""
    dims = raw.get("dimension_scores", {})
    agents = raw.get("agents_ranking", [])
    recent = raw.get("recent_evaluations", [])
    alerts = raw.get("alerts", [])

    # 前端 alerts 结构
    adapted_alerts = [
        {
            "level": a.get("level", "low"),
            "message": a.get("message", ""),
            "timestamp": a.get("timestamp", ""),
        }
        for a in alerts
    ]

    # 前端 agentsRanking 结构
    adapted_agents = [
        {
            "agent": a.get("agent", a.get("name", "")),
            "tasks": a.get("tasks", 0),
            "done": a.get("done", 0),
            "completionRate": a.get("completion_rate", a.get("successRate", 0)),
        }
        for a in agents
    ]

    # 前端 recentEvaluations
    adapted_recent = [
        {
            "id": r.get("id", ""),
            "dimension": r.get("dimension", r.get("type", "")),
            "score": r.get("score", 0),
            "status": r.get("status", ""),
            "timestamp": r.get("timestamp", r.get("startedAt", "")),
        }
        for r in recent
    ]

    return {
        "healthScore": raw.get("health_score", 0),
        "taskCompletionRate": raw.get("task_completion_rate", 0),
        "securityScore": raw.get("security_score", 0),
        "avgLatencyMs": raw.get("avg_response_latency_ms", 0),
        "toolSuccessRate": raw.get("tool_success_rate", 0),
        "activeAgents": raw.get("active_agents", 0),
        "dimensionScores": dims,
        "alerts": adapted_alerts,
        "agentsRanking": adapted_agents,
        "recentEvaluations": adapted_recent,
    }


def adapt_dashboard_trend(raw: dict[str, Any]) -> dict[str, Any]:
    """适配健康度趋势 → 前端 DashboardTrend 类型。"""
    series = raw.get("series", [])
    adapted = [
        {
            "date": s.get("date", s.get("label", "")),
            "healthScore": s.get("health_score", s.get("score", 0)),
            "business": s.get("business", 0),
            "performance": s.get("performance", 0),
            "tasks": s.get("tasks", s.get("total", 0)),
        }
        for s in series
    ]
    return {"series": adapted}


def adapt_dashboard_alerts(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配告警列表 → 前端 DashboardAlert[] 类型。"""
    alerts = raw.get("alerts", []) if isinstance(raw, dict) else raw
    return [
        {
            "level": a.get("level", "low"),
            "message": a.get("message", ""),
            "timestamp": a.get("timestamp", a.get("time", "")),
        }
        for a in alerts
    ]


def adapt_dashboard_agents_ranking(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配 Agent 排名 → 前端 agentsRanking 类型。"""
    agents = raw.get("agents", []) if isinstance(raw, dict) else raw
    return [
        {
            "agent": a.get("agent", a.get("name", "")),
            "tasks": a.get("tasks", 0),
            "done": a.get("done", 0),
            "completionRate": a.get("completion_rate", a.get("successRate", 0)),
        }
        for a in agents
    ]


# ---------------------------------------------------------------------------
# 业务质量适配
# ---------------------------------------------------------------------------

def adapt_task_quality(raw: dict[str, Any]) -> dict[str, Any]:
    """适配任务质量 → 前端 TaskStats 类型。"""
    duration = raw.get("duration", {})
    failure_reasons = raw.get("failure_reasons", {})
    reasons = failure_reasons.get("reasons", []) if isinstance(failure_reasons, dict) else []

    return {
        "total": raw.get("total", 0),
        "done": raw.get("done", 0),
        "failed": raw.get("failed", 0),
        "completionRate": raw.get("completion_rate", 0),
        "failureRate": raw.get("failure_rate", 0),
        "duration": {
            "p50": duration.get("p50", 0),
            "p95": duration.get("p95", 0),
            "p99": duration.get("p99", 0),
            "avg": duration.get("avg", 0),
        },
        "failureReasons": [
            {"reason": r.get("reason", r.get("label", "")), "count": r.get("count", r.get("value", 0))}
            for r in reasons
        ],
        "score": raw.get("quality_score", raw.get("score", 0)),
    }


def adapt_task_trend(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配任务趋势 → 前端 TaskTrendPoint[] 类型。"""
    series = raw.get("series", []) if isinstance(raw, dict) else raw
    return [
        {
            "date": s.get("date", s.get("label", "")),
            "total": s.get("total", 0),
            "done": s.get("done", 0),
            "completionRate": s.get("completion_rate", 0),
        }
        for s in series
    ]


def adapt_tool_reliability(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配工具可靠性 → 前端 ToolStatsItem[] 类型。"""
    tools = raw.get("tools", []) if isinstance(raw, dict) else raw
    return [
        {
            "tool": t.get("tool", t.get("name", "")),
            "calls": t.get("calls", t.get("total_calls", 0)),
            "success": t.get("success", 0),
            "fail": t.get("fail", t.get("failed", 0)),
            "successRate": t.get("success_rate", 0),
            "avgDurationMs": t.get("avg_duration_ms", t.get("avgLatency", 0)),
        }
        for t in tools
    ]


def adapt_tool_trend(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配工具趋势 → 前端 ToolTrendPoint[] 类型。"""
    series = raw.get("series", []) if isinstance(raw, dict) else raw
    return [
        {
            "date": s.get("date", s.get("label", "")),
            "calls": s.get("calls", s.get("total", 0)),
        }
        for s in series
    ]


def adapt_knowledge_stats(raw: dict[str, Any]) -> dict[str, Any]:
    """适配知识库统计 → 前端 KnowledgeStats 类型。"""
    return {
        "knowledgeBases": raw.get("knowledge_bases", raw.get("datasets", 0)),
        "documents": raw.get("documents", raw.get("chunks", 0)),
        "retrievals": raw.get("retrievals", raw.get("queries", 0)),
    }


def adapt_conversation_stats(raw: dict[str, Any]) -> dict[str, Any]:
    """适配对话统计 → 前端 ConversationStats 类型。"""
    return {
        "sessions": raw.get("sessions", 0),
        "messages": raw.get("messages", 0),
        "activeUsers": raw.get("active_users", 0),
        "messagesPerSession": raw.get("messages_per_session", 0),
    }


# ---------------------------------------------------------------------------
# 安全中心适配
# ---------------------------------------------------------------------------

def adapt_security_summary(raw: dict[str, Any]) -> dict[str, Any]:
    """适配安全总览 → 前端 SecuritySummary 类型。"""
    vulns = raw.get("vulnerabilities", {})
    by_sev = vulns.get("by_severity", {})
    return {
        "score": raw.get("score", 0),
        "highVulns": by_sev.get("high", 0),
        "pendingFixes": vulns.get("total", 0),
        "highNew": 0,
        "pendingNew": 0,
        "lastScan": _iso_now(),
    }


def adapt_permission_matrix(raw: dict[str, Any]) -> dict[str, Any]:
    """适配权限矩阵 → 前端 PermissionMatrix 类型。"""
    roles = raw.get("roles", [])
    actions = raw.get("actions", [])
    matrix = raw.get("matrix", {})
    if not matrix and roles:
        # 从 raw.roles 构造简单矩阵
        matrix = {r: {a: "deny" for a in actions} for r in roles}
    return {
        "roles": roles,
        "actions": actions,
        "matrix": matrix,
    }


def adapt_data_leaks(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配数据泄露列表 → 前端 DataLeak[] 类型。"""
    items = raw.get("items", []) if isinstance(raw, dict) else raw
    return [
        {
            "id": item.get("id", item.get("leak_id", "")),
            "type": item.get("type", item.get("category", "")),
            "severity": item.get("severity", "medium"),
            "source": item.get("source", item.get("location", "")),
            "description": item.get("description", item.get("message", "")),
            "foundAt": item.get("found_at", item.get("timestamp", "")),
            "status": item.get("status", "pending"),
        }
        for item in items
    ]


def adapt_vulnerabilities(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配漏洞列表 → 前端 Vulnerability[] 类型。"""
    items = raw.get("items", []) if isinstance(raw, dict) else raw
    return [
        {
            "id": v.get("id", v.get("vuln_id", "")),
            "level": v.get("level", v.get("severity", "medium")),
            "name": v.get("name", v.get("title", "")),
            "scope": v.get("scope", v.get("module", "")),
            "foundAt": v.get("found_at", v.get("created_at", "")),
            "status": v.get("status", "pending"),
            "category": v.get("category", v.get("type", "")),
        }
        for v in items
    ]


def adapt_audit_stats(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配审计统计 → 前端 SecurityAuditEvent[] 类型。"""
    events = raw.get("events", []) if isinstance(raw, dict) else raw
    if not events and isinstance(raw, dict):
        # 没有明细事件时，从统计数据构造几条摘要
        total = raw.get("total", 0)
        if total > 0:
            events = [
                {
                    "id": f"audit_summary_{int(time.time())}",
                    "level": "info",
                    "message": f"周期内共 {total} 条审计记录",
                    "time": _iso_now(),
                }
            ]
    return [
        {
            "id": e.get("id", e.get("audit_id", "")),
            "level": e.get("level", e.get("severity", "info")),
            "message": e.get("message", e.get("action", "")),
            "time": e.get("time", e.get("timestamp", e.get("created_at", ""))),
        }
        for e in events
    ]


# ---------------------------------------------------------------------------
# 性能基准适配
# ---------------------------------------------------------------------------

def adapt_performance_summary(raw: dict[str, Any]) -> dict[str, Any]:
    """适配性能总览 → 前端 PerformanceSummary 类型。"""
    latency = raw.get("latency", {})
    return {
        "p50": _ms_to_s(latency.get("p50", 0)),
        "p95": _ms_to_s(latency.get("p95", 0)),
        "p99": _ms_to_s(latency.get("p99", 0)),
        "peakQps": raw.get("qps", raw.get("peak_qps", 0)),
        "p50Delta": 0,
        "p95Delta": 0,
        "p99Delta": 0,
        "qpsDelta": 0,
        "lastTest": _iso_now(),
    }


def adapt_latency_distribution(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配延迟分布 → 前端 LatencyBucket[] 类型。"""
    buckets = raw.get("buckets", []) if isinstance(raw, dict) else raw
    return [
        {
            "label": b.get("label", b.get("range", "")),
            "count": b.get("count", 0),
        }
        for b in buckets
    ]


def adapt_latency_trend(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配延迟趋势 → 前端 LatencyTrendPoint[] 类型。"""
    series = raw.get("series", []) if isinstance(raw, dict) else raw
    return [
        {
            "label": s.get("label", s.get("date", "")),
            "p50": _ms_to_s(s.get("p50", 0)),
            "p95": _ms_to_s(s.get("p95", 0)),
            "p99": _ms_to_s(s.get("p99", 0)),
        }
        for s in series
    ]


def adapt_module_breakdown(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配模块延迟对比 → 前端 ModuleLatency[] 类型。"""
    modules = raw.get("modules", []) if isinstance(raw, dict) else raw
    return [
        {
            "module": m.get("module", m.get("name", "")),
            "latency": _ms_to_s(m.get("latency", m.get("avg_latency", 0))),
            "p95": _ms_to_s(m.get("p95", m.get("p95_latency", 0))),
        }
        for m in modules
    ]


def adapt_error_stats(raw: dict[str, Any]) -> dict[str, Any]:
    """适配错误统计 → 前端 ErrorStats 类型。"""
    error = raw.get("error", {}) if isinstance(raw, dict) else raw
    by_kind = error.get("by_kind", {})
    by_type = [{"type": k, "count": v} for k, v in by_kind.items()]
    return {
        "total": error.get("count", raw.get("total_errors", 0)),
        "errorRate": error.get("rate", raw.get("error_rate", 0)),
        "byType": by_type,
    }


# ---------------------------------------------------------------------------
# 评估引擎适配
# ---------------------------------------------------------------------------

def adapt_eval_cases(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配评测用例列表 → 前端 EvalCase[] 类型。"""
    from evoflow.eval.modules import enrich_case_row, module_label, resolve_module

    cases = raw.get("cases", []) if isinstance(raw, dict) else raw
    out = []
    for c in cases:
        row = enrich_case_row(dict(c))
        mod = row.get("module") or resolve_module(
            str(row.get("id") or ""),
            category=str(row.get("category") or ""),
            params=row.get("params") if isinstance(row.get("params"), dict) else {},
        )
        out.append(
            {
                "id": row.get("id", ""),
                "name": row.get("name", ""),
                "category": row.get("category", ""),
                "module": mod,
                "module_label": row.get("module_label") or module_label(mod),
                "level": row.get("level", ""),
                "level_label": row.get("level_label", ""),
                "description": row.get("description", ""),
                "handler": row.get("handler", ""),
                "severity": row.get("severity", row.get("level", "L1")),
                "enabled": row.get("enabled", True),
                "params": row.get("params") or {},
                "design": row.get("design") or (row.get("params") or {}).get("design") or {},
                "priority": row.get("priority") or "",
                "priority_label": row.get("priority_label") or "",
                "flow": row.get("flow") or "",
                "flow_label": row.get("flow_label") or "",
            }
        )
    return out


def adapt_eval_runs(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """适配评测历史列表 → 前端 EvalRun[] 类型。"""
    runs = raw.get("runs", []) if isinstance(raw, dict) else raw

    def _run_duration_ms(r: dict[str, Any]) -> float:
        if r.get("duration_ms"):
            try:
                return float(r["duration_ms"])
            except (TypeError, ValueError):
                pass
        summary = r.get("summary") if isinstance(r.get("summary"), dict) else {}
        if summary.get("duration_ms"):
            try:
                return float(summary["duration_ms"])
            except (TypeError, ValueError):
                pass
        started = r.get("started_at_ms") or 0
        finished = r.get("finished_at_ms") or 0
        try:
            s, f = int(started or 0), int(finished or 0)
            if s and f and f >= s:
                return float(f - s)
        except (TypeError, ValueError):
            pass
        return 0.0

    return [
        {
            "id": r.get("id", r.get("run_id", "")),
            "run_id": r.get("run_id", r.get("id", "")),
            "name": r.get("name", ""),
            "type": r.get("type", "custom"),
            "status": _normalize_run_status(r.get("status", "")),
            "passRate": r.get("pass_rate", r.get("score", 0)),
            "passed_cases": r.get("passed_cases", 0),
            "failed_cases": r.get("failed_cases", 0),
            "total_cases": r.get("total_cases", 0),
            "passedCases": r.get("passed_cases", 0),
            "totalCases": r.get("total_cases", 0),
            "duration_ms": _run_duration_ms(r),
            "duration": _fmt_duration_ms(_run_duration_ms(r)),
            "executedAt": r.get("started_at", r.get("timestamp", r.get("created_at", ""))),
            "progress": r.get("progress", 100 if "completed" in str(r.get("status", "")) else 0),
        }
        for r in runs
    ]


def adapt_eval_run_detail(raw: dict[str, Any]) -> dict[str, Any]:
    """适配评测运行详情 → 前端 EvalRunDetail 类型。

    Accepts both:
    - sync ``run_eval`` shape: ``{run_id, summary, results, ...}``
    - ``get_eval_run`` shape: ``{run: {...}, results: [...]}``
    """
    run = raw.get("run") if isinstance(raw.get("run"), dict) else None
    base = run or (raw if isinstance(raw, dict) else {})
    summary = base.get("summary") or raw.get("summary") or {}
    if isinstance(summary, str):
        try:
            summary = json.loads(summary)
        except (ValueError, TypeError):
            summary = {}
    results = raw.get("results") or []
    by_category = summary.get("by_category", {}) if isinstance(summary, dict) else {}

    dimensions = []
    for cat, stat in (by_category or {}).items():
        total = stat.get("total", 0)
        passed = stat.get("passed", 0)
        score = round(passed / total * 100, 1) if total > 0 else 0
        status = "success" if score >= 80 else ("warning" if score >= 60 else "failed")
        dimensions.append({"name": cat, "score": score, "status": status})

    from evoflow.eval.modules import enrich_case_row, module_label, resolve_module

    cases = []
    for r in results:
        metrics = r.get("metrics") if isinstance(r.get("metrics"), dict) else {}
        assertions = r.get("assertions")
        if not assertions and isinstance(metrics, dict):
            assertions = metrics.get("assertions") or []
        nested_metrics = (
            metrics.get("metrics") if isinstance(metrics.get("metrics"), dict) else {}
        )
        provenance = r.get("provenance") or metrics.get("provenance") or {}
        case_id = r.get("case_id", r.get("id", ""))
        enriched = enrich_case_row(dict(r))
        mod = enriched.get("module") or resolve_module(
            str(case_id),
            category=str(r.get("category") or ""),
            params=r.get("params") if isinstance(r.get("params"), dict) else {},
        )
        cases.append(
            {
                "id": case_id,
                "name": r.get("case_name", r.get("name", "")),
                "category": r.get("category", ""),
                "module": mod,
                "module_label": enriched.get("module_label") or module_label(mod),
                "level": r.get("level", ""),
                "level_label": enriched.get("level_label", ""),
                "handler": r.get("handler")
                or (provenance or {}).get("handler")
                or "",
                "description": r.get("description") or "",
                "params": enriched.get("params") or r.get("params") or {},
                "design": enriched.get("design") or {},
                "priority": enriched.get("priority") or "",
                "priority_label": enriched.get("priority_label") or "",
                "flow": enriched.get("flow") or "",
                "flow_label": enriched.get("flow_label") or "",
                "status": _normalize_case_status(r.get("status", "")),
                "score": r.get("score"),
                "message": r.get("detail", r.get("message", "")),
                "detail": r.get("detail", r.get("message", "")),
                "duration_ms": r.get("duration_ms") or metrics.get("duration_ms"),
                "assertions": assertions or [],
                "steps": r.get("steps") or metrics.get("steps") or [],
                "provenance": provenance,
                "metrics": nested_metrics or {
                    k: v
                    for k, v in (metrics or {}).items()
                    if k
                    not in (
                        "assertions",
                        "steps",
                        "provenance",
                        "ok",
                        "status",
                        "detail",
                        "score",
                        "duration_ms",
                    )
                },
                "raw_metrics": metrics,
                "mock": bool((provenance or {}).get("mock", False)),
            }
        )

    pass_rate = summary.get("pass_rate") if isinstance(summary, dict) else None
    if pass_rate is None:
        total_c = int(base.get("total_cases") or len(cases) or 0)
        passed_c = int(base.get("passed_cases") or 0)
        pass_rate = (passed_c / total_c) if total_c else 0

    return {
        "id": base.get("id") or base.get("run_id") or raw.get("run_id") or "",
        "run_id": base.get("run_id") or raw.get("run_id") or base.get("id") or "",
        "name": base.get("name", ""),
        "type": base.get("type", "custom"),
        "status": _normalize_run_status(base.get("status", raw.get("status", ""))),
        "passRate": pass_rate,
        "passed_cases": base.get("passed_cases"),
        "failed_cases": base.get("failed_cases"),
        "total_cases": base.get("total_cases") or len(cases),
        "duration_ms": (
            (summary or {}).get("duration_ms")
            if isinstance(summary, dict) and (summary or {}).get("duration_ms")
            else base.get("duration_ms")
            or (
                int(base.get("finished_at_ms") or 0) - int(base.get("started_at_ms") or 0)
                if base.get("finished_at_ms") and base.get("started_at_ms")
                else 0
            )
        ),
        "duration": _fmt_duration_ms(
            (summary or {}).get("duration_ms")
            if isinstance(summary, dict) and (summary or {}).get("duration_ms")
            else base.get("duration_ms")
            or (
                int(base.get("finished_at_ms") or 0) - int(base.get("started_at_ms") or 0)
                if base.get("finished_at_ms") and base.get("started_at_ms")
                else 0
            )
        ),
        "startedAt": base.get("started_at")
        or base.get("started_at_ms")
        or base.get("created_at_ms")
        or _iso_now(),
        "triggeredBy": base.get("triggered_by", "system"),
        "dimensions": dimensions,
        "cases": cases,
        "results": cases,
        "summary": summary,
        "run": base,
    }


def adapt_eval_progress(raw: dict[str, Any]) -> dict[str, Any]:
    """适配评测进度 → 前端轮询字段。"""
    return {
        "run_id": raw.get("run_id"),
        "progress": raw.get("progress", 0),
        "status": _normalize_run_status(raw.get("status", "pending")),
        "passed_cases": raw.get("passed_cases"),
        "failed_cases": raw.get("failed_cases"),
        "total_cases": raw.get("total_cases"),
        "updated_at_ms": raw.get("updated_at_ms"),
    }


def adapt_compare_evals(raw: dict[str, Any]) -> dict[str, Any]:
    """适配评测对比 → 前端对比数据。"""
    runs = raw.get("runs", []) if isinstance(raw, dict) else raw
    return {
        "runIds": [r.get("id", r.get("run_id", "")) for r in runs],
        "runs": [
            {
                "id": r.get("id", r.get("run_id", "")),
                "name": r.get("name", ""),
                "score": r.get("score", r.get("pass_rate", 0)),
                "status": _normalize_run_status(r.get("status", "")),
            }
            for r in runs
        ],
    }


# ---------------------------------------------------------------------------
# 状态归一化
# ---------------------------------------------------------------------------

def _normalize_run_status(status: str) -> str:
    """将后端状态归一化为前端 EvalRunStatus。"""
    s = str(status).lower().strip()
    if not s:
        return "pending"
    if s in ("running", "in_progress", "progress"):
        return "running"
    if "running" in s:
        return "running"
    if s in ("queued", "pending"):
        return "pending"
    if "queued" in s or "pending" in s:
        return "pending"
    if s in ("error", "failed") or s.endswith("_error"):
        return "failed"
    if "fail" in s or "error" in s:
        # completed_with_failures → completed (run finished; failures in cases)
        if "completed" in s:
            return "completed"
        return "failed"
    if "completed" in s or s in ("done", "success", "ok"):
        return "completed"
    return s


def _normalize_case_status(status: str) -> str:
    """将后端用例状态归一化为前端 success/warning/failed。"""
    s = str(status).lower()
    if "pass" in s or "success" in s:
        return "success"
    if "fail" in s or "error" in s:
        return "failed"
    if "warn" in s or "degraded" in s:
        return "warning"
    return "success"
