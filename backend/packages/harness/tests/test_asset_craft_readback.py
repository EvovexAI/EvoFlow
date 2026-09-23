"""Regression tests for Asset Hub path validation and craft experience read-back.

Covers three defects that together made saved experiences look empty in the UI:

1. ``resolve_entity_file`` rejected any non-ASCII relative path, so every craft
   entry with a Chinese slug (the norm — ``craft._slug`` keeps CJK) was
   unreadable even though the write succeeded.
2. ``list_craft_experiences`` returned ``body[:200]`` as ``problem`` and
   hard-coded ``solution``/``outcome`` to empty, so list views showed no detail.
3. ``experience.save`` advertised a ``content`` field that was silently dropped.
"""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.assets.paths import EntityRef, resolve_entity_file
from evoflow.config.paths import reset_paths_cache
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_paths_cache()
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        reset_app_config()
        reset_paths_cache()
        gc.collect()


def test_resolve_entity_file_accepts_unicode_paths() -> None:
    """CJK slugs/filenames must resolve — craft and memory write them by design."""
    ref = EntityRef("user", "user")
    for rel in (
        "craft/中文目录/SKILL.md",
        "memory/facts/偏好设置.md",
        "craft/软删不等于删干净-清理逻辑需统一收口/SKILL.md",
    ):
        assert resolve_entity_file(ref, rel).name == rel.rsplit("/", 1)[-1]


def test_resolve_entity_file_still_blocks_traversal() -> None:
    """Widening to Unicode must not weaken the traversal / injection guards."""
    ref = EntityRef("user", "user")
    for bad in ("../secret.md", "a/../../x.md", "/../etc/passwd", "", "C:/abs.md"):
        with pytest.raises(ValueError):
            resolve_entity_file(ref, bad)
    for bad in ("x<>y.md", "x|y.md", "x:y.md", "x*y.md", "x?y.md"):
        with pytest.raises(ValueError):
            resolve_entity_file(ref, bad)


def test_craft_experience_roundtrip_with_unicode_slug(assets_home: Path) -> None:
    """Save → list → detail must all work for a Chinese-titled experience."""
    from evoflow.admin import experience as experience_admin

    saved = experience_admin.save_experience(
        {
            "title": "中文标题的经验",
            "problem": "缓存写坏了",
            "solution": "先诊断再改",
            "outcome": "构建恢复",
            "steps": ["看日志", "改代码"],
        }
    )
    detail = experience_admin.get_experience(saved["id"])
    assert detail is not None, "unicode slug made the entry unreadable"
    assert detail["context"]["problem"] == "缓存写坏了"
    assert detail["context"]["solution"] == "先诊断再改"
    assert detail["steps"] == ["看日志", "改代码"]

    listed = experience_admin.list_experiences(query="中文标题")
    hit = next(e for e in listed["experiences"] if e["id"] == saved["id"])
    assert hit["problem"] == "缓存写坏了"
    assert hit["step_count"] == 2
