"""data/ directory layout and legacy SQLite migration."""

from __future__ import annotations

from pathlib import Path

from evoflow.config.data_paths import app_db_path, checkpoints_db_path, observability_db_path
from evoflow.persistence.data_layout import ensure_data_layout


def test_ensure_data_layout_migrates_legacy_dbs(tmp_path: Path) -> None:
    base = tmp_path / "home"
    base.mkdir()
    legacy_app = base / "evoflow.db"
    legacy_app.write_text("legacy", encoding="utf-8")
    legacy_obs = base / "evoflow_observability.db"
    legacy_obs.write_text("legacy", encoding="utf-8")
    legacy_cp = base / "checkpoints.db"
    legacy_cp.write_text("legacy", encoding="utf-8")

    result = ensure_data_layout(base)

    assert "evoflow.db" in result.moved
    assert not legacy_app.exists()
    assert app_db_path(base).is_file()
    assert observability_db_path(base).is_file()
    assert checkpoints_db_path(base).is_file()
