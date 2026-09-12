"""Tests for Gateway startup gate middleware."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.gateway.startup_gate import StartupGateMiddleware


@pytest.mark.asyncio
async def test_startup_gate_blocks_api_until_routers_registered():
    app = FastAPI()
    app.state.routers_registered = False
    app.state.startup_ready = False
    app.add_middleware(StartupGateMiddleware)

    @app.get("/health/liveness")
    async def liveness():
        return {"status": "alive"}

    @app.get("/api/tasks")
    async def tasks():
        return {"tasks": []}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        live = await client.get("/health/liveness")
        assert live.status_code == 200

        blocked = await client.get("/api/tasks")
        assert blocked.status_code == 503
        body = blocked.json()
        assert body["error"] == "starting_up"
        assert "retry_after_ms" in body


@pytest.mark.asyncio
async def test_startup_gate_blocks_langgraph_until_engine_ready():
    app = FastAPI()
    app.state.routers_registered = True
    app.state.startup_ready = False
    app.state._lg_app = None
    app.add_middleware(StartupGateMiddleware)

    @app.get("/api/models")
    async def models():
        return []

    @app.get("/api/langgraph/ok")
    async def lg_ok():
        return {"ok": True}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        models_resp = await client.get("/api/models")
        assert models_resp.status_code == 200

        lg_resp = await client.get("/api/langgraph/ok")
        assert lg_resp.status_code == 503
        assert lg_resp.json()["error"] == "warming_up"

        app.state._lg_app = object()
        lg_ready = await client.get("/api/langgraph/ok")
        assert lg_ready.status_code == 200


@pytest.mark.asyncio
async def test_startup_gate_blocks_extended_routes_until_registered():
    app = FastAPI()
    app.state.routers_registered = True
    app.state.extended_routers_registered = False
    app.state._lg_app = object()
    app.add_middleware(StartupGateMiddleware)

    @app.get("/api/tasks")
    async def tasks():
        return {"tasks": []}

    @app.get("/api/knowledge")
    async def knowledge():
        return {"datasets": []}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        tasks_resp = await client.get("/api/tasks")
        assert tasks_resp.status_code == 200

        blocked = await client.get("/api/knowledge")
        assert blocked.status_code == 503
        assert blocked.json()["error"] == "loading_extended"

        proactive = await client.get("/api/proactive/roles")
        assert proactive.status_code == 503
        assert proactive.json()["error"] == "loading_extended"

        app.state.extended_routers_registered = True
        ready = await client.get("/api/knowledge")
        assert ready.status_code == 200
