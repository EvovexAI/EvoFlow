"""Detached poll scheduler must survive beyond caller asyncio.run() loops."""

import time

from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll


def test_schedule_detached_poll_runs_on_background_loop():
    import asyncio

    done = asyncio.Event()

    async def job() -> None:
        await asyncio.sleep(0.05)
        done.set()

    schedule_detached_poll(job(), name="test-detached-poll")

    deadline = time.time() + 3.0
    while time.time() < deadline:
        if done.is_set():
            return
        time.sleep(0.02)
    raise AssertionError("detached poll did not complete on background loop")
