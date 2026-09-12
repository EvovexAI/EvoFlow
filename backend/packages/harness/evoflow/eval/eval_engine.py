"""Evaluation engine - run management, case registry, history, compare.

Dual engines:
- scenario       — isolated temp DB, real admin/harness APIs (no LLM)
- observational  — aggregates over production evoflow.db

Core tables:
- eval_runs / eval_cases / eval_case_results
- eval_schedules / eval_alert_rules / eval_alerts
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from typing import Any

from evoflow.persistence.db import get_db

logger = logging.getLogger(__name__)

_SECURITY_SMOKE_IDS = {
    "sec_data_leak",
    "sec_permission",
    "sec_vuln",
}

# Serialize full runs so scenario isolation cannot race progress polling on shared DB.
_RUN_LOCK = threading.RLock()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_run_id() -> str:
    return "eval_" + uuid.uuid4().hex[:16]


def _new_alert_id() -> str:
    return "alrt_" + uuid.uuid4().hex[:12]


def _table_exists(db: Any, name: str) -> bool:
    try:
        row = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
        return row is not None
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# Case listing
# ---------------------------------------------------------------------------

def list_eval_cases(
    category: str | None = None,
    level: str | None = None,
    enabled_only: bool = True,
) -> dict[str, Any]:
    """List available evaluation cases."""
    db = get_db()

    if not _table_exists(db, "eval_cases"):
        return {"total": 0, "cases": [], "_table_missing": True}

    where = []
    params: list[Any] = []
    if category:
        where.append("category = ?")
        params.append(category)
    if level:
        where.append("level = ?")
        params.append(level)
    if enabled_only:
        where.append("enabled = 1")

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    try:
        rows = db.execute(
            f"""
            SELECT id, name, category, level, description, handler, params_json,
                   enabled, created_at_ms
            FROM eval_cases
            {where_sql}
            ORDER BY category, level, id
            """,
            params,
        ).fetchall()
    except Exception:  # noqa: BLE001
        logger.exception("list_eval_cases failed")
        return {"total": 0, "cases": [], "_table_missing": False}

    from evoflow.eval.modules import enrich_case_row

    cases = []
    for r in rows:
        params_json = r["params_json"] if isinstance(r["params_json"], str) else "{}"
        try:
            params_obj = json.loads(params_json)
        except (ValueError, TypeError):
            params_obj = {}
        cases.append(
            enrich_case_row(
                {
                    "id": r["id"],
                    "name": r["name"],
                    "category": r["category"],
                    "level": r["level"],
                    "description": r["description"],
                    "handler": r["handler"],
                    "params": params_obj,
                    "enabled": bool(r["enabled"]),
                    "created_at_ms": r["created_at_ms"],
                }
            )
        )

    return {"total": len(cases), "cases": cases, "_table_missing": False}


def _select_cases_for_mode(
    mode: str,
    case_ids: list[str] | None,
    all_cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Filter cases by run mode / legacy type aliases."""
    if case_ids:
        return [c for c in all_cases if c["id"] in case_ids]

    m = (mode or "smoke").strip().lower()

    if m in ("smoke", "scenario"):
        selected = [c for c in all_cases if c.get("category") == "scenario"]
        if m == "smoke":
            # smoke = P0 ∧ (L0|L1|P0-saga) + security L1
            from evoflow.eval.case_spec import is_smoke_case

            selected = [c for c in selected if is_smoke_case(c)]
            security_smoke = [
                c
                for c in all_cases
                if c.get("category") == "security"
                and (c.get("level") == "L1" or c["id"] in _SECURITY_SMOKE_IDS)
            ]
            seen = {c["id"] for c in selected}
            for c in security_smoke:
                if c["id"] not in seen:
                    selected.append(c)
                    seen.add(c["id"])
        return selected

    if m == "observational":
        return [c for c in all_cases if c.get("category") != "scenario"]

    if m == "full":
        return list(all_cases)

    if m == "security":
        return [c for c in all_cases if c.get("category") == "security"]
    if m == "performance":
        return [c for c in all_cases if c.get("category") == "performance"]
    if m == "business":
        return [c for c in all_cases if c.get("category") == "business"]

    # legacy: type=smoke meant L1 only
    if m == "l1":
        return [c for c in all_cases if c.get("level") == "L1"]

    return list(all_cases)


