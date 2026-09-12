"""Deferred LangGraph in-process mount — keeps ``create_app()`` import-light."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Any

import httpx
from fastapi import FastAPI
from starlette.applications import Starlette
from starlette.types import ASGIApp, Receive, Scope, Send

from evoflow.langgraph_run_config import resolve_langgraph_base_url
from evoflow.runtime.long_run_limits import httpx_stream_timeout

logger = logging.getLogger(__name__)

_HOP_BY_HOP = frozenset(
    {
        b"connection",
        b"keep-alive",
        b"proxy-authenticate",
        b"proxy-authorization",
        b"te",
        b"trailers",
        b"transfer-encoding",
        b"upgrade",
        b"host",
        b"content-length",
    }
)

_LANGGRAPH_MOUNTED = False


def mount_langgraph_in_process() -> Starlette:
    """Initialize LangGraph runtime env and return its ASGI app."""
    global _LANGGRAPH_MOUNTED
    if _LANGGRAPH_MOUNTED:
        from langgraph_api.server import app as lg_app

        return lg_app
    _LANGGRAPH_MOUNTED = True

    from evoflow.langgraph_runtime_env import (
        apply_langgraph_server_env,
        load_langgraph_server_config,
    )

    apply_langgraph_server_env()
    cfg = load_langgraph_server_config()
    graphs = cfg.get("graphs") or {}
    checkpointer = cfg.get("checkpointer")

    os.environ["LANGSERVE_GRAPHS"] = json.dumps(graphs) if graphs else "{}"
    os.environ.setdefault("REDIS_URI", "fake")
    os.environ.setdefault("LANGGRAPH_RUNTIME_EDITION", "inmem")
    os.environ.setdefault("LANGGRAPH_ALLOW_BLOCKING", "true")
    # Multi-session concurrency: isolate each LG job loop so chat + proactive
    # do not starve each other on a shared asyncio loop. Opt out with
    # EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS=0 (restores Windows shared-loop mode).
    _force_iso = (os.environ.get("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS") or "1").strip().lower()
    if _force_iso in ("0", "false", "no", "off"):
        os.environ["EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS"] = "0"
        if sys.platform == "win32":
            os.environ["BG_JOB_ISOLATED_LOOPS"] = "false"
        else:
            os.environ.setdefault("BG_JOB_ISOLATED_LOOPS", "true")
    else:
        os.environ["EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS"] = "1"
        os.environ["BG_JOB_ISOLATED_LOOPS"] = "true"
        logger.info(
            "LangGraph BG_JOB_ISOLATED_LOOPS=true (per-job event loop isolation); "
            "set EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS=0 to share the Gateway loop"
        )
    os.environ.setdefault("LANGGRAPH_DISABLE_FILE_PERSISTENCE", "false")
    os.environ.setdefault("N_JOBS_PER_WORKER", "10")
    if checkpointer:
        os.environ.setdefault("LANGGRAPH_CHECKPOINTER", json.dumps(checkpointer))
    # Durable EvoFlow checkpointer already persists graph state — keep the
    # LangGraph inmem pickle store off so ~/.evoflow/.langgraph_api/*.pckl
    # (often multi-GB) is not loaded into Gateway RSS on every start.
    # Opt out with EVOFLOW_KEEP_LG_FILE_PERSISTENCE=1.
    try:
        from evoflow.config.app_config import get_app_config

        cp_cfg = getattr(get_app_config(), "checkpointer", None)
        cp_type = str(getattr(cp_cfg, "type", "") or "").strip().lower()
    except Exception:
        cp_type = ""
    keep_pckl = (os.getenv("EVOFLOW_KEEP_LG_FILE_PERSISTENCE") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if cp_type in ("sqlite", "postgres") and not keep_pckl:
        os.environ["LANGGRAPH_DISABLE_FILE_PERSISTENCE"] = "true"
        logger.info(
            "LangGraph file persistence disabled (checkpointer.type=%s); "
            "set EVOFLOW_KEEP_LG_FILE_PERSISTENCE=1 to keep .pckl store",
            cp_type,
        )
    if not os.environ.get("MIGRATIONS_PATH"):
        os.environ.setdefault("MIGRATIONS_PATH", "__inmem")

    try:
        import langgraph.version as _lg_versions

        if not getattr(_lg_versions, "__version__", ""):
            _lg_versions.__version__ = "1.0.4"
    except Exception:
        pass

    try:
        _root = logging.getLogger()
        for _h in list(_root.handlers):
            _root.removeHandler(_h)
            try:
                _h.close()
            except Exception:
                pass
    except Exception:
        pass

    from langgraph_api.server import app as lg_app

    try:
        _lg_route_paths = []
        for _r in getattr(lg_app, "routes", []):
            _lg_route_paths.append(getattr(_r, "path", str(type(_r).__name__)))
        logger.info(
            "LangGraph in-process mount ready: graphs=%s, routes=%s",
            sorted(graphs.keys()),
            _lg_route_paths,
        )
    except Exception:
        logger.info("LangGraph in-process mount ready: graphs=%s", sorted(graphs.keys()))
    return lg_app


async def ensure_langgraph_mounted(app: FastAPI) -> Starlette:
    """Mount LangGraph once in background startup (thread-pool for import cost)."""
    lg = getattr(app.state, "_lg_app", None)
    if lg is not None:
        return lg

    lock: asyncio.Lock | None = getattr(app.state, "_lg_mount_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app.state._lg_mount_lock = lock

    async with lock:
        lg = getattr(app.state, "_lg_app", None)
        if lg is not None:
            return lg
        lg = await asyncio.to_thread(mount_langgraph_in_process)
        app.state._lg_app = lg
        print(
            f"[gateway] LangGraph mounted (deferred), lg_app type={type(lg).__name__}, "
            f"routes={[getattr(r, 'path', '?') for r in getattr(lg, 'routes', [])]}",
            file=sys.stderr,
            flush=True,
        )
        logger.info(
            "[gateway] LangGraph mounted (deferred), lg_app type=%s, routes=%s",
            type(lg).__name__,
            [getattr(r, "path", "?") for r in getattr(lg, "routes", [])],
        )
        return lg


async def _read_request_body(receive: Receive) -> bytes:
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] != "http.request":
            continue
        chunk = message.get("body") or b""
        if chunk:
            chunks.append(bytes(chunk))
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


def _filter_response_headers(headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    return [(k, v) for k, v in headers if k.lower() not in _HOP_BY_HOP]


class ExternalLangGraphProxy:
    """Reverse-proxy ``/api/langgraph/*`` to a standalone LangGraph HTTP server."""

    def __init__(self, *, upstream_base: str | None = None) -> None:
        self._upstream_base = (upstream_base or resolve_langgraph_base_url()).rstrip("/")
        self._client: httpx.AsyncClient | None = None

    def _client_or_create(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx_stream_timeout(),
                follow_redirects=False,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        path = str(scope.get("path") or "")
        if not path.startswith("/"):
            path = f"/{path}"
        query = scope.get("query_string") or b""
        url = self._upstream_base + path
        if query:
            url += "?" + query.decode("latin-1", errors="replace")

        headers = {
            k.decode("latin-1", errors="replace"): v.decode("latin-1", errors="replace")
            for k, v in scope.get("headers") or []
            if k.lower() not in _HOP_BY_HOP
        }
        body = await _read_request_body(receive)
        client = self._client_or_create()
        try:
            req = client.build_request(
                method=str(scope.get("method") or "GET"),
                url=url,
                headers=headers,
                content=body if body else None,
            )
            upstream = await client.send(req, stream=True)
        except httpx.RequestError as exc:
            logger.warning("External LangGraph proxy failed url=%s: %s", url, exc)
            payload = json.dumps(
                {"detail": "LangGraph upstream unreachable", "upstream": self._upstream_base},
                ensure_ascii=False,
            ).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 503,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(payload)).encode()),
                        (b"retry-after", b"2"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": payload, "more_body": False})
            return

        out_headers = _filter_response_headers(list(upstream.headers.raw))
        await send(
            {
                "type": "http.response.start",
                "status": upstream.status_code,
                "headers": out_headers,
            }
        )
        try:
            async for chunk in upstream.aiter_raw():
                if chunk:
                    await send({"type": "http.response.body", "body": chunk, "more_body": True})
        finally:
            await upstream.aclose()
        await send({"type": "http.response.body", "body": b"", "more_body": False})


def install_external_langgraph_proxy(app: FastAPI) -> ExternalLangGraphProxy:
    """Point Gateway at external LangGraph and mark engine ready without in-process import."""
    proxy = ExternalLangGraphProxy()
    app.state._lg_app = proxy
    app.state._lg_external = True
    logger.info("LangGraph external proxy ready upstream=%s", proxy._upstream_base)
    print(
        f"[gateway] LangGraph external proxy upstream={proxy._upstream_base}",
        file=sys.stderr,
        flush=True,
    )
    return proxy


class LazyLangGraphMount:
    """ASGI placeholder at ``/api/langgraph`` until background startup sets ``_lg_app``."""

    def __init__(self, gateway_app: FastAPI) -> None:
        self._gateway = gateway_app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        lg: ASGIApp | None = getattr(self._gateway.state, "_lg_app", None)
        if lg is None:
            if scope["type"] == "http":
                body = b'{"detail":"LangGraph engine loading"}'
                await send(
                    {
                        "type": "http.response.start",
                        "status": 503,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                            (b"retry-after", b"2"),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body, "more_body": False})
            return
        await lg(scope, receive, send)
