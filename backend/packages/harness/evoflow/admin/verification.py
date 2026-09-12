"""System verification rounds (SQLite ``evoflow_verification_*``).

One ``round_id`` covers a full verification cycle; steps accumulate under it
(feature / API / request / response / duration / exceptions).
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.persistence import get_db
from evoflow.persistence.schema import ensure_app_schema
from evoflow.persistence.timestamps import now_iso_z

_ROUND_STATUSES = frozenset(
    {
        "queued",
        "running",
        "passed",
        "failed",
        "completed_with_failures",
        "error",
        "aborted",
    }
)
_STEP_STATUSES = frozenset({"pending", "passed", "failed", "error", "skipped"})
_TERMINAL_ROUND = frozenset(
    {"passed", "failed", "completed_with_failures", "error", "aborted"}
)
_ROUND_STATUS_LABELS = {
    "queued": "待开始",
    "running": "进行中",
    "passed": "通过",
    "failed": "失败",
    "completed_with_failures": "有失败但已完成",
    "error": "异常",
    "aborted": "已中止",
}
_STEP_STATUS_LABELS = {
    "pending": "待开始",
    "passed": "通过",
    "failed": "失败",
    "error": "异常",
    "skipped": "跳过",
}
# Meta domain: excluded from default seed so a round does not list its own APIs.
_SEED_EXCLUDE_DOMAINS = frozenset({"verification"})


def _db():
    db = get_db()
    ensure_app_schema(db)
    return db


def _dumps(value: Any, *, default: Any = None) -> str:
    if value is None:
        value = default if default is not None else {}
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return json.dumps(default if default is not None else {}, ensure_ascii=False)
        if s.startswith(("{", "[")):
            try:
                json.loads(s)
                return s
            except (json.JSONDecodeError, TypeError):
                pass
        return json.dumps(s, ensure_ascii=False)
    return json.dumps(value, ensure_ascii=False)


def _loads(raw: Any, *, default: Any = None) -> Any:
    if raw is None or raw == "":
        return default if default is not None else {}
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return raw
    return raw


def _new_round_id() -> str:
    return "svr_" + uuid.uuid4().hex[:16]


def _clamp_progress(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = 0
    return max(0, min(100, n))


def _normalize_round_status(status: str, *, allow_empty: bool = False) -> str:
    s = str(status or "").strip().lower()
    if not s:
        if allow_empty:
            return ""
        raise ValidationError("status is required")
    if s not in _ROUND_STATUSES:
        raise ValidationError(
            f"invalid round status '{s}'; expected one of {sorted(_ROUND_STATUSES)}"
        )
    return s


def _normalize_step_status(status: str) -> str:
    s = str(status or "").strip().lower() or "pending"
    if s not in _STEP_STATUSES:
        raise ValidationError(
            f"invalid step status '{s}'; expected one of {sorted(_STEP_STATUSES)}"
        )
    return s


def _round_row(row) -> dict[str, Any]:
    status = row[3] or "queued"
    return {
        "roundId": row[0],
        "title": row[1] or "",
        "scenario": row[2] or "",
        "status": status,
        "statusLabel": _ROUND_STATUS_LABELS.get(status, status),
        "progress": int(row[4] or 0),
        "conclusion": row[5] or "",
        "exceptions": _loads(row[6], default=[]),
        "summary": _loads(row[7], default={}),
        "config": _loads(row[8], default={}),
        "createdAt": row[9] or "",
        "startedAt": row[10] or "",
        "finishedAt": row[11] or "",
        "updatedAt": row[12] or "",
    }


def _step_row(row) -> dict[str, Any]:
    status = row[5] or "pending"
    return {
        "id": row[0],
        "roundId": row[1],
        "seq": int(row[2] or 0),
        "feature": row[3] or "",
        "api": row[4] or "",
        "status": status,
        "statusLabel": _STEP_STATUS_LABELS.get(status, status),
        "request": _loads(row[6], default={}),
        "response": _loads(row[7], default={}),
        "result": row[8] or "",
        "detail": row[9] or "",
        "exception": row[10] or "",
        "durationMs": row[11],
        "startedAt": row[12] or "",
        "finishedAt": row[13] or "",
        "createdAt": row[14] or "",
    }


def _parse_domain_list(value: Any) -> list[str] | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        parts = [p.strip().lower() for p in value.replace(";", ",").split(",") if p.strip()]
        return parts or None
    if isinstance(value, (list, tuple)):
        parts = [str(x).strip().lower() for x in value if str(x).strip()]
        return parts or None
    return [str(value).strip().lower()]


def _parse_api_list(value: Any) -> list[str] | None:
    if value is None or value == "":
        return None
    if isinstance(value, str):
        parts = [p.strip() for p in value.replace(";", ",").split(",") if p.strip()]
        return parts or None
    if isinstance(value, (list, tuple)):
        parts = [str(x).strip() for x in value if str(x).strip()]
        return parts or None
    return [str(value).strip()]


def list_api_catalog(
    *,
    domain: str | list[str] | None = None,
    risk: str | list[str] | None = None,
    query: str = "",
    include_verification: bool = False,
) -> dict[str, Any]:
    """Queryable inventory of platform APIs for verification planning."""
    from evoflow.admin.platform_actions import (
        PLATFORM_DOMAINS,
        domain_guide,
        get_registry,
    )

    reg = get_registry()
    domains_filter = _parse_domain_list(domain)
    risks_filter = _parse_domain_list(risk)  # same CSV/list parser
    q = str(query or "").strip().lower()

    items: list[dict[str, Any]] = []
    for action in reg.values():
        if not include_verification and action.domain in _SEED_EXCLUDE_DOMAINS:
            continue
        if domains_filter and action.domain not in domains_filter:
            continue
        if risks_filter and action.risk not in risks_filter:
            continue
        if q:
            hay = f"{action.name} {action.domain} {action.summary} {action.params}".lower()
            if q not in hay:
                continue
        guide = domain_guide(action.domain)
        items.append(
            {
                "api": action.name,
                "feature": action.domain,
                "featureTitle": guide.get("title") or action.domain,
                "summary": action.summary,
                "risk": action.risk,
                "params": action.params,
                "examples": list(action.examples or ()),
            }
        )

    # Stable order: PLATFORM_DOMAINS then action name
    domain_order = {d: i for i, d in enumerate(PLATFORM_DOMAINS)}
    items.sort(key=lambda x: (domain_order.get(x["feature"], 999), x["api"]))

    by_domain: dict[str, list[dict[str, Any]]] = {}
    for it in items:
        by_domain.setdefault(it["feature"], []).append(it)

    domains_out = []
    for d, acts in by_domain.items():
        guide = domain_guide(d)
        domains_out.append(
            {
                "domain": d,
                "title": guide.get("title") or d,
                "when": guide.get("when") or "",
                "count": len(acts),
                "apis": [a["api"] for a in acts],
                "items": acts,
            }
        )
    domains_out.sort(key=lambda x: domain_order.get(x["domain"], 999))

    return {
        "total": len(items),
        "domainCount": len(domains_out),
        "domains": domains_out,
        "items": items,
        "filters": {
            "domain": domains_filter,
            "risk": risks_filter,
            "query": q,
            "includeVerification": bool(include_verification),
        },
    }


def _fetch_round(db, round_id: str) -> dict[str, Any]:
    row = db.execute(
        """SELECT round_id, title, scenario, status, progress, conclusion,
                  exceptions_json, summary_json, config_json,
                  created_at, started_at, finished_at, updated_at
           FROM evoflow_verification_rounds WHERE round_id = ?""",
        (round_id,),
    ).fetchone()
    if row is None:
        raise NotFoundError(f"Verification round '{round_id}' not found")
    return _round_row(row)


def _list_steps(db, round_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        """SELECT id, round_id, seq, feature, api, status,
                  request_json, response_json, result, detail, exception,
                  duration_ms, started_at, finished_at, created_at
           FROM evoflow_verification_steps
           WHERE round_id = ?
           ORDER BY seq ASC, id ASC""",
        (round_id,),
    ).fetchall()
    return [_step_row(r) for r in rows]


def _step_stats(steps: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(steps)
    by = {k: 0 for k in _STEP_STATUSES}
    duration_sum = 0
    duration_n = 0
    for s in steps:
        st = str(s.get("status") or "pending")
        if st in by:
            by[st] += 1
        dm = s.get("durationMs")
        if isinstance(dm, (int, float)) and dm is not None:
            duration_sum += int(dm)
            duration_n += 1
    done = by["passed"] + by["failed"] + by["error"] + by["skipped"]
    progress = int(round(100 * done / total)) if total else 0
    return {
        "total": total,
        "byStatus": by,
        "progressFromSteps": progress,
        "durationMsSum": duration_sum if duration_n else None,
    }


def start_round(
    *,
    title: str = "",
    scenario: str = "",
    round_id: str = "",
    config: Any = None,
    resume: bool = True,
    seed: bool = False,
    domains: Any = None,
    apis: Any = None,
    risks: Any = None,
    include_verification: bool = False,
    only_missing: bool = True,
) -> dict[str, Any]:
    """Create a verification round, or reuse an existing ``round_id``.

    When ``round_id`` already exists and ``resume=True`` (default), returns the
    existing round so the same cycle id can accumulate more steps.

    When ``seed=True``, initialize pending steps from the platform API catalog
    (optionally filtered by ``domains`` / ``apis`` / ``risks``).
    """
    db = _db()
    now = now_iso_z()
    rid = str(round_id or "").strip()
    reused = False
    if rid:
        existing = db.execute(
            "SELECT round_id FROM evoflow_verification_rounds WHERE round_id = ?",
            (rid,),
        ).fetchone()
        if existing is not None:
            if not resume:
                raise ValidationError(
                    f"roundId '{rid}' already exists; pass resume=true to continue"
                )
            reused = True
        else:
            title_s = str(title or "").strip() or "系统验证"
            scenario_s = str(scenario or "").strip()
            cfg = config if config is not None else {}
            if isinstance(cfg, dict):
                cfg = {
                    **cfg,
                    "seed": bool(seed),
                    "domains": _parse_domain_list(domains),
                    "apis": _parse_api_list(apis),
                }
            db.execute(
                """INSERT INTO evoflow_verification_rounds
                   (round_id, title, scenario, status, progress, conclusion,
                    exceptions_json, summary_json, config_json,
                    created_at, started_at, finished_at, updated_at)
                   VALUES (?,?,?,?,0,'','[]','{}',?,?,NULL,NULL,?)""",
                (
                    rid,
                    title_s,
                    scenario_s,
                    "queued",
                    _dumps(cfg, default={}),
                    now,
                    now,
                ),
            )
            db.commit()
    else:
        rid = _new_round_id()
        title_s = str(title or "").strip() or "系统验证"
        scenario_s = str(scenario or "").strip()
        cfg = config if config is not None else {}
        if isinstance(cfg, dict):
            cfg = {
                **cfg,
                "seed": bool(seed),
                "domains": _parse_domain_list(domains),
                "apis": _parse_api_list(apis),
            }
        db.execute(
            """INSERT INTO evoflow_verification_rounds
               (round_id, title, scenario, status, progress, conclusion,
                exceptions_json, summary_json, config_json,
                created_at, started_at, finished_at, updated_at)
               VALUES (?,?,?,?,0,'','[]','{}',?,?,NULL,NULL,?)""",
            (
                rid,
                title_s,
                scenario_s,
                "queued",
                _dumps(cfg, default={}),
                now,
                now,
            ),
        )
        db.commit()

    seeded: dict[str, Any] | None = None
    if seed:
        seeded = seed_pending_steps(
            round_id=rid,
            domains=domains,
            apis=apis,
            risks=risks,
            include_verification=include_verification,
            only_missing=only_missing,
        )

    steps = _list_steps(db, rid)
    return {
        "success": True,
        "reused": reused,
        "round": _fetch_round(db, rid),
        "steps": steps,
        "stats": _step_stats(steps),
        "seeded": seeded,
    }


def seed_pending_steps(
    *,
    round_id: str,
    domains: Any = None,
    apis: Any = None,
    risks: Any = None,
    include_verification: bool = False,
    only_missing: bool = True,
) -> dict[str, Any]:
    """Initialize pending（待开始）steps from the platform API catalog."""
    rid = str(round_id or "").strip()
    if not rid:
        raise ValidationError("roundId is required")

    db = _db()
    _fetch_round(db, rid)

    catalog = list_api_catalog(
        domain=domains,
        risk=risks,
        include_verification=include_verification,
    )
    wanted = catalog["items"]
    api_filter = _parse_api_list(apis)
    if api_filter:
        allow = set(api_filter)
        wanted = [it for it in wanted if it["api"] in allow]
        missing = sorted(allow - {it["api"] for it in wanted})
        if missing:
            raise ValidationError(f"unknown apis for seed: {missing}")

    if not wanted:
        return {
            "success": True,
            "added": 0,
            "skippedExisting": 0,
            "totalPending": 0,
            "apis": [],
        }

    existing_apis: set[str] = set()
    if only_missing:
        rows = db.execute(
            "SELECT api FROM evoflow_verification_steps WHERE round_id = ?",
            (rid,),
        ).fetchall()
        existing_apis = {str(r[0] or "") for r in rows if r[0]}

    row = db.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM evoflow_verification_steps WHERE round_id = ?",
        (rid,),
    ).fetchone()
    seq_n = int(row[0] or 0)
    now = now_iso_z()
    added: list[str] = []
    skipped = 0

    for it in wanted:
        api = it["api"]
        if only_missing and api in existing_apis:
            skipped += 1
            continue
        seq_n += 1
        db.execute(
            """INSERT INTO evoflow_verification_steps
               (round_id, seq, feature, api, status,
                request_json, response_json, result, detail, exception,
                duration_ms, started_at, finished_at, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)""",
            (
                rid,
                seq_n,
                it["feature"],
                api,
                "pending",
                _dumps(
                    {
                        "params": it.get("params") or "",
                        "risk": it.get("risk") or "read",
                    },
                    default={},
                ),
                "{}",
                "待开始",
                str(it.get("summary") or ""),
                "",
                now,
            ),
        )
        added.append(api)

    # Keep round queued（待开始）until a non-pending step is recorded.
    db.execute(
        """UPDATE evoflow_verification_rounds
           SET status = CASE WHEN status IN ('passed','failed','completed_with_failures','error','aborted')
                             THEN status ELSE 'queued' END,
               progress = 0,
               updated_at = ?,
               finished_at = NULL
           WHERE round_id = ?""",
        (now, rid),
    )
    db.commit()
    steps = _list_steps(db, rid)
    return {
        "success": True,
        "added": len(added),
        "skippedExisting": skipped,
        "totalPending": _step_stats(steps)["byStatus"]["pending"],
        "apis": added,
        "stats": _step_stats(steps),
    }


def list_rounds(
    *,
    status: str = "",
    query: str = "",
    limit: int = 20,
) -> dict[str, Any]:
    db = _db()
    limit = min(max(1, int(limit or 20)), 100)
    conditions: list[str] = []
    params: list[Any] = []
    st = str(status or "").strip().lower()
    if st:
        _normalize_round_status(st)
        conditions.append("status = ?")
        params.append(st)
    q = str(query or "").strip()
    if q:
        like = f"%{q}%"
        conditions.append("(title LIKE ? OR scenario LIKE ? OR conclusion LIKE ?)")
        params.extend([like, like, like])
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = db.execute(
        f"""SELECT round_id, title, scenario, status, progress, conclusion,
                   exceptions_json, summary_json, config_json,
                   created_at, started_at, finished_at, updated_at
            FROM evoflow_verification_rounds
            {where}
            ORDER BY updated_at DESC
            LIMIT ?""",
        (*params, limit),
    ).fetchall()
    rounds = [_round_row(r) for r in rows]
    return {"total": len(rounds), "rounds": rounds}


def get_round(round_id: str, *, include_steps: bool = True) -> dict[str, Any]:
    rid = str(round_id or "").strip()
    if not rid:
        raise ValidationError("roundId is required")
    db = _db()
    round_data = _fetch_round(db, rid)
    steps = _list_steps(db, rid) if include_steps else []
    return {
        "round": round_data,
        "steps": steps,
        "stats": _step_stats(steps) if include_steps else None,
    }


def record_step(
    *,
    round_id: str,
    feature: str = "",
    api: str = "",
    status: str = "pending",
    request: Any = None,
    response: Any = None,
    result: str = "",
    detail: str = "",
    exception: str = "",
    duration_ms: int | None = None,
    seq: int | None = None,
    started_at: str = "",
    finished_at: str = "",
    upsert: bool = True,
) -> dict[str, Any]:
    rid = str(round_id or "").strip()
    if not rid:
        raise ValidationError("roundId is required")
    feature_s = str(feature or "").strip()
    api_s = str(api or "").strip()
    if not feature_s and not api_s:
        raise ValidationError("feature or api is required")

    db = _db()
    round_data = _fetch_round(db, rid)
    now = now_iso_z()
    step_status = _normalize_step_status(status)

    dm: int | None
    if duration_ms is None or duration_ms == "":
        dm = None
    else:
        try:
            dm = max(0, int(duration_ms))
        except (TypeError, ValueError) as exc:
            raise ValidationError("durationMs must be an integer") from exc

    started = str(started_at or "").strip()
    if not started and step_status != "pending":
        started = now
    finished = str(finished_at or "").strip()
    if not finished and step_status != "pending":
        finished = now

    existing_id: int | None = None
    if upsert and api_s:
        # Prefer seeded pending row; otherwise overwrite latest row for same api
        # (so repair can replace failed/error without leaving duplicate steps).
        row = db.execute(
            """SELECT id FROM evoflow_verification_steps
               WHERE round_id = ? AND api = ? AND status = 'pending'
               ORDER BY seq ASC, id ASC LIMIT 1""",
            (rid, api_s),
        ).fetchone()
        if row is None:
            row = db.execute(
                """SELECT id FROM evoflow_verification_steps
                   WHERE round_id = ? AND api = ?
                   ORDER BY id DESC LIMIT 1""",
                (rid, api_s),
            ).fetchone()
        if row is not None:
            existing_id = int(row[0])

    if existing_id is not None:
        # Fill feature from existing row if caller omitted it.
        if not feature_s:
            prev = db.execute(
                "SELECT feature, detail FROM evoflow_verification_steps WHERE id = ?",
                (existing_id,),
            ).fetchone()
            feature_s = str((prev[0] if prev else "") or "")
            if not detail and prev and prev[1]:
                detail = str(prev[1])
        db.execute(
            """UPDATE evoflow_verification_steps
               SET feature = COALESCE(NULLIF(?, ''), feature),
                   status = ?,
                   request_json = ?,
                   response_json = ?,
                   result = ?,
                   detail = COALESCE(NULLIF(?, ''), detail),
                   exception = ?,
                   duration_ms = ?,
                   started_at = COALESCE(NULLIF(?, ''), started_at),
                   finished_at = ?
               WHERE id = ?""",
            (
                feature_s,
                step_status,
                _dumps(request if request is not None else {}, default={}),
                _dumps(response if response is not None else {}, default={}),
                str(result or ("待开始" if step_status == "pending" else "")),
                str(detail or ""),
                str(exception or ""),
                dm,
                started or None,
                finished or None,
                existing_id,
            ),
        )
        # Drop duplicate rows for the same api within this round.
        db.execute(
            """DELETE FROM evoflow_verification_steps
               WHERE round_id = ? AND api = ? AND id != ?""",
            (rid, api_s, existing_id),
        )
        step_id = existing_id
    else:
        if seq is None:
            row = db.execute(
                "SELECT COALESCE(MAX(seq), 0) FROM evoflow_verification_steps WHERE round_id = ?",
                (rid,),
            ).fetchone()
            seq_n = int(row[0] or 0) + 1
        else:
            seq_n = max(1, int(seq))

        cur = db.execute(
            """INSERT INTO evoflow_verification_steps
               (round_id, seq, feature, api, status,
                request_json, response_json, result, detail, exception,
                duration_ms, started_at, finished_at, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                rid,
                seq_n,
                feature_s,
                api_s,
                step_status,
                _dumps(request if request is not None else {}, default={}),
                _dumps(response if response is not None else {}, default={}),
                str(result or ("待开始" if step_status == "pending" else "")),
                str(detail or ""),
                str(exception or ""),
                dm,
                started or None,
                finished or None,
                now,
            ),
        )
        step_id = int(cur.lastrowid)

    # Flip to running only when a step is actually executed (not pending seed).
    new_status = round_data["status"]
    started_at_round = round_data.get("startedAt") or ""
    if step_status != "pending" and new_status == "queued":
        new_status = "running"
        started_at_round = started_at_round or now
    steps = _list_steps(db, rid)
    stats = _step_stats(steps)
    progress = stats["progressFromSteps"]
    db.execute(
        """UPDATE evoflow_verification_rounds
           SET status = ?, progress = ?, started_at = COALESCE(NULLIF(started_at, ''), ?),
               updated_at = ?, finished_at = NULL
           WHERE round_id = ?""",
        (new_status, progress, started_at_round or None, now, rid),
    )
    db.commit()
    step = next(s for s in _list_steps(db, rid) if s["id"] == step_id)
    return {
        "success": True,
        "updated": existing_id is not None,
        "step": step,
        "round": _fetch_round(db, rid),
        "stats": _step_stats(_list_steps(db, rid)),
    }


