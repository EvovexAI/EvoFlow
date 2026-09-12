"""Tests for Windows LangGraph asyncio / httpx mitigations."""

from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.platform.asyncio_windows import (
    apply_windows_langgraph_runtime_fixes,
    claude_session_subprocess_supported,
    install_asyncio_benign_disconnect_handler,
    is_benign_asyncio_shutdown_error,
    is_benign_client_disconnect_error,
    is_event_loop_closed_runtime_error,
    is_subprocess_spawn_runtime_error,
)


def test_is_event_loop_closed_runtime_error() -> None:
    assert is_event_loop_closed_runtime_error(RuntimeError("Event loop is closed"))
    assert is_event_loop_closed_runtime_error(RuntimeError("bound to a different event loop"))
    assert not is_event_loop_closed_runtime_error(RuntimeError("other"))


def test_is_benign_client_disconnect_error() -> None:
    assert is_benign_client_disconnect_error(ConnectionResetError(10054, "forcibly closed"))
    assert is_benign_client_disconnect_error(BrokenPipeError())
    assert is_benign_client_disconnect_error(ConnectionAbortedError())
    assert not is_benign_client_disconnect_error(RuntimeError("boom"))
    assert not is_benign_client_disconnect_error(None)
    os_err = OSError()
    os_err.winerror = 10054  # type: ignore[attr-defined]
    assert is_benign_client_disconnect_error(os_err)
    aborted = OSError()
    aborted.winerror = 995  # type: ignore[attr-defined]
    assert is_benign_client_disconnect_error(aborted)


def test_is_benign_asyncio_shutdown_error() -> None:
    assert is_benign_asyncio_shutdown_error(asyncio.InvalidStateError("invalid state"))
    inner = OSError()
    inner.winerror = 995  # type: ignore[attr-defined]
    outer = ConnectionResetError()
    outer.__cause__ = inner
    assert is_benign_asyncio_shutdown_error(outer)
    assert not is_benign_asyncio_shutdown_error(ValueError("boom"))


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_install_asyncio_benign_disconnect_handler_swallows_reset() -> None:
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        forwarded: list[BaseException] = []

        def _previous(_loop: asyncio.AbstractEventLoop, context: dict) -> None:
            exc = context.get("exception")
            if isinstance(exc, BaseException):
                forwarded.append(exc)

        loop.set_exception_handler(_previous)
        assert install_asyncio_benign_disconnect_handler(loop) is True
        handler = loop.get_exception_handler()
        assert handler is not None
        handler(loop, {"exception": ConnectionResetError(10054, "closed"), "message": "connection_lost"})
        assert forwarded == []
        handler(loop, {"exception": ValueError("real"), "message": "other"})
        assert len(forwarded) == 1
        assert isinstance(forwarded[0], ValueError)
        assert install_asyncio_benign_disconnect_handler(loop) is False
    finally:
        loop.close()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only runtime fixes")
def test_forces_bg_job_isolated_loops_off_when_env_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BG_JOB_ISOLATED_LOOPS", "true")
    monkeypatch.delenv("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS", raising=False)
    apply_windows_langgraph_runtime_fixes()
    assert os.environ.get("BG_JOB_ISOLATED_LOOPS") == "false"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only runtime fixes")
def test_respects_force_bg_job_isolated_loops(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BG_JOB_ISOLATED_LOOPS", "true")
    monkeypatch.setenv("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS", "1")
    apply_windows_langgraph_runtime_fixes()
    assert os.environ.get("BG_JOB_ISOLATED_LOOPS") == "true"


def test_is_subprocess_spawn_runtime_error() -> None:
    assert is_subprocess_spawn_runtime_error(NotImplementedError())
    try:
        raise RuntimeError("wrap") from NotImplementedError()
    except RuntimeError as exc:
        assert is_subprocess_spawn_runtime_error(exc)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_claude_session_subprocess_unsupported_on_selector_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    monkeypatch.setenv("EVOFLOW_WIN_SELECTOR_EVENT_LOOP", "1")
    apply_windows_langgraph_runtime_fixes()
    assert type(asyncio.get_event_loop_policy()).__name__ == "WindowsSelectorEventLoopPolicy"
    assert claude_session_subprocess_supported() is False


def test_httpx_aclose_patch_swallows_closed_loop() -> None:
    import asyncio

    pytest.importorskip("httpx")
    from evoflow.platform import asyncio_windows as aw

    aw._patch_httpx_response_aclose()
    import httpx

    assert getattr(httpx.Response, "_evoflow_aclose_patched", False)

    async def _run() -> None:
        resp = httpx.Response(200, request=httpx.Request("GET", "https://example.com"))
        mock_stream = AsyncMock()
        mock_stream.aclose = AsyncMock(side_effect=RuntimeError("Event loop is closed"))
        resp.stream = mock_stream
        resp.is_closed = False

        with patch("httpx._models.AsyncByteStream", type(mock_stream)):
            await resp.aclose()

        mock_stream.aclose.assert_awaited_once()

    asyncio.run(_run())
