"""Short collab tool names + legacy aliases."""

from __future__ import annotations

from evoflow.collab.collab_tool_names import (
    DONE,
    canonical_tool_name,
    expand_tool_name_aliases,
)
from evoflow.tools.builtins.subtask_outcome_report_tool import done_tool, subtask_outcome_report_tool
from evoflow.tools.builtins.subtask_progress_tool import progress_tool
from evoflow.tools.builtins.subtask_work_checklist_tool import checklist_tool
from evoflow.tools.builtins.collab_peer_tools import peer_send_tool


def test_canonical_maps_legacy():
    assert canonical_tool_name("subtask_outcome_report") == DONE
    assert canonical_tool_name("done") == DONE
    assert "done" in expand_tool_name_aliases("subtask_outcome_report")
    assert "subtask_outcome_report" in expand_tool_name_aliases("done")


def test_registered_tool_names_are_short():
    assert done_tool.name == "done"
    assert subtask_outcome_report_tool.name == "subtask_outcome_report"
    assert progress_tool.name == "progress"
    assert checklist_tool.name == "checklist"
    assert peer_send_tool.name == "peer_send"
