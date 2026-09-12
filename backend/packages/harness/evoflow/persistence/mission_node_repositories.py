"""Normalized mission / session question tree (parent_id hierarchy per snapshot)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.agents.mission_state.models import MissionState, MissionSubproblem
from evoflow.persistence.db import get_db
from evoflow.persistence.timestamps import iso_z_to_ms
from evoflow.timeutil import utc_now_iso_z


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def delete_mission_nodes_for_thread(thread_id: str) -> None:
    get_db().execute("DELETE FROM evoflow_mission_nodes WHERE thread_id = ?", (thread_id.strip(),))
    get_db().commit()


def latest_snapshot_version(thread_id: str) -> int | None:
    row = (
        get_db()
        .execute(
            "SELECT MAX(snapshot_version) FROM evoflow_mission_nodes WHERE thread_id = ?",
            (thread_id.strip(),),
        )
        .fetchone()
    )
    if not row or row[0] is None:
        return None
    return int(row[0])


def list_nodes_for_snapshot(thread_id: str, snapshot_version: int) -> list[dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT id, thread_id, snapshot_version, turn_id, parent_id, kind,
               external_id, title, status, priority, evidence, suggested_tools_json,
               objective_confidence, intent_hint, change_type, sort_order, updated_at
        FROM evoflow_mission_nodes
        WHERE thread_id = ? AND snapshot_version = ?
        ORDER BY parent_id IS NOT NULL, sort_order, id
        """,
            (thread_id.strip(), int(snapshot_version)),
        )
        .fetchall()
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        tools_raw = row[11]
        try:
            tools = json.loads(tools_raw) if tools_raw else []
        except json.JSONDecodeError:
            tools = []
        doc: dict[str, Any] = {}
        if str(row[5]) == "objective":
            doc = {
                "objective_confidence": float(row[12] or 0),
                "intent_hint": str(row[13] or ""),
                "change_type": str(row[14] or ""),
            }
        elif str(row[5]) == "subproblem":
            doc = {"evidence": str(row[10] or ""), "suggested_tools": tools if isinstance(tools, list) else []}
        out.append(
            {
                "id": int(row[0]),
                "thread_id": str(row[1]),
                "snapshot_version": int(row[2]),
                "turn_id": str(row[3] or ""),
                "parent_id": int(row[4]) if row[4] is not None else None,
                "kind": str(row[5]),
                "external_id": str(row[6] or ""),
                "title": str(row[7] or ""),
                "status": str(row[8] or ""),
                "priority": int(row[9] or 0),
                "document": doc,
                "sort_order": int(row[15] or 0),
                "updated_at": str(row[16] or ""),
            }
        )
    return out


