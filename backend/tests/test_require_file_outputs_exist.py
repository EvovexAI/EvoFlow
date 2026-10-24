"""产出文件 path must exist on disk when saving task outputs."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.admin.errors import ValidationError
from evoflow.admin.tasks import _outcome_patch
from evoflow.collab.task_outputs import (
    missing_file_output_paths,
    require_file_outputs_exist,
)


def test_require_file_outputs_exist_ok(tmp_path: Path) -> None:
    f = tmp_path / "report.md"
    f.write_text("# ok\n", encoding="utf-8")
    items = require_file_outputs_exist(
        [{"type": "file", "key": "report", "value": str(f)}],
        str(tmp_path),
    )
    assert len(items) == 1
    assert Path(items[0]["value"]) == f
    assert items[0]["_resolve_meta"]["found"] is True


def test_require_file_outputs_exist_missing_raises(tmp_path: Path) -> None:
    missing = tmp_path / "nope.md"
    with pytest.raises(ValueError, match="路径不存在"):
        require_file_outputs_exist(
            [{"type": "file", "key": "report", "value": str(missing)}],
            str(tmp_path),
        )


def test_missing_file_output_paths_ignores_url_and_text(tmp_path: Path) -> None:
    assert missing_file_output_paths(
        [
            {"type": "url", "key": "link", "value": "https://example.com"},
            {"type": "text", "key": "note", "value": "hello"},
        ],
        str(tmp_path),
    ) == []


def test_outcome_patch_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="产出文件"):
        _outcome_patch(
            "done",
            [{"type": "file", "key": "report", "value": str(tmp_path / "ghost.md")}],
            target_status="completed",
            workspace_root=str(tmp_path),
        )


def test_outcome_patch_persists_existing_file_without_meta(tmp_path: Path) -> None:
    f = tmp_path / "out.md"
    f.write_text("x\n", encoding="utf-8")
    patch = _outcome_patch(
        "done",
        [{"type": "file", "key": "report", "value": str(f)}],
        target_status="completed",
        workspace_root=str(tmp_path),
    )
    assert Path(patch["outputs"][0]["value"]) == f
    assert "_resolve_meta" not in patch["outputs"][0]
    assert [Path(p) for p in patch["evidence_paths"]] == [f]
