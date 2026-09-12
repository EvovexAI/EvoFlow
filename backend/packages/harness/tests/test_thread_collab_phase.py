"""Collab phase state machine transition guards."""

from __future__ import annotations

from evoflow.collab.models import CollabPhase
from evoflow.collab.thread_collab import can_transition_collab_phase


def test_same_phase_always_allowed() -> None:
    assert can_transition_collab_phase(CollabPhase.EXECUTING, CollabPhase.EXECUTING)


def test_executing_to_verifying_allowed() -> None:
    assert can_transition_collab_phase(CollabPhase.EXECUTING, CollabPhase.VERIFYING)


def test_planning_to_verifying_rejected() -> None:
    assert not can_transition_collab_phase(CollabPhase.PLANNING, CollabPhase.VERIFYING)


def test_plan_ready_to_verifying_rejected() -> None:
    assert not can_transition_collab_phase(CollabPhase.PLAN_READY, CollabPhase.VERIFYING)


def test_done_is_terminal() -> None:
    assert not can_transition_collab_phase(CollabPhase.DONE, CollabPhase.EXECUTING)


def test_verifying_to_reflecting_allowed() -> None:
    assert can_transition_collab_phase(CollabPhase.VERIFYING, CollabPhase.REFLECTING)
