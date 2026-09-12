"""Tests for license issued-code ledger + issue API."""

from __future__ import annotations

import gc
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from evoflow.config.app_config import reset_app_config
from evoflow.license.codec import LicenseCodecError, issue_activation_code
from evoflow.license.issued_store import (
    insert_issued_code,
    list_issued_codes,
    revoke_issued_code,
)
from evoflow.license.keys import can_issue_activation_codes, clear_key_cache, generate_keypair
from evoflow.license.machine import clear_machine_id_cache, get_machine_id, normalize_machine_id
from evoflow.persistence.db import get_db, reset_db_for_tests

@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
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
        clear_key_cache()
        clear_machine_id_cache()
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        clear_machine_id_cache()
        clear_key_cache()
        gc.collect()


def test_insert_list_revoke_stats(sqlite_tmp):
    exp = int(time.time()) + 86400 * 40
    code = issue_activation_code(expires_at_unix=exp)
    row = insert_issued_code(
        code=code,
        expires_at_unix=exp,
        issued_to="Acme",
        note="trial",
        machine_id="",
    )
    assert row["issued_to"] == "Acme"
    assert row["status"] == "active"
    assert row["floating"] is True

    listed = list_issued_codes(q="Acme")
    assert listed["total"] == 1
    assert listed["stats"]["active"] == 1
    assert listed["items"][0]["code"]

    revoked = revoke_issued_code(row["id"])
    assert revoked is not None
    assert revoked["status"] == "revoked"
    listed2 = list_issued_codes()
    assert listed2["stats"]["revoked"] == 1


def test_list_marks_expired(sqlite_tmp):
    exp = int(time.time()) - 10
    code = issue_activation_code(expires_at_unix=exp, grouped=False)
    insert_issued_code(code=code, expires_at_unix=exp, issued_to="Old")
    listed = list_issued_codes(status="expired")
    assert listed["total"] == 1
    assert listed["items"][0]["status"] == "expired"


class IssueCodeBody(BaseModel):
    days: int | None = Field(None, ge=1, le=3650)
    expires: str | None = None
    issued_to: str = ""
    note: str = ""
    machine_id: str = ""


def _build_app() -> FastAPI:
    """Minimal FastAPI surface mirroring gateway license codes routes."""
    app = FastAPI()
    lic = APIRouter(prefix="/api/license", tags=["license"])

    @lic.get("/codes/meta")
    def meta():
        return {"can_issue": can_issue_activation_codes(), "machine_id": get_machine_id()}

    @lic.get("/codes")
    def codes_list(
        q: str = Query(""),
        status: str = Query(""),
        limit: int = Query(200),
        offset: int = Query(0),
    ):
        return list_issued_codes(q=q, status=status, limit=limit, offset=offset)

    @lic.post("/codes")
    def codes_issue(body: IssueCodeBody) -> dict[str, Any]:
        if not can_issue_activation_codes():
            raise HTTPException(
                status_code=503,
                detail={"error": "no_private_key", "message": "no key"},
            )
        mid = None
        mid_arg = str(body.machine_id or "").strip()
        if mid_arg:
            mid = normalize_machine_id(mid_arg)
            if len(mid) != 16:
                raise HTTPException(status_code=400, detail={"error": "invalid_machine"})
        days = int(body.days or 365)
        exp = int((datetime.now(UTC) + timedelta(days=days)).timestamp())
        try:
            code = issue_activation_code(machine_id=mid, expires_at_unix=exp)
        except LicenseCodecError as e:
            raise HTTPException(
                status_code=503 if e.code == "no_private_key" else 400,
                detail={"error": e.code, "message": str(e)},
            ) from e
        row = insert_issued_code(
            code=code,
            expires_at_unix=exp,
            issued_to=body.issued_to,
            note=body.note,
            machine_id=mid or "",
        )
        return {"item": row, "code": row.get("code") or code}

    @lic.post("/codes/{code_id}/revoke")
    def codes_revoke(code_id: str):
        row = revoke_issued_code(code_id)
        if not row:
            raise HTTPException(status_code=404, detail={"error": "not_found"})
        return {"item": row}

    app.include_router(lic)
    return app


@pytest.fixture
def client(sqlite_tmp):
    with TestClient(_build_app()) as c:
        yield c


def test_api_meta_and_issue_list(client: TestClient):
    meta = client.get("/api/license/codes/meta")
    assert meta.status_code == 200
    assert meta.json()["can_issue"] is True

    issued = client.post(
        "/api/license/codes",
        json={"days": 30, "issued_to": "Bob", "note": "poc"},
    )
    assert issued.status_code == 200
    body = issued.json()
    assert body["code"].startswith("EF3")
    assert body["item"]["issued_to"] == "Bob"

    listed = client.get("/api/license/codes", params={"q": "Bob"})
    assert listed.status_code == 200
    data = listed.json()
    assert data["total"] >= 1
    assert data["stats"]["active"] >= 1

    rid = body["item"]["id"]
    rev = client.post(f"/api/license/codes/{rid}/revoke")
    assert rev.status_code == 200
    assert rev.json()["item"]["status"] == "revoked"


def test_api_issue_without_private_key(sqlite_tmp, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_LICENSE_PRIVATE_KEY", raising=False)
    monkeypatch.setattr(
        "evoflow.license.keys._read_private_key_b64_from_file",
        lambda: "",
    )
    clear_key_cache()

    with TestClient(_build_app()) as c:
        meta = c.get("/api/license/codes/meta")
        assert meta.status_code == 200
        assert meta.json()["can_issue"] is False
        r = c.post("/api/license/codes", json={"days": 7, "issued_to": "X"})
        assert r.status_code == 503
        assert r.json()["detail"]["error"] == "no_private_key"
