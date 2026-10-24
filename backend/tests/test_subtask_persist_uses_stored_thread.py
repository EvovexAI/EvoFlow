"""Write path must prefer persisted subtask_thread_id (same as read resolve)."""

from evoflow.collab.conversation_persist import _executor_thread_for_persist
from evoflow.collab.thread_ids import collab_subtask_executor_thread_id


def test_executor_thread_for_persist_keeps_stored_when_lead_changes():
    sid = "node-a"
    old_lead = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    new_lead = "11111111-2222-3333-4444-555555555555"
    stored = collab_subtask_executor_thread_id(old_lead, sid)
    # New lead would derive a different executor id — persist must stay on stored.
    derived_new = collab_subtask_executor_thread_id(new_lead, sid)
    assert stored != derived_new

    got = _executor_thread_for_persist(
        lead_thread=new_lead,
        subtask_id=sid,
        stored_subtask_thread_id=stored,
    )
    assert got == stored


def test_executor_thread_for_persist_canonical_when_same_lead():
    sid = "node-b"
    lead = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    canonical = collab_subtask_executor_thread_id(lead, sid)
    got = _executor_thread_for_persist(
        lead_thread=lead,
        subtask_id=sid,
        stored_subtask_thread_id=canonical,
    )
    assert got == canonical
