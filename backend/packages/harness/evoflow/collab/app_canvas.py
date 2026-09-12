"""Canvas layout helpers for App workflows."""

from __future__ import annotations

from typing import Any

START_NODE_ID = "__start__"
ANSWER_NODE_ID = "__answer__"
_NODE_W = 300
_NODE_GAP = 48
_START_OFFSET_X = 300


def _default_position(index: int) -> dict[str, float]:
    col = index % 3
    row = index // 3
    return {
        "x": float(_START_OFFSET_X + col * (_NODE_W + _NODE_GAP)),
        "y": float(80 + row * 200),
    }


def canvas_from_steps(steps: list[Any]) -> dict[str, Any]:
    """Build FastGPT-shaped canvas_json from legacy step.canvas + depends_on."""
    nodes: list[dict[str, Any]] = [
        {
            "nodeId": START_NODE_ID,
            "type": "start",
            "position": {"x": 48.0, "y": 140.0},
        }
    ]
    edges: list[dict[str, Any]] = []
    step_list = [s for s in steps if isinstance(s, dict)]

    for i, step in enumerate(step_list):
        ref = str(step.get("ref") or step.get("step_ref") or i + 1).strip() or str(i + 1)
        canvas = step.get("canvas") if isinstance(step.get("canvas"), dict) else {}
        pos = _default_position(i)
        x = canvas.get("x", pos["x"])
        y = canvas.get("y", pos["y"])
        nodes.append(
            {
                "nodeId": ref,
                "type": "agentStep",
                "position": {"x": float(x), "y": float(y)},
            }
        )
        depends_on = step.get("depends_on") or []
        if not isinstance(depends_on, list):
            depends_on = []
        for dep in depends_on:
            src = str(dep).strip()
            if not src or src == ref:
                continue
            edges.append(
                {
                    "source": src,
                    "target": ref,
                    "sourceHandle": "out",
                    "targetHandle": "in",
                }
            )

    with_incoming = {e["target"] for e in edges}
    for node in nodes:
        if node["type"] != "agentStep":
            continue
        nid = node["nodeId"]
        if nid not in with_incoming:
            edges.append(
                {
                    "source": START_NODE_ID,
                    "target": nid,
                    "sourceHandle": "out",
                    "targetHandle": "in",
                }
            )

    return {"nodes": nodes, "edges": edges}