# ---------------------------------------------------------------------------
# Case execution (handler whitelist)
# ---------------------------------------------------------------------------

def _run_case(case_id: str, handler: str, params: dict, days: int) -> dict[str, Any]:
    """Execute a single eval case via handler whitelist."""
    from evoflow.eval import business_quality as bq
    from evoflow.eval import data_sources as ds
    from evoflow.eval import performance as perf
    from evoflow.eval import security as sec
    from evoflow.eval.scenarios import HANDLER_MAP as SCENARIO_HANDLERS

    OBS_HANDLER_MAP: dict[str, tuple] = {
        # business
        "eval.business.task_completion": (bq.evaluate_task_quality, {"days": days}),
        "eval.business.tool_success": (bq.evaluate_tool_reliability, {"days": days}),
        "eval.business.kb_hit": (ds.get_knowledge_stats, {"days": days}),
        "eval.business.conversation": (bq.evaluate_conversation_quality, {"days": days}),
        "eval.business.intervention": (bq.evaluate_intervention_rate, {"days": days}),
        "eval.business.task_consistency": (bq.evaluate_task_consistency, {"days": days}),
        # security
        "eval.security.data_leak": (sec.scan_data_leaks, {"days": days, "limit": 20}),
        "eval.security.permission": (sec.get_permission_matrix, {}),
        "eval.security.audit": (sec.get_audit_stats, {"days": days}),
        "eval.security.vulnerability": (sec.check_security_config, {}),
        # performance
        "eval.performance.latency": (perf.get_latency_distribution, {"days": days}),
        "eval.performance.error_rate": (perf.get_error_stats, {"days": days}),
        "eval.performance.tool_latency": (perf.get_module_latency_breakdown, {"days": days}),
    }

    if handler in SCENARIO_HANDLERS or str(handler).startswith("eval.scenario."):
        t0 = _now_ms()
        try:
            # Subprocess isolation: never mutate Gateway process EVOFLOW_* / shared DB.
            use_inline = bool((params or {}).get("inline")) or os.environ.get(
                "EVOFLOW_EVAL_INLINE", ""
            ).strip() in ("1", "true", "yes")
            runner = "inline"
            if use_inline and handler in SCENARIO_HANDLERS:
                result = SCENARIO_HANDLERS[handler](
                    **{k: v for k, v in (params or {}).items() if k != "inline"}
                )
            else:
                from evoflow.eval.scenarios._subprocess import run_handler_subprocess

                runner = "subprocess"
                result = run_handler_subprocess(handler)
            if isinstance(result, dict):
                prov = dict(result.get("provenance") or {})
                prov["mock"] = False
                prov["runner"] = runner
                prov["handler"] = handler
                result["provenance"] = prov
            duration = int(result.get("duration_ms") or (_now_ms() - t0))
            status = str(result.get("status") or ("passed" if result.get("ok") else "failed"))
            score = result.get("score")
            if score is None:
                score = 100.0 if status == "passed" else 0.0
            return {
                "status": status,
                "score": float(score),
                "detail": str(result.get("detail") or ""),
                "metrics": result if isinstance(result, dict) else {"value": result},
                "duration_ms": duration,
                "handler": handler,
            }
        except Exception as e:  # noqa: BLE001
            duration = _now_ms() - t0
            logger.exception("scenario case %s failed", case_id)
            return {
                "status": "error",
                "score": 0,
                "detail": str(e)[:500],
                "metrics": {},
                "duration_ms": duration,
            }

    if handler not in OBS_HANDLER_MAP:
        return {
            "status": "skipped",
            "score": 0,
            "detail": f"Unknown handler: {handler}",
            "metrics": {},
            "duration_ms": 0,
        }

    func, default_params = OBS_HANDLER_MAP[handler]
    merged_params = {**default_params, **(params or {})}

    t0 = _now_ms()
    try:
        result = func(**merged_params)
        duration = _now_ms() - t0

        score = None
        if isinstance(result, dict):
            if "score" in result:
                score = float(result["score"])
            elif "completion_rate" in result:
                score = float(result["completion_rate"]) * 100
            elif "success_rate" in result:
                score = float(result["success_rate"]) * 100
            elif "pass_rate" in result:
                score = float(result["pass_rate"]) * 100

        status = "passed" if (score is None or score >= 60) else "failed"

        return {
            "status": status,
            "score": score,
            "detail": str((result or {}).get("detail") or "") if isinstance(result, dict) else "",
            "metrics": result if isinstance(result, dict) else {"value": result},
            "duration_ms": duration,
        }
    except Exception as e:  # noqa: BLE001
        duration = _now_ms() - t0
        logger.exception("eval case %s failed", case_id)
        return {
            "status": "error",
            "score": 0,
            "detail": str(e)[:500],
            "metrics": {},
            "duration_ms": duration,
        }


