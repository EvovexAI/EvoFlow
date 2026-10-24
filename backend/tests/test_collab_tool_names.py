"""Short collab tool names registered for the model."""

from __future__ import annotations

from evoflow.collab.collab_tool_names import (
    DONE,
    canonical_tool_name,
    canonicalize_tool_names,
)
from evoflow.tools.builtins.collab_peer_tools import peer_send_tool
from evoflow.tools.builtins.subtask_outcome_report_tool import done_tool
from evoflow.tools.builtins.subtask_progress_tool import progress_tool
from evoflow.tools.builtins.subtask_work_checklist_tool import checklist_tool


def test_canonical_maps_legacy():
    assert canonical_tool_name("subtask_outcome_report") == DONE
    assert canonical_tool_name("done") == DONE
    assert canonicalize_tool_names(
        ["bash", "subtask_outcome_report", "done", "collab_peer_send"]
    ) == ["bash", "done", "peer_send"]


def test_registered_tool_names_are_short_only():
    assert done_tool.name == "done"
    assert progress_tool.name == "progress"
    assert checklist_tool.name == "checklist"
    assert peer_send_tool.name == "peer_send"
