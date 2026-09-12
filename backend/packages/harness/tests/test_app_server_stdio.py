"""Tests for stdio/TCP app-server handshake and chat bridge helpers."""

from __future__ import annotations

import io
import json
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.app_server.chat_bridge import _build_stream_url
from evoflow.app_server.stdio_rpc import PROTOCOL_VERSION, StdioAppServer, serve_stdio


def _lines(*messages: dict) -> list[str]:
    return [json.dumps(m, separators=(",", ":")) + "\n" for m in messages]


def test_initialize_then_ping():
    server = StdioAppServer()
    server.handle_message(
        {
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "probe", "version": "0"},
                "gatewayBaseUrl": "http://127.0.0.1:8012",
            },
        }
    )
    out = server.drain_writes()
    assert out[0]["id"] == 1
    assert out[0]["result"]["protocolVersion"] == PROTOCOL_VERSION
    assert out[0]["result"]["capabilities"]["turnStart"] is True
    assert out[0]["result"]["capabilities"]["gatewayCall"] is True
    assert out[0]["result"]["capabilities"]["threadStart"] is True
    assert out[0]["result"]["capabilities"]["resourcesCall"] is True
    assert server.gateway_base_url == "http://127.0.0.1:8012"
    server.handle_message({"method": "initialized"})
    server.handle_message({"id": 2, "method": "server/ping"})
    assert server.drain_writes()[0]["result"]["ok"] is True


def test_ping_rejected_before_initialize():
    server = StdioAppServer()
    server.handle_message({"id": 1, "method": "server/ping"})
    assert server.drain_writes() == [
        {"id": 1, "error": {"code": -32000, "message": "Not initialized"}}
    ]


def test_demo_stream_emits_notifications():
    server = StdioAppServer()
    server.handle_message({"id": 1, "method": "initialize", "params": {}})
    server.drain_writes()
    server.handle_message({"id": 2, "method": "demo/stream", "params": {"text": "hi"}})
    assert server.drain_writes() == [
        {"id": 2, "result": {"accepted": True}},
        {"method": "demo/delta", "params": {"delta": "hi"}},
        {"method": "demo/completed", "params": {"text": "hi"}},
    ]


def test_serve_stdio_roundtrip():
    stdin = io.StringIO(
        "".join(
            _lines(
                {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "cli"}}},
                {"method": "initialized"},
                {"id": 2, "method": "server/ping"},
            )
        )
    )
    stdout = io.StringIO()
    assert serve_stdio(stdin=stdin, stdout=stdout) == 0
    rows = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    assert rows[0]["id"] == 1 and rows[0]["result"]["protocolVersion"] == PROTOCOL_VERSION
    assert rows[1]["id"] == 2 and rows[1]["result"]["ok"] is True


def test_build_stream_url_includes_ui_sse():
    url = _build_stream_url("http://127.0.0.1:8012", "thread-1", {"stream_format": "agui"})
    assert "ui_sse=1" in url
    assert "stream_format=agui" in url
    assert "/threads/thread-1/runs/stream" in url


@pytest.mark.asyncio
async def test_proxy_gateway_call_json():
    from evoflow.app_server.chat_bridge import proxy_gateway_call, reset_shared_gateway_client_for_tests

    class _Resp:
        status_code = 200
        is_success = True
        text = '{"hello":1}'

        def json(self):
            return {"hello": 1}

    class _Client:
        def __init__(self, *a, **k):
            self.is_closed = False

        async def request(self, *a, **k):
            return _Resp()

        async def aclose(self):
            self.is_closed = True

    await reset_shared_gateway_client_for_tests()
    with patch("evoflow.app_server.chat_bridge.httpx.AsyncClient", _Client):
        out = await proxy_gateway_call(
            gateway_base="http://127.0.0.1:8070",
            method="GET",
            path="/api/models",
        )
    assert out["ok"] is True
    assert out["status"] == 200
    assert out["body"] == {"hello": 1}
    await reset_shared_gateway_client_for_tests()


