"""Usage ledger: per-message idempotency + rebuild from chat messages."""

import pytest

from evoflow.persistence.usage_ledger import (
    record_llm_chat_usage_in_txn,
    rebuild_llm_usage_ledger,
)


def _schema(conn):
    conn.executescript(
        """
        CREATE TABLE evoflow_usage_events (
            event_id TEXT PRIMARY KEY, occurred_at TEXT, category TEXT, subcategory TEXT,
            unit TEXT, quantity REAL, quantity_in REAL, quantity_out REAL, currency TEXT,
            amount REAL, pricing_source TEXT, provider TEXT, sku TEXT, session_key TEXT,
            thread_id TEXT, run_id TEXT, message_id TEXT, app_id TEXT, agent_code TEXT,
            workspace_id TEXT, subject_type TEXT, subject_id TEXT, principal_id TEXT,
            meta_json TEXT, created_at TEXT
        );
        CREATE TABLE evoflow_usage_daily (
            day TEXT, category TEXT, subcategory TEXT, sku TEXT, subject_type TEXT,
            subject_id TEXT, principal_id TEXT, quantity_sum REAL, quantity_in_sum REAL,
            quantity_out_sum REAL, amount_sum REAL, event_count INTEGER,
            UNIQUE(day, category, subcategory, sku, subject_type, subject_id, principal_id)
        );
        CREATE TABLE evoflow_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE evoflow_chat_sessions (
            session_key TEXT PRIMARY KEY, thread_id TEXT, model_name TEXT,
            primary_model_name TEXT, is_deleted INTEGER DEFAULT 0, created_by TEXT
        );
        CREATE TABLE evoflow_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, seq INTEGER, role TEXT,
            message_id TEXT, content_json TEXT DEFAULT '{}', tool_call_id TEXT, tool_name TEXT,
            run_id TEXT, thread_id TEXT, parent_thread_id TEXT, model_name TEXT,
            input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
            created_at TEXT, updated_at TEXT, cache_read_tokens INTEGER,
            cache_creation_tokens INTEGER, cache_miss_tokens INTEGER, round_id TEXT,
            turn_started_at TEXT, turn_duration_ms INTEGER, turn_state TEXT,
            UNIQUE(session_key, seq)
        );
        """
    )


def _insert_msg(conn, mid, inp, out, day="2026-10-24", model="glm-4.6", sk="sk1", seq=None):
    conn.execute(
        "INSERT INTO evoflow_chat_messages (session_key, seq, role, message_id, model_name,"
        " input_tokens, output_tokens, total_tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (sk, seq or (mid if isinstance(mid, int) else 1), "assistant", str(mid), model, inp, out, inp + out, f"{day}T00:00:00Z"),
    )


def _summary_totals(conn):
    row = conn.execute(
        "SELECT COALESCE(SUM(quantity_sum),0), COALESCE(SUM(event_count),0), COALESCE(SUM(amount_sum),0)"
        " FROM evoflow_usage_daily WHERE category='llm'"
    ).fetchone()
    return float(row[0]), int(row[1]), float(row[2])


def test_rebuild_derives_one_event_per_message(tmp_path, monkeypatch):
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    conn.execute(
        "INSERT INTO evoflow_chat_sessions VALUES ('sk1','t1','glm-4.6','glm-4.6',0,'admin')"
    )
    # Same run, same batch size — the legacy batch:{count} key dropped the second one.
    for i, (mid, a, b) in enumerate([("m1", 1000, 200), ("m2", 1500, 300), ("m3", 2000, 100)]):
        _insert_msg(conn, mid, a, b, seq=i + 1)

    result = rebuild_llm_usage_ledger(conn)
    assert result["ok"] and result["events"] == 3

    tokens, events, _amount = _summary_totals(conn)
    assert tokens == 1000 + 200 + 1500 + 300 + 2000 + 100
    assert events == 3

    keys = [r[0] for r in conn.execute("SELECT event_id FROM evoflow_usage_events ORDER BY event_id")]
    assert keys == ["llm:msg:m1", "llm:msg:m2", "llm:msg:m3"]


def test_record_llm_usage_idempotent_on_message_id(tmp_path):
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    kw = dict(
        session_key="sk1",
        run_id="r1",
        message_id="m1",
        model_name="glm-4.6",
        input_tokens=100,
        output_tokens=50,
        total_tokens=150,
    )
    assert record_llm_chat_usage_in_txn(conn, **kw) is True
    # Same message via another path/run must not double count.
    assert record_llm_chat_usage_in_txn(conn, **{**kw, "run_id": "r2"}) is False
    tokens, events, _amount = _summary_totals(conn)
    assert tokens == 150 and events == 1


def test_rebuild_replaces_legacy_events_exactly_once(tmp_path):
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    _insert_msg(conn, "m1", 500, 500, seq=1)
    # Legacy duplicate event for the same message under the old key scheme.
    conn.execute(
        "INSERT INTO evoflow_usage_events (event_id, occurred_at, category, subcategory, unit,"
        " quantity, currency, amount, sku, subject_type, subject_id, meta_json, created_at)"
        " VALUES ('llm:r1:m1','2026-10-24T00:00:00Z','llm','chat','token',1000,'USD',0,'glm-4.6',"
        "'install','','{}','2026-10-24T00:00:00Z')"
    )
    rebuild_llm_usage_ledger(conn)
    tokens, events, _amount = _summary_totals(conn)
    assert tokens == 1000 and events == 1
