"""panel_set progress kinds: collab-workflow / collabSubtaskTranscript / employeeProcess."""

from evoflow.tools.builtins.stage_tool import _build_progress_surface, _normalize_panel_kind


def test_normalize_progress_kind_aliases():
    assert _normalize_panel_kind("collab-workflow") == "collab-workflow"
    assert _normalize_panel_kind("workflow") == "collab-workflow"
    assert _normalize_panel_kind("employee-process") == "employeeProcess"
    assert _normalize_panel_kind("employee_process") == "employeeProcess"
    assert _normalize_panel_kind("collab-subtask") == "collabSubtaskTranscript"


def test_collab_workflow_requires_main_task_id():
    surface, err = _build_progress_surface(kind="collab-workflow", payload_data={}, title=None, layout=None)
    assert surface is None
    assert "mainTaskId" in (err or "")


def test_collab_workflow_stable_id():
    surface, err = _build_progress_surface(
        kind="collab-workflow",
        payload_data={"taskId": "mt-1", "thread_id": "th-9"},
        title="图",
        layout=None,
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "workflow:mt-1"
    assert surface["kind"] == "collab-workflow"
    assert surface["data"]["mainTaskId"] == "mt-1"
    assert surface["data"]["leadThreadId"] == "th-9"
    assert surface["layout"] == "half"


def test_collab_subtask_requires_ids():
    surface, err = _build_progress_surface(
        kind="collabSubtaskTranscript",
        payload_data={"mainTaskId": "mt-1"},
        title=None,
        layout=None,
    )
    assert surface is None
    assert "subtaskId" in (err or "")


def test_collab_subtask_stable_id():
    surface, err = _build_progress_surface(
        kind="collabSubtaskTranscript",
        payload_data={"main_task_id": "mt-1", "subtask_id": "st-2"},
        title=None,
        layout="wide",
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "collabSubtaskTranscript:st-2"
    assert surface["data"]["subtaskId"] == "st-2"
    assert surface["data"]["mainTaskId"] == "mt-1"


def test_employee_process_requires_task_and_agent():
    surface, err = _build_progress_surface(
        kind="employeeProcess",
        payload_data={"taskId": "mt-1"},
        title=None,
        layout=None,
    )
    assert surface is None
    assert "agentCode" in (err or "")


def test_employee_process_stable_id():
    surface, err = _build_progress_surface(
        kind="employeeProcess",
        payload_data={"task_id": "mt-9", "assigned_to": "duty-ops", "busy": 1},
        title="值班",
        layout=None,
    )
    assert err is None
    assert surface is not None
    assert surface["id"] == "process:mt-9"
    assert surface["data"]["taskId"] == "mt-9"
    assert surface["data"]["agentCode"] == "duty-ops"
    assert surface["data"]["busy"] is True
    assert surface["layout"] == "wide"
