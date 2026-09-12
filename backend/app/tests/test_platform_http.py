"""HTTP /api/platform mirrors the in-agent platform tool."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.routers.platform import router


def test_platform_http_catalog_and_verification(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    try:
        from evoflow.persistence.db import reset_db_for_tests
        from evoflow.admin.platform_actions import reset_registry_cache

        reset_db_for_tests()
        reset_registry_cache()
    except Exception:
        pass

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    cat = client.get("/api/platform/catalog", params={"domain": "verification"})
    assert cat.status_code == 200
    body = cat.json()
    assert body.get("ok") is True
    names = {i.get("name") for i in body.get("items") or []}
    assert "verification.init" in names
    assert "verification.catalog" in names

    preview = client.post(
        "/api/platform",
        json={"action": "verification.init", "args": {"title": "t"}, "confirm": False},
    )
    assert preview.status_code == 200
    assert preview.json().get("pending_confirm") is True

    started = client.post(
        "/api/platform",
        json={
            "action": "verification.init",
            "args": {"title": "t", "domains": ["diagnostics"], "confirm": True},
            "confirm": True,
        },
    )
    assert started.status_code == 200
    data = started.json()
    assert data.get("ok") is True
    rid = data["round"]["roundId"]
    assert rid.startswith("svr_")
    assert data["seeded"]["added"] >= 3

    got = client.post(
        "/api/platform",
        json={"action": "verification.get", "args": {"roundId": rid}},
    )
    assert got.status_code == 200
    assert len(got.json().get("steps") or []) >= 3
