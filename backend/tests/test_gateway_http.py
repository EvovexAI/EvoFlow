"""resolve_gateway_base_url must prefer packaged ports over legacy :8070."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.gateway_http import gateway_port_from_base, resolve_gateway_base_url


@pytest.fixture(autouse=True)
def _clear_url_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "EVOFLOW_GATEWAY_URL",
        "EVOFLOW_GATEWAY_PORT",
        "EVOFLOW_GATEWAY_HOST",
        "EVOFLOW_LANGGRAPH_URL",
        "EVOFLOW_HOME",
        "EVOFLOW_CONFIG_DIR",
        "EVOFLOW_PROFILE",
        "PORT",
    ):
        monkeypatch.delenv(key, raising=False)


def test_gateway_url_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_GATEWAY_URL", "http://127.0.0.1:8382/")
    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8070")
    assert resolve_gateway_base_url() == "http://127.0.0.1:8382"


def test_gateway_port_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8456")
    assert resolve_gateway_base_url() == "http://127.0.0.1:8456"


def test_langgraph_inprocess_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8382/api/langgraph")
    assert resolve_gateway_base_url() == "http://127.0.0.1:8382"


def test_bare_langgraph_does_not_become_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8384")
    assert resolve_gateway_base_url() == "http://127.0.0.1:8070"


def test_backend_runtime_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runtime = tmp_path / "backend-runtime.json"
    runtime.write_text(json.dumps({"port": 8721, "baseUrl": "http://127.0.0.1:8721"}), encoding="utf-8")
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    assert resolve_gateway_base_url() == "http://127.0.0.1:8721"


def test_allow_legacy_default_false(monkeypatch: pytest.MonkeyPatch) -> None:
    assert resolve_gateway_base_url(allow_legacy_default=False) is None


def test_gateway_port_from_base() -> None:
    assert gateway_port_from_base("http://127.0.0.1:8382") == 8382
    assert gateway_port_from_base("http://127.0.0.1:8382/api/langgraph") == 8382
