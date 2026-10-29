"""Embedding / vector calls land in the product usage ledger (Settings → 使用统计)."""

from evoflow.persistence.usage_ledger import (
    CATEGORY_EMBEDDING,
    SUBCATEGORY_EMBED_INDEX,
    SUBCATEGORY_EMBED_QUERY,
    record_embedding_usage_in_txn,
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
        """
    )


def test_index_embedding_estimates_amount_from_rate_card():
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    assert record_embedding_usage_in_txn(
        conn,
        model="text-embedding-3-small",
        provider="openai",
        purpose="index",
        prompt_tokens=1000,
        input_count=4,
        kb_id="kb_demo",
        occurred_at="2026-10-28T08:00:00Z",
    )
    row = conn.execute(
        "SELECT category, subcategory, unit, quantity, amount, pricing_source, subject_type, subject_id "
        "FROM evoflow_usage_events"
    ).fetchone()
    assert row[0] == CATEGORY_EMBEDDING
    assert row[1] == SUBCATEGORY_EMBED_INDEX
    assert row[2] == "token"
    assert row[3] == 1000
    assert abs(row[4] - (1000 * 0.02 / 1_000_000)) < 1e-12
    assert row[5] == "estimate:embedding_rate_card"
    assert row[6] == "kb"
    assert row[7] == "kb_demo"

    daily = conn.execute(
        "SELECT event_count, quantity_sum FROM evoflow_usage_daily "
        "WHERE category='embedding' AND subcategory='index'"
    ).fetchone()
    assert daily == (1, 1000.0)


def test_query_embedding_and_probe_skipped():
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    assert record_embedding_usage_in_txn(
        conn,
        model="text-embedding-3-large",
        purpose="query",
        prompt_tokens=32,
        input_count=1,
        occurred_at="2026-10-28T08:01:00Z",
    )
    assert (
        record_embedding_usage_in_txn(
            conn,
            model="text-embedding-3-large",
            purpose="probe",
            prompt_tokens=8,
            input_count=1,
            occurred_at="2026-10-28T08:02:00Z",
        )
        is False
    )
    rows = conn.execute(
        "SELECT subcategory, quantity FROM evoflow_usage_events ORDER BY occurred_at"
    ).fetchall()
    assert rows == [(SUBCATEGORY_EMBED_QUERY, 32.0)]


def test_local_embedding_records_volume_with_zero_amount():
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    assert record_embedding_usage_in_txn(
        conn,
        model="BAAI/bge-small-zh-v1.5",
        provider="local",
        purpose="index",
        prompt_tokens=200,
        input_count=2,
        is_local=True,
        occurred_at="2026-10-28T08:03:00Z",
    )
    row = conn.execute(
        "SELECT amount, pricing_source, provider, quantity FROM evoflow_usage_events"
    ).fetchone()
    assert row[0] == 0.0
    assert row[1] == ""
    assert row[2] == "local"
    assert row[3] == 200.0


def test_usage_meter_scope_attributes_purpose():
    from evoflow.knowledge.embedding.usage_meter import (
        current_embedding_purpose,
        embedding_usage_scope,
        note_embedding_call,
    )

    with embedding_usage_scope(purpose="query", kb_id="kb_x"):
        assert current_embedding_purpose() == "query"
    # note_embedding_call with probe purpose must no-op without DB
    with embedding_usage_scope(purpose="probe"):
        assert note_embedding_call(model="x", prompt_tokens=1, texts=["a"]) is False
