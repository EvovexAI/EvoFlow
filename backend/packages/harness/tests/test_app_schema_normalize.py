"""Tests for App JSON normalize contract."""

from __future__ import annotations

from evoflow.collab.app_schema import normalize_app_document


def test_normalize_tools_csv_to_list_and_strip_step_canvas() -> None:
    doc = normalize_app_document(
        {
            "name": "demo",
            "parameters": [{"name": "topic", "label": "主题"}],
            "steps": [
                {
                    "ref": "1",
                    "name": "调研",
                    "goal": "看 {{topic}}",
                    "assigned_agent": "researcher",
                    "tools": "web_search, read_file",
                    "skills": ["research"],
                    "depends_on": [],
                    "canvas": {"x": 1, "y": 2},
                },
                {
                    "ref": "2",
                    "goal": "写报告",
                    "assigned_agent": "writer",
                    "depends_on": ["1"],
                },
            ],
            "canvas": {},
        }
    )
    assert doc["steps"][0]["tools"] == ["web_search", "read_file"]
    assert doc["steps"][0]["skills"] == ["research"]
    assert "canvas" not in doc["steps"][0]
    assert doc["parameters"][0]["label"] == "主题"
    assert doc["canvas"]["nodes"]
    assert any(e["source"] == "1" and e["target"] == "2" for e in doc["canvas"]["edges"])


def test_normalize_syncs_depends_on_from_canvas_edges() -> None:
    doc = normalize_app_document(
        {
            "steps": [
                {"ref": "1", "goal": "a", "depends_on": ["99"]},
                {"ref": "2", "goal": "b", "depends_on": []},
            ],
            "canvas": {
                "nodes": [
                    {"nodeId": "__start__", "type": "start", "position": {"x": 0, "y": 0}},
                    {"nodeId": "1", "type": "agentStep", "position": {"x": 1, "y": 1}},
                    {"nodeId": "2", "type": "agentStep", "position": {"x": 2, "y": 2}},
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
            },
        }
    )
    assert doc["steps"][0]["depends_on"] == []
    assert doc["steps"][1]["depends_on"] == ["1"]
