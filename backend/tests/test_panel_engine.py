"""Unit tests for main-panel CDP HTTP client (``panel_engine``)."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from evoflow.tools.builtins import panel_engine as pe


@pytest.fixture(autouse=True)
def _clear_port_cache():
    pe.clear_panel_port_cache()
    yield
    pe.clear_panel_port_cache()


def test_panel_request_unavailable_without_port():
    with patch.object(pe, "read_panel_cdp_http_port", return_value=None):
        out = pe.panel_request("GET", "state")
    assert out["ok"] is False
    assert out["code"] == "backend_unavailable"


def test_panel_request_posts_json_and_unwraps_ok(monkeypatch: pytest.MonkeyPatch):
    captured: dict[str, Any] = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {"ok": True, "result": {"clicked": "e2"}}

        @property
        def text(self):
            return ""

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def request(self, method, url, content=None, headers=None):
            captured["method"] = method
            captured["url"] = url
            captured["content"] = content
            captured["headers"] = headers
            return _Resp()

        def get(self, *a, **k):
            raise AssertionError("GET unexpected")

    monkeypatch.setattr(pe, "read_panel_cdp_http_port", lambda: 19876)
    monkeypatch.setattr(pe, "read_panel_cdp_token", lambda: "secret-tok")
    monkeypatch.setattr(pe.httpx, "Client", _Client)

    out = pe.panel_request("POST", "click", body={"ref": "e2"})
    assert out == {"ok": True, "result": {"clicked": "e2"}}
    assert captured["method"] == "POST"
    assert captured["url"] == "http://127.0.0.1:19876/main-cdp/click"
    assert b'"ref"' in (captured["content"] or b"")
    assert captured["headers"]["X-EvoFlow-Panel-Token"] == "secret-tok"


def test_panel_request_unauthorized():
    class _Resp:
        status_code = 401
        text = "nope"

        def json(self):
            return {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, headers=None):
            return _Resp()

    with (
        patch.object(pe, "read_panel_cdp_http_port", return_value=9),
        patch.object(pe, "read_panel_cdp_token", return_value=None),
        patch.object(pe.httpx, "Client", _Client),
    ):
        out = pe.panel_request("GET", "state")
    assert out["ok"] is False
    assert out["code"] == "unauthorized"


def test_ui_panel_snapshot_formats_text(monkeypatch: pytest.MonkeyPatch):
    from evoflow.admin.platform_handlers import ui_panel

    def _fake(method, route, body=None, timeout=None):
        assert method == "POST" and route == "snapshot"
        return {
            "ok": True,
            "result": {
                "url": "app://main",
                "title": "EvoFlow",
                "elements": [
                    {"ref": "e1", "role": "button", "name": "发送", "inViewport": True},
                    {"ref": "e2", "role": "textbox", "name": "composer", "inViewport": False},
                ],
                "truncated": False,
            },
        }

    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        _fake,
    )
    out = ui_panel({"op": "snapshot"})
    assert out["ok"] is True
    assert out["op"] == "snapshot"
    assert "[e1] button" in out["text"]
    assert "发送" in out["text"]
    assert "(out of view)" in out["text"]


def test_ui_panel_action_forwards_name(monkeypatch: pytest.MonkeyPatch):
    from evoflow.admin.platform_handlers import ui_panel

    seen: dict[str, Any] = {}

    def _fake(method, route, body=None, timeout=None):
        seen.update(method=method, route=route, body=body)
        return {"ok": True, "result": {"action": "openXiaomi"}}

    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        _fake,
    )
    out = ui_panel({"op": "action", "name": "openXiaomi", "navigateToChat": True})
    assert out["ok"] is True
    assert seen["route"] == "action"
    assert seen["body"]["action"] == "openXiaomi"
