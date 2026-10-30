"""EDIT_NOT_READ auto-heal: replace/write proceed after registering a disk read."""

from __future__ import annotations

from pathlib import Path

from evoflow.tools.zcode_port.read_file_state import (
    EDIT_NOT_READ_MESSAGE,
    auto_register_full_read_for_edit,
    edit_guard_failure,
    reset_read_state,
)


def test_auto_register_heals_edit_not_read(tmp_path: Path) -> None:
    reset_read_state()
    target = tmp_path / "note.md"
    target.write_text("hello\n", encoding="utf-8")

    assert EDIT_NOT_READ_MESSAGE in (edit_guard_failure(target) or "")
    assert auto_register_full_read_for_edit(target) is True
    assert edit_guard_failure(target) is None


def test_auto_register_missing_file() -> None:
    reset_read_state()
    assert auto_register_full_read_for_edit("/no/such/path/xyz-evoflow-test.md") is False
