"""Dispatch stamps input_refs, not child outputs."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.admin.tasks import dispatch_confirmed_handlers


def test_dispatch_stamps_input_refs_not_outputs():
    handlers = [
        {
            "agent_code": "lead",
            "content": "跟进报告",
            "read_outputs": [{"type": "file", "key": "report", "value": "docs/a.md"}],
        }
    ]
    patches = []

    def _capture_patch(storage, tid, updates):
        patches.append((tid, dict(updates)))
        return True

    with (
        patch("evoflow.collab.handler_org.assert_handlers_org_ok"),
        patch("evoflow.admin.tasks.create_task") as mock_create,
        patch("evoflow.admin.tasks.patch_collab_main_task_in_project_storage", side_effect=_capture_patch),
        patch("evoflow.admin.tasks.get_project_storage", return_value=MagicMock()),
        patch("evoflow.admin.employees.wake", return_value={"ok": True}),
        patch("evoflow.admin.employees.resolve_role_ref", side_effect=Exception("skip")),
    ):
        mock_create.return_value = {"task_id": "Task_child"}
        results = dispatch_confirmed_handlers(
            "Task_parent",
            handlers,
            from_agent="mgr",
            parent_name="上游",
        )

    assert results[0]["ok"] is True
    assert results[0]["task_id"] == "Task_child"
    assert len(patches) == 1
    tid, updates = patches[0]
    assert tid == "Task_child"
    assert "input_refs" in updates
    assert updates["input_refs"][0]["value"] == "docs/a.md"
    assert "outputs" not in updates