@pytest.mark.asyncio
async def test_gateway_call_rpc_emits_result():
    server = StdioAppServer(gateway_base_url="http://127.0.0.1:8070")
    server.handle_message({"id": 1, "method": "initialize", "params": {}})
    server.drain_writes()

    with patch(
        "evoflow.app_server.stdio_rpc.proxy_gateway_call",
        new=AsyncMock(return_value={"ok": True, "status": 200, "body": {"n": 1}, "error": None}),
    ):
        tasks = server.handle_message(
            {"id": 9, "method": "gateway/call", "params": {"method": "GET", "path": "/api/models"}}
        )
        assert tasks
        await tasks[0]
    writes = server.drain_writes()
    assert writes[0]["id"] == 9
    assert writes[0]["result"]["body"] == {"n": 1}


@pytest.mark.asyncio
async def test_gateway_stream_rpc_accepts_and_completes():
    server = StdioAppServer(gateway_base_url="http://127.0.0.1:8070")
    server.handle_message({"id": 1, "method": "initialize", "params": {}})
    server.drain_writes()

    async def _fake_sse(**kwargs):
        emit = kwargs["emit"]
        await emit({"method": "stream/event", "params": {"event": "message", "data": {"hi": 1}}})
        return {"ok": True, "status": 200, "frames": 1, "path": "/api/x"}

    with patch("evoflow.app_server.stdio_rpc.proxy_sse_stream", new=_fake_sse):
        tasks = server.handle_message(
            {
                "id": 11,
                "method": "gateway/stream",
                "params": {
                    "method": "GET",
                    "path": "/api/chat/sessions/s1/stream-resume",
                    "turnId": "sse-1",
                },
            }
        )
        assert tasks
        await tasks[0]
    writes = server.drain_writes()
    assert writes[0]["id"] == 11 and writes[0]["result"]["accepted"] is True
    methods = [w.get("method") for w in writes[1:]]
    assert "stream/event" in methods
    assert "turn/result" in methods


def test_parse_sse_frame_structured():
    from evoflow.app_server.chat_bridge import _parse_sse_frame

    ev, data = _parse_sse_frame('event: messages\ndata: {"a":1}')
    assert ev == "messages"
    assert data == {"a": 1}


@pytest.mark.asyncio
async def test_thread_start_and_resources_call_alias():
    server = StdioAppServer(gateway_base_url="http://127.0.0.1:8070")
    server.handle_message({"id": 1, "method": "initialize", "params": {}})
    server.drain_writes()

    with patch(
        "evoflow.app_server.stdio_rpc.proxy_gateway_call",
        new=AsyncMock(
            return_value={
                "ok": True,
                "status": 200,
                "body": {"thread_id": "thr-1"},
                "error": None,
            }
        ),
    ):
        tasks = server.handle_message(
            {
                "id": 20,
                "method": "thread/start",
                "params": {"sessionKey": "agent:main:x"},
            }
        )
        assert tasks
        await tasks[0]
    writes = server.drain_writes()
    assert writes[0]["id"] == 20
    assert writes[0]["result"]["threadId"] == "thr-1"
    assert any(w.get("method") == "thread/started" for w in writes[1:])

    with patch(
        "evoflow.app_server.stdio_rpc.proxy_gateway_call",
        new=AsyncMock(return_value={"ok": True, "status": 200, "body": {"n": 2}, "error": None}),
    ):
        tasks = server.handle_message(
            {"id": 21, "method": "resources/call", "params": {"method": "GET", "path": "/api/models"}}
        )
        assert tasks
        await tasks[0]
    assert server.drain_writes()[0]["result"]["body"] == {"n": 2}


def test_thread_resume_sync():
    server = StdioAppServer(gateway_base_url="http://127.0.0.1:8070")
    server.handle_message({"id": 1, "method": "initialize", "params": {}})
    server.drain_writes()
    server.handle_message(
        {"id": 3, "method": "thread/resume", "params": {"threadId": "t1", "sessionKey": "s1"}}
    )
    writes = server.drain_writes()
    assert writes[0]["result"]["threadId"] == "t1"
    assert writes[1]["method"] == "thread/started"
