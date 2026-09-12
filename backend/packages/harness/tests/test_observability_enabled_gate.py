"""Observability SQLite must stay off unless explicitly enabled."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.debug.trace_sink import observability_enabled
from evoflow.observability.queries import observability_status
from evoflow.observability.recorder import get_observability_recorder, reset_observability_store_for_tests
from evoflow.persistence.db import reset_db_for_tests

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def isolated_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        monkeypatch.delenv("EVOFLOW_OBSERVABILITY", raising=False)
        reset_db_for_tests()
        reset_observability_store_for_tests()
        from evoflow.config.app_config import reset_app_config

        reset_app_config()
        yield Path(tmp)
        reset_observability_store_for_tests()
        reset_app_config()
        reset_db_for_tests()
        gc.collect()


def test_default_observability_disabled(isolated_home: Path) -> None:
    del isolated_home
    from evoflow.config.app_config import get_app_config, set_app_config

    base = get_app_config()
    custom = base.model_copy(deep=True)
    custom.observability = custom.observability.model_copy(update={"enabled": False})
    set_app_config(custom)

    assert observability_enabled() is False
    st = observability_status()
    assert st["enabled"] is False

    obs_path = Path(st["sqlite_path"])
    get_observability_recorder().record_trace_event(
        thread_id="t-disabled",
        lane="test",
        occurred_at="2026-08-12T00:00:00+08:00",
        event="noop",
        payload={"k": 1},
    )
    assert not obs_path.is_file()


def test_env_overrides_config_to_enable(isolated_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.config.app_config import get_app_config, set_app_config

    obs_path = isolated_home / "obs-on.db"
    base = get_app_config()
    custom = base.model_copy(deep=True)
    custom.observability = custom.observability.model_copy(
        update={"enabled": False, "sqlite_path": str(obs_path)}
    )
    set_app_config(custom)
    monkeypatch.setenv("EVOFLOW_OBSERVABILITY", "1")

    assert observability_enabled() is True
    get_observability_recorder().record_trace_event(
        thread_id="t-enabled",
        lane="test",
        occurred_at="2026-08-12T00:00:00+08:00",
        event="ok",
        payload={"k": 1},
    )
    assert obs_path.is_file()
