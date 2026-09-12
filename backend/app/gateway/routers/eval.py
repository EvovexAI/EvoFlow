"""评测中心 API 路由 —— 健康总览 + 业务质量 + 安全中心 + 性能基准 + 评测管理。

所有接口返回统一信封 ``{ "code": 0, "data": {...}, "message": "ok" }``。
核心计算逻辑位于 ``evoflow.eval`` 包（同步函数），此处通过
``app.gateway.db_async.run_db`` 在工作线程中执行，避免阻塞事件循环。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Query, Depends, Request

from app.gateway.db_async import run_db
from evoflow.eval import business_quality as bq
from evoflow.eval import dashboard as dash
from evoflow.eval import data_sources as ds
from evoflow.eval import eval_engine as engine
from evoflow.eval import performance as perf
from evoflow.eval import response_adapters as ad
from evoflow.eval import security as sec

logger = logging.getLogger(__name__)

from evoflow.authz.http_guard import require_org_admin


def _org_admin_dep(request: Request) -> None:
    require_org_admin(request)

router = APIRouter(prefix="/api/eval", tags=["eval"], dependencies=[Depends(_org_admin_dep)])


def _ok(data: Any) -> dict[str, Any]:
    """统一成功响应信封。"""
    return {"code": 0, "data": data, "message": "ok"}


# ---------------------------------------------------------------------------
# 健康总览
# ---------------------------------------------------------------------------

@router.get("/dashboard/summary")
async def dashboard_summary(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """健康总览数据。"""
    data = await run_db(dash.get_dashboard_summary, days)
    return _ok(ad.adapt_dashboard_summary(data))


@router.get("/dashboard/trend")
async def dashboard_trend(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """健康度趋势。"""
    data = await run_db(dash.get_dashboard_trend, days)
    return _ok(ad.adapt_dashboard_trend(data))


@router.get("/dashboard/alerts")
async def dashboard_alerts(
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    """关键告警。"""
    data = await run_db(dash.get_dashboard_alerts, days, limit)
    return _ok(ad.adapt_dashboard_alerts(data))


@router.get("/dashboard/agents-ranking")
async def dashboard_agents_ranking(
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(5, ge=1, le=50),
) -> dict[str, Any]:
    """Agent 排行。"""
    data = await run_db(dash.get_dashboard_agents_ranking, days, limit)
    return _ok(ad.adapt_dashboard_agents_ranking(data))


# ---------------------------------------------------------------------------
# 业务质量
# ---------------------------------------------------------------------------

@router.get("/business/tasks")
async def business_tasks(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """任务质量统计。"""
    data = await run_db(bq.evaluate_task_quality, days)
    return _ok(ad.adapt_task_quality(data))


@router.get("/business/tasks/trend")
async def business_tasks_trend(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """任务质量趋势。"""
    data = await run_db(ds.get_task_trend, days)
    return _ok(ad.adapt_task_trend(data))


@router.get("/business/tools")
async def business_tools(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """工具可靠性统计。"""
    data = await run_db(bq.evaluate_tool_reliability, days)
    return _ok(ad.adapt_tool_reliability(data))


@router.get("/business/tools/trend")
async def business_tools_trend(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """工具可靠性趋势。"""
    data = await run_db(ds.get_tool_trend, days)
    return _ok(ad.adapt_tool_trend(data))


@router.get("/business/knowledge")
async def business_knowledge(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """知识库质量统计。"""
    data = await run_db(ds.get_knowledge_stats, days)
    return _ok(ad.adapt_knowledge_stats(data))


@router.get("/business/conversations")
async def business_conversations(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """对话统计。"""
    data = await run_db(ds.get_conversation_stats, days)
    return _ok(ad.adapt_conversation_stats(data))


@router.get("/business/scenarios")
async def business_scenarios() -> dict[str, Any]:
    """最近一次业务场景回归结果（供 Business「场景」Tab）。"""
    data = await run_db(engine.list_scenario_results, 1)
    return _ok(data)


@router.get("/business/intervention")
async def business_intervention(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """人工介入率。"""
    data = await run_db(bq.evaluate_intervention_rate, days)
    return _ok(data)


# ---------------------------------------------------------------------------
# 安全中心
# ---------------------------------------------------------------------------

@router.get("/security/summary")
async def security_summary(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """安全总览：评分、漏洞统计、数据泄露、权限情况。"""
    data = await run_db(sec.get_security_summary, days)
    return _ok(ad.adapt_security_summary(data))


@router.get("/security/permission-matrix")
async def security_permission_matrix() -> dict[str, Any]:
    """权限矩阵：角色 → 权限点映射。"""
    data = await run_db(sec.get_permission_matrix)
    return _ok(ad.adapt_permission_matrix(data))


@router.get("/security/data-leaks")
async def security_data_leaks(
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """数据泄露扫描结果。"""
    data = await run_db(sec.scan_data_leaks, days, limit)
    return _ok(ad.adapt_data_leaks(data))


@router.get("/security/vulnerabilities")
async def security_vulnerabilities(
    severity: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """漏洞列表（支持按严重级别筛选）。"""
    data = await run_db(sec.list_vulnerabilities, limit, severity)
    return _ok(ad.adapt_vulnerabilities(data))


@router.get("/security/audit-stats")
async def security_audit_stats(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """审计日志统计。"""
    data = await run_db(sec.get_audit_stats, days)
    return _ok(ad.adapt_audit_stats(data))


@router.post("/security/scan")
async def security_scan(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """触发安全扫描（同步执行，返回完整结果）。"""
    data = await run_db(sec.get_security_summary, days)
    return _ok(ad.adapt_security_summary(data))


# ---------------------------------------------------------------------------
# 性能基准
# ---------------------------------------------------------------------------

@router.get("/performance/summary")
async def performance_summary(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """性能总览：P50/P95/P99、QPS、错误率。"""
    data = await run_db(perf.get_performance_summary, days)
    return _ok(ad.adapt_performance_summary(data))


@router.get("/performance/latency-distribution")
async def performance_latency_distribution(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """延迟分布直方图。"""
    data = await run_db(perf.get_latency_distribution, days)
    return _ok(ad.adapt_latency_distribution(data))


@router.get("/performance/trend")
async def performance_latency_trend(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """延迟趋势（按天 P50/P95/P99）。"""
    data = await run_db(perf.get_latency_trend, days)
    return _ok(ad.adapt_latency_trend(data))


@router.get("/performance/version-compare")
async def performance_version_compare() -> dict[str, Any]:
    """版本性能对比（当前版本 vs 上一版本）。"""
    # 基于最近两次完整评测的对比数据
    data = await run_db(engine.compare_evals, [])
    # 若没有评测数据则返回空结构
    if not data or not isinstance(data, dict) or not data.get("runs"):
        return _ok([])
    return _ok(data)


@router.post("/performance/run-load-test")
async def performance_run_load_test(
    config: dict = Body(default_factory=dict),
) -> dict[str, Any]:
    """触发性能压测——本轮未接入压测引擎，明确返回未实现。"""
    del config
    return _ok({
        "ok": False,
        "implemented": False,
        "status": "not_implemented",
        "message": "负载压测引擎尚未接入，请使用 scenario/smoke 做业务回归。",
    })


@router.get("/performance/module-breakdown")
async def performance_module_breakdown(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """各模块延迟对比。"""
    data = await run_db(perf.get_module_latency_breakdown, days)
    return _ok(ad.adapt_module_breakdown(data))


@router.get("/performance/error-stats")
async def performance_error_stats(days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    """错误统计。"""
    data = await run_db(perf.get_error_stats, days)
    return _ok(ad.adapt_error_stats(data))


# ---------------------------------------------------------------------------
# 评测管理
# ---------------------------------------------------------------------------

@router.get("/cases")
async def eval_cases(
    category: str | None = Query(None),
    level: str | None = Query(None),
) -> dict[str, Any]:
    """评测用例列表。"""
    data = await run_db(engine.list_eval_cases, category, level, False)
    return _ok(ad.adapt_eval_cases(data))


@router.get("/architecture")
async def eval_architecture(
    pack: str | None = Query(None, description="employees | workflow；空则返回全部"),
) -> dict[str, Any]:
    """员工/工作流评测体系矩阵（阶段 × 能力 × 覆盖度）。"""
    from evoflow.eval.pack_architecture import list_pack_architectures, pack_architecture_view

    if pack:
        return _ok(pack_architecture_view(pack))
    return _ok(list_pack_architectures())


@router.post("/run")
async def eval_run_start(
    name: str = Body("一键评测", embed=True),
    type: str = Body("smoke", embed=True),  # noqa: A002
    mode: str | None = Body(None, embed=True),
    case_ids: list[str] | None = Body(None, embed=True),
    config: dict | None = Body(None, embed=True),
    async_mode: bool = Body(True, embed=True),
) -> dict[str, Any]:
    """启动一次评测。

    ``mode``/``type``: smoke | full | scenario | observational | security | ...
    默认 ``async_mode=True``：立即返回 run_id，通过 ``/run/{id}/progress`` 轮询。
    """
    cfg = dict(config or {})
    if mode:
        cfg["mode"] = mode
    run_type = str(mode or type or "smoke")

    def _start() -> dict[str, Any]:
        return engine.run_eval(
            name,
            run_type,
            case_ids,
            cfg,
            async_mode=async_mode,
        )

    data = await run_db(_start)
    if data.get("async"):
        return _ok(data)
    return _ok(ad.adapt_eval_run_detail(data))


@router.get("/runs")
async def eval_runs_list(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    type: str | None = Query(None),  # noqa: A002
    status: str | None = Query(None),
) -> dict[str, Any]:
    """评测历史列表。"""
    data = await run_db(engine.list_eval_runs, limit, offset, type, status)
    return _ok(ad.adapt_eval_runs(data))


@router.get("/run/{run_id}")
async def eval_run_detail(run_id: str) -> dict[str, Any]:
    """评测运行详情（含用例结果）。"""
    data = await run_db(engine.get_eval_run, run_id)
    return _ok(ad.adapt_eval_run_detail(data))


@router.get("/run/{run_id}/progress")
async def eval_run_progress(run_id: str) -> dict[str, Any]:
    """评测进度。"""
    data = await run_db(engine.get_eval_progress, run_id)
    return _ok(ad.adapt_eval_progress(data))


@router.post("/run/{run_id}/re-run")
async def eval_run_rerun(
    run_id: str,
    async_mode: bool = Body(True, embed=True),
) -> dict[str, Any]:
    """重新执行评测。"""
    data = await run_db(engine.rerun_eval, run_id, async_mode=async_mode)
    return _ok(data)


@router.get("/alerts")
async def eval_alerts_list(
    limit: int = Query(50, ge=1, le=200),
    run_id: str | None = Query(None),
) -> dict[str, Any]:
    """评测触发的告警历史（面板渠道）。"""
    data = await run_db(engine.list_eval_alerts, limit, run_id)
    return _ok(data)


@router.get("/compare")
async def eval_compare(run_ids: str = Query(..., description="逗号分隔的 run_id 列表")) -> dict[str, Any]:
    """两次或多次评测对比。"""
    ids = [s.strip() for s in run_ids.split(",") if s.strip()]
    data = await run_db(engine.compare_evals, ids)
    return _ok(ad.adapt_compare_evals(data))


# ---------------------------------------------------------------------------
# 评测计划
# ---------------------------------------------------------------------------

@router.get("/schedules")
async def eval_schedules_list() -> dict[str, Any]:
    """评测计划列表。"""
    # 计划数据存储在 eval_schedules 表；表不存在时返回空列表
    def _get_schedules() -> list[dict[str, Any]]:
        from evoflow.persistence.db import get_db
        from evoflow.eval.data_sources import _table_exists, _row_to_dict, _columns
        db = get_db()
        if not _table_exists(db, "eval_schedules"):
            return []
        cols = _columns(db, "eval_schedules")
        rows = db.execute("SELECT * FROM eval_schedules ORDER BY created_at_ms DESC LIMIT 100").fetchall()
        return [_row_to_dict(r, cols) for r in rows]
    data = await run_db(_get_schedules)
    return _ok(data)


@router.post("/schedules")
async def eval_schedules_create(
    name: str = Body(..., embed=True),
    type: str = Body("daily", embed=True),  # noqa: A002
    cron: str = Body("0 2 * * *", embed=True),
    case_ids: list[str] | None = Body(None, embed=True),
    config: dict | None = Body(None, embed=True),
) -> dict[str, Any]:
    """创建评测计划。"""
    def _create() -> dict[str, Any]:
        from evoflow.persistence.db import get_db
        from evoflow.eval.data_sources import _table_exists
        import time
        import uuid
        db = get_db()
        if not _table_exists(db, "eval_schedules"):
            db.execute("""
                CREATE TABLE IF NOT EXISTS eval_schedules (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT DEFAULT 'daily',
                    cron TEXT DEFAULT '0 2 * * *',
                    case_ids TEXT,
                    config TEXT,
                    enabled INTEGER DEFAULT 1,
                    created_at_ms INTEGER,
                    updated_at_ms INTEGER
                )
            """)
        sid = f"sch_{uuid.uuid4().hex[:12]}"
        now = int(time.time() * 1000)
        import json
        db.execute(
            "INSERT INTO eval_schedules (id, name, type, cron, case_ids, config, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
            (sid, name, type, cron, json.dumps(case_ids or []), json.dumps(config or {}), now, now),
        )
        db.commit()
        return {"ok": True, "id": sid}
    data = await run_db(_create)
    return _ok(data)


@router.post("/schedules/{schedule_id}/toggle")
async def eval_schedules_toggle(schedule_id: str) -> dict[str, Any]:
    """切换评测计划启用/停用。"""
    def _toggle() -> dict[str, Any]:
        from evoflow.persistence.db import get_db
        from evoflow.eval.data_sources import _table_exists
        import time
        db = get_db()
        if not _table_exists(db, "eval_schedules"):
            return {"ok": False, "error": "schedule table not found"}
        row = db.execute("SELECT enabled FROM eval_schedules WHERE id = ?", (schedule_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "schedule not found"}
        new_val = 0 if row["enabled"] else 1
        db.execute(
            "UPDATE eval_schedules SET enabled = ?, updated_at_ms = ? WHERE id = ?",
            (new_val, int(time.time() * 1000), schedule_id),
        )
        db.commit()
        return {"ok": True, "enabled": bool(new_val)}
    data = await run_db(_toggle)
    return _ok(data)


# ---------------------------------------------------------------------------
# 告警规则
# ---------------------------------------------------------------------------

@router.get("/alerts/rules")
async def eval_alert_rules_list() -> dict[str, Any]:
    """告警规则列表。"""
    def _get_rules() -> list[dict[str, Any]]:
        from evoflow.persistence.db import get_db
        from evoflow.eval.data_sources import _table_exists, _row_to_dict, _columns
        db = get_db()
        if not _table_exists(db, "eval_alert_rules"):
            return []
        cols = _columns(db, "eval_alert_rules")
        rows = db.execute("SELECT * FROM eval_alert_rules ORDER BY created_at_ms DESC LIMIT 100").fetchall()
        return [_row_to_dict(r, cols) for r in rows]
    data = await run_db(_get_rules)
    return _ok(data)


@router.post("/alerts/rules")
async def eval_alert_rules_create(
    name: str = Body(..., embed=True),
    dimension: str = Body("business", embed=True),
    metric: str = Body("completion_rate", embed=True),
    operator: str = Body("<", embed=True),
    threshold: float = Body(..., embed=True),
    level: str = Body("medium", embed=True),
    channel: str = Body("in_app", embed=True),
) -> dict[str, Any]:
    """创建告警规则。"""
    def _create() -> dict[str, Any]:
        from evoflow.persistence.db import get_db
        from evoflow.eval.data_sources import _table_exists
        import time
        import uuid
        db = get_db()
        if not _table_exists(db, "eval_alert_rules"):
            db.execute("""
                CREATE TABLE IF NOT EXISTS eval_alert_rules (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    dimension TEXT,
                    metric TEXT,
                    operator TEXT,
                    threshold REAL,
                    level TEXT,
                    channel TEXT,
                    enabled INTEGER DEFAULT 1,
                    created_at_ms INTEGER,
                    updated_at_ms INTEGER
                )
            """)
        rid = f"alert_{uuid.uuid4().hex[:12]}"
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO eval_alert_rules (id, name, dimension, metric, operator, threshold, level, channel, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
            (rid, name, dimension, metric, operator, threshold, level, channel, now, now),
        )
        db.commit()
        return {"ok": True, "id": rid}
    data = await run_db(_create)
    return _ok(data)


@router.post("/alerts/rules/{rule_id}/toggle")
async def eval_alert_rules_toggle(rule_id: str) -> dict[str, Any]:
    """切换告警规则启用/停用。"""
    def _toggle() -> dict[str, Any]:
        from evoflow.persistence.db import get_db
        from evoflow.eval.data_sources import _table_exists
        import time
        db = get_db()
        if not _table_exists(db, "eval_alert_rules"):
            return {"ok": False, "error": "alert table not found"}
        row = db.execute("SELECT enabled FROM eval_alert_rules WHERE id = ?", (rule_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "rule not found"}
        new_val = 0 if row["enabled"] else 1
        db.execute(
            "UPDATE eval_alert_rules SET enabled = ?, updated_at_ms = ? WHERE id = ?",
            (new_val, int(time.time() * 1000), rule_id),
        )
        db.commit()
        return {"ok": True, "enabled": bool(new_val)}
    data = await run_db(_toggle)
    return _ok(data)
