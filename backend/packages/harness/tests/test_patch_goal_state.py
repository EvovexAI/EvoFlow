"""patch_goal_state must write via upsert_goal_session (not broken patch kwargs)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from evoflow.agents.goal.goal_runtime import patch_goal_state


def test_patch_goal_state_calls_upsert(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict] = []

    def _upsert(sk: str, **kwargs: object) -> None:
        calls.append({"sk": sk, **kwargs})

    monkeypatch.setattr(
        "evoflow.persistence.goal_repositories.upsert_goal_session",
        _upsert,
    )

    patch_goal_state(
        "agent:main:sk1",
        status="running",
        step_count=3,
        goal_status="active",
    )
    assert len(calls) == 1
    assert calls[0]["sk"] == "agent:main:sk1"
    assert calls[0]["status"] == "running"
    assert calls[0]["step_count"] == 3
    assert calls[0]["goal_status"] == "active"
