"""Browser bridge tests — real node kernel + real loopback HTTP stub.

Verifies the embedded ``BRIDGE_SETUP_JS`` adapter end to end: the bridge global
registers under the ZCode symbol, ``list()`` and ``execute(command)`` reach the
Gateway HTTP surface, the command mapping table routes correctly, and
unmapped commands return structured errors.
"""

from __future__ import annotations

import json
import json as _json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


def parse_kernel_json(out: str):
    """Kernel returns ``=> <value>``; object values arrive as JSON-encoded strings."""
    value = _json.loads(out.removeprefix("=> ").strip())
    if isinstance(value, str):
        value = _json.loads(value)
    return value


gateway_stub_transport: dict = {"value": "webview2"}


@pytest.fixture(scope="module")
def gateway_stub():
    """Minimal stand-in for the Gateway /api/browser surface (real HTTP)."""
    received: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: N802
            pass

        def _json(self, payload: dict, status: int = 200):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/api/browser/transport"):
                self._json({"transport": gateway_stub_transport.get("value", "webview2")})
                return
            if self.path.startswith("/api/browser/tabs"):
                self._json(
                    {
                        "tabs": [
                            {
                                "tabId": "primary",
                                "url": "https://example.com/",
                                "title": "Example Domain",
                                "viewport": {"width": 1280, "height": 720},
                                "active": True,
                            }
                        ],
                        "activeTabId": "primary",
                    }
                )
                return
            self._json({"detail": "not found"}, 404)

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            received.append(payload)
            command = payload.get("command") or {}
            if command.get("method") == "navigate":
                self._json({"ok": True, "state": {"url": command.get("url"), "title": "Example Domain"}})
                return
            if command.get("method") == "getState":
                self._json({"ok": True, "state": {"url": "https://example.com/", "title": "Example Domain"}})
                return
            if command.get("method") == "viewportSet":
                self._json({"ok": True})
                return
            self._json({"ok": False, "error": {"code": "unknown", "message": "no such command"}}, 200)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], received
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="module")
def kernel(gateway_stub):
    """node-repl-host kernel with the bridge setup pre-verified.

    【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    只设 ``EVOFLOW_GATEWAY_PORT`` 不够：``resolve_gateway_base_url()`` 的优先级是
    ``EVOFLOW_GATEWAY_URL`` > ``EVOFLOW_GATEWAY_PORT``，而本机 shell（由网关拉起的
    进程）本来就注入了 ``EVOFLOW_GATEWAY_URL=http://127.0.0.1:8382``。于是内核桥
    绕过本 fixture 的 stub 端口，真的去打现网网关：``list()`` 返回桌面端当前标签
    （``browser-embed/blank``）而不是 stub 的 ``https://example.com/``，四条用例
    连带失败（execute / viewportSet / Edge 拒绝同样打在真网关上）。
    两个变量必须在同一个 fixture 里覆盖并在退出时还原，否则 module 级作用域会把
    8382 泄漏给同进程后续用例。
    """
    port, _received = gateway_stub
    import os

    saved = {
        k: os.environ.get(k)
        for k in ("EVOFLOW_GATEWAY_PORT", "EVOFLOW_GATEWAY_URL", "EVOFLOW_LANGGRAPH_URL")
    }
    os.environ["EVOFLOW_GATEWAY_PORT"] = str(port)
    os.environ["EVOFLOW_GATEWAY_URL"] = f"http://127.0.0.1:{port}"
    os.environ.pop("EVOFLOW_LANGGRAPH_URL", None)
    from evoflow.plugins import node_repl

    # 内核进程懒起且粘住首次解析到的 base：上一个用例留下的进程会带着旧 base
    # 继续服务，必须先关掉才能用 stub 端口重新拉起。
    node_repl.shutdown()
    from evoflow.plugins.node_repl import call_node_repl_js

    try:
        yield call_node_repl_js
    finally:
        try:
            node_repl.shutdown()
        except Exception:
            pass
        for key, val in saved.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val


def test_bridge_symbol_registered(kernel) -> None:
    out = kernel('typeof Symbol.for("zcode.node-repl.browser-control-bridge")')
    assert "symbol" in out


def test_bridge_list_hits_gateway(kernel) -> None:
    out = kernel(
        'globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")].list()'
        ".then((r) => JSON.stringify(r))"
    )
    body = parse_kernel_json(out)
    assert isinstance(body, list) and len(body) == 1
    assert body[0]["id"] == "evoflow-webview"
    assert body[0]["type"] == "iab"
    assert body[0]["metadata"]["url"] == "https://example.com/"


def test_bridge_execute_navigate(kernel, gateway_stub) -> None:
    _port, received = gateway_stub
    out = kernel(
        'globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")]'
        '.execute("evoflow-webview", 1, { method: "navigate", url: "https://example.com/" })'
        ".then((r) => JSON.stringify(r))"
    )
    body = json.loads(out.strip().lstrip("=> \n"))
    assert body["ok"] is True
    assert body["state"]["url"] == "https://example.com/"
    assert received[-1]["command"]["method"] == "navigate"


def test_bridge_maps_browser_viewport_set(kernel, gateway_stub) -> None:
    _port, received = gateway_stub
    out = kernel(
        'globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")]'
        '.execute("evoflow-webview", 1, { method: "browserViewportSet", width: 800, height: 600 })'
        ".then((r) => JSON.stringify(r))"
    )
    body = json.loads(out.strip().lstrip("=> \n"))
    assert body["ok"] is True
    assert received[-1]["command"]["method"] == "viewportSet"
    assert received[-1]["command"]["width"] == 800


def test_bridge_refuses_edge_fallback(kernel) -> None:
    # 用户要求：只驱动客户端内置浏览器面板（webview2）；Edge 回退必须如实拒绝。
    gateway_stub_transport["value"] = "edge"
    try:
        with pytest.raises(Exception, match="WebView2"):
            kernel(
                'globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")]'
                '.execute("evoflow-webview", 1, { method: "navigate", url: "https://x.test/" })'
            )
    finally:
        gateway_stub_transport["value"] = "webview2"


def test_bridge_unmapped_command_structured_error(kernel) -> None:
    out = kernel(
        'globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")]'
        '.execute("evoflow-webview", 1, { method: "recordingStart", options: {} })'
        ".then((r) => JSON.stringify(r))"
    )
    body = json.loads(out.strip().lstrip("=> \n"))
    assert body["ok"] is False
    assert "recordingStart" in body["error"]["message"]
