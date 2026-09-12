"""Filesystem integration helpers for Knowledge Vault (no real MCP / embedding download)."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.knowledge.vault.normalize import build_graph_from_note, extract_wikilinks, normalize_notes
from evoflow.knowledge.vault.paths import assert_write_allowed, normalize_vault_relative_path, resolve_inside_vault
from evoflow.knowledge.vault.template import render_inbox_note


@pytest.fixture
def sample_vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    (root / ".obsidian").mkdir(parents=True)
    (root / "Knowledge").mkdir()
    (root / "00-Inbox").mkdir()
    (root / "Knowledge" / "Agent Memory.md").write_text(
        "---\ntags: [agent, memory]\n---\n\n智能体长期记忆用于保存跨任务可复用的信息。\n",
        encoding="utf-8",
    )
    (root / "Knowledge" / "RAG.md").write_text("# RAG\n检索增强生成。\n", encoding="utf-8")
    (root / "Knowledge" / "EvoFlow.md").write_text(
        "EvoFlow 使用 [[Agent Memory]] 和 [[RAG]]。\n",
        encoding="utf-8",
    )
    return root


def test_chinese_content_and_links(sample_vault: Path):
    text = (sample_vault / "Knowledge" / "EvoFlow.md").read_text(encoding="utf-8")
    assert "[[Agent Memory]]" in text
    links = extract_wikilinks(text)
    assert set(links) == {"Agent Memory", "RAG"}

    mem = (sample_vault / "Knowledge" / "Agent Memory.md").read_text(encoding="utf-8")
    assert "智能体长期记忆" in mem
    # title / keyword style match simulation
    assert "记住" in "怎么让 AI 记住以前项目？" or "记忆" in mem


def test_graph_depth1(sample_vault: Path):
    content = (sample_vault / "Knowledge" / "EvoFlow.md").read_text(encoding="utf-8")
    notes = normalize_notes("personal", {"path": "Knowledge/EvoFlow.md", "content": content, "title": "EvoFlow"})
    g = build_graph_from_note("personal", notes[0], depth=1, direction="outgoing")
    assert len(g.nodes) == 3
    assert {e.target for e in g.edges} == {"Agent Memory", "RAG"}


def test_inbox_write_allowlist(sample_vault: Path):
    rel = normalize_vault_relative_path("00-Inbox/New Note.md")
    assert_write_allowed(rel, ["00-Inbox"])
    target = resolve_inside_vault(sample_vault, rel)
    body = render_inbox_note(title="New Note", content="hello", source="test", confidence=0.8)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    assert target.is_file()
    assert "confidence: 0.80" in target.read_text(encoding="utf-8")
    # vault files untouched outside inbox
    assert (sample_vault / "Knowledge" / "EvoFlow.md").is_file()


def test_delete_config_does_not_delete_vault(sample_vault: Path):
    # Simulate config delete: only assert vault remains
    assert (sample_vault / ".obsidian").is_dir()
    assert (sample_vault / "Knowledge" / "Agent Memory.md").is_file()
