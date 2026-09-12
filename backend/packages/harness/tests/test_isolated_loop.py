"""Tests for isolated event-loop runner."""

from __future__ import annotations

import asyncio

from evoflow.platform.isolated_loop import run_coroutine_on_fresh_loop


def test_run_coroutine_on_fresh_loop_executes_and_tears_down() -> None:
    seen_loop: asyncio.AbstractEventLoop | None = None

    async def _job() -> int:
        nonlocal seen_loop
        seen_loop = asyncio.get_running_loop()
        return 42

    assert run_coroutine_on_fresh_loop(_job()) == 42
    assert seen_loop is not None
    assert seen_loop.is_closed()

    async def _fail_if_closed() -> None:
        loop = asyncio.get_running_loop()
        assert not loop.is_closed()

    run_coroutine_on_fresh_loop(_fail_if_closed())
