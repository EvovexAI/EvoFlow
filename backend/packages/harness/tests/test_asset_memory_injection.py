"""runtime-aligned Tier-0 memory injection (read_path + standing only)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.agents.lead_agent.prompt import build_memory_injection_sections
from evoflow.assets.guidance import build_entity_memory_injection
from evoflow.assets.hub import ensure_entity_tree
from evoflow.assets.memory_injection import resolve_memory_injection_mode
from evoflow.assets.paths import EntityRef
from evoflow.config.memory_config import MemoryConfig, set_memory_config


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        set_memory_config(MemoryConfig(injection_mode="asset"))
        yield Path(tmp)
        set_memory_config(MemoryConfig())


def test_default_injection_mode_is_asset() -> None:
    set_memory_config(MemoryConfig())
    assert resolve_memory_injection_mode() == "asset"


def test_asset_tier0_read_path_with_catalog(assets_home: Path) -> None:
    """asset-hub 模式下 entity block 内部渲染 catalog,让模型一眼看到已有哪些资产."""
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    standing = assets_home / "assets" / "user" / "memory" / "standing.md"
    standing.write_text(
        "v1\n\n当前主线：prompt-audit\n",
        encoding="utf-8",
    )
    facts = assets_home / "assets" / "user" / "memory" / "facts"
    facts.mkdir(parents=True, exist_ok=True)
    (facts / "ci-fix.md").write_text(
        "---\ntitle: CI fix\nsummary: 使用 cache mount\n---\n\nuse --mount=type=cache\n",
        encoding="utf-8",
    )

    block = build_entity_memory_injection(ref)
    # standing 内容仍出现在块内(无 BEGIN/END sentinel,只用 ``` 代码栅栏)
    assert "prompt-audit" in block
    # read/write/replace 是统一的工具集(任意出现即可,不必 "read / write / replace" 这个完整字面)
    for token in ("read", "write", "replace"):
        assert token in block, token
    # catalog 已渲染(新格式:不再用 <catalog> 包裹,而是 - path · label 平铺)
    assert "ci-fix" in block
    # 锚点行里就带 base_dir,不必单开一行
    assert "base=" in block


def test_asset_skips_empty_standing(assets_home: Path) -> None:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    assert build_entity_memory_injection(ref) == ""


def test_build_memory_injection_sections_asset_no_legacy_memory(assets_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ref = EntityRef("user", "user").normalized()
    ensure_entity_tree(ref)
    (assets_home / "assets" / "user" / "memory" / "standing.md").write_text(
        "v1\n\n验证岗偏好结论先行\n",
        encoding="utf-8",
    )

    class _Cfg:
        enabled = True
        injection_enabled = True
        injection_mode = "asset"
        chat_compact_max_tokens = 800
        max_injection_tokens = 2000

    monkeypatch.setattr("evoflow.config.memory_config.get_memory_config", lambda: _Cfg())

    block = build_memory_injection_sections(agent_name="main")
    # standing 内容仍可见(没有 sentinel,只有 markdown 代码栅栏 + base 锚点)
    assert "验证岗偏好结论先行" in block
    assert "<memory>" not in block
    assert "User Context" not in block


def test_build_memory_injection_sections_legacy_includes_sqlite_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    set_memory_config(MemoryConfig(injection_mode="legacy"))

    class _Cfg:
        enabled = True
        injection_enabled = True
        injection_mode = "legacy"
        chat_compact_max_tokens = 800
        max_injection_tokens = 2000

    monkeypatch.setattr("evoflow.config.memory_config.get_memory_config", lambda: _Cfg())
    monkeypatch.setattr(
        "evoflow.agents.lead_agent.prompt._get_memory_context",
        lambda *a, **k: "<memory>\nUser Context:\n- Work: test\n</memory>\n",
    )
    monkeypatch.setattr(
        "evoflow.assets.guidance.build_session_asset_memory_block",
        lambda **k: "",
    )

    block = build_memory_injection_sections(agent_name="main")
    assert "<memory>" in block
    set_memory_config(MemoryConfig())


def test_procedure_once_when_user_and_workspace(assets_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.assets.paths import workspace_entity_ref
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    user = EntityRef("user", "user").normalized()
    ensure_entity_tree(user)
    (assets_home / "assets" / "user" / "memory" / "standing.md").write_text(
        "v1\n\n用户主线：dedupe-read-path\n",
        encoding="utf-8",
    )

    repo = assets_home / "proj"
    repo.mkdir()
    ws = workspace_entity_ref(str(repo))
    ensure_entity_tree(ws)
    (repo / ".evoflow" / "memory" / "standing.md").write_text(
        "v1\n\n工作区：EvoFlow harness\n",
        encoding="utf-8",
    )

    class _Cfg:
        enabled = True
        injection_enabled = True
        injection_mode = "asset"
        chat_compact_max_tokens = 800
        max_injection_tokens = 2000

    monkeypatch.setattr("evoflow.config.memory_config.get_memory_config", lambda: _Cfg())

    block = build_memory_injection_sections(
        agent_name="main",
        local_workspace_root=str(repo),
    )
    assert block.count("## Entity assets") == 1
    # procedure 段已改写为中文
    assert "先问用户" in block
    assert "dedupe-read-path" in block
    assert "EvoFlow harness" in block
    assert "<workspace_memory>" in block
    # heading 格式:`### User \`xxx\` · base=\`...\``(短破折号 + 锚点合并)
    assert "### User `assets/user`" in block
    assert "### Workspace `" in block
    # Workspace block must not re-paste the shared procedure
    ws_start = block.index("<workspace_memory>")
    assert "## Entity assets" not in block[ws_start:]
    assert "先问用户" not in block[ws_start:]
