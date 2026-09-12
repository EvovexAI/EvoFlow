"""App canvas_json dual-track persistence + schema v83 backfill."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_app_canvas_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    canvas = {
        "nodes": [
            {"nodeId": "__start__", "type": "start", "position": {"x": 48, "y": 140}},
            {"nodeId": "1", "type": "agentStep", "position": {"x": 300, "y": 80}},
            {"nodeId": "2", "type": "agentStep", "position": {"x": 620, "y": 80}},
        ],
        "edges": [
            {
                "source": "__start__",
                "target": "1",
                "sourceHandle": "out",
                "targetHandle": "in",
            },
            {
                "source": "1",
                "target": "2",
                "sourceHandle": "out",
                "targetHandle": "in",
            },
        ],
        "viewport": {"x": 10, "y": 20, "zoom": 0.9},
    }
    steps = [
        {
            "ref": "1",
            "name": "步骤 1",
            "description": "research",
            "assigned_agent": "researcher",
            "depends_on": [],
            "tools": "web_search",
        },
        {
            "ref": "2",
            "name": "步骤 2",
            "description": "write",
            "assigned_agent": "writer",
            "depends_on": ["1"],
        },
    ]

    app_repositories.save_app(
        "App_test_canvas",
        {
            "name": "Canvas App",
            "description": "dual track",
            "steps": steps,
            "goal_template": "Ship report",
            "canvas": canvas,
            "status": "draft",
        },
    )

    loaded = app_repositories.load_app("App_test_canvas")
    assert loaded is not None
    assert loaded["canvas"]["viewport"]["zoom"] == 0.9
    assert len(loaded["canvas"]["nodes"]) == 3
    assert loaded["canvas"]["edges"][1]["source"] == "1"
    assert loaded["steps"][0]["assigned_agent"] == "researcher"

    listed = app_repositories.list_apps()
    hit = next(a for a in listed if a["id"] == "App_test_canvas")
    assert hit.get("canvas") in ({}, None) or not (hit.get("canvas") or {}).get("nodes")
    assert hit.get("step_count") == 2
    assert len(hit.get("steps") or []) == 2
    assert hit["steps"][0].get("assigned_agent") == "researcher"
    assert "description" not in hit["steps"][0]

    listed_full = app_repositories.list_apps(summary=False)
    hit_full = next(a for a in listed_full if a["id"] == "App_test_canvas")
    assert hit_full["canvas"]["nodes"][1]["nodeId"] == "1"


def test_app_load_without_canvas_is_empty_dict(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        "App_no_canvas",
        {
            "name": "No Canvas",
            "steps": [{"ref": "1", "name": "only", "depends_on": []}],
            "goal_template": "g",
        },
    )
    loaded = app_repositories.load_app("App_no_canvas")
    assert loaded is not None
    assert isinstance(loaded.get("canvas"), dict)


def test_canvas_from_steps_helper() -> None:
    from evoflow.collab.app_canvas import canvas_from_steps

    steps = [
        {
            "ref": "1",
            "name": "A",
            "depends_on": [],
            "canvas": {"x": 111, "y": 222},
        },
        {
            "ref": "2",
            "name": "B",
            "depends_on": ["1"],
            "canvas": {"x": 333, "y": 444},
        },
    ]
    canvas = canvas_from_steps(steps)
    assert canvas["nodes"][0]["nodeId"] == "__start__"
    assert canvas["nodes"][1]["position"] == {"x": 111.0, "y": 222.0}
    assert canvas["nodes"][2]["position"] == {"x": 333.0, "y": 444.0}
    assert any(e["source"] == "1" and e["target"] == "2" for e in canvas["edges"])
    assert any(e["source"] == "__start__" and e["target"] == "1" for e in canvas["edges"])
