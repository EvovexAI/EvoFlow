"""Collab → ZCode workflowRuns projection."""

from __future__ import annotations

from app.gateway.v4.workflow_runs_projection import (
    extract_workflow_progress_from_platform_result,
    project_collab_to_workflow_run,
    to_journal_summary,
    upsert_run_list,
)


def test_extract_from_platform_ui_open_stage():
    tip = extract_workflow_progress_from_platform_result(
        action="workflow.run",
        content='{"ok":true,"task_id":"T1","runId":"R1","name":"指南"}',
        display={
            "kind": "platform_ui",
            "schemaVersion": 1,
            "title": "指南",
            "actions": [
                {
                    "label": "打开工作流",
                    "autoOpen": True,
                    "openStage": {
                        "kind": "collab-workflow",
                        "title": "指南",
                        "data": {"mainTaskId": "T1"},
                    },
                }
            ],
        },
    )
    assert tip is not None
    assert tip["mainTaskId"] == "T1"
    assert tip["runId"] == "R1"
    assert tip["name"] == "指南"


def test_extract_ignores_non_workflow_action():
    assert (
        extract_workflow_progress_from_platform_result(
            action="tasks.create",
            content='{"ok":true,"task_id":"T1"}',
            display=None,
        )
        is None
    )


def test_project_collab_shapes_protocol_run():
    run = project_collab_to_workflow_run(
        main_task={"taskId": "T1", "name": "能力指南", "status": "completed"},
        subtasks=[
            {
                "subtaskId": "a",
                "ref": "1",
                "name": "并行调研",
                "status": "completed",
                "assignedAgentDisplay": "能力梳理员",
            },
            {
                "subtaskId": "b",
                "ref": "2",
                "name": "起草",
                "status": "completed",
                "assignedAgentDisplay": "起草人",
            },
        ],
        tool_call_id="tc_platform_1",
        run_id="T1",
        name="能力指南",
    )
    assert run is not None
    assert run["runId"] == "T1"
    assert run["toolCallId"] == "tc_platform_1"
    assert run["status"] == "completed"
    assert len(run["actors"]) == 2
    assert len(run["nodes"]) == 2
    assert run["nodes"][0]["phase"] == "settled"
    # siteId 必须是真实 subtaskId，才能点开右栏节点详情
    assert run["nodes"][0]["siteId"] == "a"
    assert run["nodes"][1]["siteId"] == "b"
    assert run["phases"][0]["name"] == "并行调研"
    summary = to_journal_summary(run)
    assert summary["runId"] == "T1"
    assert summary["label"] == "能力指南"
    assert summary["resumable"] is False


def test_upsert_replaces_same_run_id():
    a = {"runId": "R1", "status": "running", "actors": [], "nodes": [], "usage": {}, "lastEventSequence": 1}
    b = {"runId": "R1", "status": "completed", "actors": [], "nodes": [], "usage": {}, "lastEventSequence": 2}
    out = upsert_run_list([a], b)
    assert len(out) == 1
    assert out[0]["status"] == "completed"
