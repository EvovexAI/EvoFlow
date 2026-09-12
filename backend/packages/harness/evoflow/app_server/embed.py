"""Optional embedded app-server TCP listener inside Gateway (debug only).

Desktop uses native-style: Tauri spawns ``--mode app-server`` over stdio and kills
it on window exit. Set ``EVOFLOW_EMBED_APP_SERVER=1`` to also bind TCP in-process.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def resolve_app_server_listen_port() -> int:
    raw = (os.environ.get("EVOFLOW_APP_SERVER_PORT") or "").strip()
    if raw.isdigit():
        return int(raw)
    for key in ("EVOFLOW_GATEWAY_PORT", "EVOFLOW_GATEWAY_BIND_PORT"):
        gw = (os.environ.get(key) or "").strip()
        if gw.isdigit():
            return int(gw) + 1
    return 8071


def resolve_gateway_base_url_for_embed() -> str:
    explicit = (os.environ.get("EVOFLOW_GATEWAY_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    for key in ("EVOFLOW_GATEWAY_PORT", "EVOFLOW_GATEWAY_BIND_PORT"):
        gw = (os.environ.get(key) or "").strip()
        if gw.isdigit():
            return f"http://127.0.0.1:{int(gw)}"
    # Common isolated-stack default when env is unset.
    return "http://127.0.0.1:8070"


async def start_embedded_app_server(app: Any) -> None:
    """Bind JSON-RPC TCP next to Gateway; store handles on ``app.state``."""
    from evoflow.app_server.stdio_rpc import serve_tcp_server

    if getattr(app.state, "app_server_server", None) is not None:
        return

    host = (os.environ.get("EVOFLOW_APP_SERVER_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    port = resolve_app_server_listen_port()
    gateway_base = resolve_gateway_base_url_for_embed()
    os.environ.setdefault("EVOFLOW_APP_SERVER_PORT", str(port))

    try:
        server = await serve_tcp_server(host, port, gateway_base_url=gateway_base)
    except OSError as exc:
        logger.warning("Embedded app-server bind failed on %s:%s: %s", host, port, exc)
        app.state.app_server_error = str(exc)
        app.state.app_server_port = None
        return

    socks = server.sockets or []
    bound_port = int(socks[0].getsockname()[1]) if socks else port
    app.state.app_server_server = server
    app.state.app_server_port = bound_port
    app.state.app_server_gateway_base = gateway_base
    app.state.app_server_error = None
    logger.info(
        "Embedded app-server listening on %s:%s (gateway=%s)",
        host,
        bound_port,
        gateway_base,
    )
    # Keep serving until cancelled on shutdown.
    async with server:
        await server.serve_forever()


async def stop_embedded_app_server(app: Any) -> None:
    server = getattr(app.state, "app_server_server", None)
    task = getattr(app.state, "app_server_task", None)
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    if server is not None:
        server.close()
        try:
            await server.wait_closed()
        except Exception:
            pass
    app.state.app_server_server = None
    app.state.app_server_task = None
