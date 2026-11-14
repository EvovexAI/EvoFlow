"""V4 cold-hydrate priority: user open jumps ahead of prefetch/hover warm."""

from __future__ import annotations

import asyncio

import pytest

from app.gateway.v4.conversation import _HydratePriorityGate


@pytest.mark.asyncio
async def test_interactive_hydrate_jumps_ahead_of_prefetch() -> None:
    gate = _HydratePriorityGate(1)
    order: list[str] = []

    async def worker(name: str, *, high: bool, hold: float = 0.05) -> None:
        await gate.acquire(high_priority=high)
        try:
            order.append(f"start:{name}")
            await asyncio.sleep(hold)
            order.append(f"end:{name}")
        finally:
            gate.release()

    # Prefetch grabs the only slot first; interactive should run next, before
    # a second prefetch that was already waiting.
    t_prefetch1 = asyncio.create_task(worker("prefetch1", high=False, hold=0.08))
    await asyncio.sleep(0.01)
    t_prefetch2 = asyncio.create_task(worker("prefetch2", high=False, hold=0.01))
    await asyncio.sleep(0.01)
    t_open = asyncio.create_task(worker("open", high=True, hold=0.01))
    await asyncio.gather(t_prefetch1, t_prefetch2, t_open)

    # prefetch1 starts first (already active); open must finish before prefetch2 starts.
    assert order[0] == "start:prefetch1"
    open_start = order.index("start:open")
    prefetch2_start = order.index("start:prefetch2")
    assert open_start < prefetch2_start
