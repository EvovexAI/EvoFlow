"""data retention VACUUM 让路闸：活跃流式 run 时跳过 VACUUM。

2026-11-15 01:10 hang dump：启动 900s 后的 retention 对 3.1GB 主库 VACUUM 35s
独占锁库，authz（loop 上同步 get_db）+ live_run_snapshot 写线程全体排队，
事件循环连带 stall。只测决策函数 _maybe_vacuum_sqlite（run_data_retention
中段会摸真实主库，测试绝不整体调用）与网关侧 _vacuum_busy_guard。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.persistence import data_retention as dr


@pytest.fixture()
def vacuum_paths_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """三个假 DB 文件 + stub 路径解析与 _vacuum_paths，返回可 VACUUM 的路径表。"""
    app_db = tmp_path / "evoflow.db"
    obs_db = tmp_path / "observability.db"
    cp_db = tmp_path / "checkpoints.db"
    for p in (app_db, obs_db, cp_db):
        p.write_bytes(b"")
    seen: list[Path] = []

    monkeypatch.setattr(dr, "resolve_evolflow_db_path", lambda: app_db)
    monkeypatch.setattr(dr, "observability_db_path", lambda base: obs_db)
    monkeypatch.setattr(dr, "checkpoints_db_path", lambda base: cp_db)
    monkeypatch.setattr(dr, "_vacuum_paths", lambda paths: seen.extend(paths) or [str(p) for p in paths])
    return [app_db, obs_db, cp_db]


def _cfg(vacuum_sqlite: bool = True) -> dr.DataRetentionConfig:
    cfg = dr.DataRetentionConfig()
    cfg.vacuum_sqlite = vacuum_sqlite
    return cfg


def test_vacuum_skipped_when_guard_busy(vacuum_paths_env: list[Path], monkeypatch: pytest.MonkeyPatch) -> None:
    """guard 返回 False（有活跃 run）→ 不碰任何 DB 文件。"""
    guard_calls = {"n": 0}

    def _busy() -> bool:
        guard_calls["n"] += 1
        return False

    out = dr._maybe_vacuum_sqlite(cfg=_cfg(), base_dir=Path("."), deleted_total=10, vacuum_path_guard=_busy)
    assert out == []
    assert guard_calls["n"] == 1
    assert vacuum_paths_env[0].read_bytes() == b""


def test_vacuum_runs_when_guard_allows(vacuum_paths_env: list[Path]) -> None:
    out = dr._maybe_vacuum_sqlite(cfg=_cfg(), base_dir=Path("."), deleted_total=10, vacuum_path_guard=lambda: True)
    assert len(out) == 3


def test_vacuum_runs_without_guard(vacuum_paths_env: list[Path]) -> None:
    """guard 缺省 = 旧行为。"""
    out = dr._maybe_vacuum_sqlite(cfg=_cfg(), base_dir=Path("."), deleted_total=10)
    assert len(out) == 3


def test_vacuum_skipped_below_min_deleted(vacuum_paths_env: list[Path], monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = _cfg()
    cfg.vacuum_min_deleted_rows = 100
    out = dr._maybe_vacuum_sqlite(cfg=cfg, base_dir=Path("."), deleted_total=10)
    assert out == []


def test_guard_exception_propagates_to_caller(vacuum_paths_env: list[Path]) -> None:
    """guard 抛异常 → 冒泡（run_data_retention 兜进 result.errors，不中断整轮）。"""

    def _boom() -> bool:
        raise RuntimeError("probe failed")

    with pytest.raises(RuntimeError):
        dr._maybe_vacuum_sqlite(cfg=_cfg(), base_dir=Path("."), deleted_total=10, vacuum_path_guard=_boom)


def test_runner_guard_blocks_when_streams_active(monkeypatch: pytest.MonkeyPatch) -> None:
    """网关侧：有活跃流 → 不允许 VACUUM；空 → 允许；探测异常 → fail-open 允许。

    【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    本用例原来只桩 `list_active_stream_proxies`，另两道判据（事件循环 lag /
    inflight REST）读的是**真实进程状态**，于是判据变成「套件跑了多久」：
      `hang_diagnostics._last_loop_beat` 在模块 import 时初始化，单跑该文件
      （~1.8s）lag < 2.0s → 绿；全量跑（231s）lag ≈ 231s ≥ 2.0s → 永远 False，
      断言 `is True` 必红。
    证据：全量 6 failed 里这一条三处断言只有中间那条红（前一条有流、后一条
    fail-open 都成立），且单跑三文件 36 passed。
    修法：把另两道探测也桩成「健康」（lag=0、无 inflight），语义回到本用例
    真正要守的东西——「流注册表为空就该放行」。同文件
    `test_runner_guard_blocks_any_inflight` 早已是这么写的。
    """
    import app.gateway.data_retention_runner as runner

    monkeypatch.setattr(
        "app.gateway.hang_diagnostics.get_event_loop_lag_seconds",
        lambda: 0.0,
    )
    monkeypatch.setattr(
        "app.gateway.hang_diagnostics.snapshot_inflight_requests",
        lambda: {"count": 0, "by_lane": {}, "all": [], "long_waiting": []},
    )
    monkeypatch.setattr(
        "app.gateway.routers.langgraph_proxy.list_active_stream_proxies",
        lambda: [{"thread_id": "t1"}],
    )
    assert runner._vacuum_busy_guard() is False

    monkeypatch.setattr(
        "app.gateway.routers.langgraph_proxy.list_active_stream_proxies",
        lambda: [],
    )
    assert runner._vacuum_busy_guard() is True

    def _raise() -> list:
        raise RuntimeError("registry gone")

    monkeypatch.setattr("app.gateway.routers.langgraph_proxy.list_active_stream_proxies", _raise)
    assert runner._vacuum_busy_guard() is True


def test_runner_guard_env_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    """EVOFLOW_VACUUM_BUSY_GUARD=0 → 回退旧行为（永远允许）。"""
    import app.gateway.data_retention_runner as runner

    monkeypatch.setenv("EVOFLOW_VACUUM_BUSY_GUARD", "0")
    monkeypatch.setattr(
        "app.gateway.routers.langgraph_proxy.list_active_stream_proxies",
        lambda: [{"thread_id": "t1"}],
    )
    assert runner._vacuum_busy_guard() is True


def test_obs_size_cap_retry_seconds_default(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.gateway.data_retention_runner as runner

    monkeypatch.delenv("EVOFLOW_OBS_SIZE_CAP_RETRY_S", raising=False)
    assert runner._obs_size_cap_retry_seconds() == 3600
    monkeypatch.setenv("EVOFLOW_OBS_SIZE_CAP_RETRY_S", "120")
    assert runner._obs_size_cap_retry_seconds() == 300  # floor 300s


def test_runner_guard_blocks_any_inflight(monkeypatch: pytest.MonkeyPatch) -> None:
    """任意 inflight REST（含 proactive）都应让路，不只 chat/langgraph。"""
    import app.gateway.data_retention_runner as runner

    monkeypatch.setattr(
        "app.gateway.routers.langgraph_proxy.list_active_stream_proxies",
        lambda: [],
    )
    monkeypatch.setattr(
        "app.gateway.hang_diagnostics.get_event_loop_lag_seconds",
        lambda: 0.0,
    )
    monkeypatch.setattr(
        "app.gateway.hang_diagnostics.snapshot_inflight_requests",
        lambda: {
            "all": [
                {"path": "/api/proactive/approvals", "method": "GET"},
            ]
        },
    )
    assert runner._vacuum_busy_guard() is False


def test_vacuum_paths_skips_oversized_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """多 GB 库不得在 Gateway 进程内 VACUUM（2026-11-19 15:03 卡机）。"""
    big = tmp_path / "evoflow.db"
    big.write_bytes(b"x" * 1024)
    monkeypatch.setenv("EVOFLOW_VACUUM_MAX_BYTES", "512")
    calls: list[str] = []

    class _FakeConn:
        def execute(self, *_a, **_k):
            calls.append("VACUUM")
            return None

        def close(self) -> None:
            return None

    monkeypatch.setattr(dr.sqlite3, "connect", lambda *_a, **_k: _FakeConn())
    out = dr._vacuum_paths([big])
    assert out == []
    assert calls == []


def test_vacuum_paths_runs_under_size_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    small = tmp_path / "evoflow.db"
    small.write_bytes(b"ok")
    monkeypatch.setenv("EVOFLOW_VACUUM_MAX_BYTES", "1024")
    calls: list[str] = []

    class _FakeConn:
        def execute(self, sql, *_a, **_k):
            calls.append(str(sql))
            return None

        def close(self) -> None:
            return None

    monkeypatch.setattr(dr.sqlite3, "connect", lambda *_a, **_k: _FakeConn())
    out = dr._vacuum_paths([small])
    assert out == [str(small)]
    assert any("VACUUM" in c for c in calls)


def test_observability_rebuild_not_blocked_by_vacuum_max_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """VACUUM INTO must still run for multi-GB obs DBs (in-place VACUUM stays gated).

    2026-11-23 non-dev: freelist ~1GB unreclaimed because rebuild wrongly called
    ``_skip_vacuum_due_to_size`` and returned False while the file was 2.5GB.
    """
    obs = tmp_path / "evoflow_observability.db"
    obs.write_bytes(b"x" * 2048)
    monkeypatch.setenv("EVOFLOW_VACUUM_MAX_BYTES", "512")  # would block in-place VACUUM
    monkeypatch.setattr(dr, "_observability_freelist_bytes", lambda _p: 512 * 1024 * 1024)
    monkeypatch.setattr(
        "evoflow.observability.recorder.reset_observability_store",
        lambda: None,
        raising=False,
    )

    real_calls: list[str] = []

    class _Conn:
        def execute(self, sql, *_a, **_k):
            real_calls.append(str(sql))
            if "VACUUM INTO" in str(sql):
                rebuilt = obs.with_suffix(".db.rebuild")
                rebuilt.write_bytes(b"compacted")
            return None

        def close(self) -> None:
            return None

    monkeypatch.setattr(dr.sqlite3, "connect", lambda *_a, **_k: _Conn())
    ok = dr._vacuum_observability_rebuild(obs)
    assert ok is True
    assert any("VACUUM INTO" in c for c in real_calls)
    assert obs.read_bytes() == b"compacted"
    # In-place VACUUM remains gated for oversized files (rebuild must not share that gate).
    fat = tmp_path / "fat.db"
    fat.write_bytes(b"x" * 2048)
    assert dr._skip_vacuum_due_to_size(fat) is True


def test_size_cap_skips_rebuild_when_busy_guard_blocks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Busy chat/REST must not start VACUUM INTO mid-session."""
    db = tmp_path / "obs.db"
    conn = __import__("sqlite3").connect(str(db))
    conn.execute(
        "CREATE TABLE evoflow_obs_gateway_requests ("
        "id TEXT, occurred_at TEXT, method TEXT, path TEXT, query_string TEXT,"
        "client_ip TEXT, user_agent TEXT, request_content_type TEXT,"
        "response_content_type TEXT, status_code INTEGER, duration_ms REAL,"
        "request_headers_json TEXT, response_headers_json TEXT,"
        "request_body_sample TEXT, response_body_sample TEXT,"
        "request_body_truncated INTEGER, response_body_truncated INTEGER,"
        "error_type TEXT, metadata_json TEXT)"
    )
    conn.execute(
        "CREATE TABLE evoflow_obs_model_invocations ("
        "id TEXT, requested_at TEXT, request_json TEXT, response_json TEXT)"
    )
    conn.execute("CREATE TABLE evoflow_obs_trace_events (id TEXT, occurred_at TEXT, payload_json TEXT)")
    conn.execute(
        "INSERT INTO evoflow_obs_gateway_requests (id, occurred_at, method, path, status_code, duration_ms)"
        " VALUES ('1', '2020-01-01T00:00:00Z', 'GET', '/api/x', 200, 1)"
    )
    conn.commit()
    conn.close()
    # Pad file past freelist reclaim threshold via fake freelist probe.
    monkeypatch.setattr(dr, "_observability_db_bytes", lambda _p: 3 * 1024**3)
    monkeypatch.setattr(dr, "_observability_freelist_bytes", lambda _p: 512 * 1024 * 1024)
    rebuild_calls = {"n": 0}
    monkeypatch.setattr(
        dr,
        "_vacuum_observability_rebuild",
        lambda _p: rebuild_calls.__setitem__("n", rebuild_calls["n"] + 1) or True,
    )
    _stripped, _deleted, vacuumed = dr.enforce_observability_db_size_cap(
        db,
        max_bytes=2 * 1024**3,
        vacuum_path_guard=lambda: False,
    )
    assert vacuumed is False
    assert rebuild_calls["n"] == 0
