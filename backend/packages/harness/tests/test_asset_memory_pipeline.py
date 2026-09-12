"""Full runtime memory pipeline alignment (write path + queue gating)."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evoflow.agents.memory.queue import ConversationContext, MemoryUpdateQueue
from evoflow.assets.ad_hoc_note import (
    build_ad_hoc_filename,
    validate_ad_hoc_filename,
    write_ad_hoc_note,
)
from evoflow.assets.citation import extract_evo_asset_citations, parse_rollout_ids
from evoflow.assets.memory_injection import asset_hub_memory_injection
from evoflow.assets.paths import EntityRef
from evoflow.assets.pipeline_config import (
    MemoryAssetsConfig,
    max_unused_days,
    should_run_legacy_memory_updater,
)
from evoflow.config.memory_config import MemoryConfig, set_memory_config


@pytest.fixture
def assets_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        yield Path(tmp)
        set_memory_config(MemoryConfig())


def test_default_max_unused_days_is_30() -> None:
    set_memory_config(MemoryConfig())
    assert max_unused_days() == 30


def test_asset_mode_skips_legacy_updater_by_default() -> None:
    set_memory_config(MemoryConfig(injection_mode="asset"))
    assert asset_hub_memory_injection() is True
    assert should_run_legacy_memory_updater() is False


def test_legacy_injection_runs_updater() -> None:
    set_memory_config(MemoryConfig(injection_mode="legacy"))
    assert should_run_legacy_memory_updater() is True


def test_legacy_updater_opt_in_under_asset_mode() -> None:
    set_memory_config(
        MemoryConfig(
            injection_mode="asset",
            assets=MemoryAssetsConfig(legacy_updater_enabled=True),
        )
    )
    assert should_run_legacy_memory_updater() is True


def test_ad_hoc_filename_contract() -> None:
    name = build_ad_hoc_filename(slug_hint="Reply In Chinese")
    assert name.endswith(".md")
    assert validate_ad_hoc_filename(name) is None
    assert validate_ad_hoc_filename("bad-name.md") == "must use YYYY-MM-DDTHH-MM-SS-<slug>.md"


def test_write_ad_hoc_note_creates_inbox_file(assets_home: Path) -> None:
    ref = EntityRef("user", "user").normalized()
    data = write_ad_hoc_note(ref, "Prefer concise replies", slug_hint="pref-style")
    rel = str(data.get("path") or "")
    assert rel.startswith("memory/_inbox/notes/")
    full = assets_home / "assets" / "user" / Path(*rel.split("/"))
    assert full.is_file()
    assert "Prefer concise replies" in full.read_text(encoding="utf-8")


def test_parse_rollout_ids_and_strip() -> None:
    block = (
        "<citation_entries>\nmemory/standing.md:1-2|note=[x]\n</citation_entries>\n"
        "<rollout_ids>\nthread-a\nthread-b\nthread-a\n</rollout_ids>"
    )
    assert parse_rollout_ids(block) == ["thread-a", "thread-b"]
    text = f"done.<evo-asset-citation>{block}</evo-asset-citation>"
    parsed = extract_evo_asset_citations(text)
    assert parsed["rollout_ids"] == ["thread-a", "thread-b"]
    assert "<evo-asset-citation>" not in parsed["text"]


def test_queue_asset_mode_skips_memory_updater() -> None:
    set_memory_config(MemoryConfig(injection_mode="asset", debounce_seconds=1))
    q = MemoryUpdateQueue()
    ctx = ConversationContext(thread_id="t1", messages=[{"role": "user", "content": "hi"}])
    updater = MagicMock()
    updater.update_memory.return_value = True
    with q._lock:
        q._queue = [ctx]
        q._processing = False
    with patch("evoflow.agents.memory.updater.MemoryUpdater", return_value=updater), patch(
        "evoflow.assets.phase1.run_phase1_extract",
        return_value={"ok": True, "skipped": "disabled"},
    ), patch(
        "evoflow.assets.phase2.run_phase2_consolidate",
        return_value={"ok": True, "skipped": "disabled"},
    ), patch(
        "evoflow.assets.citation.record_citations_from_messages",
        return_value={"ok": True, "recorded": 0},
    ):
        q._process_queue()
    updater.update_memory.assert_not_called()


def test_queue_legacy_runs_memory_updater() -> None:
    set_memory_config(MemoryConfig(injection_mode="legacy", debounce_seconds=1))
    q = MemoryUpdateQueue()
    ctx = ConversationContext(thread_id="t1", messages=[{"role": "user", "content": "hi"}])
    updater = MagicMock()
    updater.update_memory.return_value = True
    with q._lock:
        q._queue = [ctx]
        q._processing = False
    with patch("evoflow.agents.memory.updater.MemoryUpdater", return_value=updater), patch(
        "evoflow.assets.phase1.run_phase1_extract",
        return_value={"ok": True, "skipped": "disabled"},
    ), patch(
        "evoflow.assets.phase2.run_phase2_consolidate",
        return_value={"ok": True, "skipped": "disabled"},
    ), patch(
        "evoflow.assets.citation.record_citations_from_messages",
        return_value={"ok": True, "recorded": 0},
    ):
        q._process_queue()
    updater.update_memory.assert_called_once()
