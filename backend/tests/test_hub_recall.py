"""Asset Hub turn-tail recall — title match only."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.assets.hub_recall import format_hub_asset_recall, hub_recall_enabled
from evoflow.assets.paths import EntityRef


def test_hub_recall_enabled_default_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EVOFLOW_HUB_RECALL", raising=False)
    assert hub_recall_enabled() is True
    monkeypatch.setenv("EVOFLOW_HUB_RECALL", "0")
    assert hub_recall_enabled() is False


def test_format_hub_asset_recall_title_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    root = tmp_path / "assets" / "employees" / "demo-writer"
    craft = root / "craft"
    craft.mkdir(parents=True)
    (craft / "five-block.md").write_text(
        "---\nname: five-block\ndescription: 五段式硬规则\n---\n\n# 五段式\n\n必须写摄影机型号\n",
        encoding="utf-8",
    )
    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "standing.md").write_text("v1\n\n## User Profile\ndemo\n", encoding="utf-8")

    # Title/description hit
    text = format_hub_asset_recall(EntityRef("employee", "demo-writer"), "五段式")
    assert "ASSET HUB RECALL" in text
    assert "craft/five-block.md" in text
    assert "五段式" in text

    # Body-only token must NOT match (title-only policy)
    assert format_hub_asset_recall(EntityRef("employee", "demo-writer"), "摄影机型号") == ""

    assert format_hub_asset_recall(EntityRef("employee", "demo-writer"), "你好") == ""
