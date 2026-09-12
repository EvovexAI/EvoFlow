"""Unified usage / cost ledger (main app DB).

Append-only events + UTC-day rollup for settings「使用统计」.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Categories reserved for product metering (extend freely).
CATEGORY_LLM = "llm"
CATEGORY_MEDIA = "media"
CATEGORY_TOOL = "tool"
CATEGORY_EMBEDDING = "embedding"
CATEGORY_STORAGE = "storage"
CATEGORY_OTHER = "other"

UNIT_TOKEN = "token"
UNIT_REQUEST = "request"
UNIT_SECOND = "second"
UNIT_BYTE = "byte"
UNIT_CREDIT = "credit"

SUBCATEGORY_CHAT = "chat"


def _day_utc(occurred_at: str) -> str:
    s = str(occurred_at or "").strip()
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return utc_now_iso_z()[:10]


def _f(v: Any, default: float = 0.0) -> float:
    try:
        return float(v if v is not None else default)
    except (TypeError, ValueError):
        return default


def _s(v: Any, default: str = "") -> str:
    return str(v if v is not None else default).strip() or default


def record_usage_event_in_txn(
    db: Any,
    *,
    event_id: str,
    category: str,
    unit: str,
    quantity: float = 0,
    quantity_in: float = 0,
    quantity_out: float = 0,
    subcategory: str = "",
    currency: str = "USD",
    amount: float = 0,
    pricing_source: str = "",
    provider: str = "",
    sku: str = "",
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    message_id: str | None = None,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    subject_type: str = "install",
    subject_id: str = "",
    principal_id: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Insert one event + upsert daily rollup. Returns False if event_id already exists."""
    eid = _s(event_id)
    cat = _s(category)
    un = _s(unit)
    if not eid or not cat or not un:
        return False

    qty = _f(quantity)
    qty_in = _f(quantity_in)
    qty_out = _f(quantity_out)
    if qty <= 0 and (qty_in or qty_out):
        qty = qty_in + qty_out
    if qty <= 0 and _f(amount) <= 0:
        return False

    now = utc_now_iso_z()
    occurred = _s(occurred_at) or now
    day = _day_utc(occurred)
    sub = _s(subcategory)
    sk = _s(sku)
    st = _s(subject_type, "install") or "install"
    sid = _s(subject_id)
    uid = _s(principal_id)
    amt = _f(amount)
    meta_json = json.dumps(meta if isinstance(meta, dict) else {}, ensure_ascii=False)

    existing = db.execute(
        "SELECT 1 FROM evoflow_usage_events WHERE event_id = ?",
        (eid,),
    ).fetchone()
    if existing:
        return False

    db.execute(
        """
        INSERT INTO evoflow_usage_events (
            event_id, occurred_at, category, subcategory, unit,
            quantity, quantity_in, quantity_out,
            currency, amount, pricing_source, provider, sku,
            session_key, thread_id, run_id, message_id, app_id, agent_code, workspace_id,
            subject_type, subject_id, principal_id, meta_json, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            eid,
            occurred,
            cat,
            sub,
            un,
            qty,
            qty_in,
            qty_out,
            _s(currency, "USD") or "USD",
            amt,
            _s(pricing_source),
            _s(provider),
            sk,
            _s(session_key) or None,
            _s(thread_id) or None,
            _s(run_id) or None,
            _s(message_id) or None,
            _s(app_id) or None,
            _s(agent_code) or None,
            _s(workspace_id) or None,
            st,
            sid,
            uid or None,
            meta_json,
            now,
        ),
    )

    db.execute(
        """
        INSERT INTO evoflow_usage_daily (
            day, category, subcategory, sku, subject_type, subject_id, principal_id,
            quantity_sum, quantity_in_sum, quantity_out_sum, amount_sum, event_count
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(day, category, subcategory, sku, subject_type, subject_id, principal_id) DO UPDATE SET
            quantity_sum = quantity_sum + excluded.quantity_sum,
            quantity_in_sum = quantity_in_sum + excluded.quantity_in_sum,
            quantity_out_sum = quantity_out_sum + excluded.quantity_out_sum,
            amount_sum = amount_sum + excluded.amount_sum,
            event_count = event_count + 1
        """,
        (day, cat, sub, sk, st, sid, uid, qty, qty_in, qty_out, amt),
    )
    return True


def record_usage_event(**kwargs: Any) -> bool:
    """Commit a single usage event (idempotent on event_id)."""

    def _write(db: Any) -> bool:
        return record_usage_event_in_txn(db, **kwargs)

    try:
        return run_db_transaction(_write)
    except Exception:
        logger.exception("record_usage_event failed event_id=%s", kwargs.get("event_id"))
        return False


def _resolve_model_sku(
    db: Any,
    *,
    model_name: str | None = None,
    session_key: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Prefer explicit model_name; fall back to session / thread flat columns."""
    name = _s(model_name)
    if name:
        return name
    sk = _s(session_key)
    if sk:
        row = db.execute(
            """
            SELECT COALESCE(NULLIF(model_name, ''), NULLIF(primary_model_name, ''))
            FROM evoflow_chat_sessions
            WHERE session_key = ? AND is_deleted = 0
            LIMIT 1
            """,
            (sk,),
        ).fetchone()
        if row and row[0]:
            return str(row[0]).strip()
    tid = _s(thread_id)
    if tid:
        row = db.execute(
            """
            SELECT COALESCE(NULLIF(model_name, ''), NULLIF(primary_model_name, ''))
            FROM evoflow_chat_sessions
            WHERE thread_id = ? AND is_deleted = 0
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (tid,),
        ).fetchone()
        if row and row[0]:
            return str(row[0]).strip()
    return ""


def record_llm_chat_usage_in_txn(
    db: Any,
    *,
    session_key: str,
    run_id: str | None = None,
    thread_id: str | None = None,
    message_id: str | None = None,
    model_name: str | None = None,
    provider: str | None = None,
    input_tokens: int | float = 0,
    output_tokens: int | float = 0,
    total_tokens: int | float = 0,
    app_id: str | None = None,
    agent_code: str | None = None,
    workspace_id: str | None = None,
    principal_id: str | None = None,
    occurred_at: str | None = None,
    meta: dict[str, Any] | None = None,
) -> bool:
    """Record one LLM chat turn. Idempotent key: llm:{run_id}:{message_id} or fallback."""
    sk = _s(session_key)
    rid = _s(run_id)
    mid = _s(message_id)
    if mid and rid:
        event_id = f"llm:{rid}:{mid}"
    elif mid and sk:
        event_id = f"llm:{sk}:{mid}"
    elif rid:
        event_id = f"llm:{rid}:turn"
    elif sk:
        # Last resort — still unique per call if caller adds seq in meta; prefer message_id.
        event_id = f"llm:{sk}:{utc_now_iso_z()}"
    else:
        return False

    tot = _f(total_tokens)
    inp = _f(input_tokens)
    out = _f(output_tokens)
    if tot <= 0:
        tot = inp + out
    if tot <= 0:
        return False

    sku = _resolve_model_sku(
        db,
        model_name=model_name,
        session_key=sk,
        thread_id=thread_id,
    )

    return record_usage_event_in_txn(
        db,
        event_id=event_id,
        category=CATEGORY_LLM,
        subcategory=SUBCATEGORY_CHAT,
        unit=UNIT_TOKEN,
        quantity=tot,
        quantity_in=inp,
        quantity_out=out,
        sku=sku,
        provider=_s(provider),
        session_key=sk or None,
        thread_id=_s(thread_id) or None,
        run_id=rid or None,
        message_id=mid or None,
        app_id=_s(app_id) or None,
        agent_code=_s(agent_code) or None,
        workspace_id=_s(workspace_id) or None,
        principal_id=_s(principal_id) or None,
        occurred_at=occurred_at,
        meta=meta,
    )


def _parse_range(from_day: str | None, to_day: str | None, *, default_days: int = 30) -> tuple[str, str]:
    today = utc_now_iso_z()[:10]
    end = _s(to_day) or today
    if len(end) < 10:
        end = today
    end = end[:10]
    start = _s(from_day)
    if len(start) >= 10:
        start = start[:10]
    else:
        # default_days inclusive window ending at ``end``
        from datetime import date, timedelta

        try:
            end_d = date.fromisoformat(end)
        except ValueError:
            end_d = date.fromisoformat(today)
            end = today
        start = (end_d - timedelta(days=max(0, int(default_days) - 1))).isoformat()
    return start, end


def fetch_usage_summary(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    """Usage summary. ``principal_id=None`` + ``include_orphan=True`` = all rows (legacy).
    ``principal_id=<pid>`` + ``include_orphan=False`` = that principal's rows only.
    """
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    uid = _s(principal_id)
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)
    if uid:
        where += " AND principal_id = ?"
        params.append(uid)
    elif not include_orphan:
        where += " AND principal_id IS NOT NULL AND principal_id != ''"
    else:
        # include_orphan with no uid = all rows (nothing extra to filter)
        pass

    row = db.execute(
        f"""
        SELECT
            COALESCE(SUM(quantity_sum), 0),
            COALESCE(SUM(quantity_in_sum), 0),
            COALESCE(SUM(quantity_out_sum), 0),
            COALESCE(SUM(amount_sum), 0),
            COALESCE(SUM(event_count), 0)
        FROM evoflow_usage_daily
        WHERE {where}
        """,
        params,
    ).fetchone()

    peak = db.execute(
        f"""
        SELECT day, SUM(quantity_sum) AS q
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY day
        ORDER BY q DESC
        LIMIT 1
        """,
        params,
    ).fetchone()

    llm_where = "day >= ? AND day <= ? AND category = ?"
    llm_params: list[Any] = [start, end, CATEGORY_LLM]
    if uid:
        llm_where += " AND principal_id = ?"
        llm_params.append(uid)
    elif not include_orphan:
        llm_where += " AND principal_id IS NOT NULL AND principal_id != ''"
    llm_row = db.execute(
        f"""
        SELECT COALESCE(SUM(quantity_sum), 0), COALESCE(SUM(event_count), 0)
        FROM evoflow_usage_daily
        WHERE {llm_where}
        """,
        llm_params,
    ).fetchone()

    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "quantity_sum": _f(row[0] if row else 0),
        "quantity_in_sum": _f(row[1] if row else 0),
        "quantity_out_sum": _f(row[2] if row else 0),
        "amount_sum": _f(row[3] if row else 0),
        "event_count": int(row[4] or 0) if row else 0,
        "llm_token_sum": _f(llm_row[0] if llm_row else 0),
        "llm_event_count": int(llm_row[1] or 0) if llm_row else 0,
        "peak_day": str(peak[0]) if peak and peak[0] else None,
        "peak_quantity": _f(peak[1] if peak else 0),
    }


def _usage_where(
    base_where: str,
    base_params: list[Any],
    *,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> tuple[str, list[Any]]:
    """Append principal_id scoping to a usage query.

    ``principal_id=<pid>`` restricts to that principal. With ``include_orphan=True`` and no
    uid, all rows pass (legacy). ``include_orphan=False`` with no uid keeps only
    attributed rows (admin full view handled by passing no uid + True).
    """
    uid = _s(principal_id)
    params = list(base_params)
    where = base_where
    if uid:
        where += " AND principal_id = ?"
        params.append(uid)
    elif not include_orphan:
        where += " AND principal_id IS NOT NULL AND principal_id != ''"
    return where, params


def fetch_usage_daily(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)
    where, params = _usage_where(where, params, principal_id=principal_id, include_orphan=include_orphan)

    rows = db.execute(
        f"""
        SELECT day,
               SUM(quantity_sum) AS quantity_sum,
               SUM(quantity_in_sum) AS quantity_in_sum,
               SUM(quantity_out_sum) AS quantity_out_sum,
               SUM(amount_sum) AS amount_sum,
               SUM(event_count) AS event_count
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY day
        ORDER BY day ASC
        """,
        params,
    ).fetchall()

    days = [
        {
            "day": str(r[0]),
            "quantity_sum": _f(r[1]),
            "quantity_in_sum": _f(r[2]),
            "quantity_out_sum": _f(r[3]),
            "amount_sum": _f(r[4]),
            "event_count": int(r[5] or 0),
        }
        for r in rows
    ]
    return {"from": start, "to": end, "day_basis": "utc", "category": cat or None, "days": days}


def fetch_usage_daily_by_sku(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = CATEGORY_LLM,
    top_n: int = 8,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    """Multi-series daily trend for top SKUs (settings dashboard line chart)."""
    start, end = _parse_range(from_day, to_day)
    cat = _s(category) or CATEGORY_LLM
    lim = max(1, min(int(top_n or 8), 20))
    db = get_db()

    top_where, top_params = _usage_where(
        "day >= ? AND day <= ? AND category = ?",
        [start, end, cat],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    top_rows = db.execute(
        f"""
        SELECT sku, SUM(quantity_sum) AS q
        FROM evoflow_usage_daily
        WHERE {top_where}
        GROUP BY sku
        ORDER BY q DESC
        LIMIT ?
        """,
        (*top_params, lim),
    ).fetchall()
    skus = [str(r[0] or "") or "(unknown)" for r in top_rows]
    if not skus:
        return {
            "from": start,
            "to": end,
            "day_basis": "utc",
            "category": cat,
            "skus": [],
            "days": [],
            "series": [],
        }

    placeholders = ",".join("?" for _ in skus)
    # Map empty sku in DB to "(unknown)" for consistency with by-sku
    rows_where, rows_params = _usage_where(
        "day >= ? AND day <= ? AND category = ?",
        [start, end, cat],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    rows = db.execute(
        f"""
        SELECT day,
               CASE WHEN sku IS NULL OR sku = '' THEN '(unknown)' ELSE sku END AS sku_key,
               SUM(quantity_sum) AS quantity_sum
        FROM evoflow_usage_daily
        WHERE {rows_where}
          AND (CASE WHEN sku IS NULL OR sku = '' THEN '(unknown)' ELSE sku END) IN ({placeholders})
        GROUP BY day, sku_key
        ORDER BY day ASC
        """,
        (*rows_params, *skus),
    ).fetchall()

    from datetime import date, timedelta

    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError:
        start_d = date.fromisoformat(utc_now_iso_z()[:10])
        end_d = start_d

    day_list: list[str] = []
    cur = start_d
    while cur <= end_d:
        day_list.append(cur.isoformat())
        cur += timedelta(days=1)

    grid: dict[str, dict[str, float]] = {d: {s: 0.0 for s in skus} for d in day_list}
    for day, sku_key, qty in rows:
        d = str(day)
        s = str(sku_key or "") or "(unknown)"
        if d in grid and s in grid[d]:
            grid[d][s] = _f(qty)

    series = [
        {
            "sku": sku,
            "points": [{"day": d, "quantity_sum": grid[d][sku]} for d in day_list],
        }
        for sku in skus
    ]
    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "category": cat,
        "skus": skus,
        "days": day_list,
        "series": series,
    }


def fetch_usage_by_category(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    start, end = _parse_range(from_day, to_day)
    db = get_db()
    where, params = _usage_where(
        "day >= ? AND day <= ?",
        [start, end],
        principal_id=principal_id,
        include_orphan=include_orphan,
    )
    rows = db.execute(
        f"""
        SELECT category,
               SUM(quantity_sum), SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY category
        ORDER BY SUM(quantity_sum) DESC
        """,
        params,
    ).fetchall()
    items = [
        {
            "category": str(r[0]),
            "quantity_sum": _f(r[1]),
            "amount_sum": _f(r[2]),
            "event_count": int(r[3] or 0),
        }
        for r in rows
    ]
    return {"from": start, "to": end, "day_basis": "utc", "items": items}


def fetch_usage_by_sku(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = CATEGORY_LLM,
    principal_id: str | None = None,
    include_orphan: bool = True,
) -> dict[str, Any]:
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)
    where, params = _usage_where(where, params, principal_id=principal_id, include_orphan=include_orphan)

    rows = db.execute(
        f"""
        SELECT sku,
               SUM(quantity_sum), SUM(quantity_in_sum), SUM(quantity_out_sum),
               SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY sku
        ORDER BY SUM(quantity_sum) DESC
        LIMIT 50
        """,
        params,
    ).fetchall()
    items = [
        {
            "sku": str(r[0] or "") or "(unknown)",
            "quantity_sum": _f(r[1]),
            "quantity_in_sum": _f(r[2]),
            "quantity_out_sum": _f(r[3]),
            "amount_sum": _f(r[4]),
            "event_count": int(r[5] or 0),
        }
        for r in rows
    ]
    return {"from": start, "to": end, "day_basis": "utc", "category": cat or None, "items": items}


def fetch_usage_by_principal(
    *,
    from_day: str | None = None,
    to_day: str | None = None,
    category: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Admin rollup: usage grouped by ``principal_id`` (displayName preferred).

    Orphan / unattributed rows appear as ``principal_id=null`` with label 「未归属」.
    """
    start, end = _parse_range(from_day, to_day)
    cat = _s(category)
    lim = max(1, min(int(limit or 100), 500))
    db = get_db()
    where = "day >= ? AND day <= ?"
    params: list[Any] = [start, end]
    if cat:
        where += " AND category = ?"
        params.append(cat)

    has_pid = bool(
        db.execute(
            "SELECT 1 FROM pragma_table_info('evoflow_usage_daily') WHERE name='principal_id'"
        ).fetchone()
    )
    if not has_pid:
        return {
            "from": start,
            "to": end,
            "day_basis": "utc",
            "category": cat or None,
            "items": [],
        }

    rows = db.execute(
        f"""
        SELECT COALESCE(NULLIF(TRIM(principal_id), ''), '') AS pid,
               SUM(quantity_sum), SUM(quantity_in_sum), SUM(quantity_out_sum),
               SUM(amount_sum), SUM(event_count)
        FROM evoflow_usage_daily
        WHERE {where}
        GROUP BY COALESCE(NULLIF(TRIM(principal_id), ''), '')
        ORDER BY SUM(amount_sum) DESC, SUM(quantity_sum) DESC
        LIMIT ?
        """,
        (*params, lim),
    ).fetchall()

    names: dict[str, str] = {}
    try:
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_principals'"
        ).fetchone():
            for pr in db.execute(
                "SELECT principal_id, display_name FROM evoflow_principals"
            ).fetchall():
                pid = str(pr[0] or "").strip()
                dn = str(pr[1] or "").strip()
                if pid and dn:
                    names[pid] = dn
    except Exception:
        names = {}

    proactive_by_pid: dict[str, float] = {}
    try:
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_proactive_cost_log'"
        ).fetchone() and db.execute(
            "SELECT 1 FROM pragma_table_info('evoflow_proactive_cost_log') WHERE name='principal_id'"
        ).fetchone():
            prow = db.execute(
                """
                SELECT COALESCE(NULLIF(TRIM(principal_id), ''), '') AS pid,
                       COALESCE(SUM(cost_usd), 0)
                FROM evoflow_proactive_cost_log
                WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?
                GROUP BY COALESCE(NULLIF(TRIM(principal_id), ''), '')
                """,
                (start, end),
            ).fetchall()
            for r in prow:
                proactive_by_pid[str(r[0] or "")] = _f(r[1])
    except Exception:
        proactive_by_pid = {}

    items: list[dict[str, Any]] = []
    for r in rows:
        pid = str(r[0] or "").strip()
        amount = _f(r[4])
        proactive = proactive_by_pid.pop(pid, 0.0) if proactive_by_pid else 0.0
        label = names.get(pid) if pid else "未归属"
        if pid and not label:
            label = pid
        items.append(
            {
                "principal_id": pid or None,
                "display_name": names.get(pid) if pid else None,
                "label": label,
                "quantity_sum": _f(r[1]),
                "quantity_in_sum": _f(r[2]),
                "quantity_out_sum": _f(r[3]),
                "amount_sum": amount,
                "event_count": int(r[5] or 0),
                "proactive_cost_usd": proactive,
                "total_amount_sum": round(amount + proactive, 6),
            }
        )
    for pid, proactive in sorted(proactive_by_pid.items(), key=lambda x: -x[1]):
        if proactive <= 0:
            continue
        label = names.get(pid) if pid else "未归属"
        if pid and not label:
            label = pid
        items.append(
            {
                "principal_id": pid or None,
                "display_name": names.get(pid) if pid else None,
                "label": label,
                "quantity_sum": 0.0,
                "quantity_in_sum": 0.0,
                "quantity_out_sum": 0.0,
                "amount_sum": 0.0,
                "event_count": 0,
                "proactive_cost_usd": proactive,
                "total_amount_sum": proactive,
            }
        )
    items.sort(
        key=lambda x: (-float(x.get("total_amount_sum") or 0), -float(x.get("quantity_sum") or 0))
    )

    return {
        "from": start,
        "to": end,
        "day_basis": "utc",
        "category": cat or None,
        "items": items,
    }


def heal_empty_llm_skus(db: Any | None = None) -> dict[str, Any]:
    """Backfill empty llm event sku from session model columns; rebuild llm daily rollup."""

    def _heal(conn: Any) -> dict[str, Any]:
        if not conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_usage_events'"
        ).fetchone():
            return {"ok": False, "reason": "no_table", "updated_events": 0}

        before = conn.execute(
            """
            SELECT COUNT(*) FROM evoflow_usage_events
            WHERE category = 'llm' AND (sku IS NULL OR sku = '')
            """
        ).fetchone()
        empty_n = int(before[0] or 0) if before else 0
        if empty_n <= 0:
            return {"ok": True, "updated_events": 0, "rebuilt_daily": False}

        conn.execute(
            """
            UPDATE evoflow_usage_events
            SET sku = COALESCE((
                SELECT COALESCE(NULLIF(s.model_name, ''), NULLIF(s.primary_model_name, ''))
                FROM evoflow_chat_sessions s
                WHERE s.session_key = evoflow_usage_events.session_key
                  AND s.is_deleted = 0
                LIMIT 1
            ), '')
            WHERE category = 'llm'
              AND (sku IS NULL OR sku = '')
              AND session_key IS NOT NULL
              AND session_key != ''
            """
        )
        conn.execute(
            """
            UPDATE evoflow_usage_events
            SET sku = COALESCE((
                SELECT COALESCE(NULLIF(s.model_name, ''), NULLIF(s.primary_model_name, ''))
                FROM evoflow_chat_sessions s
                WHERE s.thread_id = evoflow_usage_events.thread_id
                  AND s.is_deleted = 0
                ORDER BY s.updated_at DESC
                LIMIT 1
            ), sku)
            WHERE category = 'llm'
              AND (sku IS NULL OR sku = '')
              AND thread_id IS NOT NULL
              AND thread_id != ''
            """
        )

        after = conn.execute(
            """
            SELECT COUNT(*) FROM evoflow_usage_events
            WHERE category = 'llm' AND (sku IS NULL OR sku = '')
            """
        ).fetchone()
        still_empty = int(after[0] or 0) if after else 0
        updated = max(0, empty_n - still_empty)

        # Rebuild llm daily from events so empty-sku buckets move to real model names.
        conn.execute("DELETE FROM evoflow_usage_daily WHERE category = ?", (CATEGORY_LLM,))
        conn.execute(
            """
            INSERT INTO evoflow_usage_daily (
                day, category, subcategory, sku, subject_type, subject_id,
                quantity_sum, quantity_in_sum, quantity_out_sum, amount_sum, event_count
            )
            SELECT
                substr(occurred_at, 1, 10) AS day,
                category,
                COALESCE(subcategory, ''),
                COALESCE(sku, ''),
                COALESCE(subject_type, 'install'),
                COALESCE(subject_id, ''),
                SUM(quantity),
                SUM(quantity_in),
                SUM(quantity_out),
                SUM(amount),
                COUNT(*)
            FROM evoflow_usage_events
            WHERE category = ?
            GROUP BY day, category, COALESCE(subcategory, ''), COALESCE(sku, ''),
                     COALESCE(subject_type, 'install'), COALESCE(subject_id, '')
            """,
            (CATEGORY_LLM,),
        )
        return {
            "ok": True,
            "updated_events": updated,
            "still_empty": still_empty,
            "rebuilt_daily": True,
        }

    if db is not None:
        return _heal(db)
    return run_db_transaction(_heal)
