"""Smoke: list_memory_agent_slots reads SQLite content keys (not disk)."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_list_memory_agent_slots_marks_sqlite_content(sqlite_tmp: Path):
    from evoflow.persistence import memory_repositories as mem_repo
    from evoflow.agents.memory.updater import list_memory_agent_slots
    from evoflow.config.agents_config import save_agent_config

    save_agent_config(
        "demo-agent",
        {"agent_type": "custom", "agent_name": "演示", "description": "slot test"},
    )
    mem_repo.save_memory(
        "demo-agent",
        {
            "version": "1.0",
            "lastUpdated": "2026-07-21T00:00:00Z",
            "user": {
                "workContext": {"summary": "hello", "updatedAt": "2026-07-21T00:00:00Z"},
                "personalContext": {"summary": "", "updatedAt": ""},
                "topOfMind": {"summary": "", "updatedAt": ""},
            },
            "history": {
                "recentMonths": {"summary": "", "updatedAt": ""},
                "earlierContext": {"summary": "", "updatedAt": ""},
                "longTermBackground": {"summary": "", "updatedAt": ""},
            },
            "facts": [
                {
                    "id": "fact_1",
                    "content": "prefers concise",
                    "category": "preference",
                    "confidence": 0.9,
                    "createdAt": "2026-07-21T00:00:00Z",
                    "source": "test",
                }
            ],
        },
    )

    slots = list_memory_agent_slots()
    by_id = {s["id"]: s for s in slots}
    assert None in by_id
    assert by_id[None]["has_memory_file"] is False
    assert "demo-agent" in by_id
    assert by_id["demo-agent"]["has_memory_file"] is True
    assert by_id["demo-agent"]["display_name"] == "演示"
