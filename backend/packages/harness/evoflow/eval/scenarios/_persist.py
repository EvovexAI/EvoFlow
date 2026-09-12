"""Persistence reconciliation for eval scenarios (SQLite + JSON stores).

Every scenario must end with at least one ``plane=sqlite|json_store`` assertion
so results are checked against durable state, not only API return values.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from evoflow.eval.scenarios._harness import Assertion, check, _jsonable


def _db():
    from evoflow.persistence.db import get_db

    return get_db()


def db_one(sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    row = _db().execute(sql, tuple(params)).fetchone()
    return dict(row) if row is not None else None


def db_all(sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    return [dict(r) for r in _db().execute(sql, tuple(params)).fetchall()]


def db_scalar(sql: str, params: tuple | list = ()) -> Any:
    row = _db().execute(sql, tuple(params)).fetchone()
    if row is None:
        return None
    return row[0]


def check_db_count(
    name: str,
    table: str,
    expected: int,
    *,
    where: str = "",
    params: tuple | list = (),
) -> Assertion:
    sql = f"SELECT COUNT(*) FROM {table}" + (f" WHERE {where}" if where else "")
    actual = int(db_scalar(sql, params) or 0)
    return check(
        name,
        actual == int(expected),
        inputs={"table": table, "where": where, "params": list(params)},
        expected=int(expected),
        actual=actual,
        api=f"db.COUNT({table})",
        plane="sqlite",
        evidence={"sql": sql},
    )


def _with_plane(row: Assertion, plane: str) -> Assertion:
    out = dict(row)
    out["plane"] = plane
    ev = out.get("evidence")
    if isinstance(ev, dict):
        ev = {**ev, "plane": plane}
    else:
        ev = {"plane": plane}
    out["evidence"] = ev
    return out


def check_db_row(
    name: str,
    sql: str,
    params: tuple | list,
    expected: dict[str, Any],
    *,
    api: str = "db.SELECT",
) -> Assertion:
    """Assert first row exists and ``expected`` is a subset of column values."""
    row = db_one(sql, params)
    if row is None:
        return _with_plane(
            check(
                name,
                False,
                inputs={"sql": sql, "params": list(params)},
                expected=expected,
                actual=None,
                api=api,
            ),
            "sqlite",
        )
    mismatches: dict[str, Any] = {}
    for k, exp in expected.items():
        act = row.get(k)
        if act != exp:
            # soft: string compare
            if str(act) != str(exp):
                mismatches[k] = {"expected": exp, "actual": act}
    ok = not mismatches
    return _with_plane(
        check(
            name,
            ok,
            inputs={"sql": sql, "params": list(params)},
            expected=expected,
            actual={k: row.get(k) for k in expected} if ok else {"row": _jsonable(row), "mismatches": mismatches},
            api=api,
        ),
        "sqlite",
    )


def check_db_json_contains(
    name: str,
    sql: str,
    params: tuple | list,
    json_col: str,
    expected_subset: dict[str, Any],
    *,
    api: str = "db.JSON",
) -> Assertion:
    row = db_one(sql, params)
    if row is None:
        return _with_plane(
            check(
                name,
                False,
                inputs={"sql": sql, "params": list(params), "json_col": json_col},
                expected=expected_subset,
                actual=None,
                api=api,
            ),
            "sqlite",
        )
    raw = row.get(json_col)
    try:
        obj = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (TypeError, ValueError):
        obj = {}
    if not isinstance(obj, dict):
        obj = {}
    mismatches = {}
    for k, exp in expected_subset.items():
        act = obj.get(k)
        if act != exp and str(act) != str(exp):
            # allow substring for source_ref etc.
            if isinstance(exp, str) and isinstance(act, str) and exp in act:
                continue
            mismatches[k] = {"expected": exp, "actual": act}
    ok = not mismatches
    return _with_plane(
        check(
            name,
            ok,
            inputs={"sql": sql, "params": list(params), "json_col": json_col},
            expected=expected_subset,
            actual={k: obj.get(k) for k in expected_subset} if ok else {"parsed": obj, "mismatches": mismatches},
            api=api,
        ),
        "sqlite",
    )


def check_db_absent(name: str, sql: str, params: tuple | list = ()) -> Assertion:
    row = db_one(sql, params)
    return _with_plane(
        check(
            name,
            row is None,
            inputs={"sql": sql, "params": list(params)},
            expected=None,
            actual=row,
            api="db.ABSENT",
        ),
        "sqlite",
    )


# ── domain helpers ──────────────────────────────────────────────


def expect_agent(agent_code: str, *, agent_name: str | None = None) -> Assertion:
    exp: dict[str, Any] = {"agent_code": agent_code}
    if agent_name is not None:
        exp["agent_name"] = agent_name
    return check_db_row(
        f"db_agent_{agent_code}",
        "SELECT agent_code, agent_name FROM evoflow_agents WHERE lower(agent_code)=lower(?)",
        (agent_code,),
        exp,
        api="db.evoflow_agents",
    )


def expect_agent_skill(agent_code: str, skill_name: str) -> Assertion:
    row = db_one(
        """
        SELECT item_value FROM evoflow_agent_list_items
        WHERE lower(agent_code)=lower(?) AND list_kind='skills' AND item_value=?
        """,
        (agent_code, skill_name),
    )
    return check(
        f"db_agent_skill_{agent_code}_{skill_name}",
        row is not None,
        inputs={"agent_code": agent_code, "skill": skill_name},
        expected=skill_name,
        actual=(row or {}).get("item_value") if row else None,
        api="db.evoflow_agent_list_items(skills)",
        plane="sqlite",
    )


def expect_no_agent_skill(agent_code: str, skill_name: str) -> Assertion:
    row = db_one(
        """
        SELECT item_value FROM evoflow_agent_list_items
        WHERE lower(agent_code)=lower(?) AND list_kind='skills' AND item_value=?
        """,
        (agent_code, skill_name),
    )
    return check(
        f"db_no_agent_skill_{agent_code}_{skill_name}",
        row is None,
        inputs={"agent_code": agent_code, "skill": skill_name},
        expected=None,
        actual=(row or {}).get("item_value") if row else None,
        api="db.evoflow_agent_list_items(skills)",
        plane="sqlite",
    )


def expect_agent_mcp(agent_code: str, server_name: str) -> Assertion:
    row = db_one(
        """
        SELECT item_value FROM evoflow_agent_list_items
        WHERE lower(agent_code)=lower(?) AND list_kind='mcp_servers' AND item_value=?
        """,
        (agent_code, server_name),
    )
    return check(
        f"db_agent_mcp_{agent_code}_{server_name}",
        row is not None,
        inputs={"agent_code": agent_code, "mcp": server_name},
        expected=server_name,
        actual=(row or {}).get("item_value") if row else None,
        api="db.evoflow_agent_list_items(mcp_servers)",
        plane="sqlite",
    )

    exp: dict[str, Any] = {"agent_code": agent_code}
    if agent_name is not None:
        exp["agent_name"] = agent_name
    return check_db_row(
        f"db_agent_{agent_code}",
        "SELECT agent_code, agent_name FROM evoflow_agents WHERE lower(agent_code)=lower(?)",
        (agent_code,),
        exp,
        api="db.evoflow_agents",
    )


def expect_role(agent_code: str, *, status: str | None = None, role_name: str | None = None) -> Assertion:
    exp: dict[str, Any] = {"agent_code": agent_code}
    if status is not None:
        exp["status"] = status
    if role_name is not None:
        exp["role_name"] = role_name
    return check_db_row(
        f"db_role_{agent_code}",
        "SELECT agent_code, role_name, status FROM evoflow_proactive_roles WHERE agent_code=?",
        (agent_code,),
        exp,
        api="db.evoflow_proactive_roles",
    )


def expect_no_role(agent_code: str) -> Assertion:
    return check_db_absent(
        f"db_no_role_{agent_code}",
        "SELECT agent_code FROM evoflow_proactive_roles WHERE agent_code=?",
        (agent_code,),
    )


def expect_task(
    task_id: str,
    *,
    status: str | None = None,
    assigned_to: str | None = None,
    source_ref: str | None = None,
    user_item_id: str | None = None,
) -> list[Assertion]:
    exp: dict[str, Any] = {"task_id": task_id}
    if status is not None:
        exp["status"] = status
    if assigned_to is not None:
        exp["assigned_to"] = assigned_to
    out = [
        check_db_row(
            f"db_task_{task_id}",
            "SELECT task_id, status, assigned_to, extra_json FROM evoflow_collab_tasks WHERE task_id=?",
            (task_id,),
            {k: v for k, v in exp.items() if k != "extra"},
            api="db.evoflow_collab_tasks",
        )
    ]
    subset: dict[str, Any] = {}
    if source_ref is not None:
        subset["source_ref"] = source_ref
    if user_item_id is not None:
        subset["user_item_id"] = user_item_id
    if subset:
        out.append(
            check_db_json_contains(
                f"db_task_extra_{task_id}",
                "SELECT extra_json FROM evoflow_collab_tasks WHERE task_id=?",
                (task_id,),
                "extra_json",
                subset,
                api="db.evoflow_collab_tasks.extra_json",
            )
        )
    return out


def expect_approval(approval_id: str, *, status: str) -> Assertion:
    return check_db_row(
        f"db_approval_{approval_id}",
        "SELECT id, status FROM evoflow_proactive_approvals WHERE id=?",
        (approval_id,),
        {"id": approval_id, "status": status},
        api="db.evoflow_proactive_approvals",
    )


def expect_initiative(initiative_id: str, *, status: str) -> Assertion:
    return check_db_row(
        f"db_initiative_{initiative_id}",
        "SELECT id, status FROM evoflow_proactive_initiatives WHERE id=?",
        (initiative_id,),
        {"id": initiative_id, "status": status},
        api="db.evoflow_proactive_initiatives",
    )


def expect_mcp_server(name: str, *, enabled: int | bool | None = None) -> Assertion:
    exp: dict[str, Any] = {"name": name}
    if enabled is not None:
        exp["enabled"] = 1 if enabled else 0
    return check_db_row(
        f"db_mcp_{name}",
        "SELECT name, enabled FROM evoflow_mcp_servers WHERE name=?",
        (name,),
        exp,
        api="db.evoflow_mcp_servers",
    )


def expect_no_mcp_server(name: str) -> Assertion:
    return check_db_absent(
        f"db_no_mcp_{name}",
        "SELECT name FROM evoflow_mcp_servers WHERE name=?",
        (name,),
    )


def expect_app(app_id: str, *, name: str | None = None) -> Assertion:
    exp: dict[str, Any] = {"id": app_id}
    if name is not None:
        exp["name"] = name
    return check_db_row(
        f"db_app_{app_id}",
        "SELECT id, name FROM evoflow_apps WHERE id=?",
        (app_id,),
        exp,
        api="db.evoflow_apps",
    )


def expect_app_run(run_id: str | None = None, *, task_id: str | None = None, app_id: str | None = None) -> Assertion:
    if run_id:
        return check_db_row(
            f"db_run_{run_id}",
            "SELECT id, task_id, app_id FROM evoflow_app_runs WHERE id=?",
            (run_id,),
            {"id": run_id, **({"task_id": task_id} if task_id else {}), **({"app_id": app_id} if app_id else {})},
            api="db.evoflow_app_runs",
        )
    if task_id:
        row = db_one("SELECT id, task_id, app_id FROM evoflow_app_runs WHERE task_id=? ORDER BY created_at DESC", (task_id,))
        return _with_plane(
            check(
                f"db_run_by_task_{task_id}",
                row is not None and (not app_id or row.get("app_id") == app_id),
                inputs={"task_id": task_id, "app_id": app_id},
                expected={"task_id": task_id, "app_id": app_id},
                actual=row,
                api="db.evoflow_app_runs",
            ),
            "sqlite",
        )
    return _with_plane(
        check("db_run_missing_key", False, expected="run_id or task_id", actual=None, api="db.evoflow_app_runs"),
        "sqlite",
    )


def expect_vault_setting(vault_id: str) -> Assertion:
    """Vault registry lives in evoflow_app_settings key knowledge.vaults."""
    from evoflow.knowledge.vault.constants import VAULTS_SETTINGS_KEY
    from evoflow.persistence import config_repositories as cfg_repo

    raw = cfg_repo.get_app_setting(VAULTS_SETTINGS_KEY) or {}
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        items = []
    ids = [str(i.get("id") or "") for i in items if isinstance(i, dict)]
    # also verify SQLite row for settings key exists
    row = db_one(
        "SELECT key FROM evoflow_app_settings WHERE key=?",
        (VAULTS_SETTINGS_KEY,),
    )
    ok = vault_id in ids and row is not None
    return _with_plane(
        check(
            f"db_vault_{vault_id}",
            ok,
            inputs={"vault_id": vault_id, "settings_key": VAULTS_SETTINGS_KEY},
            expected=vault_id,
            actual={"setting_row": bool(row), "vault_ids": ids[:20]},
            api="db.evoflow_app_settings(knowledge.vaults)",
        ),
        "sqlite",
    )


def expect_user_item(item_id: str, *, status: str | None = None, title: str | None = None) -> Assertion:
    """Items persist in ``{EVOFLOW_HOME}/data/user_items.json`` (not SQLite)."""
    home = Path(str(__import__("os").environ.get("EVOFLOW_HOME") or ""))
    path = home / "data" / "user_items.json"
    blob: dict[str, Any] = {}
    if path.is_file():
        try:
            blob = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            blob = {}
    items = blob.get("items") if isinstance(blob, dict) else None
    if not isinstance(items, list):
        # some stores use dict keyed by id
        if isinstance(blob, dict) and item_id in blob:
            item = blob.get(item_id)
        else:
            item = None
            items = []
    else:
        item = next((i for i in items if isinstance(i, dict) and str(i.get("id") or "") == item_id), None)
    if item is None and isinstance(blob.get("items"), dict):
        item = blob["items"].get(item_id)
    ok = isinstance(item, dict)
    mismatches = {}
    if ok and status is not None and str(item.get("status") or "") != status:
        mismatches["status"] = {"expected": status, "actual": item.get("status")}
        ok = False
    if ok and title is not None and str(item.get("title") or "") != title:
        mismatches["title"] = {"expected": title, "actual": item.get("title")}
        ok = False
    return _with_plane(
        check(
            f"json_item_{item_id}",
            ok,
            inputs={"item_id": item_id, "path": str(path)},
            expected={"id": item_id, **({"status": status} if status else {}), **({"title": title} if title else {})},
            actual=item if ok else {"found": item, "mismatches": mismatches, "file_exists": path.is_file()},
            api="json.user_items",
        ),
        "json_store",
    )


def expect_skill_enabled(skill_name: str, enabled: bool) -> Assertion:
    row = db_one("SELECT name, enabled FROM evoflow_skills WHERE name=?", (skill_name,))
    if row is None:
        return check(
            f"db_skill_{skill_name}",
            False,
            inputs={"name": skill_name},
            expected={"row": "present", "enabled": bool(enabled)},
            actual=None,
            api="db.evoflow_skills",
            plane="sqlite",
        )
    act = row.get("enabled")
    act_bool = bool(int(act)) if act is not None and str(act).isdigit() else bool(act)
    return check(
        f"db_skill_{skill_name}",
        act_bool is bool(enabled),
        inputs={"name": skill_name},
        expected={"enabled": bool(enabled)},
        actual={"enabled": act},
        api="db.evoflow_skills",
        plane="sqlite",
    )


def count_persist_assertions(assertions: list[Assertion]) -> int:
    return sum(1 for a in assertions if a.get("plane") in ("sqlite", "json_store"))
