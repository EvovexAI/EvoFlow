"""Tests for LangGraph deployment mode detection."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _clear_langgraph_env(monkeypatch: pytest.MonkeyPatch):
    for key in (
        "EVOFLOW_LANGGRAPH_EXTERNAL",
        "EVOFLOW_LANGGRAPH_URL",
        "EVOFLOW_GATEWAY_URL",
        "EVOFLOW_GATEWAY_PORT",
        "EVOFLOW_GATEWAY_HOST",
        "PORT",
    ):
        monkeypatch.delenv(key, raising=False)


def test_external_mode_explicit_flag(monkeypatch: pytest.MonkeyPatch):
    from evoflow.langgraph_deployment import is_external_langgraph_mode

    monkeypatch.setenv("EVOFLOW_LANGGRAPH_EXTERNAL", "1")
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8012/api/langgraph")
    assert is_external_langgraph_mode() is True


def test_inprocess_when_url_matches_gateway_port(monkeypatch: pytest.MonkeyPatch):
    from evoflow.langgraph_deployment import is_external_langgraph_mode

    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8012")
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8012/api/langgraph")
    assert is_external_langgraph_mode() is False


def test_external_when_url_points_to_different_port(monkeypatch: pytest.MonkeyPatch):
    from evoflow.langgraph_deployment import is_external_langgraph_mode

    monkeypatch.setenv("EVOFLOW_GATEWAY_PORT", "8012")
    monkeypatch.setenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:2024/api/langgraph")
    assert is_external_langgraph_mode() is True
