"""Cold hydration must rebuild CUA output.display (screenshots) like live mirror."""

from __future__ import annotations

import json

from app.gateway.v4.hydration import _build_hydrated_tool_output


def test_hydrated_tool_output_parses_cua_marker_into_display() -> None:
    marker = {
        "status": "success",
        "images": [{"url": "/api/threads/t1/browser-snapshots/abc123", "kb": 12}],
        "target_app": {"app_key": "windows-exe:Feishu.exe", "display_name": "飞书"},
    }
    body = (
        "[Screenshot captured: /api/threads/t1/browser-snapshots/abc123 (12KB)]\n\n"
        f"{{evoflow-cua-display:{json.dumps(marker, ensure_ascii=False)}}}"
    )
    out = _build_hydrated_tool_output(
        tool_name="mcp__node_repl__js",
        out_text=body,
        status="success",
        thread_id="t1",
    )
    assert "evoflow-cua-display" not in out["text"]
    display = out.get("display") or {}
    assert display.get("kind") == "cua"
    media = display.get("media") or []
    assert len(media) == 1
    assert media[0]["artifactUri"] == "/api/threads/t1/browser-snapshots/abc123"
    assert (display.get("targetApp") or {}).get("displayName") == "飞书"


def test_hydrated_tool_output_prefers_payload_cua_display() -> None:
    out = _build_hydrated_tool_output(
        tool_name="mcp__node_repl__js",
        out_text="ok",
        status="success",
        payload={
            "content": "ok",
            "cua_display": {
                "status": "success",
                "images": [{"url": "/api/threads/t1/browser-snapshots/xyz"}],
            },
        },
    )
    display = out.get("display") or {}
    assert display.get("kind") == "cua"
    assert display["media"][0]["artifactUri"].endswith("/xyz")


def test_hydrated_tool_output_browser_screenshot_json() -> None:
    blob = {
        "type": "browser_screenshot",
        "image_url": "/api/threads/t1/browser-snapshots/shot1",
    }
    out = _build_hydrated_tool_output(
        tool_name="browser_snapshot",
        out_text=json.dumps(blob),
        status="success",
    )
    display = out.get("display") or {}
    assert display.get("kind") == "cua"
    assert display["media"][0]["artifactUri"].endswith("/shot1")
