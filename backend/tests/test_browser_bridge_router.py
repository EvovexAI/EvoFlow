"""Browser bridge router tests — real FastAPI, monkeypatched engine command sink."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers import browser_bridge as browser_bridge_router


@pytest.fixture()
def bridge_headers(monkeypatch: pytest.MonkeyPatch, tmp_path) -> dict[str, str]:
    """内核桥调用头：bridge_auth token（数据目录隔离到 tmp_path）。"""
    from evoflow.plugins import bridge_auth

    monkeypatch.delenv("EVOFLOW_BROWSER_BRIDGE_TOKEN", raising=False)
    token_file = tmp_path / "bridge-token"
    monkeypatch.setenv("EVOFLOW_BRIDGE_TOKEN_FILE", str(token_file))
    bridge_auth.reset_bridge_token_cache()
    token = bridge_auth.get_bridge_token()
    return {"X-EvoFlow-Bridge-Token": token}


@pytest.fixture()
def client(tmp_path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    captured: list[dict] = []

    class FakeEngine:
        def execute(self, thread_id: str, command: dict, timeout: float) -> dict:
            captured.append({"threadId": thread_id, "command": command})
            if command.get("method") == "navigate":
                return {
                    "ok": True,
                    "state": {"url": command.get("url"), "title": "Example Domain"},
                    "elapsedMs": 1.0,
                }
            if command.get("method") == "getState":
                return {
                    "ok": True,
                    "state": {
                        "url": "https://example.com/",
                        "title": "Example Domain",
                        "viewport": {"width": 1280, "height": 720},
                    },
                    "elapsedMs": 1.0,
                }
            return {"ok": True, "elapsedMs": 1.0}

    monkeypatch.setattr(
        browser_bridge_router, "_get_engine", lambda: FakeEngine(), raising=False
    )
    monkeypatch.setattr(browser_bridge_router, "require_org_admin", lambda request: None)

    app = FastAPI()
    app.include_router(browser_bridge_router.router)
    return TestClient(app), captured


def test_execute_navigate(client: TestClient, bridge_headers: dict[str, str]) -> None:
    tc, captured = client
    resp = tc.post(
        "/api/browser/execute",
        json={"command": {"method": "navigate", "url": "https://example.com"}},
        headers=bridge_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["state"]["url"] == "https://example.com"
    assert captured[0]["threadId"] == "evoflow-node-repl-bridge"


def test_execute_rejects_missing_token(client: TestClient) -> None:
    """token guard：缺头/错头 → 403（本地零凭据旁路不再适用于命令面）。"""
    tc, _captured = client
    missing = tc.post(
        "/api/browser/execute",
        json={"command": {"method": "navigate", "url": "https://x.test"}},
    )
    assert missing.status_code == 403
    wrong = tc.post(
        "/api/browser/execute",
        json={"command": {"method": "navigate", "url": "https://x.test"}},
        headers={"X-EvoFlow-Bridge-Token": "not-the-token"},
    )
    assert wrong.status_code == 403


def test_execute_custom_thread_id(client: TestClient, bridge_headers: dict[str, str]) -> None:
    tc, captured = client
    resp = tc.post(
        "/api/browser/execute",
        json={"command": {"method": "navigate", "url": "https://x.test"}, "threadId": "thread-A"},
        headers=bridge_headers,
    )
    assert resp.status_code == 200
    assert captured[-1]["threadId"] == "thread-A"


def test_tabs_single_webview_model(client: TestClient, bridge_headers: dict[str, str]) -> None:
    tc, _captured = client
    resp = tc.get("/api/browser/tabs", headers=bridge_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["activeTabId"] == "primary"
    assert body["tabs"][0]["url"] == "https://example.com/"
    assert body["tabs"][0]["active"] is True


def test_log_endpoint_appends_to_unified_file(client: TestClient, tmp_path, monkeypatch) -> None:
    """POST /api/browser/log 把前端日志追加进统一 logs/plugin-control.log。"""
    from app.gateway.routers import browser_bridge as router
    from evoflow.tools.builtins import browser_debug_log

    log_file = tmp_path / "logs" / "plugin-control.log"
    monkeypatch.setattr(browser_debug_log, "unified_log_path", lambda: log_file)

    tc, _captured = client
    resp = tc.post(
        "/api/browser/log",
        json={
            "source": "web",
            "entries": [
                {"ts": "2026-10-16T10:00:00Z", "level": "info", "msg": "[panel] mount ok"},
                {"ts": "2026-10-16T10:00:01Z", "level": "warn", "msg": "[panel] bounds mismatch"},
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "count": 2}
    content = log_file.read_text(encoding="utf-8")
    assert "[web]" in content
    assert "[panel] mount ok" in content
    assert "warn:2026-10-16T10:00:01Z" in content


def test_browser_debug_log_creates_file(tmp_path, monkeypatch) -> None:
    """统一日志写入器：目录自动创建、多行按序追加。"""
    from evoflow.tools.builtins import browser_debug_log

    log_file = tmp_path / "logs" / "plugin-control.log"
    monkeypatch.setattr(browser_debug_log, "unified_log_path", lambda: log_file)

    browser_debug_log.browser_debug_log("rust", "upsert label=browser-embed-primary")
    browser_debug_log.browser_debug_log("web", "[panel] slot 698x722")
    browser_debug_log.browser_debug_log("py", "engine navigate ok")

    lines = log_file.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
    assert "[rust]" in lines[0] and "upsert" in lines[0]
    assert "[web]" in lines[1]
    assert "[py]" in lines[2]


def test_unified_log_path_under_logs_english(tmp_path, monkeypatch) -> None:
    """Default path is ``{evoflow_dir}/logs/plugin-control.log`` (not Chinese root name)."""
    from evoflow.tools.builtins import browser_debug_log

    monkeypatch.setenv("EVOFLOW_CONFIG_DIR", str(tmp_path))
    path = browser_debug_log.unified_log_path()
    assert path.name == "plugin-control.log"
    assert path.parent.name == "logs"
    assert path.parent.parent == tmp_path


def test_unified_log_migrates_legacy_chinese_root(tmp_path, monkeypatch) -> None:
    """First write moves root-level ``插件控制日志.log`` into logs/plugin-control.log."""
    from evoflow.tools.builtins import browser_debug_log

    monkeypatch.setenv("EVOFLOW_CONFIG_DIR", str(tmp_path))
    legacy = tmp_path / "插件控制日志.log"
    legacy.write_text("legacy\n", encoding="utf-8")

    browser_debug_log.browser_debug_log("py", "fresh")
    dest = tmp_path / "logs" / "plugin-control.log"
    assert dest.is_file()
    text = dest.read_text(encoding="utf-8")
    assert "legacy" in text
    assert "fresh" in text
    assert not legacy.exists()
