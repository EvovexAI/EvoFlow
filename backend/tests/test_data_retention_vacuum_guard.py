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
    """网关侧：有活跃流 → 不允许 VACUUM；空 → 允许；探测异常 → fail-open 允许。"""
    import app.gateway.data_retention_runner as runner

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
