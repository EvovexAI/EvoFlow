"""Panel UI settings in evoflow_app_settings."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.persistence import config_repositories as cfg_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.panel_settings import (
    PANEL_SETTINGS_KEY,
    get_panel_settings,
    patch_panel_settings,
)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_panel_settings_defaults(sqlite_tmp: None) -> None:
    del sqlite_tmp
    s = get_panel_settings()
    assert s["theme"] == "system"
    assert s["memoryEnabledDefault"] is True
    assert s["knowledgeMapEnabled"] is True
    assert s["useVirtualPaths"] is False
    assert s["workspaceIndexWatchEnabled"] is False


def test_panel_settings_patch_merge(sqlite_tmp: None) -> None:
    del sqlite_tmp
    patch_panel_settings({"theme": "dark", "memoryEnabledDefault": False})
    s = get_panel_settings()
    assert s["theme"] == "dark"
    assert s["memoryEnabledDefault"] is False
    assert s["useVirtualPaths"] is False
    assert s["workspaceIndexWatchEnabled"] is False
    raw = cfg_repo.get_app_setting(PANEL_SETTINGS_KEY)
    assert isinstance(raw, dict)
    assert raw["theme"] == "dark"
