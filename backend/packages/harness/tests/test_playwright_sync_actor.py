"""Playwright worker thread init (Windows Selector vs Proactor policy)."""

from __future__ import annotations

import sys

import pytest

from evoflow.tools.builtins.playwright_sync_actor import init_playwright_worker_thread


@pytest.mark.skipif(sys.platform != "win32", reason="Windows event loop policy only")
def test_init_playwright_worker_thread_uses_proactor_after_selector() -> None:
    import asyncio

    policy_before = asyncio.get_event_loop_policy()
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        init_playwright_worker_thread()
        assert isinstance(
            asyncio.get_event_loop_policy(),
            asyncio.WindowsProactorEventLoopPolicy,
        )
    finally:
        asyncio.set_event_loop_policy(policy_before)
