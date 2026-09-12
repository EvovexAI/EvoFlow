"""Data retention helpers."""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import pytest

from evoflow.config.data_retention_config import DataRetentionConfig
from evoflow.persistence.data_retention import (
    prune_gateway_logs,
    prune_task_status_events,
    run_checkpoint_db_retention,
)
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_prune_gateway_logs_removes_old_files(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    old = log_dir / "gateway-2020-01-01.log"
    old.write_text("x", encoding="utf-8")
    new = log_dir / "gateway-2099-12-31.log"
    new.write_text("y", encoding="utf-8")

    removed = prune_gateway_logs(log_dir, days=7)

    assert removed == 1
    assert not old.exists()
    assert new.exists()


def test_prune_task_status_events(sqlite_tmp: None) -> None:
    from evoflow.persistence.db import get_db

    conn = get_db()
    conn.execute(
        """
        INSERT INTO evoflow_task_events (event_type, task_id, event_json, created_at, updated_at)
        VALUES ('status', 't1', '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
        """
    )
    conn.commit()
    n = prune_task_status_events(days=90)
    assert n >= 1
    row = conn.execute("SELECT COUNT(*) FROM evoflow_task_events WHERE event_type = 'status'").fetchone()
    assert int(row[0]) == 0


def test_retention_config_defaults() -> None:
    cfg = DataRetentionConfig()
    assert cfg.logs_days == 7
    assert cfg.observability_days == 90
    assert cfg.gateway_requests_days == 7
    assert cfg.observability_max_size_gb == 2.0
    assert cfg.enabled is True
    assert cfg.vacuum_sqlite is True
    assert cfg.vacuum_min_deleted_rows == 1
    assert cfg.startup_delay_seconds == 900


def test_prune_observability_db_gateway_shorter_retention(tmp_path: Path) -> None:
    from evoflow.observability.sqlite_store import ObservabilitySqliteStore
    from evoflow.observability.tables import ObservabilityTable
    from evoflow.persistence.data_retention import prune_observability_db

    obs_path = tmp_path / "evoflow_observability.db"
    store = ObservabilitySqliteStore(obs_path)
    store.insert_gateway_request(
        occurred_at="2020-01-01T00:00:00.000Z",
        method="GET",
        path="/api/tasks",
        query_string=None,
        client_ip=None,
        user_agent=None,
        request_content_type=None,
        response_content_type=None,
        status_code=200,
        duration_ms=1.0,
    )
    store.insert_trace_event(
        thread_id="t1",
        run_id=None,
        lane="collab_cycle",
        occurred_at="2020-01-01T00:00:00.000Z",
        event="test",
        payload={"x": 1},
    )
    store.close()

    deleted = prune_observability_db(obs_path, days=90, gateway_requests_days=7)
    assert deleted >= 1

    conn = sqlite3.connect(str(obs_path))
    gw = conn.execute(f"SELECT COUNT(*) FROM {ObservabilityTable.GATEWAY_REQUESTS}").fetchone()[0]
    trace = conn.execute(f"SELECT COUNT(*) FROM {ObservabilityTable.TRACE_EVENTS}").fetchone()[0]
    conn.close()
    assert int(gw) == 0
    assert int(trace) == 0


def test_enforce_observability_db_size_cap_strips_and_deletes(tmp_path: Path) -> None:
    from evoflow.observability.sqlite_store import ObservabilitySqliteStore
    from evoflow.observability.tables import ObservabilityTable
    from evoflow.persistence.data_retention import enforce_observability_db_size_cap

    obs_path = tmp_path / "evoflow_observability.db"
    store = ObservabilitySqliteStore(obs_path)
    for i in range(20):
        store.insert_gateway_request(
            occurred_at=f"2026-08-26T10:00:{i:02d}.000Z",
            method="GET",
            path="/api/tasks",
            query_string=None,
            client_ip=None,
            user_agent=None,
            request_content_type="application/json",
            response_content_type="application/json",
            status_code=200,
            duration_ms=1.0,
            request_body_sample="x" * 5000,
            response_body_sample="y" * 5000,
            request_headers={"h": "z" * 3000},
        )
    store.close()

    size = obs_path.stat().st_size
    stripped2, deleted, vacuumed = enforce_observability_db_size_cap(
        obs_path,
        max_bytes=max(4096, size // 3),
    )
    assert stripped2 >= 20
    assert deleted > 0
    assert vacuumed is True

    conn = sqlite3.connect(str(obs_path))
    remaining = conn.execute(f"SELECT COUNT(*) FROM {ObservabilityTable.GATEWAY_REQUESTS}").fetchone()[0]
    conn.close()
    assert int(remaining) < 20


def test_run_checkpoint_db_retention_skips_uninitialized_db(tmp_path: Path) -> None:
    cp_path = tmp_path / "checkpoints.db"
    sqlite3.connect(str(cp_path)).close()

    result = run_checkpoint_db_retention(
        cp_path,
        protected=set(),
        purge_thread_ids={"orphan-thread"},
        keep_per_thread=5,
    )

    assert result == (0, 0, 0, 0, 0)
