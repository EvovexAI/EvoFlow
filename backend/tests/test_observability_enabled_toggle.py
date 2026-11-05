"""UI toggle for observability.enabled (config.yaml surgical patch)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import yaml


def test_set_observability_enabled_writes_yaml(tmp_path: Path, monkeypatch) -> None:
    cfg = tmp_path / "config.yaml"
    cfg.write_text("observability:\n  enabled: false\n", encoding="utf-8")

    from evoflow.config.app_config import AppConfig
    from evoflow.debug import trace_sink

    mem = SimpleNamespace(observability=SimpleNamespace(enabled=False))

    monkeypatch.delenv("EVOFLOW_OBSERVABILITY", raising=False)
    monkeypatch.setattr(AppConfig, "resolve_config_path", classmethod(lambda cls, config_path=None: cfg))
    monkeypatch.setattr("evoflow.config.app_config.get_app_config", lambda: mem)
    monkeypatch.setattr("evoflow.config.app_config.reload_app_config", lambda: mem)

    out = trace_sink.set_observability_enabled(True)
    assert out["ok"] is True
    assert out["enabled"] is True
    assert out["locked_by_env"] is False

    data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert data["observability"]["enabled"] is True
    assert mem.observability.enabled is True


def test_set_observability_enabled_locked_by_env(tmp_path: Path, monkeypatch) -> None:
    cfg = tmp_path / "config.yaml"
    cfg.write_text("observability:\n  enabled: false\n", encoding="utf-8")

    from evoflow.config.app_config import AppConfig
    from evoflow.debug import trace_sink

    monkeypatch.setenv("EVOFLOW_OBSERVABILITY", "0")
    monkeypatch.setattr(AppConfig, "resolve_config_path", classmethod(lambda cls, config_path=None: cfg))

    out = trace_sink.set_observability_enabled(True)
    assert out["ok"] is False
    assert out["locked_by_env"] is True
    assert out["enabled"] is False

    data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
    assert data["observability"]["enabled"] is False
