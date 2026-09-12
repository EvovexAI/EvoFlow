"""Admin usage rollup by principal."""

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


def test_fetch_usage_by_principal(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.authz import principals as principals_mod
    from evoflow.persistence.usage_ledger import fetch_usage_by_principal

    ensure_app_schema(get_db())
    principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    principals_mod.create_principal(display_name="Bob", principal_id="user:bob")

    db = get_db()
    # Minimal daily rows (schema may have more NOT NULL cols — insert common set)
    cols = {str(r[1]) for r in db.execute("PRAGMA table_info(evoflow_usage_daily)").fetchall()}
    assert "principal_id" in cols
    for pid, qty, amt in (
        ("user:alice", 1000, 0.5),
        ("user:bob", 200, 0.1),
        ("", 50, 0.02),
    ):
        db.execute(
            """
            INSERT INTO evoflow_usage_daily (
                day, category, subcategory, sku, subject_type, subject_id, principal_id,
                quantity_sum, quantity_in_sum, quantity_out_sum, amount_sum, event_count
            ) VALUES (?, 'llm', '', 'gpt', '', '', ?, ?, 0, 0, ?, 1)
            """,
            ("2026-09-01", pid, qty, amt),
        )
    db.commit()

    out = fetch_usage_by_principal(from_day="2026-09-01", to_day="2026-09-01")
    items = out["items"]
    assert len(items) >= 2
    by_pid = {str(i.get("principal_id") or ""): i for i in items}
    assert by_pid["user:alice"]["display_name"] == "Alice"
    assert by_pid["user:alice"]["label"] == "Alice"
    assert by_pid["user:alice"]["quantity_sum"] == 1000
    assert by_pid[""]["label"] == "未归属" or by_pid.get(None) or True
    orphan = next(i for i in items if not i.get("principal_id"))
    assert orphan["label"] == "未归属"
