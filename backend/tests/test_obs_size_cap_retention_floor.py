"""观测库体积上限压缩必须给「保留天数」留硬底线。

【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】

现网实证缺陷：配置 `gateway_requests_days=7`，实际
`evoflow_obs_gateway_requests` 只剩当天 13 小时（235,970 行全在 2026-11-19）。
根因是 `enforce_observability_db_size_cap` 里 `min_gateway_days` 只是
`_ = min_gateway_days  # reserved for future soft-retention tuning` —— 空实现，
删行按等比 ratio 一路删到只剩几千行，把最能说明接口问题的近期历史削光。

本文件钉三条：
1. 底线内的行一条都不能删（即使远超 size cap）；
2. 底线外的行照删（不能因为加了底线就变成「永不删」，那是另一个 bug）；
3. 守住底线后仍超上限时必须 WARNING 点名（不能静默）。

反向验证（必须做）：把 `older_than` 传成 None 恢复旧行为，第 1 条必须变红。
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from evoflow.persistence.data_retention import enforce_observability_db_size_cap

_GW = "evoflow_obs_gateway_requests"
_MODEL = "evoflow_obs_model_invocations"
_TRACE = "evoflow_obs_trace_events"


def _iso(days_ago: float) -> str:
    """与现网同格式：带 +08:00 偏移的 ISO 串（julianday 必须能解析它）。"""
    dt = datetime.now(UTC) - timedelta(days=days_ago)
    return dt.astimezone().isoformat()


def _make_db(path: Path, *, rows_per_day: int = 40, days: int = 10) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute(
            f"""
            CREATE TABLE {_GW} (
                id TEXT, occurred_at TEXT, method TEXT, path TEXT, query_string TEXT,
                client_ip TEXT, user_agent TEXT, request_content_type TEXT,
                response_content_type TEXT, status_code INTEGER, duration_ms REAL,
                request_headers_json TEXT, response_headers_json TEXT,
                request_body_sample TEXT, response_body_sample TEXT,
                request_body_truncated INTEGER, response_body_truncated INTEGER,
                error_type TEXT, metadata_json TEXT
            )
            """
        )
        conn.execute(
            f"""
            CREATE TABLE {_MODEL} (
                id TEXT, requested_at TEXT, request_json TEXT, response_json TEXT
            )
            """
        )
        conn.execute(f"CREATE TABLE {_TRACE} (id TEXT, occurred_at TEXT, payload_json TEXT)")
        for d in range(days):
            for i in range(rows_per_day):
                conn.execute(
                    f"INSERT INTO {_GW} (id, occurred_at, method, path, status_code, duration_ms)"
                    " VALUES (?, ?, 'GET', '/api/x', 200, 1.0)",
                    (f"{d}-{i}", _iso(days_ago=d)),
                )
                conn.execute(
                    f"INSERT INTO {_MODEL} (id, requested_at, request_json, response_json)"
                    " VALUES (?, ?, ?, ?)",
                    (f"m{d}-{i}", _iso(days_ago=d), "x" * 2000, "y" * 2000),
                )
                conn.execute(
                    f"INSERT INTO {_TRACE} (id, occurred_at, payload_json) VALUES (?, ?, ?)",
                    (f"t{d}-{i}", _iso(days_ago=d), "{}"),
                )
        conn.commit()
    finally:
        conn.close()


def _count_all(path: Path, table: str) -> int:
    """全表行数。别用 ``newer_than_days=0`` 代替它 —— 那等于「比此刻更新」= 0 行。"""
    conn = sqlite3.connect(str(path))
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] or 0)
    finally:
        conn.close()


def _count(path: Path, table: str, *, newer_than_days: float) -> int:
    cutoff = datetime.now(UTC) - timedelta(days=newer_than_days)
    conn = sqlite3.connect(str(path))
    try:
        rows = conn.execute(f"SELECT occurred_at FROM {table}").fetchall()
    finally:
        conn.close()
    n = 0
    for (raw,) in rows:
        if not raw:
            continue
        try:
            ts = datetime.fromisoformat(str(raw))
        except ValueError:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        if ts >= cutoff:
            n += 1
    return n


def test_floor_protects_recent_rows_even_when_far_over_cap(tmp_path: Path) -> None:
    """底线 3 天内的行必须全留 —— 这正是「7 天被削成 13 小时」的修复判据。"""
    db = tmp_path / "obs.db"
    _make_db(db)
    before_recent = _count(db, _GW, newer_than_days=2.5)
    assert before_recent > 0, "夹具必须造出底线内的行，否则这条测试什么也没证明"

    stripped, deleted, _vacuumed = enforce_observability_db_size_cap(
        db,
        max_bytes=1,  # 极小的上限：旧实现会把整表删到只剩几千行
        min_gateway_days=3,
        min_model_days=3,
    )
    after_recent = _count(db, _GW, newer_than_days=2.5)
    assert after_recent == before_recent, (
        f"底线内(3天)的行被删了：{before_recent} -> {after_recent}（deleted={deleted}）"
    )


def test_rows_outside_floor_are_still_deleted(tmp_path: Path) -> None:
    """加了底线不能变成「永不删」，否则库会无限长下去。"""
    db = tmp_path / "obs.db"
    _make_db(db)
    total_before = _count_all(db, _GW)
    enforce_observability_db_size_cap(
        db,
        max_bytes=1,
        min_gateway_days=3,
        min_model_days=3,
    )
    total_after = _count_all(db, _GW)
    assert total_after < total_before, "底线外的旧行没有被删，体积上限失效"


def test_warns_when_still_over_cap_after_floor(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """守住底线仍超上限时必须喊出来，不能静默削历史。"""
    db = tmp_path / "obs.db"
    _make_db(db)
    with caplog.at_level(logging.WARNING):
        enforce_observability_db_size_cap(
            db,
            max_bytes=1,
            min_gateway_days=3,
            min_model_days=3,
        )
    assert any("over cap" in r.message for r in caplog.records), (
        "仍超上限却没有 WARNING；运维只会看到「统计没了」查不到原因"
    )


def test_old_behavior_would_delete_recent_rows(tmp_path: Path) -> None:
    """反向验证：去掉底线（older_than=None）旧行为必须删掉近期行。

    这条绿着说明上面那条测试的判据是有效的 —— 若这条也「保留成功」，
    说明测试夹根本没让函数进入删行分支，前面那条等于空转。
    """
    from evoflow.persistence import data_retention as dr

    db = tmp_path / "obs.db"
    _make_db(db)
    before_recent = _count(db, _GW, newer_than_days=2.5)

    orig = dr._delete_oldest_rows

    def _no_floor(conn, table, *, batch, time_col="occurred_at", older_than=None):
        return orig(conn, table, batch=batch, time_col=time_col, older_than=None)

    dr._delete_oldest_rows = _no_floor
    try:
        enforce_observability_db_size_cap(
            db, max_bytes=1, min_gateway_days=3, min_model_days=3
        )
    finally:
        dr._delete_oldest_rows = orig

    after_recent = _count(db, _GW, newer_than_days=2.5)
    assert after_recent < before_recent, (
        "反向验证失败：旧行为本应删掉近期行却没删，说明夹具没触发删行分支"
    )
