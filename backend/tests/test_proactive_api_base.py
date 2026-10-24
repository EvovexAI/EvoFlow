"""resolve_proactive_api_base must prefer Gateway URL over legacy :8070."""

from __future__ import annotations

import pytest

from evoflow.admin.proactive_http import resolve_proactive_api_base


@pytest.fixture(autouse=True)
def _clear_url_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "EVOFLOW_PROACTIVE_URL",
        "EVOFLOW_GATEWAY_URL",
        "EVOFLOW_GATEWAY_PORT",
        "EVOFLOW_GATEWAY_HOST",
        "EVOFLOW_LANGGRAPH_URL",
    ):
        monkeypatch.delenv(key, raising=False)


def test_explicit_proactive_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_PROACTIVE_URL", "http://127.0.0.1:9000/api/proactive/")
    assert resolve_proactive_api_base() == "http://127.0.0.1:9000/api/proactive"


def test_gateway_url_packaged_split(monkeypatch: pytest.MonkeyPatch) -> None:
    """LangGraph tool process has GATEWAY_URL=8382; must not fall back to 8070."""
    monkeypatch.setenv("EVOFLOW_GATEWAY_URL", "http://127.0.0.1:8382")
    assert resolve_proactive_api_base() == "http://127.0.0.1:8382/api/proactive"


def test_gateway_port_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8382")
    assert resolve_proactive_api_base() == "http://127.0.0.1:8382/api/proactive"


def test_langgraph_inprocess_mount(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8382/api/langgraph")
    assert resolve_proactive_api_base() == "http://127.0.0.1:8382/api/proactive"


def test_bare_langgraph_url_does_not_steal_proactive(monkeypatch: pytest.MonkeyPatch) -> None:
    """Split LG on :8384 must not become proactive host when Gateway URL missing."""
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8384")
    assert resolve_proactive_api_base() == "http://127.0.0.1:8070/api/proactive"


def test_gateway_url_beats_bare_langgraph(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_GATEWAY_URL", "http://127.0.0.1:8382")
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8384")
    assert resolve_proactive_api_base() == "http://127.0.0.1:8382/api/proactive"


def test_legacy_default_when_unset() -> None:
    assert resolve_proactive_api_base() == "http://127.0.0.1:8070/api/proactive"
