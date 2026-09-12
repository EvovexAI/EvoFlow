"""Resume / continue the same duty round_id on wake/dispatch."""

from __future__ import annotations

from evoflow.proactive.runner import resolve_dispatch_round_id


def test_resolve_explicit_round_id_wins() -> None:
    rid, resumed = resolve_dispatch_round_id(
        round_id="dispatch:fixed",
        related_task={"round_id": "dispatch:other"},
        resume_round=True,
        fresh_round=True,
    )
    assert rid == "dispatch:fixed"
    assert resumed is True


def test_resolve_resume_from_related_task() -> None:
    rid, resumed = resolve_dispatch_round_id(
        resume_round=True,
        related_task={"round_id": "dispatch:from-task", "source_ref": "dispatch:src"},
    )
    assert rid == "dispatch:from-task"
    assert resumed is True


def test_resolve_resume_falls_back_to_source_ref() -> None:
    rid, resumed = resolve_dispatch_round_id(
        resume_round=True,
        related_task={"source_ref": "dispatch:src-only"},
    )
    assert rid == "dispatch:src-only"
    assert resumed is True


def test_resolve_fresh_round_ignores_task() -> None:
    rid, resumed = resolve_dispatch_round_id(
        fresh_round=True,
        resume_round=True,
        related_task={"round_id": "dispatch:old"},
    )
    assert resumed is False
    assert rid.startswith("dispatch:")
    assert rid != "dispatch:old"


def test_resolve_default_mints_new() -> None:
    rid, resumed = resolve_dispatch_round_id(
        related_task={"round_id": "dispatch:old"},
    )
    assert resumed is False
    assert rid.startswith("dispatch:")
    assert rid != "dispatch:old"
