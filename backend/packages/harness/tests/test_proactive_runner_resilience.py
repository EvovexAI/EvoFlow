"""Proactive runner resilience against gateway overload / LangGraph connect errors."""

from __future__ import annotations

import sys
from types import ModuleType

import pytest

from evoflow.proactive.runner import ProactiveRunner


def _install_fake_hang_diag(monkeypatch, *, lag: float, socket_broken: bool) -> None:
    diag = ModuleType("app.gateway.hang_diagnostics")
    diag.get_event_loop_lag_seconds = lambda: lag
    diag.is_listen_socket_broken = lambda: socket_broken
    for name in ("app", "app.gateway"):
        if name not in sys.modules:
            sys.modules[name] = ModuleType(name)
    monkeypatch.setitem(sys.modules, "app.gateway.hang_diagnostics", diag)


def test_gateway_dispatch_overloaded_when_lag_high(monkeypatch):
    runner = ProactiveRunner()
    _install_fake_hang_diag(monkeypatch, lag=12.5, socket_broken=False)
    overloaded, lag = runner._gateway_dispatch_overloaded()
    assert overloaded is True
    assert lag == 12.5


def test_gateway_dispatch_overloaded_when_listen_socket_broken(monkeypatch):
    runner = ProactiveRunner()
    _install_fake_hang_diag(monkeypatch, lag=0.2, socket_broken=True)
    overloaded, _lag = runner._gateway_dispatch_overloaded()
    assert overloaded is True


@pytest.mark.asyncio
async def test_reschedule_after_langgraph_connect_failure(monkeypatch):
    runner = ProactiveRunner()
    updates: list[tuple[str, str]] = []

    class _Role:
        agent_code = "product-manager"

    class _Repo:
        @staticmethod
        def update_heartbeat(code, *, last_heartbeat_at, next_heartbeat_at):
            updates.append((code, next_heartbeat_at))

    monkeypatch.setattr(
        "evoflow.proactive.runner.ProactiveRepository.update_heartbeat",
        _Repo.update_heartbeat,
    )
    retry_at = await runner._reschedule_after_langgraph_connect_failure(_Role())
    assert updates == [("product-manager", retry_at)]
    assert retry_at.endswith("Z")
