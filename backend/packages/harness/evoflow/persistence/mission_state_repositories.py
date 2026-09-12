"""Normalized mission state (scalar columns + list / subproblem child tables)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.row_mappers import (
    mission_rows_to_wrapped,
    mission_state_to_rows,
)
from evoflow.timeutil import utc_now_iso_z


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def load_mission_state_wrapped(thread_id: str) -> dict[str, Any] | None:
    tid = thread_id.strip()
    row = (
        get_db()
        .execute(
            """
        SELECT thread_id, wrapper_version, wrapper_updated_at, turn_id, state_ts,
               primary_objective, objective_confidence, intent_hint, change_type, version,
               bound_plan_markdown, bound_plan_at, updated_at
        FROM evoflow_mission_state WHERE thread_id = ?
        """,
            (tid,),
        )
        .fetchone()
    )
    if not row:
        return None
    main = _row_dict(row)
    list_items = [
        (str(d["kind"]), str(d["content"]), int(d.get("sort_order") or 0))
        for d in (
            _row_dict(r)
            for r in get_db()
            .execute(
                "SELECT kind, content, sort_order FROM evoflow_mission_state_items WHERE thread_id = ? ORDER BY kind, sort_order",
                (tid,),
            )
            .fetchall()
        )
    ]
    scenarios = [
        (str(d["scenario_key"]), int(d.get("sort_order") or 0))
        for d in (
            _row_dict(r)
            for r in get_db()
            .execute(
                "SELECT scenario_key, sort_order FROM evoflow_mission_state_scenarios WHERE thread_id = ? ORDER BY sort_order",
                (tid,),
            )
            .fetchall()
        )
    ]
    subproblems = [
        _row_dict(r)
        for r in get_db()
        .execute(
            """
        SELECT external_id, title, status, priority, evidence, suggested_tools_json, sort_order,
               created_at, updated_at
        FROM evoflow_mission_subproblems WHERE thread_id = ? ORDER BY sort_order
        """,
            (tid,),
        )
        .fetchall()
    ]
    return mission_rows_to_wrapped(main, list_items, scenarios, subproblems)


def save_mission_state_wrapped(thread_id: str, wrapped: dict[str, Any]) -> None:
    tid = thread_id.strip()
    main, list_items, scenarios, subproblems = mission_state_to_rows(tid, wrapped)
    now = utc_now_iso_z()
    conn = get_db()
    conn.execute(
        """
        INSERT INTO evoflow_mission_state (
            thread_id, wrapper_version, wrapper_updated_at, turn_id, state_ts,
            primary_objective, objective_confidence, intent_hint, change_type, version,
            bound_plan_markdown, bound_plan_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET
            wrapper_version = excluded.wrapper_version,
            wrapper_updated_at = excluded.wrapper_updated_at,
            turn_id = excluded.turn_id,
            state_ts = excluded.state_ts,
            primary_objective = excluded.primary_objective,
            objective_confidence = excluded.objective_confidence,
            intent_hint = excluded.intent_hint,
            change_type = excluded.change_type,
            version = excluded.version,
            bound_plan_markdown = excluded.bound_plan_markdown,
            bound_plan_at = excluded.bound_plan_at,
            updated_at = excluded.updated_at
        """,
        (
            main["thread_id"],
            main["wrapper_version"],
            main["wrapper_updated_at"] or now,
            main["turn_id"],
            main["state_ts"],
            main["primary_objective"],
            main["objective_confidence"],
            main["intent_hint"],
            main["change_type"],
            main["version"],
            main["bound_plan_markdown"],
            main["bound_plan_at"],
            now,
        ),
    )
    existing_created: dict[str, str] = {}
    for row in conn.execute(
        "SELECT external_id, created_at FROM evoflow_mission_subproblems WHERE thread_id = ?",
        (tid,),
    ).fetchall():
        ext = str(row[0] or "").strip()
        if ext:
            created_val = str(row[1] or "").strip()
            if created_val:
                existing_created[ext] = created_val

    conn.execute("DELETE FROM evoflow_mission_state_items WHERE thread_id = ?", (tid,))
    conn.execute("DELETE FROM evoflow_mission_state_scenarios WHERE thread_id = ?", (tid,))
    conn.execute("DELETE FROM evoflow_mission_subproblems WHERE thread_id = ?", (tid,))
    for kind, content, sort_order in list_items:
        conn.execute(
            """
            INSERT INTO evoflow_mission_state_items (thread_id, kind, content, sort_order, updated_at)
            VALUES (?,?,?,?,?)
            """,
            (tid, kind, content, sort_order, now),
        )
    for scenario_key, sort_order in scenarios:
        conn.execute(
            """
            INSERT INTO evoflow_mission_state_scenarios (thread_id, scenario_key, sort_order, updated_at)
            VALUES (?,?,?,?)
            """,
            (tid, scenario_key, sort_order, now),
        )
    for sp in subproblems:
        ext_id = str(sp.get("id") or sp.get("external_id") or f"sub-{sp.get('_sort', 0)}")
        tools = sp.get("suggested_tools")
        if not isinstance(tools, str):
            tools = json.dumps(tools or [], ensure_ascii=False)
        created_at = existing_created.get(ext_id) or str(sp.get("created_at") or "").strip() or now
        conn.execute(
            """
            INSERT INTO evoflow_mission_subproblems (
                thread_id, external_id, title, status, priority, evidence, suggested_tools_json,
                sort_order, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                tid,
                ext_id,
                str(sp.get("title") or ""),
                str(sp.get("status") or "pending"),
                int(sp.get("priority") or 3),
                str(sp.get("evidence") or ""),
                tools,
                int(sp.get("_sort") or sp.get("sort_order") or 0),
                created_at,
                now,
            ),
        )
    conn.commit()


def delete_mission_state_children(thread_id: str) -> None:
    tid = thread_id.strip()
    conn = get_db()
    conn.execute("DELETE FROM evoflow_mission_state_items WHERE thread_id = ?", (tid,))
    conn.execute("DELETE FROM evoflow_mission_state_scenarios WHERE thread_id = ?", (tid,))
    conn.execute("DELETE FROM evoflow_mission_subproblems WHERE thread_id = ?", (tid,))


def load_mission_state_header_and_scenarios(thread_id: str) -> tuple[dict[str, Any] | None, list[str]]:
    """Scalar mission header + activated scenarios (no items/subproblems child tables)."""
    tid = thread_id.strip()
    row = (
        get_db()
        .execute(
            """
        SELECT thread_id, wrapper_version, wrapper_updated_at, turn_id, state_ts,
               primary_objective, objective_confidence, intent_hint, change_type, version,
               bound_plan_markdown, bound_plan_at, updated_at
        FROM evoflow_mission_state WHERE thread_id = ?
        """,
            (tid,),
        )
        .fetchone()
    )
    if not row:
        return None, []
    header = _row_dict(row)
    scenarios = [
        str(d["scenario_key"])
        for d in (
            _row_dict(r)
            for r in get_db()
            .execute(
                "SELECT scenario_key, sort_order FROM evoflow_mission_state_scenarios WHERE thread_id = ? ORDER BY sort_order",
                (tid,),
            )
            .fetchall()
        )
    ]
    return header, scenarios