def update_round(
    *,
    round_id: str,
    status: str = "",
    progress: int | None = None,
    conclusion: str | None = None,
    exceptions: Any = None,
    summary: Any = None,
    title: str | None = None,
    scenario: str | None = None,
) -> dict[str, Any]:
    rid = str(round_id or "").strip()
    if not rid:
        raise ValidationError("roundId is required")
    db = _db()
    round_data = _fetch_round(db, rid)
    now = now_iso_z()

    new_status = round_data["status"]
    st = _normalize_round_status(status, allow_empty=True)
    if st:
        new_status = st

    new_progress = (
        _clamp_progress(progress)
        if progress is not None
        else int(round_data.get("progress") or 0)
    )
    new_conclusion = (
        str(conclusion)
        if conclusion is not None
        else str(round_data.get("conclusion") or "")
    )
    new_exceptions = (
        exceptions if exceptions is not None else round_data.get("exceptions") or []
    )
    if not isinstance(new_exceptions, list):
        new_exceptions = [new_exceptions]
    new_summary = summary if summary is not None else round_data.get("summary") or {}
    if not isinstance(new_summary, dict):
        raise ValidationError("summary must be a JSON object")
    new_title = str(title) if title is not None else str(round_data.get("title") or "")
    new_scenario = (
        str(scenario) if scenario is not None else str(round_data.get("scenario") or "")
    )

    started_at = round_data.get("startedAt") or ""
    finished_at = round_data.get("finishedAt") or ""
    if new_status == "running" and not started_at:
        started_at = now
    if new_status in _TERMINAL_ROUND:
        finished_at = finished_at or now
        if progress is None and new_progress < 100:
            new_progress = 100
    elif st and new_status not in _TERMINAL_ROUND:
        finished_at = ""

    db.execute(
        """UPDATE evoflow_verification_rounds
           SET title = ?, scenario = ?, status = ?, progress = ?, conclusion = ?,
               exceptions_json = ?, summary_json = ?,
               started_at = ?, finished_at = ?, updated_at = ?
           WHERE round_id = ?""",
        (
            new_title,
            new_scenario,
            new_status,
            new_progress,
            new_conclusion,
            _dumps(new_exceptions, default=[]),
            _dumps(new_summary, default={}),
            started_at or None,
            finished_at or None,
            now,
            rid,
        ),
    )
    db.commit()
    steps = _list_steps(db, rid)
    return {
        "success": True,
        "round": _fetch_round(db, rid),
        "steps": steps,
        "stats": _step_stats(steps),
    }