def build_node_tree(nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Build a tree from flat rows (root = parent_id NULL)."""
    if not nodes:
        return None
    by_id = {n["id"]: {**n, "children": []} for n in nodes}
    roots: list[dict[str, Any]] = []
    for n in by_id.values():
        pid = n.get("parent_id")
        if pid is None:
            roots.append(n)
        else:
            parent = by_id.get(pid)
            if parent is not None:
                parent["children"].append(n)
            else:
                roots.append(n)
    if len(roots) == 1:
        return roots[0]
    return {"kind": "snapshot", "title": "", "children": roots}


def load_latest_mission_tree(thread_id: str) -> dict[str, Any] | None:
    ver = latest_snapshot_version(thread_id)
    if ver is None:
        return None
    nodes = list_nodes_for_snapshot(thread_id, ver)
    tree = build_node_tree(nodes)
    if tree is None:
        return None
    return {"thread_id": thread_id, "snapshot_version": ver, "tree": tree, "nodes": nodes}


def _mission_state_dict_from_nodes(
    nodes: list[dict[str, Any]],
    header: dict[str, Any],
    activated_scenarios: list[str],
) -> dict[str, Any]:
    root = next((n for n in nodes if n.get("parent_id") is None and n.get("kind") == "objective"), None)
    if root is None:
        root = next((n for n in nodes if n.get("kind") == "objective"), None)
    if root is None:
        raise ValueError("mission nodes missing objective root")

    doc = root.get("document") if isinstance(root.get("document"), dict) else {}
    children = [n for n in nodes if n.get("parent_id") == root["id"]]

    active_subproblems: list[dict[str, Any]] = []
    done_subproblems: list[str] = []
    success_criteria: list[str] = []
    constraints: list[str] = []
    out_of_scope: list[str] = []

    for n in sorted(children, key=lambda x: int(x.get("sort_order") or 0)):
        kind = str(n.get("kind") or "")
        title = str(n.get("title") or "").strip()
        if not title and kind != "subproblem":
            continue
        if kind == "subproblem":
            sub_doc = n.get("document") if isinstance(n.get("document"), dict) else {}
            tools = sub_doc.get("suggested_tools")
            active_subproblems.append(
                {
                    "id": str(n.get("external_id") or ""),
                    "title": title,
                    "status": str(n.get("status") or "pending"),
                    "priority": int(n.get("priority") or 3),
                    "evidence": str(sub_doc.get("evidence") or n.get("evidence") or ""),
                    "suggested_tools": list(tools) if isinstance(tools, list) else [],
                }
            )
        elif kind == "done":
            done_subproblems.append(title)
        elif kind == "criterion":
            success_criteria.append(title)
        elif kind == "constraint":
            constraints.append(title)
        elif kind == "out_of_scope":
            out_of_scope.append(title)

    return {
        "thread_id": str(header.get("thread_id") or root.get("thread_id") or ""),
        "turn_id": str(header.get("turn_id") or root.get("turn_id") or ""),
        "ts_ms": iso_z_to_ms(header.get("state_ts") or header.get("ts_ms")),
        "primary_objective": str(root.get("title") or header.get("primary_objective") or "").strip(),
        "objective_confidence": float(doc.get("objective_confidence") if doc.get("objective_confidence") is not None else root.get("objective_confidence") or header.get("objective_confidence") or 0),
        "intent_hint": str(doc.get("intent_hint") or root.get("intent_hint") or header.get("intent_hint") or "chat"),
        "change_type": str(doc.get("change_type") or root.get("change_type") or header.get("change_type") or "update"),
        "version": int(header.get("version") or root.get("snapshot_version") or 1),
        "bound_plan_markdown": str(header.get("bound_plan_markdown") or ""),
        "bound_plan_ts_ms": iso_z_to_ms(header.get("bound_plan_at") or header.get("bound_plan_ts_ms")),
        "success_criteria": success_criteria,
        "constraints": constraints,
        "active_subproblems": active_subproblems,
        "done_subproblems": done_subproblems,
        "out_of_scope": out_of_scope,
        "activated_scenarios": list(activated_scenarios),
    }


def _nodes_snapshot_matches_state(thread_id: str, state: MissionState) -> bool:
    version = max(1, int(state.version or 1))
    if latest_snapshot_version(thread_id) != version:
        return False
    nodes = list_nodes_for_snapshot(thread_id, version)
    if not nodes:
        return False
    root = next((n for n in nodes if n.get("parent_id") is None and n.get("kind") == "objective"), None)
    if root is None:
        return False
    if str(root.get("turn_id") or "") != str(state.turn_id or ""):
        return False
    if str(root.get("title") or "").strip() != str(state.primary_objective or "").strip():
        return False
    expected_subs = len(state.active_subproblems or [])
    actual_subs = sum(1 for n in nodes if n.get("kind") == "subproblem")
    return expected_subs == actual_subs


def load_mission_state_from_nodes_if_current(thread_id: str) -> MissionState | None:
    """Rebuild ``MissionState`` from synced nodes + header when snapshot version matches."""
    from evoflow.persistence.mission_state_repositories import load_mission_state_header_and_scenarios

    header, scenarios = load_mission_state_header_and_scenarios(thread_id)
    if not header:
        return None
    ver = int(header.get("version") or 1)
    if latest_snapshot_version(thread_id) != ver:
        return None
    nodes = list_nodes_for_snapshot(thread_id, ver)
    if not nodes:
        return None
    try:
        state_dict = _mission_state_dict_from_nodes(nodes, header, scenarios)
        return MissionState.model_validate(state_dict)
    except Exception:
        return None


def sync_mission_nodes_from_state(thread_id: str, state: MissionState) -> None:
    """Persist one snapshot of objective / subproblems / criteria as a parent_id tree."""
    tid = thread_id.strip()
    if _nodes_snapshot_matches_state(tid, state):
        return
    version = max(1, int(state.version or 1))
    turn_id = str(state.turn_id or "")
    now = utc_now_iso_z()
    conn = get_db()

    conn.execute(
        "DELETE FROM evoflow_mission_nodes WHERE thread_id = ? AND snapshot_version = ?",
        (tid, version),
    )

    def _insert(
        *,
        parent_id: int | None,
        kind: str,
        title: str,
        status: str = "",
        external_id: str = "",
        priority: int = 0,
        sort_order: int = 0,
        document: dict[str, Any] | None = None,
    ) -> int:
        doc = document or {}
        evidence = str(doc.get("evidence") or "")
        tools_json = _dumps(doc.get("suggested_tools") or [])
        obj_conf = float(doc.get("objective_confidence") or 0)
        intent_hint = str(doc.get("intent_hint") or "")
        change_type = str(doc.get("change_type") or "")
        cur = conn.execute(
            """
            INSERT INTO evoflow_mission_nodes (
                thread_id, snapshot_version, turn_id, parent_id, kind,
                external_id, title, status, priority, evidence, suggested_tools_json,
                objective_confidence, intent_hint, change_type, sort_order, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tid,
                version,
                turn_id,
                parent_id,
                kind,
                external_id,
                title,
                status,
                priority,
                evidence,
                tools_json,
                obj_conf,
                intent_hint,
                change_type,
                sort_order,
                now,
            ),
        )
        return int(cur.lastrowid)

    root_id = _insert(
        parent_id=None,
        kind="objective",
        title=str(state.primary_objective or "").strip(),
        status="in_progress" if state.active_subproblems else "done",
        document={
            "objective_confidence": state.objective_confidence,
            "intent_hint": state.intent_hint,
            "change_type": state.change_type,
        },
    )

    for i, sp in enumerate(state.active_subproblems or []):
        if isinstance(sp, MissionSubproblem):
            sub = sp
        elif isinstance(sp, dict):
            sub = MissionSubproblem.model_validate(sp)
        else:
            continue
        _insert(
            parent_id=root_id,
            kind="subproblem",
            title=str(sub.title or "").strip(),
            status=str(sub.status or "pending"),
            external_id=str(sub.id or f"sub-{i + 1}"),
            priority=int(sub.priority or 3),
            sort_order=i,
            document={
                "evidence": sub.evidence,
                "suggested_tools": list(sub.suggested_tools or []),
            },
        )

    for i, summary in enumerate(state.done_subproblems or []):
        text = str(summary or "").strip()
        if not text:
            continue
        _insert(
            parent_id=root_id,
            kind="done",
            title=text,
            status="done",
            external_id=f"done-{i + 1}",
            sort_order=1000 + i,
        )

    for i, crit in enumerate(state.success_criteria or []):
        text = str(crit or "").strip()
        if not text:
            continue
        _insert(
            parent_id=root_id,
            kind="criterion",
            title=text,
            sort_order=2000 + i,
        )

    for i, con in enumerate(state.constraints or []):
        text = str(con or "").strip()
        if not text:
            continue
        _insert(
            parent_id=root_id,
            kind="constraint",
            title=text,
            sort_order=3000 + i,
        )

    for i, oos in enumerate(state.out_of_scope or []):
        text = str(oos or "").strip()
        if not text:
            continue
        _insert(
            parent_id=root_id,
            kind="out_of_scope",
            title=text,
            sort_order=4000 + i,
        )

    conn.commit()
