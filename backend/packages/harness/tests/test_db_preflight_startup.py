"""Fast startup DB preflight (quick_check) vs full integrity_check."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from evoflow.persistence import db as db_mod


def _make_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t(v) VALUES ('ok')")
    conn.commit()
    conn.close()


def test_startup_preflight_quick_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_STARTUP_DB_PREFLIGHT", raising=False)
    p = tmp_path / "test.db"
    _make_db(p)
    assert db_mod.preflight_database_startup(p, label="test.db") is True


def test_startup_preflight_skip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_STARTUP_DB_PREFLIGHT", "skip")
    p = tmp_path / "missing.db"
    assert db_mod.preflight_database_startup(p, label="missing.db") is True


def test_startup_preflight_missing_file_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_STARTUP_DB_PREFLIGHT", raising=False)
    p = tmp_path / "nope.db"
    assert db_mod.preflight_database_startup(p, label="nope.db") is True


def test_startup_preflight_skips_observability(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_STARTUP_DB_PREFLIGHT", raising=False)
    p = tmp_path / "evoflow_observability.db"
    _make_db(p)
    called = {"n": 0}

    def _fake_quick(conn):
        called["n"] += 1
        return "ok"

    monkeypatch.setattr(db_mod, "_quick_check", _fake_quick)
    assert db_mod.preflight_database_startup(p, label="observability.db") is True
    assert called["n"] == 0


def test_startup_preflight_mode_full_delegates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_STARTUP_DB_PREFLIGHT", "full")
    p = tmp_path / "test.db"
    _make_db(p)
    called = {"full": False}

    def _fake_full(path: Path, *, label: str = "") -> bool:
        called["full"] = True
        assert path == p
        return True

    monkeypatch.setattr(db_mod, "preflight_database", _fake_full)
    assert db_mod.preflight_database_startup(p, label="test.db") is True
    assert called["full"] is True
