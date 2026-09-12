from unittest.mock import MagicMock, patch

from evoflow.collab.models import CollabPhase
from evoflow.collab.thread_collab import advance_collab_phase_to_reflecting_for_task


def test_advance_collab_phase_to_reflecting():
    paths = MagicMock()
    task = {"thread_id": "thread-1"}
    state = MagicMock()
    state.collab_phase = CollabPhase.VERIFYING

    with (
        patch("evoflow.collab.storage.find_main_task", return_value=(None, task)),
        patch("evoflow.collab.thread_collab.load_thread_collab_state", return_value=state),
        patch("evoflow.collab.thread_collab.merge_thread_collab_state", side_effect=lambda cur, upd: upd),
        patch("evoflow.collab.thread_collab.save_thread_collab_state") as save,
    ):
        ok = advance_collab_phase_to_reflecting_for_task(paths, "task-1")
        assert ok is True
        save.assert_called()
