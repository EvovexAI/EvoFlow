"""Regression: workflow editor reads must not queue behind the process write lock.

A running workflow persists run/step status through ``get_db()`` (shared write
connection guarded by a process-wide ``threading.RLock``). If the apps read path
also used ``get_db()``, opening the workflow editor had to wait for that lock —
「加载工作流…」 stalled whenever anything else was executing.

These tests assert the apps read path goes through the WAL read pool instead.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from evoflow.persistence import app_repositories
from evoflow.persistence import db as db_mod


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db_path = tmp_path / "evoflow.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.setattr(db_mod, "_cached_default_path", None, raising=False)
    monkeypatch.setattr(db_mod, "_read_pool", None, raising=False)
    monkeypatch.setattr(db_mod, "_shared_conn", None, raising=False)
    monkeypatch.setattr(db_mod, "_shared_conn_path", None, raising=False)
    monkeypatch.setattr(db_mod, "_shared_wrapper", None, raising=False)
    app_repositories.reset_apps_columns_cache_for_tests()
    yield
    app_repositories.reset_apps_columns_cache_for_tests()


def _seed_app(app_id: str = "App_test") -> None:
    app_repositories.save_app(
        app_id,
        {
            "name": "测试工作流",
            "description": "d",
            "status": "draft",
            "steps": [{"ref": "s1", "name": "step", "goal": "g"}],
            "parameters": [],
            "canvas": {"nodes": [], "edges": []},
        },
    )


def test_load_app_works_via_read_pool() -> None:
    _seed_app()
    app = app_repositories.load_app("App_test")
    assert app is not None
    assert app["name"] == "测试工作流"
    assert [s["ref"] for s in app["steps"]] == ["s1"]


def test_app_exists_and_owner_scope_use_read_pool() -> None:
    _seed_app()
    assert app_repositories.app_exists("App_test") is True
    assert app_repositories.app_exists("App_missing") is False
    # No owner_scope_id column handling must not raise.
    app_repositories.get_app_owner_scope("App_test")


def test_list_apps_uses_read_pool() -> None:
    _seed_app()
    rows = app_repositories.list_apps()
    assert any(r.get("id") == "App_test" for r in rows)


def test_count_runs_batch_uses_read_pool() -> None:
    _seed_app()
    assert app_repositories.count_runs_batch(["App_test"]) == {}
    assert app_repositories.count_runs("App_test") == 0


def test_load_app_does_not_block_on_write_lock() -> None:
    """The whole point: a held write lock must not stall the apps read path."""
    _seed_app()
    lock = db_mod.db_connection_lock()
    released = threading.Event()
    acquired = threading.Event()

    def holder() -> None:
        with lock:
            acquired.set()
            released.wait(timeout=5.0)

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    assert acquired.wait(timeout=5.0)

    # Write lock is held — a get_db()-based read would block here.
    started = time.perf_counter()
    app = app_repositories.load_app("App_test")
    elapsed = time.perf_counter() - started

    released.set()
    t.join(timeout=5.0)

    assert app is not None
    assert elapsed < 1.0, f"load_app blocked on the write lock for {elapsed:.2f}s"


def test_list_apps_does_not_block_on_write_lock() -> None:
    _seed_app()
    lock = db_mod.db_connection_lock()
    released = threading.Event()
    acquired = threading.Event()

    def holder() -> None:
        with lock:
            acquired.set()
            released.wait(timeout=5.0)

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    assert acquired.wait(timeout=5.0)

    started = time.perf_counter()
    rows = app_repositories.list_apps()
    elapsed = time.perf_counter() - started

    released.set()
    t.join(timeout=5.0)

    assert any(r.get("id") == "App_test" for r in rows)
    assert elapsed < 1.0, f"list_apps blocked on the write lock for {elapsed:.2f}s"
