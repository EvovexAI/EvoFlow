"""Daily usage pivot for Settings → 使用统计 table."""

from evoflow.persistence.usage_ledger import (
    CATEGORY_EMBEDDING,
    CATEGORY_LLM,
    CATEGORY_MEDIA,
    SUBCATEGORY_CHAT,
    SUBCATEGORY_EMBED_INDEX,
    SUBCATEGORY_IMAGE,
    SUBCATEGORY_VIDEO,
    fetch_usage_daily_breakdown,
    record_embedding_usage_in_txn,
    record_media_generation_usage_in_txn,
    record_usage_event_in_txn,
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


def test_daily_breakdown_pivots_categories(monkeypatch):
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)

    record_usage_event_in_txn(
        conn,
        event_id="llm:1",
        category=CATEGORY_LLM,
        subcategory=SUBCATEGORY_CHAT,
        unit="token",
        quantity=1000,
        quantity_in=800,
        quantity_out=200,
        amount=0.01,
        sku="m1",
        occurred_at="2026-10-28T10:00:00Z",
    )
    record_media_generation_usage_in_txn(
        conn,
        media_kind="image",
        provider="jimeng",
        model="seedream",
        task_id="img1",
        occurred_at="2026-10-28T11:00:00Z",
    )
    record_media_generation_usage_in_txn(
        conn,
        media_kind="video",
        provider="minimax",
        model="h3",
        task_id="vid1",
        duration_seconds=5,
        occurred_at="2026-10-28T12:00:00Z",
    )
    record_embedding_usage_in_txn(
        conn,
        model="text-embedding-3-small",
        purpose="index",
        prompt_tokens=500,
        input_count=2,
        kb_id="kb1",
        occurred_at="2026-10-28T13:00:00Z",
    )

    monkeypatch.setattr(
        "evoflow.persistence.usage_ledger.get_db",
        lambda: conn,
    )
    out = fetch_usage_daily_breakdown(from_day="2026-10-28", to_day="2026-10-28")
    assert out["days"]
    day = out["days"][0]
    assert day["day"] == "2026-10-28"
    assert day["llm_tokens"] == 1000
    assert day["llm_calls"] == 1
    assert day["image_calls"] == 1
    assert day["video_calls"] == 1
    assert day["embed_tokens"] == 500
    assert day["embed_calls"] == 1
    assert day["amount_sum"] > 0
    # subcategory constants referenced so imports stay honest
    assert SUBCATEGORY_EMBED_INDEX == "index"
    assert SUBCATEGORY_IMAGE == "image"
    assert SUBCATEGORY_VIDEO == "video"
    assert CATEGORY_EMBEDDING == "embedding"
    assert CATEGORY_MEDIA == "media"
