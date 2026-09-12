"""Gateway hang diagnostics helpers."""

from __future__ import annotations

import pytest

pytest.importorskip("app.gateway.hang_diagnostics")
from app.gateway import hang_diagnostics as hd


def test_fatal_listen_socket_context_winerror_64():
    ctx = {"message": "Accept failed on a socket", "exception": OSError(22, "x", None, 64)}
    assert hd._is_fatal_listen_socket_context(ctx) is True


def test_fatal_listen_socket_context_negative():
    assert hd._is_fatal_listen_socket_context({"message": "other", "exception": ValueError("x")}) is False


def test_mark_listen_socket_broken_sets_flag(monkeypatch):
    monkeypatch.setattr(hd, "_listen_socket_broken", False, raising=False)
    monkeypatch.setattr(hd, "_listen_socket_broken_at", None, raising=False)
    monkeypatch.setattr(hd, "dump_gateway_diagnostics", lambda *a, **k: None)
    hd._mark_listen_socket_broken("WinError 64")
    assert hd.is_listen_socket_broken() is True
    assert "64" in (hd.listen_socket_broken_detail() or "")
