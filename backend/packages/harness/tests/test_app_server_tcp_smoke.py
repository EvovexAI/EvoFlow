"""Smoke: TCP app-server initialize + ping."""

from __future__ import annotations

import asyncio
import json
import threading
import time

from evoflow.app_server.stdio_rpc import serve_tcp


async def _client(port: int) -> None:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)

    async def send(obj: dict) -> None:
        writer.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())
        await writer.drain()

    async def recv() -> dict:
        line = await reader.readline()
        return json.loads(line.decode())

    await send(
        {
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "smoke"},
                "gatewayBaseUrl": "http://127.0.0.1:9",
            },
        }
    )
    init = await recv()
    assert init["result"]["capabilities"]["turnStart"] is True
    await send({"method": "initialized"})
    await send({"id": 2, "method": "server/ping"})
    ping = await recv()
    assert ping["result"]["ok"] is True
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:
        pass


def test_tcp_handshake_smoke():
    port = 18765

    def run_server() -> None:
        asyncio.run(serve_tcp("127.0.0.1", port, gateway_base_url="http://127.0.0.1:9"))

    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(0.35)
    asyncio.run(_client(port))
