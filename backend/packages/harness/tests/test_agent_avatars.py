"""Builtin avatar seed / refresh (product default vs user upload)."""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

import pytest

from evoflow.config import agent_avatars as av
from evoflow.persistence.db import reset_db_for_tests

# 1x1 transparent PNG
_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)
_PNG2 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000c49444154789c630060000000020001e221bc330000000049454e44ae426082"
)


@pytest.fixture
def avatar_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setattr(av, "_BUNDLED_AVATARS_DIR", bundled)
    reset_db_for_tests()
    yield bundled, home
    reset_db_for_tests()


def test_seed_writes_bundled_source_marker(avatar_home) -> None:
    bundled, _home = avatar_home
    (bundled / "demo.png").write_bytes(_PNG)
    path = av.seed_builtin_avatar_file("demo")
    assert path is not None and path.is_file()
    assert path.read_bytes() == _PNG
    src = av._read_avatar_source("demo")
    assert src == f"bundled:{hashlib.sha256(_PNG).hexdigest()}"


def test_user_upload_not_refreshed_when_bundle_changes(avatar_home) -> None:
    bundled, _home = avatar_home
    (bundled / "demo.png").write_bytes(_PNG)
    av.seed_builtin_avatar_file("demo")
    av.save_avatar_bytes("demo", _PNG2)
    assert av._read_avatar_source("demo") == "user"

    (bundled / "demo.png").write_bytes(_PNG)  # "new" product default differs from upload
    n = av.refresh_stale_builtin_avatars(["demo"])
    assert n == 0
    assert av._local_avatar_path("demo").read_bytes() == _PNG2


def test_refresh_updates_outdated_bundled_marker(avatar_home) -> None:
    bundled, _home = avatar_home
    (bundled / "demo.png").write_bytes(_PNG)
    av.seed_builtin_avatar_file("demo")
    (bundled / "demo.png").write_bytes(_PNG2)
    n = av.refresh_stale_builtin_avatars(["demo"])
    assert n == 1
    assert av._local_avatar_path("demo").read_bytes() == _PNG2
    assert av._read_avatar_source("demo") == f"bundled:{hashlib.sha256(_PNG2).hexdigest()}"


def test_refresh_replaces_legacy_file_without_marker(avatar_home) -> None:
    """Pre-marker installs must pick up new package cutouts on upgrade."""
    bundled, home = avatar_home
    (bundled / "demo.png").write_bytes(_PNG2)
    agent_dir = home / "agents" / "demo"
    agent_dir.mkdir(parents=True)
    (agent_dir / "avatar.png").write_bytes(_PNG)  # legacy, no marker

    n = av.refresh_stale_builtin_avatars(["demo"])
    assert n == 1
    assert av._local_avatar_path("demo").read_bytes() == _PNG2
    assert av._read_avatar_source("demo") == f"bundled:{hashlib.sha256(_PNG2).hexdigest()}"


def test_refresh_skips_user_marked_even_when_legacy_looking(avatar_home) -> None:
    bundled, home = avatar_home
    (bundled / "demo.png").write_bytes(_PNG)
    agent_dir = home / "agents" / "demo"
    agent_dir.mkdir(parents=True)
    (agent_dir / "avatar.png").write_bytes(_PNG2)
    (agent_dir / ".avatar_source").write_text("user\n", encoding="utf-8")

    n = av.refresh_stale_builtin_avatars(["demo"])
    assert n == 0
    assert av._local_avatar_path("demo").read_bytes() == _PNG2


def test_alias_seeds_from_target_bundled_asset(avatar_home, monkeypatch) -> None:
    bundled, _home = avatar_home
    (bundled / "main.png").write_bytes(_PNG)
    monkeypatch.setattr(av, "_BUNDLED_AVATAR_ALIASES", {"demo-alias": "main"})
    path = av.seed_builtin_avatar_file("demo-alias")
    assert path is not None and path.is_file()
    assert path.read_bytes() == _PNG
    assert "demo-alias" in av._resolve_avatar_codes(None)


def test_xiaomi_does_not_alias_to_main_cutout() -> None:
    """小V defaults to gallery preset; must not reuse the male lead cutout."""
    assert "xiaomi" not in av._BUNDLED_AVATAR_ALIASES
    from evoflow.config.agents_config import _XIAOMI_DEFAULT_AVATAR, _BUILTIN_AGENT_AVATARS

    assert _BUILTIN_AGENT_AVATARS.get("xiaomi") == _XIAOMI_DEFAULT_AVATAR
    assert _XIAOMI_DEFAULT_AVATAR.startswith("preset:")


def test_should_upgrade_xiaomi_avatar_from_male_image() -> None:
    from evoflow.config.agents_config import _should_upgrade_xiaomi_avatar, _XIAOMI_DEFAULT_AVATAR

    assert _should_upgrade_xiaomi_avatar("image", _XIAOMI_DEFAULT_AVATAR) is True
    assert _should_upgrade_xiaomi_avatar(None, _XIAOMI_DEFAULT_AVATAR) is True
    assert _should_upgrade_xiaomi_avatar(_XIAOMI_DEFAULT_AVATAR, _XIAOMI_DEFAULT_AVATAR) is False
    # Keep an intentional different gallery pick.
    assert _should_upgrade_xiaomi_avatar("preset:designer", _XIAOMI_DEFAULT_AVATAR) is False