def conclude_round(
    *,
    round_id: str,
    conclusion: str = "",
    status: str = "",
    exceptions: Any = None,
    summary: Any = None,
    progress: int | None = None,
) -> dict[str, Any]:
    """Finalize a round: set conclusion / terminal status / exception list."""
    rid = str(round_id or "").strip()
    if not rid:
        raise ValidationError("roundId is required")
    db = _db()
    steps = _list_steps(db, rid)
    stats = _step_stats(steps)

    st = str(status or "").strip().lower()
    if not st:
        failed = stats["byStatus"]["failed"] + stats["byStatus"]["error"]
        passed = stats["byStatus"]["passed"]
        pending = stats["byStatus"]["pending"]
        if failed and (passed or pending):
            st = "completed_with_failures"
        elif failed:
            st = "failed"
        elif pending:
            st = "completed_with_failures"
        elif stats["total"] == 0:
            st = "error"
        else:
            st = "passed"

    conclusion_s = str(conclusion or "").strip()
    if not conclusion_s:
        conclusion_s = (
            f"验证结束：{stats['total']} 步，"
            f"通过 {stats['byStatus']['passed']}，"
            f"失败 {stats['byStatus']['failed'] + stats['byStatus']['error']}，"
            f"待开始 {stats['byStatus']['pending']}。"
        )

    exc_list = exceptions
    if exc_list is None:
        exc_list = [
            {
                "seq": s.get("seq"),
                "feature": s.get("feature"),
                "api": s.get("api"),
                "status": s.get("status"),
                "exception": s.get("exception") or s.get("detail") or s.get("result"),
            }
            for s in steps
            if s.get("status") in {"failed", "error"}
            or (s.get("exception") or "").strip()
        ]

    return update_round(
        round_id=rid,
        status=st,
        progress=progress if progress is not None else 100,
        conclusion=conclusion_s,
        exceptions=exc_list,
        summary=summary if summary is not None else {"stats": stats},
    )


def delete_round(round_id: str) -> dict[str, Any]:
    rid = str(round_id or "").strip()
    if not rid:
        raise ValidationError("roundId is required")
    db = _db()
    _fetch_round(db, rid)
    db.execute("DELETE FROM evoflow_verification_steps WHERE round_id = ?", (rid,))
    db.execute("DELETE FROM evoflow_verification_rounds WHERE round_id = ?", (rid,))
    db.commit()
    return {"success": True, "roundId": rid, "deleted": True}
