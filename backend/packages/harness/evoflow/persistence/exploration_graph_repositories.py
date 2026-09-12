"""CRUD + incremental mind_map_ops for the session knowledge graph.

All writes use ``run_db_transaction`` (BEGIN IMMEDIATE, single commit) so batches
stay short and do not hold table locks across tool execution or network I/O.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.exploration_graph.models import (
    ApplyOpsResult,
    ExplorationEdge,
    ExplorationGraphHeader,
    ExplorationNode,
    MindMapOp,
    OpApplyRecord,
)
from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_ACTIVE_NODE_STATUSES = frozenset({"active", "stale", "resolved"})
_MAX_NODES_PER_THREAD = 2000
_MAX_EDGES_PER_THREAD = 4000


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads_list(raw: Any) -> list:
    if isinstance(raw, list):
        return raw
    try:
        parsed = json.loads(str(raw or "[]"))
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _loads_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(str(raw or "{}"))
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def resolve_scope_thread_id(thread_id: str | None) -> str:
    """Map executor sub-threads to lead thread (same rule as chat transcript scope)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    try:
        from evoflow.collab.thread_ids import normalize_lead_thread_id

        lead = normalize_lead_thread_id(tid)
        return lead or tid
    except Exception:
        return tid


def _resolve_session_key(thread_id: str) -> str | None:
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = find_session_key_by_thread_id(thread_id)
        return str(sk).strip() if sk else None
    except Exception:
        return None


def _header_from_row(row: Any) -> ExplorationGraphHeader:
    d = _row_dict(row)
    return ExplorationGraphHeader(
        thread_id=str(d["thread_id"]),
        session_key=str(d["session_key"]) if d.get("session_key") else None,
        graph_version=int(d.get("graph_version") or 0),
        active_turn_id=str(d.get("active_turn_id") or ""),
        node_count=int(d.get("node_count") or 0),
        edge_count=int(d.get("edge_count") or 0),
        render_summary=str(d.get("render_summary") or ""),
        goal=str(d.get("goal") or ""),
        created_at=str(d.get("created_at") or ""),
        updated_at=str(d.get("updated_at") or ""),
    )


def _node_from_row(row: Any) -> ExplorationNode:
    d = _row_dict(row)
    return ExplorationNode(
        id=int(d["id"]),
        thread_id=str(d["thread_id"]),
        external_id=str(d["external_id"]),
        kind=str(d.get("kind") or "note"),
        parent_external_id=str(d["parent_external_id"]) if d.get("parent_external_id") else None,
        title=str(d.get("title") or ""),
        body=str(d.get("body") or ""),
        status=str(d.get("status") or "active"),
        refs=_loads_list(d.get("refs_json")),
        meta=_loads_dict(d.get("meta_json")),
        source_tool=str(d.get("source_tool") or ""),
        source_tool_call_id=str(d.get("source_tool_call_id") or ""),
        turn_id=str(d.get("turn_id") or ""),
        sort_order=int(d.get("sort_order") or 0),
        graph_version=int(d.get("graph_version") or 0),
        created_at=str(d.get("created_at") or ""),
        updated_at=str(d.get("updated_at") or ""),
    )


def _edge_from_row(row: Any) -> ExplorationEdge:
    d = _row_dict(row)
    return ExplorationEdge(
        id=int(d["id"]),
        thread_id=str(d["thread_id"]),
        external_id=str(d["external_id"]),
        from_external_id=str(d["from_external_id"]),
        to_external_id=str(d["to_external_id"]),
        rel=str(d.get("rel") or "depends"),
        label=str(d.get("label") or ""),
        status=str(d.get("status") or "active"),
        source_tool_call_id=str(d.get("source_tool_call_id") or ""),
        graph_version=int(d.get("graph_version") or 0),
        created_at=str(d.get("created_at") or ""),
        updated_at=str(d.get("updated_at") or ""),
    )


def _count_active_nodes(conn: Any, thread_id: str) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) FROM evoflow_exploration_nodes
        WHERE thread_id = ? AND status != 'deleted'
        """,
        (thread_id,),
    ).fetchone()
    return int(row[0] if row else 0)


def _count_active_edges(conn: Any, thread_id: str) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) FROM evoflow_exploration_edges
        WHERE thread_id = ? AND status != 'deleted'
        """,
        (thread_id,),
    ).fetchone()
    return int(row[0] if row else 0)


def _ensure_header_row(
    conn: Any,
    thread_id: str,
    *,
    session_key: str | None = None,
    active_turn_id: str = "",
) -> None:
    now = utc_now_iso_z()
    sk = str(session_key or "").strip() or _resolve_session_key(thread_id)
    conn.execute(
        """
        INSERT INTO evoflow_exploration_graph (
            thread_id, session_key, graph_version, active_turn_id,
            node_count, edge_count, render_summary, created_at, updated_at
        ) VALUES (?, ?, 0, ?, 0, 0, '', ?, ?)
        ON CONFLICT(thread_id) DO NOTHING
        """,
        (thread_id, sk, str(active_turn_id or ""), now, now),
    )
    if sk:
        conn.execute(
            """
            UPDATE evoflow_exploration_graph
            SET session_key = COALESCE(session_key, ?), updated_at = ?
            WHERE thread_id = ?
            """,
            (sk, now, thread_id),
        )


def _refresh_header_counts(conn: Any, thread_id: str, *, now: str) -> tuple[int, int]:
    node_count = _count_active_nodes(conn, thread_id)
    edge_count = _count_active_edges(conn, thread_id)
    conn.execute(
        """
        UPDATE evoflow_exploration_graph
        SET node_count = ?, edge_count = ?, updated_at = ?
        WHERE thread_id = ?
        """,
        (node_count, edge_count, now, thread_id),
    )
    return node_count, edge_count


