"""New chat sessions must stamp the request principal, not local-admin by default."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


@pytest.mark.asyncio
async def test_create_new_session_stamps_context_principal(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.authz import principals as principals_mod
    from evoflow.persistence import chat_session_service as chat_svc
    from evoflow.persistence import session_repositories as sess_repo

    ensure_app_schema(get_db())
    admin = principals_mod.get_or_create_local_admin()
    alice = principals_mod.ensure_webui_principal(
        webui_user_id=77,
        username="alice77",
        is_primary=False,
    )
    assert alice["principal_id"] != admin["principal_id"]

    row = await chat_svc.create_new_session(
        agent_id="main",
        title="alice chat",
        context={"created_by": alice["principal_id"], "principal_id": alice["principal_id"]},
        ensure_thread=False,
    )
    sk = str(row.get("sessionKey") or "")
    assert sk
    stored = sess_repo.get_session_row_for_ui(sk)
    assert stored is not None
    created_by = str(stored.get("createdBy") or stored.get("created_by") or "")
    scope_id = str(stored.get("scopeId") or stored.get("scope_id") or "")
    assert created_by == alice["principal_id"]
    assert created_by != admin["principal_id"]
    assert scope_id == f"personal:{alice['principal_id']}"
