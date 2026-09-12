"""API tests for license activate/status and premium-gated routes.

Uses a minimal FastAPI app (no full Gateway) so harness tests stay light.
"""

from __future__ import annotations

import gc
import tempfile
import time
from pathlib import Path

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from evoflow.config.app_config import reset_app_config
from evoflow.license.codec import (
    LicenseCodecError,
    code_fingerprint,
    issue_activation_code,
    resolve_bind_machine_id,
    verify_activation_code,
)
from evoflow.license.entitlements import build_activated_state, get_license_status
from evoflow.license.gate import require_premium
from evoflow.license.machine import clear_machine_id_cache, get_machine_id
from evoflow.license.keys import generate_keypair
from evoflow.license.store import clear_license_state, set_license_state
from evoflow.persistence.db import get_db, reset_db_for_tests


class ActivateBody(BaseModel):
    code: str = Field(..., min_length=8)


def _build_app() -> FastAPI:
    app = FastAPI()
    lic = APIRouter(prefix="/api/license", tags=["license"])

    @lic.get("/status")
    def status():
        return get_license_status().to_dict()

    @lic.post("/activate")
    def activate(body: ActivateBody):
        local_mid = get_machine_id()
        try:
            claims = verify_activation_code(body.code, expected_machine_id=local_mid)
            bind_mid = resolve_bind_machine_id(claims, local_mid)
        except LicenseCodecError as e:
            raise HTTPException(
                status_code=400,
                detail={"error": e.code, "message": str(e)},
            ) from e
        set_license_state(
            build_activated_state(
                machine_id=bind_mid,
                expires_at_unix=claims.expires_at_unix,
                features=claims.features,
                code_fp=code_fingerprint(body.code),
            )
        )
        return get_license_status().to_dict()

    @lic.post("/deactivate")
    def deactivate():
        clear_license_state()
        return get_license_status().to_dict()

    app.include_router(lic)

    gated = APIRouter(prefix="/api/tasks", dependencies=[Depends(require_premium)])

    @gated.get("/ping")
    def ping():
        return {"ok": True}

    app.include_router(gated)
    return app


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        priv, pub, mac = generate_keypair()
        monkeypatch.setenv("EVOFLOW_LICENSE_PRIVATE_KEY", priv)
        monkeypatch.setenv("EVOFLOW_LICENSE_PUBLIC_KEY", pub)
        monkeypatch.setenv("EVOFLOW_LICENSE_CODE_MAC", mac)
        monkeypatch.delenv("EVOFLOW_LICENSE_SECRET", raising=False)
        monkeypatch.setattr(
            "evoflow.license.entitlements.ENFORCE_LICENSE_VERIFY",
            True,
        )
        clear_machine_id_cache()
        from evoflow.license.keys import clear_key_cache

        clear_key_cache()
        reset_app_config()
        reset_db_for_tests()
        get_db()

        with TestClient(_build_app()) as c:
            yield c

        reset_db_for_tests()
        reset_app_config()
        clear_machine_id_cache()
        clear_key_cache()
        gc.collect()


def test_status_inactive(client: TestClient):
    r = client.get("/api/license/status")
    assert r.status_code == 200
    body = r.json()
    assert body["activated"] is False
    assert body["premium"] is False
    assert len(body["machine_id"]) == 16


def test_gated_route_403_then_ok(client: TestClient):
    r0 = client.get("/api/tasks/ping")
    assert r0.status_code == 403
    detail = r0.json()["detail"]
    assert detail["error"] == "license_required"

    # Floating code: no machine pre-bind
    code = issue_activation_code(expires_at_unix=int(time.time()) + 86400)
    act = client.post("/api/license/activate", json={"code": code})
    assert act.status_code == 200
    body = act.json()
    assert body["premium"] is True
    assert body["machine_id"] == get_machine_id()

    r1 = client.get("/api/tasks/ping")
    assert r1.status_code == 200
    assert r1.json()["ok"] is True


def test_activate_wrong_machine(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("evoflow.license.codec.ENFORCE_MACHINE_BIND", True)
    code = issue_activation_code(
        machine_id="0123456789ABCDEF",
        expires_at_unix=int(time.time()) + 86400,
    )
    r = client.post("/api/license/activate", json={"code": code})
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "machine_mismatch"


def test_deactivate(client: TestClient):
    code = issue_activation_code(expires_at_unix=int(time.time()) + 86400)
    assert client.post("/api/license/activate", json={"code": code}).status_code == 200
    d = client.post("/api/license/deactivate")
    assert d.status_code == 200
    assert d.json()["premium"] is False
    assert client.get("/api/tasks/ping").status_code == 403