def _coerce_op(raw: MindMapOp | dict[str, Any]) -> MindMapOp:
    if isinstance(raw, MindMapOp):
        return raw
    return MindMapOp.model_validate(raw)


# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------


def get_graph_header(thread_id: str) -> ExplorationGraphHeader | None:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        return None
    row = get_db().execute(
        "SELECT * FROM evoflow_exploration_graph WHERE thread_id = ?",
        (tid,),
    ).fetchone()
    return _header_from_row(row) if row else None


def ensure_graph_header(
    thread_id: str,
    *,
    session_key: str | None = None,
    active_turn_id: str = "",
) -> ExplorationGraphHeader:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        raise ValueError("thread_id is required")

    def _write(conn: Any) -> ExplorationGraphHeader:
        now = utc_now_iso_z()
        _ensure_header_row(conn, tid, session_key=session_key, active_turn_id=active_turn_id)
        if active_turn_id:
            conn.execute(
                """
                UPDATE evoflow_exploration_graph
                SET active_turn_id = ?, updated_at = ?
                WHERE thread_id = ?
                """,
                (str(active_turn_id), now, tid),
            )
        row = conn.execute(
            "SELECT * FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        if not row:
            raise RuntimeError(f"failed to ensure exploration graph for {tid}")
        return _header_from_row(row)

    return run_db_transaction(_write)


def update_graph_summary(thread_id: str, render_summary: str) -> ExplorationGraphHeader | None:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        return None

    def _write(conn: Any) -> ExplorationGraphHeader | None:
        now = utc_now_iso_z()
        conn.execute(
            """
            UPDATE evoflow_exploration_graph
            SET render_summary = ?, updated_at = ?
            WHERE thread_id = ?
            """,
            (str(render_summary or ""), now, tid),
        )
        row = conn.execute(
            "SELECT * FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        return _header_from_row(row) if row else None

    return run_db_transaction(_write)


def delete_exploration_graph(thread_id: str) -> None:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        return

    def _write(conn: Any) -> None:
        conn.execute("DELETE FROM evoflow_exploration_ops WHERE thread_id = ?", (tid,))
        conn.execute("DELETE FROM evoflow_exploration_edges WHERE thread_id = ?", (tid,))
        conn.execute("DELETE FROM evoflow_exploration_nodes WHERE thread_id = ?", (tid,))
        conn.execute("DELETE FROM evoflow_exploration_graph WHERE thread_id = ?", (tid,))

    run_db_transaction(_write)


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


def list_nodes(
    thread_id: str,
    *,
    status: str | None = "active",
    kind: str | None = None,
    limit: int = 500,
) -> list[ExplorationNode]:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        return []
    lim = max(1, min(int(limit), _MAX_NODES_PER_THREAD))
    sql = [
        "SELECT * FROM evoflow_exploration_nodes WHERE thread_id = ?",
    ]
    params: list[Any] = [tid]
    if status == "active":
        sql.append("AND status != 'deleted'")
    elif status:
        sql.append("AND status = ?")
        params.append(status)
    if kind:
        sql.append("AND kind = ?")
        params.append(kind)
    sql.append("ORDER BY sort_order, updated_at DESC, id DESC LIMIT ?")
    params.append(lim)
    rows = get_db().execute("\n".join(sql), tuple(params)).fetchall()
    return [_node_from_row(r) for r in rows]


def get_node(thread_id: str, external_id: str) -> ExplorationNode | None:
    tid = resolve_scope_thread_id(thread_id)
    eid = str(external_id or "").strip()
    if not tid or not eid:
        return None
    row = get_db().execute(
        """
        SELECT * FROM evoflow_exploration_nodes
        WHERE thread_id = ? AND external_id = ?
        """,
        (tid, eid),
    ).fetchone()
    return _node_from_row(row) if row else None


def upsert_node(
    thread_id: str,
    node: ExplorationNode | dict[str, Any],
    *,
    graph_version: int | None = None,
    source_tool: str = "",
    source_tool_call_id: str = "",
    turn_id: str = "",
) -> ExplorationNode:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        raise ValueError("thread_id is required")
    if isinstance(node, dict):
        payload = dict(node)
        payload.setdefault("thread_id", tid)
        model = ExplorationNode.model_validate(payload)
    else:
        model = node
    eid = str(model.external_id or "").strip()
    if not eid:
        raise ValueError("external_id is required")

    def _write(conn: Any) -> ExplorationNode:
        _ensure_header_row(conn, tid)
        now = utc_now_iso_z()
        header = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        ver = int(graph_version if graph_version is not None else (header[0] if header else 0))
        parent = str(model.parent_external_id).strip() if model.parent_external_id else None
        conn.execute(
            """
            INSERT INTO evoflow_exploration_nodes (
                thread_id, external_id, kind, parent_external_id, title, body, status,
                refs_json, meta_json, source_tool, source_tool_call_id, turn_id,
                sort_order, graph_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id, external_id) DO UPDATE SET
                kind = excluded.kind,
                parent_external_id = excluded.parent_external_id,
                title = excluded.title,
                body = excluded.body,
                status = excluded.status,
                refs_json = excluded.refs_json,
                meta_json = excluded.meta_json,
                source_tool = excluded.source_tool,
                source_tool_call_id = excluded.source_tool_call_id,
                turn_id = excluded.turn_id,
                sort_order = excluded.sort_order,
                graph_version = excluded.graph_version,
                updated_at = excluded.updated_at
            """,
            (
                tid,
                eid,
                str(model.kind or "note"),
                parent,
                str(model.title or ""),
                str(model.body or ""),
                str(model.status or "active"),
                _dumps(model.refs or []),
                _dumps(model.meta or {}),
                str(source_tool or model.source_tool or ""),
                str(source_tool_call_id or model.source_tool_call_id or ""),
                str(turn_id or model.turn_id or ""),
                int(model.sort_order or 0),
                ver,
                now,
                now,
            ),
        )
        _refresh_header_counts(conn, tid, now=now)
        row = conn.execute(
            "SELECT * FROM evoflow_exploration_nodes WHERE thread_id = ? AND external_id = ?",
            (tid, eid),
        ).fetchone()
        if not row:
            raise RuntimeError(f"upsert_node failed for {eid}")
        return _node_from_row(row)

    return run_db_transaction(_write)


def patch_node(
    thread_id: str,
    external_id: str,
    *,
    title: str | None = None,
    body: str | None = None,
    append_body: str | None = None,
    status: str | None = None,
    parent_external_id: str | None = None,
    kind: str | None = None,
    refs: list[str] | None = None,
    meta: dict[str, Any] | None = None,
    graph_version: int | None = None,
) -> ExplorationNode | None:
    tid = resolve_scope_thread_id(thread_id)
    eid = str(external_id or "").strip()
    if not tid or not eid:
        return None
    existing = get_node(tid, eid)
    if existing is None:
        return None

    new_body = existing.body
    if body is not None:
        new_body = body
    if append_body:
        extra = str(append_body).strip()
        if extra:
            new_body = f"{new_body.rstrip()}\n{extra}".strip() if new_body.strip() else extra

    def _write(conn: Any) -> ExplorationNode | None:
        now = utc_now_iso_z()
        header = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        ver = int(graph_version if graph_version is not None else (header[0] if header else 0))
        conn.execute(
            """
            UPDATE evoflow_exploration_nodes SET
                kind = COALESCE(?, kind),
                parent_external_id = COALESCE(?, parent_external_id),
                title = COALESCE(?, title),
                body = ?,
                status = COALESCE(?, status),
                refs_json = COALESCE(?, refs_json),
                meta_json = COALESCE(?, meta_json),
                graph_version = ?,
                updated_at = ?
            WHERE thread_id = ? AND external_id = ?
            """,
            (
                kind,
                parent_external_id,
                title,
                new_body,
                status,
                _dumps(refs) if refs is not None else None,
                _dumps(meta) if meta is not None else None,
                ver,
                now,
                tid,
                eid,
            ),
        )
        row = conn.execute(
            "SELECT * FROM evoflow_exploration_nodes WHERE thread_id = ? AND external_id = ?",
            (tid, eid),
        ).fetchone()
        return _node_from_row(row) if row else None

    return run_db_transaction(_write)


def user_patch_node_status(
    thread_id: str,
    external_id: str,
    status: str,
    *,
    session_key: str | None = None,
) -> ExplorationNode | None:
    """Apply a user-initiated status change from evopanel (bumps graph_version)."""
    from evoflow.exploration_graph.node_status import (
        is_processing_status,
        is_status_tracked_kind,
        is_user_patchable_status,
        normalize_node_status,
        should_cascade_status_to_descendants,
    )

    tid = resolve_mind_map_thread_id(thread_id, session_key=session_key)
    eid = str(external_id or "").strip()
    st = normalize_node_status(status)
    if not tid or not eid:
        return None
    if not is_user_patchable_status(st):
        raise ValueError(f"unsupported status: {status}")
    if eid == "goal:session":
        raise ValueError("cannot change goal node status")

    def _tracked_descendants(conn: Any, root_id: str) -> list[str]:
        rows = conn.execute(
            """
            SELECT external_id, kind, parent_external_id, status
            FROM evoflow_exploration_nodes
            WHERE thread_id = ? AND status != 'deleted'
            """,
            (tid,),
        ).fetchall()
        children: dict[str, list[str]] = {}
        meta: dict[str, tuple[str, str]] = {}
        for row in rows:
            cid = str(row[0] or "").strip()
            if not cid:
                continue
            meta[cid] = (str(row[1] or ""), str(row[3] or "active"))
            parent = str(row[2] or "").strip()
            if parent:
                children.setdefault(parent, []).append(cid)
        out: list[str] = []
        queue = list(children.get(root_id, []))
        seen: set[str] = set()
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            kind, cur_status = meta.get(cur, ("", "active"))
            if is_status_tracked_kind(kind, cur) and is_processing_status(cur_status):
                out.append(cur)
            queue.extend(children.get(cur, []))
        return out

    def _write(conn: Any) -> ExplorationNode | None:
        row = conn.execute(
            "SELECT external_id, kind FROM evoflow_exploration_nodes WHERE thread_id = ? AND external_id = ? AND status != 'deleted'",
            (tid, eid),
        ).fetchone()
        if not row:
            return None
        if not is_status_tracked_kind(str(row[1] or ""), eid):
            raise ValueError("only flow/gap/task/hypothesis nodes support status edits")
        now = utc_now_iso_z()
        sk = session_key or _resolve_session_key(tid)
        _ensure_header_row(conn, tid, session_key=sk)
        header = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        new_ver = int(header[0] if header else 0) + 1
        conn.execute(
            """
            UPDATE evoflow_exploration_nodes SET
                status = ?,
                graph_version = ?,
                updated_at = ?
            WHERE thread_id = ? AND external_id = ?
            """,
            (st, new_ver, now, tid, eid),
        )
        if should_cascade_status_to_descendants(st):
            for child_id in _tracked_descendants(conn, eid):
                conn.execute(
                    """
                    UPDATE evoflow_exploration_nodes SET
                        status = ?,
                        graph_version = ?,
                        updated_at = ?
                    WHERE thread_id = ? AND external_id = ?
                    """,
                    (st, new_ver, now, tid, child_id),
                )
        conn.execute(
            """
            UPDATE evoflow_exploration_graph SET graph_version = ?, updated_at = ? WHERE thread_id = ?
            """,
            (new_ver, now, tid),
        )
        conn.execute(
            """
            INSERT INTO evoflow_exploration_ops (
                thread_id, scope_thread_id, graph_version, turn_id, run_id,
                tool_name, tool_call_id, op_index, op, target_external_id,
                payload_json, apply_status, error_message, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tid,
                tid,
                new_ver,
                "",
                None,
                "user",
                f"user-status:{eid}",
                0,
                "patch_node",
                eid,
                _dumps({"op": "patch_node", "id": eid, "status": st, "source": "user"}),
                "applied",
                "",
                now,
            ),
        )
        out = conn.execute(
            "SELECT * FROM evoflow_exploration_nodes WHERE thread_id = ? AND external_id = ?",
            (tid, eid),
        ).fetchone()
        return _node_from_row(out) if out else None

    return run_db_transaction(_write)


def soft_delete_node(thread_id: str, external_id: str, *, graph_version: int | None = None) -> bool:
    tid = resolve_scope_thread_id(thread_id)
    eid = str(external_id or "").strip()
    if not tid or not eid:
        return False

    def _write(conn: Any) -> bool:
        now = utc_now_iso_z()
        header = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        ver = int(graph_version if graph_version is not None else (header[0] if header else 0))
        cur = conn.execute(
            """
            UPDATE evoflow_exploration_nodes
            SET status = 'deleted', graph_version = ?, updated_at = ?
            WHERE thread_id = ? AND external_id = ? AND status != 'deleted'
            """,
            (ver, now, tid, eid),
        )
        if cur.rowcount:
            _refresh_header_counts(conn, tid, now=now)
        return cur.rowcount > 0

    return run_db_transaction(_write)


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------


def list_edges(
    thread_id: str,
    *,
    status: str | None = "active",
    from_external_id: str | None = None,
    to_external_id: str | None = None,
    limit: int = 500,
) -> list[ExplorationEdge]:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        return []
    lim = max(1, min(int(limit), _MAX_EDGES_PER_THREAD))
    sql = ["SELECT * FROM evoflow_exploration_edges WHERE thread_id = ?"]
    params: list[Any] = [tid]
    if status == "active":
        sql.append("AND status != 'deleted'")
    elif status:
        sql.append("AND status = ?")
        params.append(status)
    if from_external_id:
        sql.append("AND from_external_id = ?")
        params.append(from_external_id)
    if to_external_id:
        sql.append("AND to_external_id = ?")
        params.append(to_external_id)
    sql.append("ORDER BY updated_at DESC, id DESC LIMIT ?")
    params.append(lim)
    rows = get_db().execute("\n".join(sql), tuple(params)).fetchall()
    return [_edge_from_row(r) for r in rows]


def get_edge(thread_id: str, external_id: str) -> ExplorationEdge | None:
    tid = resolve_scope_thread_id(thread_id)
    eid = str(external_id or "").strip()
    if not tid or not eid:
        return None
    row = get_db().execute(
        """
        SELECT * FROM evoflow_exploration_edges
        WHERE thread_id = ? AND external_id = ?
        """,
        (tid, eid),
    ).fetchone()
    return _edge_from_row(row) if row else None


def upsert_edge(
    thread_id: str,
    edge: ExplorationEdge | dict[str, Any],
    *,
    graph_version: int | None = None,
    source_tool_call_id: str = "",
) -> ExplorationEdge:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        raise ValueError("thread_id is required")
    if isinstance(edge, dict):
        payload = dict(edge)
        payload.setdefault("thread_id", tid)
        model = ExplorationEdge.model_validate(payload)
    else:
        model = edge
    eid = str(model.external_id or "").strip()
    from_id = str(model.from_external_id or "").strip()
    to_id = str(model.to_external_id or "").strip()
    if not eid or not from_id or not to_id:
        raise ValueError("external_id, from_external_id, to_external_id are required")

    def _write(conn: Any) -> ExplorationEdge:
        _ensure_header_row(conn, tid)
        now = utc_now_iso_z()
        header = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        ver = int(graph_version if graph_version is not None else (header[0] if header else 0))
        conn.execute(
            """
            INSERT INTO evoflow_exploration_edges (
                thread_id, external_id, from_external_id, to_external_id, rel, label,
                status, source_tool_call_id, graph_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id, external_id) DO UPDATE SET
                from_external_id = excluded.from_external_id,
                to_external_id = excluded.to_external_id,
                rel = excluded.rel,
                label = excluded.label,
                status = excluded.status,
                source_tool_call_id = excluded.source_tool_call_id,
                graph_version = excluded.graph_version,
                updated_at = excluded.updated_at
            """,
            (
                tid,
                eid,
                from_id,
                to_id,
                str(model.rel or "depends"),
                str(model.label or ""),
                str(model.status or "active"),
                str(source_tool_call_id or model.source_tool_call_id or ""),
                ver,
                now,
                now,
            ),
        )
        _refresh_header_counts(conn, tid, now=now)
        row = conn.execute(
            "SELECT * FROM evoflow_exploration_edges WHERE thread_id = ? AND external_id = ?",
            (tid, eid),
        ).fetchone()
        if not row:
            raise RuntimeError(f"upsert_edge failed for {eid}")
        return _edge_from_row(row)

    return run_db_transaction(_write)


def soft_delete_edge(thread_id: str, external_id: str, *, graph_version: int | None = None) -> bool:
    tid = resolve_scope_thread_id(thread_id)
    eid = str(external_id or "").strip()
    if not tid or not eid:
        return False

    def _write(conn: Any) -> bool:
        now = utc_now_iso_z()
        header = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (tid,),
        ).fetchone()
        ver = int(graph_version if graph_version is not None else (header[0] if header else 0))
        cur = conn.execute(
            """
            UPDATE evoflow_exploration_edges
            SET status = 'deleted', graph_version = ?, updated_at = ?
            WHERE thread_id = ? AND external_id = ? AND status != 'deleted'
            """,
            (ver, now, tid, eid),
        )
        if cur.rowcount:
            _refresh_header_counts(conn, tid, now=now)
        return cur.rowcount > 0

    return run_db_transaction(_write)


# ---------------------------------------------------------------------------
# Ops log + batch apply
# ---------------------------------------------------------------------------


def list_ops(
    thread_id: str,
    *,
    tool_call_id: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    tid = resolve_scope_thread_id(thread_id)
    if not tid:
        return []
    lim = max(1, min(int(limit), 1000))
    if tool_call_id:
        rows = get_db().execute(
            """
            SELECT * FROM evoflow_exploration_ops
            WHERE thread_id = ? AND tool_call_id = ?
            ORDER BY op_index, id
            LIMIT ?
            """,
            (tid, str(tool_call_id), lim),
        ).fetchall()
    else:
        rows = get_db().execute(
            """
            SELECT * FROM evoflow_exploration_ops
            WHERE thread_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (tid, lim),
        ).fetchall()
    return [_row_dict(r) for r in rows]


def load_graph_snapshot(
    thread_id: str,
    *,
    node_limit: int = 200,
    edge_limit: int = 200,
) -> dict[str, Any]:
    """Header + active nodes/edges for API or prompt rendering."""
    tid = resolve_scope_thread_id(thread_id)
    header = get_graph_header(tid) if tid else None
    if not header:
        return {"header": None, "nodes": [], "edges": []}
    return {
        "header": header.model_dump(mode="json"),
        "nodes": [n.model_dump(mode="json") for n in list_nodes(tid, limit=node_limit)],
        "edges": [e.model_dump(mode="json") for e in list_edges(tid, limit=edge_limit)],
    }


def _graph_header_has_content(header: ExplorationGraphHeader | None) -> bool:
    if header is None:
        return False
    if int(header.node_count or 0) > 0:
        return True
    if str(header.goal or "").strip():
        return True
    if str(header.render_summary or "").strip():
        return True
    return False


def find_thread_id_by_session_key(session_key: str) -> str | None:
    """Resolve exploration graph thread_id from session_key (graph header or latest chat row)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = get_db().execute(
        """
        SELECT thread_id FROM evoflow_exploration_graph
        WHERE session_key = ? AND TRIM(COALESCE(thread_id, '')) != ''
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        (sk,),
    ).fetchone()
    if row and str(row[0] or "").strip():
        return str(row[0]).strip()
    row = get_db().execute(
        """
        SELECT thread_id FROM evoflow_chat_messages
        WHERE session_key = ? AND TRIM(COALESCE(thread_id, '')) != ''
        ORDER BY seq DESC
        LIMIT 1
        """,
        (sk,),
    ).fetchone()
    if row and str(row[0] or "").strip():
        return str(row[0]).strip()
    return None


def find_thread_id_with_graph_for_session(session_key: str) -> str | None:
    """Prefer the session graph row that actually has nodes/goal (not an empty new thread header)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    rows = get_db().execute(
        """
        SELECT thread_id FROM evoflow_exploration_graph
        WHERE session_key = ? AND TRIM(COALESCE(thread_id, '')) != ''
        ORDER BY node_count DESC, graph_version DESC, updated_at DESC
        LIMIT 8
        """,
        (sk,),
    ).fetchall()
    for row in rows or []:
        tid = str(row[0] or "").strip()
        if tid and _graph_header_has_content(get_graph_header(tid)):
            return tid
    return None


def resolve_mind_map_thread_id(
    thread_id: str | None = None,
    *,
    session_key: str | None = None,
) -> str:
    """Pick the thread whose exploration graph should be injected into model context."""
    scoped = resolve_scope_thread_id(thread_id)
    sk = str(session_key or "").strip()
    if not sk and scoped:
        sk = str(_resolve_session_key(scoped) or "").strip()

    candidates: list[str] = []
    rich = find_thread_id_with_graph_for_session(sk) if sk else None
    if rich:
        candidates.append(rich)
    if scoped and scoped not in candidates:
        candidates.append(scoped)
    if sk:
        fb = find_thread_id_by_session_key(sk)
        if fb and fb not in candidates:
            candidates.append(fb)

    for tid in candidates:
        if _graph_header_has_content(get_graph_header(tid)):
            return tid
    return scoped or (candidates[0] if candidates else "")


def load_graph_snapshot_for_session(
    session_key: str,
    *,
    thread_id: str | None = None,
    node_limit: int = 200,
    edge_limit: int = 200,
) -> dict[str, Any]:
    """Load graph by session_key with thread_id fallbacks (sidebar binding may use camelCase only)."""
    tid = resolve_mind_map_thread_id(thread_id, session_key=session_key)
    if not tid:
        return {"header": None, "nodes": [], "edges": [], "thread_id": ""}
    snap = load_graph_snapshot(tid, node_limit=node_limit, edge_limit=edge_limit)
    snap["thread_id"] = resolve_scope_thread_id(tid)
    return snap


_KIND_PREFIX_MAP = {
    "goal:": "goal",
    "flow:": "flow",
    "gap:": "gap",
    "claim:": "claim",
    "file:": "file",
    "diagram:": "diagram",
}


def _effective_op_meta(op: MindMapOp, *, external_id: str, body: str = "") -> dict[str, Any]:
    from evoflow.exploration_graph.diagram import enrich_diagram_meta

    kind = _resolve_node_kind(op.kind, external_id) if op.kind else _infer_kind_from_id(external_id) or ""
    return enrich_diagram_meta(
        meta=dict(op.meta or {}),
        kind=kind,
        diagram_type=getattr(op, "diagram_type", None),
        body=body or str(op.body or op.append_body or ""),
    )


def _infer_kind_from_id(external_id: str) -> str | None:
    """Infer node kind from external_id prefix (e.g. 'flow:xxx' → 'flow').

    Returns None when the prefix is unrecognized.
    """
    eid = str(external_id or "").strip().lower()
    for prefix, kind in _KIND_PREFIX_MAP.items():
        if eid.startswith(prefix):
            return kind
    return None


def _resolve_node_kind(op_kind: str | None, external_id: str) -> str:
    """Resolve the effective kind: use explicit kind when set, otherwise infer from id prefix.

    When *op_kind* is missing or is the generic default ``'note'``, we infer the kind
    from the external_id prefix (``flow:`` → ``flow``, ``gap:`` → ``gap``, …).
    This prevents nodes like ``flow:deep-audit`` from being stored as ``note`` just
    because the model omitted the ``kind`` field (whose default is ``'note'``).
    """
    raw = str(op_kind or "").strip().lower()
    if raw and raw != "note":
        return raw
    inferred = _infer_kind_from_id(external_id)
    return inferred or raw or "note"


def _apply_single_op(
    conn: Any,
    *,
    scope_tid: str,
    op: MindMapOp,
    graph_version: int,
    turn_id: str,
    tool_name: str,
    tool_call_id: str,
) -> OpApplyRecord:
    eid = str(op.id).strip()
    # Auto-derive edge external_id from (from, rel, to) when omitted.
    # Lets models build edges without inventing edge-id strings.
    if not eid and op.op in {"upsert_edge", "delete_edge"}:
        from_id_norm = str(op.from_id or "").strip()
        to_id_norm = str(op.to_id or "").strip()
        rel_norm = str(op.rel or "depends").strip() or "depends"
        if from_id_norm and to_id_norm:
            eid = f"edge:{from_id_norm}::{rel_norm}::{to_id_norm}"
    try:
        if op.op == "upsert_node":
            if _count_active_nodes(conn, scope_tid) >= _MAX_NODES_PER_THREAD:
                existing = conn.execute(
                    "SELECT 1 FROM evoflow_exploration_nodes WHERE thread_id = ? AND external_id = ?",
                    (scope_tid, eid),
                ).fetchone()
                if not existing:
                    return OpApplyRecord(
                        op_index=-1,
                        op=op.op,
                        target_external_id=eid,
                        apply_status="rejected",
                        error_message=f"node cap {_MAX_NODES_PER_THREAD} reached",
                    )
            parent = str(op.parent).strip() if op.parent else None
            now = utc_now_iso_z()
            node_body = str(op.body or "")
            node_meta = _effective_op_meta(op, external_id=eid, body=node_body)
            conn.execute(
                """
                INSERT INTO evoflow_exploration_nodes (
                    thread_id, external_id, kind, parent_external_id, title, body, status,
                    refs_json, meta_json, source_tool, source_tool_call_id, turn_id,
                    sort_order, graph_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(thread_id, external_id) DO UPDATE SET
                    kind = excluded.kind,
                    parent_external_id = excluded.parent_external_id,
                    title = excluded.title,
                    body = excluded.body,
                    status = 'active',
                    refs_json = excluded.refs_json,
                    meta_json = excluded.meta_json,
                    source_tool = excluded.source_tool,
                    source_tool_call_id = excluded.source_tool_call_id,
                    turn_id = excluded.turn_id,
                    sort_order = excluded.sort_order,
                    graph_version = excluded.graph_version,
                    updated_at = excluded.updated_at
                """,
                (
                    scope_tid,
                    eid,
                    _resolve_node_kind(op.kind, eid),
                    parent,
                    str(op.title or ""),
                    node_body,
                    _dumps(op.refs or []),
                    _dumps(node_meta),
                    str(tool_name or ""),
                    str(tool_call_id or ""),
                    str(turn_id or ""),
                    int(op.sort_order or 0),
                    graph_version,
                    now,
                    now,
                ),
            )
        elif op.op == "patch_node":
            row = conn.execute(
                "SELECT body, meta_json, kind FROM evoflow_exploration_nodes WHERE thread_id = ? AND external_id = ?",
                (scope_tid, eid),
            ).fetchone()
            if not row:
                return OpApplyRecord(
                    op_index=-1,
                    op=op.op,
                    target_external_id=eid,
                    apply_status="rejected",
                    error_message="node not found",
                )
            body = str(row[0] or "")
            if op.body:
                body = str(op.body)
            if op.append_body:
                extra = str(op.append_body).strip()
                if extra:
                    body = f"{body.rstrip()}\n{extra}".strip() if body.strip() else extra
            existing_meta = _loads_dict(row[1] if len(row) > 1 else {})
            existing_kind = str(row[2] if len(row) > 2 else "").strip()
            resolved_kind = _resolve_node_kind(op.kind, eid) if op.kind else existing_kind
            from evoflow.exploration_graph.diagram import enrich_diagram_meta

            patch_meta = {**existing_meta, **_effective_op_meta(op, external_id=eid, body=body)}
            patch_meta = enrich_diagram_meta(
                meta=patch_meta,
                kind=resolved_kind,
                diagram_type=getattr(op, "diagram_type", None) or existing_meta.get("diagram_type"),
                body=body,
            )
            now = utc_now_iso_z()
            conn.execute(
                """
                UPDATE evoflow_exploration_nodes SET
                    kind = COALESCE(?, kind),
                    parent_external_id = COALESCE(?, parent_external_id),
                    title = COALESCE(?, title),
                    body = ?,
                    status = COALESCE(?, status),
                    refs_json = COALESCE(?, refs_json),
                    meta_json = COALESCE(?, meta_json),
                    graph_version = ?,
                    updated_at = ?
                WHERE thread_id = ? AND external_id = ?
                """,
                (
                    _resolve_node_kind(op.kind, eid) if op.kind else None,
                    str(op.parent).strip() if op.parent else None,
                    str(op.title) if op.title else None,
                    body,
                    str(op.status) if op.status else None,
                    _dumps(op.refs) if op.refs else None,
                    _dumps(patch_meta),
                    graph_version,
                    now,
                    scope_tid,
                    eid,
                ),
            )
        elif op.op == "delete_node":
            now = utc_now_iso_z()
            conn.execute(
                """
                UPDATE evoflow_exploration_nodes
                SET status = 'deleted', graph_version = ?, updated_at = ?
                WHERE thread_id = ? AND external_id = ?
                """,
                (graph_version, now, scope_tid, eid),
            )
        elif op.op == "upsert_edge":
            from_id = str(op.from_id or "").strip()
            to_id = str(op.to_id or "").strip()
            if not from_id or not to_id:
                return OpApplyRecord(
                    op_index=-1,
                    op=op.op,
                    target_external_id=eid,
                    apply_status="rejected",
                    error_message="from and to are required for upsert_edge",
                )
            if _count_active_edges(conn, scope_tid) >= _MAX_EDGES_PER_THREAD:
                existing = conn.execute(
                    "SELECT 1 FROM evoflow_exploration_edges WHERE thread_id = ? AND external_id = ?",
                    (scope_tid, eid),
                ).fetchone()
                if not existing:
                    return OpApplyRecord(
                        op_index=-1,
                        op=op.op,
                        target_external_id=eid,
                        apply_status="rejected",
                        error_message=f"edge cap {_MAX_EDGES_PER_THREAD} reached",
                    )
            now = utc_now_iso_z()
            conn.execute(
                """
                INSERT INTO evoflow_exploration_edges (
                    thread_id, external_id, from_external_id, to_external_id, rel, label,
                    status, source_tool_call_id, graph_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
                ON CONFLICT(thread_id, external_id) DO UPDATE SET
                    from_external_id = excluded.from_external_id,
                    to_external_id = excluded.to_external_id,
                    rel = excluded.rel,
                    label = excluded.label,
                    status = 'active',
                    source_tool_call_id = excluded.source_tool_call_id,
                    graph_version = excluded.graph_version,
                    updated_at = excluded.updated_at
                """,
                (
                    scope_tid,
                    eid,
                    from_id,
                    to_id,
                    str(op.rel or "depends"),
                    str(op.label or ""),
                    str(tool_call_id or ""),
                    graph_version,
                    now,
                    now,
                ),
            )
        elif op.op == "delete_edge":
            now = utc_now_iso_z()
            conn.execute(
                """
                UPDATE evoflow_exploration_edges
                SET status = 'deleted', graph_version = ?, updated_at = ?
                WHERE thread_id = ? AND external_id = ?
                """,
                (graph_version, now, scope_tid, eid),
            )
        elif op.op == "set_goal":
            goal_text = str(op.title or op.body or "").strip()
            if not goal_text:
                return OpApplyRecord(
                    op_index=-1,
                    op=op.op,
                    target_external_id="goal:session",
                    apply_status="rejected",
                    error_message="set_goal requires title or body",
                )
            goal_id = "goal:session"
            now = utc_now_iso_z()
            # Layer 2: When the goal changes, auto-archive old flow:/gap: nodes
            # to prevent stale problems from polluting the new session's context.
            prev_goal_row = conn.execute(
                "SELECT goal FROM evoflow_exploration_graph WHERE thread_id = ?",
                (scope_tid,),
            ).fetchone()
            prev_goal = str(prev_goal_row[0] or "").strip() if prev_goal_row else ""
            if prev_goal and prev_goal != goal_text:
                # Goal changed — archive active/stale flow: and gap: nodes.
                # Match by external_id prefix (catches old nodes stored with
                # kind='note') OR by correct kind (catches new nodes).
                conn.execute(
                    """
                    UPDATE evoflow_exploration_nodes
                    SET status = 'resolved', graph_version = ?, updated_at = ?
                    WHERE thread_id = ?
                      AND status IN ('active', 'stale')
                      AND (
                          external_id LIKE 'flow:%' OR external_id LIKE 'gap:%'
                          OR kind IN ('flow', 'gap')
                      )
                    """,
                    (graph_version, now, scope_tid),
                )
            conn.execute(
                """
                UPDATE evoflow_exploration_graph
                SET goal = ?, updated_at = ?
                WHERE thread_id = ?
                """,
                (goal_text, now, scope_tid),
            )
            conn.execute(
                """
                INSERT INTO evoflow_exploration_nodes (
                    thread_id, external_id, kind, parent_external_id, title, body, status,
                    refs_json, meta_json, source_tool, source_tool_call_id, turn_id,
                    sort_order, graph_version, created_at, updated_at
                ) VALUES (?, ?, 'goal', NULL, ?, ?, 'active', '[]', '{}', ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(thread_id, external_id) DO UPDATE SET
                    kind = 'goal',
                    title = excluded.title,
                    body = excluded.body,
                    status = 'active',
                    source_tool = excluded.source_tool,
                    source_tool_call_id = excluded.source_tool_call_id,
                    turn_id = excluded.turn_id,
                    graph_version = excluded.graph_version,
                    updated_at = excluded.updated_at
                """,
                (
                    scope_tid,
                    goal_id,
                    goal_text,
                    str(op.body or "").strip() if op.body and op.body != goal_text else "",
                    str(tool_name or ""),
                    str(tool_call_id or ""),
                    str(turn_id or ""),
                    graph_version,
                    now,
                    now,
                ),
            )
            return OpApplyRecord(
                op_index=-1,
                op=op.op,
                target_external_id=goal_id,
                apply_status="ok",
            )
        else:
            return OpApplyRecord(
                op_index=-1,
                op=str(op.op),
                target_external_id=eid,
                apply_status="rejected",
                error_message=f"unknown op {op.op!r}",
            )
        return OpApplyRecord(op_index=-1, op=op.op, target_external_id=eid, apply_status="ok")
    except Exception as exc:
        logger.debug("mind_map op failed op=%s id=%s", op.op, eid, exc_info=True)
        return OpApplyRecord(
            op_index=-1,
            op=op.op,
            target_external_id=eid,
            apply_status="rejected",
            error_message=str(exc)[:500],
        )


def apply_mind_map_ops(
    thread_id: str,
    ops: list[MindMapOp | dict[str, Any]],
    *,
    scope_thread_id: str | None = None,
    turn_id: str = "",
    run_id: str | None = None,
    tool_name: str = "",
    tool_call_id: str = "",
) -> ApplyOpsResult:
    """Apply a batch of incremental ops in one short transaction (no lock across tool I/O)."""
    from evoflow.exploration_graph.mind_map_diag import log_mind_map

    raw_tid = str(thread_id or "").strip()
    scope_tid = str(scope_thread_id or "").strip() or resolve_scope_thread_id(raw_tid)
    if not scope_tid:
        log_mind_map("apply_mind_map_ops中止", reason="thread_id为空", raw_thread_id=raw_tid)
        raise ValueError("thread_id is required")

    log_mind_map(
        "apply_mind_map_ops开始",
        raw_thread_id=raw_tid,
        scope_thread_id=scope_tid,
        tool=tool_name,
        call_id=tool_call_id,
        op_count=len(ops or []),
    )

    parsed = [_coerce_op(op) for op in (ops or [])]
    if not parsed:
        header = ensure_graph_header(scope_tid, active_turn_id=turn_id)
        return ApplyOpsResult(
            scope_thread_id=scope_tid,
            graph_version=header.graph_version,
            applied=[],
            node_count=header.node_count,
            edge_count=header.edge_count,
        )

    def _write(conn: Any) -> ApplyOpsResult:
        now = utc_now_iso_z()
        sk = _resolve_session_key(scope_tid)
        _ensure_header_row(conn, scope_tid, session_key=sk, active_turn_id=turn_id)
        row = conn.execute(
            "SELECT graph_version FROM evoflow_exploration_graph WHERE thread_id = ?",
            (scope_tid,),
        ).fetchone()
        current_ver = int(row[0] if row else 0)
        new_ver = current_ver + 1

        records: list[OpApplyRecord] = []
        for idx, op in enumerate(parsed):
            rec = _apply_single_op(
                conn,
                scope_tid=scope_tid,
                op=op,
                graph_version=new_ver,
                turn_id=turn_id,
                tool_name=tool_name,
                tool_call_id=tool_call_id,
            )
            rec = rec.model_copy(update={"op_index": idx})
            records.append(rec)
            conn.execute(
                """
                INSERT INTO evoflow_exploration_ops (
                    thread_id, scope_thread_id, graph_version, turn_id, run_id,
                    tool_name, tool_call_id, op_index, op, target_external_id,
                    payload_json, apply_status, error_message, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scope_tid,
                    scope_tid,
                    new_ver,
                    str(turn_id or ""),
                    str(run_id or "") or None,
                    str(tool_name or ""),
                    str(tool_call_id or ""),
                    idx,
                    op.op,
                    str(op.id),
                    _dumps(op.model_dump(mode="json")),
                    rec.apply_status,
                    rec.error_message,
                    now,
                ),
            )

        node_count, edge_count = _refresh_header_counts(conn, scope_tid, now=now)
        conn.execute(
            """
            UPDATE evoflow_exploration_graph
            SET graph_version = ?, active_turn_id = COALESCE(?, active_turn_id),
                session_key = COALESCE(session_key, ?),
                updated_at = ?
            WHERE thread_id = ?
            """,
            (new_ver, str(turn_id or "") or None, sk, now, scope_tid),
        )
        log_mind_map(
            "apply_mind_map_ops提交",
            scope_thread_id=scope_tid,
            session_key=sk or "(未解析)",
            graph_version=new_ver,
            node_count=node_count,
            edge_count=edge_count,
            tool=tool_name,
            call_id=tool_call_id,
        )
        return ApplyOpsResult(
            scope_thread_id=scope_tid,
            graph_version=new_ver,
            applied=records,
            node_count=node_count,
            edge_count=edge_count,
        )

    return run_db_transaction(_write)
