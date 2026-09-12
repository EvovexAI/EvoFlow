"""Tests for mind map node status helpers."""

from evoflow.exploration_graph.node_status import (
    is_processing_status,
    is_user_patchable_status,
    normalize_node_status,
)


def test_normalize_node_status_aliases() -> None:
    assert normalize_node_status("idle") == "parked"
    assert normalize_node_status("") == "active"


def test_is_user_patchable_status() -> None:
    assert is_user_patchable_status("parked")
    assert is_user_patchable_status("resolved")
    assert not is_user_patchable_status("stale")
    assert not is_user_patchable_status("deleted")


def test_is_processing_status() -> None:
    assert is_processing_status("active")
    assert is_processing_status("stale")
    assert not is_processing_status("parked")
    assert not is_processing_status("resolved")


def test_is_status_tracked_kind() -> None:
    from evoflow.exploration_graph.node_status import is_status_tracked_kind

    assert is_status_tracked_kind("flow", "flow:auth")
    assert is_status_tracked_kind("note", "gap:open")
    assert not is_status_tracked_kind("file", "file:x.py")
    assert not is_status_tracked_kind("note", "note:a")


def test_should_cascade_status_to_descendants() -> None:
    from evoflow.exploration_graph.node_status import should_cascade_status_to_descendants

    assert should_cascade_status_to_descendants("resolved")
    assert should_cascade_status_to_descendants("parked")
    assert not should_cascade_status_to_descendants("active")
