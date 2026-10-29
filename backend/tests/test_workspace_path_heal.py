"""Cited chat paths often omit projects/<ep>/ or mangle segreport1.md → segreport1/2/3.md."""

from __future__ import annotations

from pathlib import Path

from app.gateway.routers.workspaces import (
    _collapse_numbered_path_segments,
    _fuzzy_locate_under_workspace,
    _heal_missing_workspace_file_target,
)


def test_collapse_numbered_path_segments():
    assert (
        _collapse_numbered_path_segments("04-storyboard/continuity/segreport1/2/3.md")
        == "04-storyboard/continuity/segreport3.md"
    )
    assert _collapse_numbered_path_segments("segreport1/2/3.md") == "segreport3.md"
    assert _collapse_numbered_path_segments("continuity/segreport2.md") is None


def test_fuzzy_locate_under_projects(tmp_path: Path):
    root = tmp_path
    real = root / "projects" / "ep-1" / "04-storyboard" / "continuity" / "segreport3.md"
    real.parent.mkdir(parents=True)
    real.write_text("ok", encoding="utf-8")
    # cited without projects/<ep>/
    hit = _fuzzy_locate_under_workspace(root, "04-storyboard/continuity/segreport3.md")
    assert hit is not None
    assert hit.resolve() == real.resolve()


def test_heal_missing_combines_collapse_and_locate(tmp_path: Path):
    root = tmp_path
    real = root / "projects" / "ep-1" / "04-storyboard" / "continuity" / "segreport3.md"
    real.parent.mkdir(parents=True)
    real.write_text("ok", encoding="utf-8")
    cited = str(root / "04-storyboard" / "continuity" / "segreport1" / "2" / "3.md")
    missing = Path(cited)
    healed = _heal_missing_workspace_file_target(
        missing,
        root=str(root),
        thread_id=None,
        cited=cited,
    )
    assert healed.is_file()
    assert healed.resolve() == real.resolve()
