"""Legacy three profile files merge into single USER.md."""

from __future__ import annotations

from pathlib import Path

from evoflow.assets import paths as assets_paths
from evoflow.assets.paths import EntityRef, profile_path
from evoflow.assets.user_profile_dims import (
    USER_PROFILE_FILENAME,
    ensure_user_profile_files,
    read_user_profile_dimensions,
)


def test_ensure_merges_legacy_dims(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)
    ent = EntityRef("user", "user")
    root = profile_path(ent, USER_PROFILE_FILENAME).parent
    root.mkdir(parents=True, exist_ok=True)
    (root / "basic-info.md").write_text("# 基本信息\n\n## 称呼\n银泰\n", encoding="utf-8")
    (root / "preferences.md").write_text("# 偏好\n\n## 风格\n结论先行\n", encoding="utf-8")
    (root / "persona.md").write_text("# 画像\n\n## 习惯\n先读文档\n", encoding="utf-8")

    ensure_user_profile_files(ent)
    user_md = root / USER_PROFILE_FILENAME
    assert user_md.is_file()
    body = user_md.read_text(encoding="utf-8")
    assert "银泰" in body
    assert "结论先行" in body
    assert "先读文档" in body
    assert not (root / "basic-info.md").exists()
    assert not (root / "preferences.md").exists()
    assert not (root / "persona.md").exists()

    dims = read_user_profile_dimensions(entity=ent, max_chars_per_dim=8000)
    assert "银泰" in (dims.get(USER_PROFILE_FILENAME) or "")
