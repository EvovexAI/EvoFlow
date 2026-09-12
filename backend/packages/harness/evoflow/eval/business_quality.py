"""业务质量评测器 —— 基于 data_sources 采集的真实数据做量化评估。

各评估函数返回结构化的质量评分与明细，供健康总览与业务质量 API 直接消费。
去 Mock 原则：数据为空返回 0/空结构，不生成随机假数据，不标注 ``_mock``。
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.eval.data_sources import (
    get_task_duration_distribution,
    get_task_stats,
    get_task_trend,
    get_tool_call_stats,
)

logger = logging.getLogger(__name__)


def _clamp(score: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return round(max(lo, min(hi, score)), 1)


def evaluate_task_quality(days: int = 7) -> dict[str, Any]:
    """任务质量评估：完成率、失败率、耗时分布、失败原因。"""
    stats = get_task_stats(days)
    duration = get_task_duration_distribution(days)
    trend = get_task_trend(days)

    total = int(stats.get("total") or 0)
    done = int(stats.get("done") or 0)
    failed = int(stats.get("failed") or 0)
    completion_rate = stats.get("completion_rate") or (done / total if total else 0.0)

    # 综合质量分：完成率权重最高，叠加耗时表现
    duration_score = 100.0
    avg = duration.get("avg") or 0.0
    if avg > 0:
        if avg > 300:
            duration_score = 40.0
        elif avg > 120:
            duration_score = 60.0
        elif avg > 60:
            duration_score = 80.0

    quality_score = _clamp(completion_rate * 100 * 0.7 + duration_score * 0.3)

    return {
        "days": days,
        "total": total,
        "done": done,
        "failed": failed,
        "completion_rate": round(completion_rate, 4),
        "failure_rate": round(failed / total, 4) if total else 0.0,
        "duration": duration,
        "trend": trend,
        "quality_score": quality_score,
        "failure_reasons": get_failure_reasons(days, limit=5),
    }


def evaluate_tool_reliability(days: int = 7) -> dict[str, Any]:
    """工具可靠性评估：成功率、平均耗时、低成功率工具告警。"""
    tool_stats = get_tool_call_stats(days)
    total_calls = int(tool_stats.get("total_calls") or 0)
    tools = tool_stats.get("tools") or []

    success_calls = sum(int(t.get("success") or 0) for t in tools)
    success_rate = (success_calls / total_calls) if total_calls else 0.0

    reliability_score = _clamp(success_rate * 100)
    degraded = [t for t in tools if int(t.get("calls") or 0) > 0 and (t.get("success_rate") or 0) < 0.8]

    return {
        "days": days,
        "total_calls": total_calls,
        "success_rate": round(success_rate, 4),
        "reliability_score": reliability_score,
        "tools": tools,
        "degraded_tools": [
            {"tool": t.get("tool"), "success_rate": t.get("success_rate"), "calls": t.get("calls")}
            for t in degraded
        ],
    }


def evaluate_conversation_quality(days: int = 7) -> dict[str, Any]:
    """对话质量评估：会话规模、消息密度、活跃度。"""
    from evoflow.eval.data_sources import get_conversation_stats

    conv = get_conversation_stats(days)
    sessions = int(conv.get("sessions") or 0)
    messages = int(conv.get("messages") or 0)
    active_users = int(conv.get("active_users") or 0)

    # 基于消息密度给一个质量分
    msgs_per_session = (messages / sessions) if sessions else 0.0
    if msgs_per_session >= 5:
        quality_score = 88.0
    elif msgs_per_session >= 2:
        quality_score = 72.0
    elif sessions > 0:
        quality_score = 60.0
    else:
        quality_score = 0.0

    return {
        "days": days,
        "sessions": sessions,
        "messages": messages,
        "active_users": active_users,
        "messages_per_session": round(msgs_per_session, 2),
        "quality_score": _clamp(quality_score),
    }


def get_agent_ranking(days: int = 7, limit: int = 10) -> dict[str, Any]:
    """Agent / 员工表现排行（优先 collab 任务 assignee，其次 admin agents 列表）。"""
    from evoflow.eval.data_sources import _columns, _table_exists, get_db

    db = get_db()
    limit = max(1, min(int(limit), 50))
    counts: dict[str, dict[str, int]] = {}

    # Prefer collab / mission task assignee fields
    for table, assignee_cols, status_col in (
        ("evoflow_collab_tasks", ("assignee", "assigned_to", "assigned_role"), "status"),
        ("evoflow_mission_nodes", ("assignee", "assigned_to", "owner"), "status"),
    ):
        if not _table_exists(db, table):
            continue
        cols = _columns(db, table)
        agent_col = next((c for c in assignee_cols if c in cols), None)
        if not agent_col or status_col not in cols:
            continue
        try:
            result = db.execute(
                f"""
                SELECT COALESCE({agent_col}, '') AS agent,
                       COUNT(*) AS tasks,
                       SUM(CASE WHEN LOWER(COALESCE({status_col}, ''))
                            IN ('done','completed','reviewed','closed') THEN 1 ELSE 0 END) AS done
                FROM {table}
                WHERE COALESCE({agent_col}, '') != ''
                GROUP BY COALESCE({agent_col}, '')
                """
            ).fetchall()
            for r in result:
                agent = str(r["agent"] or "").strip()
                if not agent:
                    continue
                bucket = counts.setdefault(agent, {"tasks": 0, "done": 0})
                bucket["tasks"] += int(r["tasks"] or 0)
                bucket["done"] += int(r["done"] or 0)
        except Exception:  # noqa: BLE001
            logger.debug("agent ranking from %s failed", table, exc_info=True)

    rows: list[dict[str, Any]] = []
    for agent, c in counts.items():
        tasks = c["tasks"]
        done = c["done"]
        rows.append(
            {
                "agent": agent,
                "tasks": tasks,
                "done": done,
                "completion_rate": round(done / tasks, 4) if tasks else 0.0,
            }
        )

    # Fallback: list configured agents / employees with zero tasks
    if not rows:
        try:
            from evoflow.admin import agents as agents_admin

            listed = agents_admin.list_agents()
            agents = listed.get("agents") or listed.get("items") or []
            for a in agents[:limit]:
                code = str(a.get("agent_code") or a.get("code") or a.get("id") or "").strip()
                if code:
                    rows.append(
                        {"agent": code, "tasks": 0, "done": 0, "completion_rate": 0.0}
                    )
        except Exception:  # noqa: BLE001
            rows = []

    rows.sort(key=lambda x: (x.get("completion_rate") or 0, x.get("tasks") or 0), reverse=True)
    return {"days": days, "ranking": rows[:limit]}


def evaluate_intervention_rate(days: int = 7) -> dict[str, Any]:
    """人工介入率：待审批 / 待确认任务占比（DecisionGate + acceptance）。"""
    from evoflow.eval.data_sources import _columns, _table_exists, get_db

    db = get_db()
    total = 0
    pending_approval = 0
    pending_acceptance = 0

    if _table_exists(db, "evoflow_collab_tasks"):
        cols = _columns(db, "evoflow_collab_tasks")
        if "status" in cols:
            try:
                row = db.execute(
                    "SELECT COUNT(*) AS c FROM evoflow_collab_tasks"
                ).fetchone()
                total = int(row["c"] or 0) if row else 0
                row2 = db.execute(
                    """
                    SELECT COUNT(*) AS c FROM evoflow_collab_tasks
                    WHERE LOWER(COALESCE(status,'')) IN
                      ('waiting_user','pending_approval','awaiting_close','waiting_approval')
                    """
                ).fetchone()
                pending_approval = int(row2["c"] or 0) if row2 else 0
            except Exception:  # noqa: BLE001
                pass

    # Proactive approvals table
    for table in ("proactive_approvals", "evoflow_proactive_approvals"):
        if not _table_exists(db, table):
            continue
        cols = _columns(db, table)
        status_col = "status" if "status" in cols else None
        if not status_col:
            continue
        try:
            row = db.execute(
                f"""
                SELECT COUNT(*) AS c FROM {table}
                WHERE LOWER(COALESCE({status_col},'')) = 'pending'
                """
            ).fetchone()
            pending_approval += int(row["c"] or 0) if row else 0
        except Exception:  # noqa: BLE001
            pass

    intervention = pending_approval + pending_acceptance
    rate = (intervention / total) if total else 0.0
    # Lower intervention is better for autonomy; score inverse of rate
    score = _clamp(100 - rate * 100) if total else 0.0
    return {
        "days": days,
        "total_tasks": total,
        "pending_approval": pending_approval,
        "pending_acceptance": pending_acceptance,
        "intervention_count": intervention,
        "intervention_rate": round(rate, 4),
        "score": score,
    }


def evaluate_task_consistency(days: int = 7) -> dict[str, Any]:
    """任务状态与审批台账轻量一致性：pending_approval 应对应未决审批。"""
    from evoflow.eval.data_sources import _columns, _table_exists, get_db

    del days
    db = get_db()
    waiting_tasks = 0
    pending_approvals = 0
    inconsistencies = 0

    if _table_exists(db, "evoflow_collab_tasks") and "status" in _columns(db, "evoflow_collab_tasks"):
        try:
            row = db.execute(
                """
                SELECT COUNT(*) AS c FROM evoflow_collab_tasks
                WHERE LOWER(COALESCE(status,'')) IN
                  ('waiting_user','pending_approval','waiting_approval')
                """
            ).fetchone()
            waiting_tasks = int(row["c"] or 0) if row else 0
        except Exception:  # noqa: BLE001
            waiting_tasks = 0

    for table in ("proactive_approvals", "evoflow_proactive_approvals"):
        if not _table_exists(db, table):
            continue
        cols = _columns(db, table)
        if "status" not in cols:
            continue
        try:
            row = db.execute(
                f"SELECT COUNT(*) AS c FROM {table} WHERE LOWER(COALESCE(status,'')) = 'pending'"
            ).fetchone()
            pending_approvals += int(row["c"] or 0) if row else 0
        except Exception:  # noqa: BLE001
            pass

    # Soft check: if tasks wait for approval but no pending approval rows → inconsistency signal
    if waiting_tasks > 0 and pending_approvals == 0:
        inconsistencies = waiting_tasks
    elif pending_approvals > waiting_tasks + 5:
        inconsistencies = pending_approvals - waiting_tasks

    checked = max(waiting_tasks, pending_approvals, 1)
    consistency_rate = 1.0 - min(1.0, inconsistencies / checked)
    score = _clamp(consistency_rate * 100)
    return {
        "waiting_tasks": waiting_tasks,
        "pending_approvals": pending_approvals,
        "inconsistencies": inconsistencies,
        "consistency_rate": round(consistency_rate, 4),
        "score": score,
        "detail": "" if inconsistencies == 0 else "waiting tasks / pending approvals mismatch",
    }


def get_failure_reasons(days: int = 7, limit: int = 10) -> dict[str, Any]:
    """失败原因 TOP（基于任务事件表 event_type/原因字段）。"""
    from evoflow.eval.data_sources import _columns, _table_exists, get_db

    db = get_db()
    limit = max(1, min(int(limit), 50))
    reasons: list[dict[str, Any]] = []

    if _table_exists(db, "evoflow_task_events"):
        cols = _columns(db, "evoflow_task_events")
        reason_col = "event_type" if "event_type" in cols else ("reason" if "reason" in cols else None)
        if reason_col:
            try:
                result = db.execute(
                    f"""
                    SELECT {reason_col} AS reason, COUNT(*) AS count
                    FROM evoflow_task_events
                    GROUP BY {reason_col}
                    ORDER BY count DESC
                    """
                ).fetchall()
                for r in result:
                    reasons.append(
                        {"reason": str(r["reason"] or "unknown"), "count": int(r["count"] or 0)}
                    )
            except Exception:  # noqa: BLE001
                reasons = []

    return {"days": days, "reasons": reasons[:limit]}