# ---------------------------------------------------------------------------
# Alert evaluation
# ---------------------------------------------------------------------------

def _evaluate_alerts_for_run(run_id: str, summary: dict[str, Any], results: list[dict]) -> list[dict]:
    """Match enabled alert rules against run summary; persist triggered alerts."""
    db = get_db()
    if not _table_exists(db, "eval_alert_rules"):
        return []

    try:
        rows = db.execute(
            "SELECT * FROM eval_alert_rules WHERE enabled = 1"
        ).fetchall()
    except Exception:  # noqa: BLE001
        return []

    pass_rate = float(summary.get("pass_rate") or 0) * 100.0
    scenario_results = [r for r in results if r.get("category") == "scenario"]
    scenario_total = len(scenario_results)
    scenario_passed = sum(1 for r in scenario_results if r.get("status") == "passed")
    scenario_pass_rate = (scenario_passed / scenario_total * 100.0) if scenario_total else None

    metric_values: dict[str, float | None] = {
        "pass_rate": pass_rate,
        "scenario_pass_rate": scenario_pass_rate,
        "failed_cases": float(summary.get("failed_cases") or 0),
    }

    triggered: list[dict[str, Any]] = []
    now = _now_ms()

    def _match(op: str, value: float, threshold: float) -> bool:
        if op in ("lt", "<"):
            return value < threshold
        if op in ("lte", "<="):
            return value <= threshold
        if op in ("gt", ">"):
            return value > threshold
        if op in ("gte", ">="):
            return value >= threshold
        if op in ("eq", "=="):
            return abs(value - threshold) < 1e-9
        return False

    for row in rows:
        metric = str(row["metric"] or "pass_rate")
        value = metric_values.get(metric)
        if value is None:
            continue
        op = str(row["operator"] or "lt")
        threshold = float(row["threshold"] or 0)
        if not _match(op, float(value), threshold):
            continue
        alert_id = _new_alert_id()
        message = (
            f"{row['name']}: {metric}={value:.1f} {op} {threshold}"
        )
        alert = {
            "id": alert_id,
            "rule_id": row["id"],
            "run_id": run_id,
            "level": row["level"] or "warn",
            "dimension": row["dimension"] or "",
            "metric": metric,
            "message": message,
            "value": float(value),
            "threshold": threshold,
            "created_at_ms": now,
        }
        if _table_exists(db, "eval_alerts"):
            try:
                db.execute(
                    """
                    INSERT INTO eval_alerts
                        (id, rule_id, run_id, level, dimension, metric, message, value, threshold, created_at_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        alert["id"],
                        alert["rule_id"],
                        alert["run_id"],
                        alert["level"],
                        alert["dimension"],
                        alert["metric"],
                        alert["message"],
                        alert["value"],
                        alert["threshold"],
                        alert["created_at_ms"],
                    ),
                )
            except Exception:  # noqa: BLE001
                logger.exception("insert eval alert failed")
        triggered.append(alert)

    try:
        db.commit()
    except Exception:  # noqa: BLE001
        pass
    return triggered


def list_eval_alerts(limit: int = 50, run_id: str | None = None) -> dict[str, Any]:
    db = get_db()
    if not _table_exists(db, "eval_alerts"):
        return {"total": 0, "alerts": [], "_table_missing": True}
    try:
        if run_id:
            rows = db.execute(
                "SELECT * FROM eval_alerts WHERE run_id = ? ORDER BY created_at_ms DESC LIMIT ?",
                (run_id, limit),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM eval_alerts ORDER BY created_at_ms DESC LIMIT ?",
                (limit,),
            ).fetchall()
    except Exception:  # noqa: BLE001
        return {"total": 0, "alerts": [], "_table_missing": False}
    alerts = [dict(r) for r in rows]
    return {"total": len(alerts), "alerts": alerts, "_table_missing": False}


# ---------------------------------------------------------------------------
# Run evaluation
# ---------------------------------------------------------------------------

def _execute_run(
    run_id: str,
    name: str,
    mode: str,
    selected: list[dict[str, Any]],
    days: int,
) -> dict[str, Any]:
    db = get_db()
    now = _now_ms()
    passed = 0
    failed = 0
    results: list[dict[str, Any]] = []

    for i, case in enumerate(selected):
        case_result = _run_case(case["id"], case["handler"], case["params"], days)
        # After scenario isolation, ensure we write to production DB.
        db = get_db()
        try:
            db.execute(
                """
                INSERT INTO eval_case_results
                    (run_id, case_id, status, score, metrics_json, detail,
                     started_at_ms, finished_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    case["id"],
                    case_result["status"],
                    case_result.get("score"),
                    json.dumps(case_result.get("metrics", {}), ensure_ascii=False, default=str),
                    case_result.get("detail", ""),
                    now,
                    _now_ms(),
                ),
            )
        except Exception:  # noqa: BLE001
            logger.exception("insert case result failed")

        if case_result["status"] == "passed":
            passed += 1
        else:
            failed += 1

        results.append({
            "case_id": case["id"],
            "case_name": case["name"],
            "category": case["category"],
            **case_result,
        })

        progress = int((i + 1) / len(selected) * 100) if selected else 100
        try:
            db.execute(
                "UPDATE eval_runs SET progress = ?, passed_cases = ?, failed_cases = ?, updated_at_ms = ? WHERE run_id = ?",
                (progress, passed, failed, _now_ms(), run_id),
            )
            db.commit()
        except Exception:  # noqa: BLE001
            pass

    finish_ms = _now_ms()
    total = len(selected)

    by_cat: dict[str, dict[str, int]] = {}
    for r in results:
        cat = r["category"]
        if cat not in by_cat:
            by_cat[cat] = {"total": 0, "passed": 0}
        by_cat[cat]["total"] += 1
        if r["status"] == "passed":
            by_cat[cat]["passed"] += 1

    summary = {
        "total_cases": total,
        "passed_cases": passed,
        "failed_cases": failed,
        "pass_rate": round(passed / total, 4) if total else 0.0,
        "duration_ms": finish_ms - now,
        "by_category": by_cat,
        "mode": mode,
    }

    status = "completed" if failed == 0 else "completed_with_failures"
    alerts = _evaluate_alerts_for_run(run_id, summary, results)
    summary["alerts_triggered"] = len(alerts)

    try:
        db = get_db()
        db.execute(
            """
            UPDATE eval_runs
            SET status = ?, summary_json = ?, passed_cases = ?, failed_cases = ?,
                finished_at_ms = ?, progress = 100, updated_at_ms = ?
            WHERE run_id = ?
            """,
            (
                status,
                json.dumps(summary, ensure_ascii=False),
                passed,
                failed,
                finish_ms,
                finish_ms,
                run_id,
            ),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("finalize eval run failed")

    return {
        "run_id": run_id,
        "name": name,
        "type": mode,
        "status": status,
        "summary": summary,
        "results": results,
        "alerts": alerts,
        "_table_missing": False,
    }


def run_eval(
    name: str,
    type: str = "smoke",  # noqa: A002 - keep API field name
    case_ids: list[str] | None = None,
    config: dict | None = None,
    *,
    async_mode: bool = False,
) -> dict[str, Any]:
    """Execute an evaluation run.

    ``type`` / mode: smoke | full | scenario | observational | security | performance | business
    When ``async_mode=True``, returns immediately with run_id; progress via get_eval_progress.
    """
    db = get_db()

    if not _table_exists(db, "eval_runs"):
        return {
            "run_id": None,
            "error": "eval tables not initialized",
            "_table_missing": True,
        }

    config = config or {}
    days = int(config.get("days", 7))
    mode = str(config.get("mode") or type or "smoke").strip().lower()

    all_cases = list_eval_cases()["cases"]
    selected = _select_cases_for_mode(mode, case_ids, all_cases)

    run_id = _new_run_id()
    now = _now_ms()
    cfg_store = {**config, "mode": mode, "days": days}

    try:
        db.execute(
            """
            INSERT INTO eval_runs
                (run_id, name, type, status, config_json, total_cases, progress,
                 created_at_ms, started_at_ms, updated_at_ms)
            VALUES (?, ?, ?, 'running', ?, ?, 0, ?, ?, ?)
            """,
            (
                run_id,
                name,
                mode,
                json.dumps(cfg_store, ensure_ascii=False),
                len(selected),
                now,
                now,
                now,
            ),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("create eval run failed")
        return {"run_id": None, "error": "failed to create run record"}

    if async_mode:
        def _bg() -> None:
            with _RUN_LOCK:
                try:
                    _execute_run(run_id, name, mode, selected, days)
                except Exception:  # noqa: BLE001
                    logger.exception("async eval run failed run_id=%s", run_id)
                    try:
                        db2 = get_db()
                        db2.execute(
                            "UPDATE eval_runs SET status = 'error', updated_at_ms = ? WHERE run_id = ?",
                            (_now_ms(), run_id),
                        )
                        db2.commit()
                    except Exception:  # noqa: BLE001
                        pass

        threading.Thread(target=_bg, name=f"eval-{run_id}", daemon=True).start()
        return {
            "run_id": run_id,
            "name": name,
            "type": mode,
            "status": "running",
            "async": True,
            "total_cases": len(selected),
            "_table_missing": False,
        }

    with _RUN_LOCK:
        return _execute_run(run_id, name, mode, selected, days)


# ---------------------------------------------------------------------------
# Run queries
# ---------------------------------------------------------------------------

def _row_to_run_dict(row: Any) -> dict[str, Any]:
    d = {}
    for key in row.keys():
        d[key] = row[key]
    for field in ("config_json", "summary_json"):
        if field in d and d[field]:
            try:
                d[field.replace("_json", "")] = json.loads(d[field])
            except (ValueError, TypeError):
                pass
    return d


def get_eval_run(run_id: str) -> dict[str, Any]:
    """Get eval run detail with case results."""
    db = get_db()

    if not _table_exists(db, "eval_runs"):
        return {"run": None, "results": [], "_table_missing": True}

    try:
        row = db.execute(
            "SELECT * FROM eval_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return {"run": None, "results": [], "_table_missing": True}

    if not row:
        return {"run": None, "results": [], "_table_missing": False}

    run_dict = _row_to_run_dict(row)

    try:
        result_rows = db.execute(
            """
            SELECT r.*, c.name AS case_name, c.category, c.level,
                   c.handler AS case_handler, c.description AS case_description,
                   c.params_json AS case_params_json
            FROM eval_case_results r
            LEFT JOIN eval_cases c ON r.case_id = c.id
            WHERE r.run_id = ?
            ORDER BY r.id ASC
            """,
            (run_id,),
        ).fetchall()
    except Exception:  # noqa: BLE001
        result_rows = []

    from evoflow.eval.modules import enrich_case_row

    results = []
    for r in result_rows:
        metrics = {}
        try:
            metrics = json.loads(r["metrics_json"]) if r["metrics_json"] else {}
        except (ValueError, TypeError):
            pass
        case_params = {}
        try:
            raw_params = r["case_params_json"] if "case_params_json" in r.keys() else None
            case_params = json.loads(raw_params) if raw_params else {}
        except (ValueError, TypeError, KeyError):
            case_params = {}
        assertions = []
        if isinstance(metrics, dict):
            assertions = list(metrics.get("assertions") or [])
        row = enrich_case_row(
            {
                "id": r["case_id"],
                "case_id": r["case_id"],
                "case_name": r["case_name"],
                "category": r["category"],
                "level": r["level"],
                "handler": (r["case_handler"] if "case_handler" in r.keys() else "")
                or (metrics.get("provenance") or {}).get("handler")
                or "",
                "description": r["case_description"] if "case_description" in r.keys() else "",
                "params": case_params,
                "status": r["status"],
                "score": r["score"],
                "metrics": metrics,
                "assertions": assertions,
                "steps": list((metrics or {}).get("steps") or []) if isinstance(metrics, dict) else [],
                "provenance": (metrics or {}).get("provenance") if isinstance(metrics, dict) else None,
                "detail": r["detail"],
                "started_at_ms": r["started_at_ms"],
                "finished_at_ms": r["finished_at_ms"],
                "duration_ms": (
                    int(r["finished_at_ms"] or 0) - int(r["started_at_ms"] or 0)
                    if r["finished_at_ms"] and r["started_at_ms"]
                    else (metrics.get("duration_ms") if isinstance(metrics, dict) else None)
                ),
            }
        )
        results.append(row)

    return {"run": run_dict, "results": results, "_table_missing": False}


def list_eval_runs(
    limit: int = 20,
    offset: int = 0,
    type: str | None = None,  # noqa: A002
    status: str | None = None,
) -> dict[str, Any]:
    """List eval run history."""
    db = get_db()

    if not _table_exists(db, "eval_runs"):
        return {"total": 0, "runs": [], "_table_missing": True}

    where = []
    params: list[Any] = []
    if type:
        where.append("type = ?")
        params.append(type)
    if status:
        where.append("status = ?")
        params.append(status)

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    try:
        total_row = db.execute(
            f"SELECT COUNT(*) AS c FROM eval_runs {where_sql}",
            params,
        ).fetchone()
        total = int(total_row[0]) if total_row else 0

        rows = db.execute(
            f"""
            SELECT * FROM eval_runs
            {where_sql}
            ORDER BY created_at_ms DESC
            LIMIT ? OFFSET ?
            """,
            (*params, limit, offset),
        ).fetchall()
    except Exception:  # noqa: BLE001
        logger.exception("list eval runs failed")
        return {"total": 0, "runs": [], "_table_missing": False}

    runs = [_row_to_run_dict(r) for r in rows]
    return {"total": total, "runs": runs, "_table_missing": False}


def get_eval_progress(run_id: str) -> dict[str, Any]:
    """Get eval run progress."""
    db = get_db()

    if not _table_exists(db, "eval_runs"):
        return {"run_id": run_id, "progress": 0, "status": "unknown",
                "_table_missing": True}

    try:
        row = db.execute(
            """
            SELECT run_id, status, progress, total_cases, passed_cases,
                   failed_cases, updated_at_ms
            FROM eval_runs WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
    except Exception:  # noqa: BLE001
        return {"run_id": run_id, "progress": 0, "status": "unknown",
                "_table_missing": False}

    if not row:
        return {"run_id": run_id, "progress": 0, "status": "not_found",
                "_table_missing": False}

    return {
        "run_id": row["run_id"],
        "status": row["status"],
        "progress": row["progress"],
        "total_cases": row["total_cases"],
        "passed_cases": row["passed_cases"],
        "failed_cases": row["failed_cases"],
        "updated_at_ms": row["updated_at_ms"],
        "_table_missing": False,
    }


def rerun_eval(run_id: str, *, async_mode: bool = False) -> dict[str, Any]:
    """Re-run an evaluation based on an existing run."""
    detail = get_eval_run(run_id)
    if not detail.get("run"):
        return {"error": "run not found",
                "_table_missing": detail.get("_table_missing", False)}

    run = detail["run"]
    config = run.get("config", {})
    case_ids = [r["case_id"] for r in detail.get("results", [])]

    return run_eval(
        name=f"{run.get('name', 'Rerun')} (rerun)",
        type=run.get("type", "custom"),
        case_ids=case_ids if case_ids else None,
        config=config,
        async_mode=async_mode,
    )


def compare_evals(run_ids: list[str]) -> dict[str, Any]:
    """Compare two or more eval runs."""
    runs = []
    all_case_ids: set[str] = set()

    for rid in run_ids:
        detail = get_eval_run(rid)
        if detail.get("run"):
            runs.append(detail)
            for r in detail.get("results", []):
                all_case_ids.add(r["case_id"])

    if len(runs) < 2:
        return {"error": "need at least 2 valid runs", "runs_compared": len(runs)}

    comparison = []
    for case_id in sorted(all_case_ids):
        row = {"case_id": case_id}
        for detail in runs:
            rid = detail["run"]["run_id"]
            match = next(
                (r for r in detail["results"] if r["case_id"] == case_id), None
            )
            row[rid] = {
                "status": match["status"] if match else "not_run",
                "score": match["score"] if match else None,
            }
        comparison.append(row)

    return {
        "runs_compared": len(runs),
        "run_ids": [r["run"]["run_id"] for r in runs],
        "run_names": [r["run"].get("name", "") for r in runs],
        "summary_comparison": [
            {
                "run_id": r["run"]["run_id"],
                "name": r["run"].get("name", ""),
                "total_cases": r["run"].get("total_cases", 0),
                "passed_cases": r["run"].get("passed_cases", 0),
                "failed_cases": r["run"].get("failed_cases", 0),
                "pass_rate": r["run"].get("summary", {}).get("pass_rate", 0),
                "duration_ms": r["run"].get("summary", {}).get("duration_ms", 0),
                "created_at_ms": r["run"].get("created_at_ms"),
            }
            for r in runs
        ],
        "case_comparison": comparison,
    }


def list_scenario_results(limit: int = 1) -> dict[str, Any]:
    """Latest scenario case results for Business UI tab."""
    listing = list_eval_runs(limit=20)
    for run in listing.get("runs") or []:
        detail = get_eval_run(str(run.get("run_id") or ""))
        results = [
            r for r in (detail.get("results") or []) if r.get("category") == "scenario"
        ]
        if results:
            return {
                "run_id": run.get("run_id"),
                "run_name": run.get("name"),
                "status": run.get("status"),
                "results": results,
                "pass_rate": (
                    round(
                        sum(1 for r in results if r.get("status") == "passed") / len(results),
                        4,
                    )
                    if results
                    else 0.0
                ),
            }
    return {"run_id": None, "results": [], "pass_rate": 0.0}
