"""Tests for automation deliverable output paths."""

from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evoflow.automation.output_paths import (
    automation_deliverable_rel_path,
    automation_output_instructions,
    resolve_automation_deliverable_path,
    resolve_automation_outputs_root,
)


@pytest.fixture
def evoflow_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        yield Path(tmp)


def test_default_deliverable_layout(evoflow_home: Path) -> None:
    when = datetime(2026, 8, 24, 13, 8, tzinfo=timezone.utc)
    p = resolve_automation_deliverable_path(
        "bd105575",
        automation_name="每日AI日报",
        run_id="run1",
        run_at=when,
    )
    assert p == evoflow_home / "outputs" / "automations" / "bd105575" / "20260824.md"
    assert p.parent.is_dir()


def test_custom_template_relative(evoflow_home: Path) -> None:
    when = datetime(2026, 8, 24, tzinfo=timezone.utc)
    p = resolve_automation_deliverable_path(
        "bd105575",
        automation_name="每日AI日报",
        run_id="abc",
        run_at=when,
        output_template="automations/{automation_id}/{date}-{slug}.{ext}",
    )
    assert p.name == "20260824-AI.md"
    rel = automation_deliverable_rel_path(p)
    assert rel == "outputs/automations/bd105575/20260824-AI.md"


def test_output_instructions_include_abs_and_rel(evoflow_home: Path) -> None:
    p = resolve_automation_outputs_root() / "x" / "20260824.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    rel = automation_deliverable_rel_path(p)
    block = automation_output_instructions(p, rel_path=rel)
    assert str(p).replace("\\", "/") in block.replace("\\", "/")
    assert rel in block
    assert "completed" in block
