"""Media generation rows land in the product usage ledger (Settings → 使用统计)."""

from evoflow.persistence.usage_ledger import (
    CATEGORY_MEDIA,
    record_media_generation_usage_in_txn,
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


def test_image_usage_idempotent_on_task_id():
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    kwargs = dict(
        media_kind="image",
        provider="jimeng",
        model="doubao-seedream-5.0-flash",
        mode="image2image",
        task_id="task_img_1",
        status="succeeded",
        aspect_ratio="1:1",
        reference_count=1,
        prompt="mug product shot",
        occurred_at="2026-10-28T08:00:00Z",
    )
    assert record_media_generation_usage_in_txn(conn, **kwargs) is True
    assert record_media_generation_usage_in_txn(conn, **kwargs) is False  # same task_id

    row = conn.execute(
        "SELECT category, subcategory, unit, quantity, amount, pricing_source, sku FROM evoflow_usage_events"
    ).fetchone()
    assert row[0] == CATEGORY_MEDIA
    assert row[1] == "image"
    assert row[2] == "request"
    assert row[3] == 1
    assert row[4] > 0
    assert row[5] == "estimate:media_rate_card"
    assert row[6] == "doubao-seedream-5.0-flash"

    daily = conn.execute(
        "SELECT event_count, amount_sum FROM evoflow_usage_daily WHERE category='media' AND subcategory='image'"
    ).fetchone()
    assert daily == (1, row[4])


def test_video_usage_scales_with_duration_and_prefers_vendor_cost():
    import sqlite3

    conn = sqlite3.connect(":memory:")
    _schema(conn)
    assert record_media_generation_usage_in_txn(
        conn,
        media_kind="video",
        provider="minimax",
        model="minimax-h3/QY3",
        mode="text2video",
        task_id="oai:task_abc",
        status="succeeded",
        duration_seconds=10,
        vendor_cost=0.88,
        vendor_currency="USD",
        occurred_at="2026-10-28T08:01:00Z",
    )
    row = conn.execute(
        "SELECT amount, pricing_source, quantity_out, subcategory FROM evoflow_usage_events WHERE event_id=?",
        ("media:video:oai:task_abc",),
    ).fetchone()
    assert row[0] == 0.88
    assert row[1] == "vendor"
    assert row[2] == 10
    assert row[3] == "video"
