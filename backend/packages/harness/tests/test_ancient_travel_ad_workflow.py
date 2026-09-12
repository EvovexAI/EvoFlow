"""Bundled 古风穿梭短片 workflow definition."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.workflows.bundled.ancient_travel_ad import APP_DEFINITION, APP_ID, install


@pytest.fixture()
def wf_db(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "ancient-travel-ad.db"))
    from evoflow.persistence.db import reset_db_for_tests

    reset_db_for_tests()
    yield
    reset_db_for_tests()


def test_ancient_travel_ad_definition_validates():
    from evoflow.collab.app_schema import normalize_app_document
    from evoflow.collab.workflow_validator import validate_app_definition

    doc = normalize_app_document(dict(APP_DEFINITION))
    v = validate_app_definition(doc)
    assert v.get("valid"), v.get("errors")
    refs = [s["ref"] for s in doc["steps"]]
    assert refs == ["brief", "prompts", "images", "videos", "assemble"]
    agents = [s.get("assigned_agent") for s in doc["steps"]]
    assert agents[0] == "media-screenwriter"
    assert agents[2] == "media-artist"
    assert "byted-ark-seedream-skill" in (doc["steps"][2].get("skills") or [])


def test_install_ancient_travel_ad_workflow(wf_db):
    out = install(publish=True, overwrite=True)
    assert out["appId"] == APP_ID
    assert out["steps_count"] == 5
    from evoflow.admin import apps as apps_admin

    got = apps_admin.get_app(APP_ID)
    app = got.get("app") or {}
    assert app.get("status") == "published"
    assert "{{hero_object}}" in str(app.get("goal_template") or "")
