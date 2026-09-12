"""Exploration graph persistence + schema v48."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.exploration_graph.models import ExplorationEdge, ExplorationNode
from evoflow.persistence.exploration_graph_repositories import (
    apply_mind_map_ops,
    delete_exploration_graph,
    get_graph_header,
    get_node,
    list_edges,
    list_nodes,
    list_ops,
    load_graph_snapshot,
    patch_node,
    resolve_scope_thread_id,
    soft_delete_node,
    upsert_edge,
    upsert_node,
)
from evoflow.persistence.schema import APP_SCHEMA_VERSION, ensure_app_schema


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        from evoflow.persistence.db import get_db, reset_db_for_tests

        reset_db_for_tests()
        ensure_app_schema(get_db())
        yield
        reset_db_for_tests()
        import gc

        gc.collect()


def test_schema_v48_tables_exist(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.db import get_db

    db = get_db()
    assert int(db.execute("PRAGMA user_version").fetchone()[0]) == APP_SCHEMA_VERSION == 50
    cols = {str(r[1]) for r in db.execute("PRAGMA table_info(evoflow_exploration_graph)").fetchall()}
    assert "goal" in cols
    for name in (
        "evoflow_exploration_graph",
        "evoflow_exploration_nodes",
        "evoflow_exploration_edges",
        "evoflow_exploration_ops",
    ):
        row = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
        assert row is not None, name


def test_resolve_scope_thread_id_maps_sub_executor() -> None:
    lead = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    sub = f"{lead}__sub__task-1"
    assert resolve_scope_thread_id(sub) == lead
    assert resolve_scope_thread_id(lead) == lead


def test_crud_nodes_and_edges(sqlite_tmp: None) -> None:
    del sqlite_tmp
    tid = "thread-crud-1"
    node = upsert_node(
        tid,
        ExplorationNode(
            external_id="file:auth/login.ts",
            kind="file",
            title="login",
            body="handleLogin entry",
        ),
        source_tool="read_file",
        source_tool_call_id="tc-1",
        turn_id="turn-1",
    )
    assert node.external_id == "file:auth/login.ts"
    assert get_node(tid, "file:auth/login.ts") is not None

    patched = patch_node(tid, "file:auth/login.ts", append_body="uses JWT")
    assert patched is not None
    assert "JWT" in patched.body

    edge = upsert_edge(
        tid,
        ExplorationEdge(
            external_id="edge:router-login",
            from_external_id="file:api/router.ts",
            to_external_id="file:auth/login.ts",
            rel="imports",
        ),
        source_tool_call_id="tc-1",
    )
    assert edge.rel == "imports"
    assert len(list_edges(tid)) == 1

    header = get_graph_header(tid)
    assert header is not None
    assert header.node_count == 1
    assert header.edge_count == 1

    assert soft_delete_node(tid, "file:auth/login.ts")
    header2 = get_graph_header(tid)
    assert header2 is not None
    assert header2.node_count == 0
    assert list_nodes(tid) == []


def test_apply_set_goal_updates_header_and_node(sqlite_tmp: None) -> None:
    del sqlite_tmp
    tid = "thread-goal-1"
    result = apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "修复登录 401"}],
        tool_call_id="tc-goal",
    )
    assert result.applied[0].apply_status == "ok"
    header = get_graph_header(tid)
    assert header is not None
    assert header.goal == "修复登录 401"
    goal_node = get_node(tid, "goal:session")
    assert goal_node is not None
    assert goal_node.kind == "goal"
    assert goal_node.title == "修复登录 401"


def test_apply_mind_map_ops_batch(sqlite_tmp: None) -> None:
    del sqlite_tmp
    tid = "thread-ops-1"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "Auth flow investigation"}],
        tool_call_id="tc-goal",
    )
    result = apply_mind_map_ops(
        tid,
        [
            {
                "op": "upsert_node",
                "id": "flow:auth",
                "kind": "flow",
                "title": "Auth flow",
            },
            {
                "op": "upsert_node",
                "id": "file:auth/login.ts",
                "kind": "file",
                "parent": "flow:auth",
                "title": "login.ts",
            },
            {
                "op": "upsert_edge",
                "id": "edge:r-l",
                "from": "file:api/router.ts",
                "to": "file:auth/login.ts",
                "rel": "imports",
            },
            {
                "op": "patch_node",
                "id": "flow:auth",
                "append_body": "refresh TBD",
            },
        ],
        turn_id="turn-a",
        tool_name="read_file",
        tool_call_id="tc-batch-1",
    )
    assert result.graph_version == 2
    assert len(result.applied) == 4
    assert all(r.apply_status == "ok" for r in result.applied)
    assert result.node_count == 3
    assert result.edge_count == 1

    flow = get_node(tid, "flow:auth")
    assert flow is not None
    assert "refresh TBD" in flow.body

    ops = list_ops(tid, tool_call_id="tc-batch-1")
    assert len(ops) == 4

    snap = load_graph_snapshot(tid)
    assert snap["header"]["graph_version"] == 2
    assert snap["header"]["goal"] == "Auth flow investigation"
    assert len(snap["nodes"]) == 3
    assert len(snap["edges"]) == 1


def test_apply_ops_rejects_patch_missing_node(sqlite_tmp: None) -> None:
    del sqlite_tmp
    apply_mind_map_ops(
        "thread-ops-2",
        [{"op": "set_goal", "title": "test goal"}],
        tool_call_id="tc-goal-2",
    )
    result = apply_mind_map_ops(
        "thread-ops-2",
        [{"op": "patch_node", "id": "missing", "append_body": "x"}],
        tool_call_id="tc-err",
    )
    assert result.applied[0].apply_status == "rejected"
    assert get_graph_header("thread-ops-2") is not None
    assert result.graph_version == 2


def test_sub_thread_ops_attach_to_lead(sqlite_tmp: None) -> None:
    del sqlite_tmp
    lead = "bbbbbbbb-bbbb-cccc-dddd-ffffffffffff"
    sub = f"{lead}__sub__w1"
    apply_mind_map_ops(
        sub,
        [
            {"op": "set_goal", "title": "worker subtask"},
            {"op": "upsert_node", "id": "note:1", "title": "from worker"},
        ],
        tool_call_id="tc-sub",
    )
    assert get_node(lead, "note:1") is not None
    assert get_node(sub, "note:1") is not None


def test_find_thread_id_by_session_key(sqlite_tmp: None) -> None:
    del sqlite_tmp
    tid = "thread-sk-lookup"
    sk = "agent:main:test-sk"
    apply_mind_map_ops(
        tid,
        [{"op": "set_goal", "title": "g"}],
        tool_call_id="tc-sk",
    )
    from evoflow.persistence.db import get_db

    get_db().execute(
        "UPDATE evoflow_exploration_graph SET session_key = ? WHERE thread_id = ?",
        (sk, tid),
    )
    get_db().commit()

    from evoflow.persistence.exploration_graph_repositories import (
        find_thread_id_by_session_key,
        load_graph_snapshot_for_session,
    )

    assert find_thread_id_by_session_key(sk) == tid
    snap = load_graph_snapshot_for_session(sk)
    assert snap["thread_id"] == tid
    assert snap["header"] is not None
    assert snap["header"]["goal"] == "g"


def test_resolve_mind_map_thread_id_prefers_graph_with_nodes(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.db import get_db
    from evoflow.persistence.exploration_graph_repositories import (
        resolve_mind_map_thread_id,
    )

    old_tid = "thread-mm-old"
    new_tid = "thread-mm-new"
    sk = "agent:main:mm-scope"
    apply_mind_map_ops(
        old_tid,
        [
            {"op": "set_goal", "title": "old goal"},
            {"op": "upsert_node", "id": "flow:keep", "kind": "flow", "title": "Keep me"},
        ],
        tool_call_id="tc-old",
    )
    get_db().execute(
        "UPDATE evoflow_exploration_graph SET session_key = ? WHERE thread_id = ?",
        (sk, old_tid),
    )
    get_db().execute(
        """
        INSERT INTO evoflow_exploration_graph (
            thread_id, session_key, graph_version, active_turn_id,
            node_count, edge_count, render_summary, created_at, updated_at
        ) VALUES (?, ?, 0, '', 0, 0, '', datetime('now'), datetime('now'))
        """,
        (new_tid, sk),
    )
    get_db().commit()

    resolved = resolve_mind_map_thread_id(new_tid, session_key=sk)
    assert resolved == old_tid
    section = __import__(
        "evoflow.exploration_graph.prompt",
        fromlist=["build_mind_map_section"],
    ).build_mind_map_section(new_tid, session_key=sk)
    assert "old goal" in section
    assert "flow:keep" in section


def test_delete_exploration_graph(sqlite_tmp: None) -> None:
    del sqlite_tmp
    tid = "thread-del"
    apply_mind_map_ops(tid, [{"op": "set_goal", "title": "del test"}, {"op": "upsert_node", "id": "n1", "title": "x"}], tool_call_id="tc-d")
    assert get_graph_header(tid) is not None
    delete_exploration_graph(tid)
    assert get_graph_header(tid) is None
    assert list_ops(tid) == []
