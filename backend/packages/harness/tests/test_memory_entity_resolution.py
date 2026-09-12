"""Agent memory → user entity resolution."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from evoflow.assets.guidance import (
    build_agent_soul_injection_block,
    build_session_asset_memory_block,
    resolve_memory_entity,
    resolve_profile_entity,
)
from evoflow.assets.hub import ensure_entity_tree
from evoflow.assets.migrate_agent_memory import migrate_agent_memory_to_user
from evoflow.assets.paths import EntityRef, entity_root, profile_path
from evoflow.config.memory_config import MemoryConfig, set_memory_config
from evoflow.memory.document_codec import namespace_for_agent_key
from evoflow.tools.builtins.assets_tool import assets_tool


@pytest.fixture
def asset_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        set_memory_config(MemoryConfig(injection_mode="asset"))
        yield Path(tmp)
        set_memory_config(MemoryConfig())


def test_resolve_memory_entity_main_and_custom_agent_to_user() -> None:
    assert resolve_memory_entity(agent_name="main").entity_type == "user"
    assert resolve_memory_entity(agent_name="custom-bot-xyz").entity_type == "user"
    assert resolve_memory_entity(entity_type="agent", entity_id="custom-bot-xyz").entity_type == "user"


def test_resolve_profile_entity_custom_agent(asset_home: Path) -> None:
    ensure_entity_tree(EntityRef("agent", "custom-bot-xyz"))
    ent = resolve_profile_entity(agent_name="custom-bot-xyz")
    assert ent.entity_type == "agent"
    assert ent.entity_id == "custom-bot-xyz"


def test_ensure_agent_tree_has_no_memory_dir(asset_home: Path) -> None:
    ensure_entity_tree(EntityRef("agent", "test-agent"))
    root = entity_root(EntityRef("agent", "test-agent"))
    assert (root / "profile").is_dir()
    assert not (root / "memory").exists()
    assert not (root / "craft").exists()


def test_assets_note_from_custom_agent_writes_user_inbox(asset_home: Path) -> None:
    runtime = type("R", (), {"context": {"agent_name": "custom-bot-xyz"}, "config": {}})()
    raw = assets_tool.func(
        action="note",
        content="[preference] likes python",
        runtime=runtime,
        tool_call_id="t1",
    )
    out = json.loads(raw)
    assert out["ok"] is True
    path = out.get("path") or ""
    assert "memory/_inbox/notes/" in path
    full = entity_root(EntityRef("user", "user")) / path
    assert full.is_file()


def test_namespace_for_agent_key_is_user() -> None:
    assert namespace_for_agent_key("main") == "user:default"
    assert namespace_for_agent_key("custom-bot-xyz") == "user:default"


def test_agent_soul_injection_when_summary_exists(asset_home: Path) -> None:
    ensure_entity_tree(EntityRef("agent", "bot-a"))
    soul = profile_path(EntityRef("agent", "bot-a"), "SOUL.md")
    soul.write_text("# SOUL\n\nFriendly coding assistant.\n", encoding="utf-8")
    from evoflow.assets.soul_summary import consolidate_soul_summary_for_entity

    consolidate_soul_summary_for_entity(EntityRef("agent", "bot-a"))
    block = build_agent_soul_injection_block(agent_name="bot-a")
    assert "<agent_soul" in block
    assert "Friendly" in block


def test_migrate_agent_memory_dry_run(asset_home: Path) -> None:
    agent_mem = entity_root(EntityRef("agent", "old-bot")) / "memory" / "facts" / "x.md"
    agent_mem.parent.mkdir(parents=True, exist_ok=True)
    agent_mem.write_text("fact\n", encoding="utf-8")
    report = migrate_agent_memory_to_user(dry_run=True)
    assert report["filesMoved"] >= 1
    assert not (entity_root(EntityRef("user", "user")) / "memory" / "facts" / "x.md").exists()


def test_migrate_agent_memory_apply(asset_home: Path) -> None:
    agent_mem = entity_root(EntityRef("agent", "old-bot")) / "memory" / "facts" / "y.md"
    agent_mem.parent.mkdir(parents=True, exist_ok=True)
    agent_mem.write_text("merged\n", encoding="utf-8")
    migrate_agent_memory_to_user(dry_run=False)
    user_file = entity_root(EntityRef("user", "user")) / "memory" / "facts" / "y.md"
    assert user_file.is_file()
    assert "merged" in user_file.read_text(encoding="utf-8")


def test_build_session_block_uses_user_memory(asset_home: Path) -> None:
    ensure_entity_tree(EntityRef("user", "user"))
    user_standing = entity_root(EntityRef("user", "user")) / "memory" / "standing.md"
    user_standing.write_text("v1\n\nUser standing text here.\n", encoding="utf-8")
    block = build_session_asset_memory_block(agent_name="custom-bot-xyz")
    assert block.strip()
    assert "User standing" in block or "standing" in block.lower()
