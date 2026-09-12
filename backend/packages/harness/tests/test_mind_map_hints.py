"""Soft mind-map hint helpers (non-blocking)."""

from __future__ import annotations

from langchain_core.messages import ToolMessage

from evoflow.exploration_graph.mind_map_hints import (
    append_evidence_tool_mind_map_hints,
    append_mind_map_hints,
    collect_evidence_tool_mind_map_hints,
    collect_mind_map_soft_hints,
    evidence_tool_output_has_substance,
    ops_are_step_note_diaries,
    ops_flat_under_goal_only,
    ops_have_intent_flow_gap_body,
    ops_include_body_distill,
    sibling_tool_names_for_call,
)


def test_ops_are_step_note_diaries() -> None:
    assert ops_are_step_note_diaries(
        [{"op": "upsert_node", "id": "note:step-1", "kind": "note", "body": "x"}]
    )
    assert not ops_are_step_note_diaries(
        [{"op": "upsert_node", "id": "file:a.ts", "kind": "file", "title": "a.ts"}]
    )


def test_ops_include_body_distill() -> None:
    assert ops_include_body_distill(
        [{"op": "patch_node", "id": "file:a.ts", "append_body": "login() calls /api"}]
    )
    assert not ops_include_body_distill(
        [{"op": "upsert_node", "id": "file:a.ts", "kind": "file", "parent": "goal:session", "title": "a.ts"}]
    )


def test_ops_have_intent_flow_gap_body() -> None:
    assert ops_have_intent_flow_gap_body(
        [{"op": "upsert_node", "id": "gap:x", "kind": "gap", "body": "查看 tauri-api.js 实现"}]
    )


def test_ops_flat_under_goal_only() -> None:
    assert ops_flat_under_goal_only(
        [{"op": "upsert_node", "id": "file:a.ts", "kind": "file", "parent": "goal:session"}]
    )
    assert not ops_flat_under_goal_only(
        [{"op": "upsert_node", "id": "file:a.ts", "kind": "file", "parent": "flow:auth"}]
    )


def test_collect_hints_for_read_placeholder() -> None:
    hints = collect_mind_map_soft_hints(
        tool_name="read",
        tool_args={"path": "src/a.ts"},
        ops=[{"op": "upsert_node", "id": "file:src/a.ts", "kind": "file", "parent": "goal:session", "title": "a.ts"}],
        thread_id="",
    )
    assert any("patch_node" in h for h in hints)


def test_append_mind_map_hints_on_success() -> None:
    msg = ToolMessage(content="ok", tool_call_id="c1", name="read")
    out = append_mind_map_hints(
        msg,
        tool_name="read",
        tool_args={"path": "a.ts"},
        ops=[{"op": "upsert_node", "id": "note:step-1", "kind": "note", "body": "继续"}],
        thread_id="",
    )
    assert "[思维导图提示]" in str(out.content)
    assert out.status != "error"


def test_append_skips_error_tool_message() -> None:
    msg = ToolMessage(content="Error: x", tool_call_id="c1", name="read", status="error")
    out = append_mind_map_hints(
        msg,
        tool_name="read",
        tool_args={},
        ops=[{"op": "upsert_node", "id": "note:step-1", "kind": "note"}],
        thread_id="",
    )
    assert out is msg


def test_collect_evidence_hints_without_mind_map_in_batch() -> None:
    hints = collect_evidence_tool_mind_map_hints(
        tool_name="read",
        tool_args={"path": "src/a.ts"},
        batch_has_mind_map=False,
        thread_id="t1",
    )
    assert hints
    assert "patch_node" in hints[0]
    assert "追加" in hints[0]
    assert "须" not in hints[0]


def test_collect_evidence_hints_skips_when_mind_map_in_batch() -> None:
    hints = collect_evidence_tool_mind_map_hints(
        tool_name="read",
        tool_args={"path": "src/a.ts"},
        batch_has_mind_map=True,
        thread_id="t1",
    )
    assert hints == []


def test_collect_evidence_hints_only_first_in_batch() -> None:
    hints = collect_evidence_tool_mind_map_hints(
        tool_name="rg",
        tool_args={"pattern": "x", "path": "src"},
        batch_has_mind_map=False,
        thread_id="t1",
        is_first_evidence_in_batch=False,
    )
    assert hints == []


def test_append_evidence_hints_on_read_result() -> None:
    msg = ToolMessage(content="file contents", tool_call_id="c1", name="read")
    out = append_evidence_tool_mind_map_hints(
        msg,
        tool_name="read",
        tool_args={"path": "src/a.ts"},
        batch_has_mind_map=False,
        thread_id="t1",
    )
    assert "[思维导图提示]" in str(out.content)
    assert "须" not in str(out.content)


def test_evidence_output_has_substance() -> None:
    assert not evidence_tool_output_has_substance("")
    assert not evidence_tool_output_has_substance("(no matches)")
    assert not evidence_tool_output_has_substance("(no matches)\nrg: warning: ignored")
    assert not evidence_tool_output_has_substance("(empty)")
    assert not evidence_tool_output_has_substance("(page appears empty or had no extractable content)")
    assert evidence_tool_output_has_substance("export function createModel() {}")
    assert evidence_tool_output_has_substance("[rg] /usr/bin/rg\nsrc/a.ts:1:match")


def test_append_evidence_hints_skips_no_matches() -> None:
    msg = ToolMessage(content="(no matches)", tool_call_id="c1", name="rg")
    out = append_evidence_tool_mind_map_hints(
        msg,
        tool_name="rg",
        tool_args={"pattern": "foo", "path": "src"},
        batch_has_mind_map=False,
        thread_id="t1",
    )
    assert out is msg
    assert "[思维导图提示]" not in str(out.content)


def test_collect_hints_when_claim_without_flow_status() -> None:
    hints = collect_mind_map_soft_hints(
        tool_name="mind_map",
        tool_args={},
        ops=[
            {
                "op": "upsert_node",
                "id": "claim:fix",
                "kind": "claim",
                "parent": "flow:upload",
                "body": "已修复",
            }
        ],
        thread_id="",
    )
    assert any("claim" in h and "flow:upload" in h for h in hints)


def test_ops_status_patched_ids() -> None:
    from evoflow.exploration_graph.mind_map_hints import ops_status_patched_ids

    patched = ops_status_patched_ids(
        [{"op": "patch_node", "id": "flow:upload", "status": "resolved", "append_body": "done"}]
    )
    assert patched == {"flow:upload"}


def test_sibling_tool_names_for_call() -> None:
    from langchain_core.messages import AIMessage

    msgs = [
        AIMessage(
            content="",
            tool_calls=[
                {"id": "c1", "name": "read", "args": {"path": "a.ts"}},
                {"id": "c2", "name": "mind_map", "args": {"ops": []}},
            ],
        )
    ]
    names, found = sibling_tool_names_for_call(msgs, "c1")
    assert found
    assert "read" in names
    assert "mind_map" in names
