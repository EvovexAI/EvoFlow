"""Regression tests for the 2026-10 concurrency/deadlock audit fixes.

Each test pins one audit finding so a later refactor cannot silently
reintroduce it:

1. EventQueue resident loop — module-level asyncio.Lock acquired inside
   handlers must keep working across events (the per-event loop rewrite
   silently broke every handler after the first).
2. goal_service start_goal — the concurrency-limit check and the counter
   increment must live in the same ``global_lock`` critical section
   (check-then-act let concurrent starts exceed MAX_CONCURRENT_GOALS).
3. Stream persist flush — batched disk writes must leave the event loop
   (sync write+fsync on the loop stalled the whole gateway during streams).
"""

from __future__ import annotations

import ast
import asyncio
import time
from pathlib import Path

import pytest

from app.gateway.events.event_queue import EventQueue
from app.gateway.streaming import background_worker
from app.gateway.streaming.persistent_writer import PersistentStreamWriter, read_stream_output

_BACKEND = Path(__file__).parent.parent


async def test_event_queue_shared_asyncio_lock_survives_multiple_events():
    """Handlers awaiting a module-level asyncio.Lock must work for every event.

    Regression: _run_async_handler created a fresh event loop per event and
    closed it; the first event bound the shared lock to that dead loop and
    every subsequent event raised "bound to a different event loop", silently
    swallowed by per-handler isolation.
    """
    shared_lock = asyncio.Lock()
    handled: list[int] = []

    async def handler(data: dict) -> None:
        async with shared_lock:
            await asyncio.sleep(0)
            handled.append(data["i"])

    queue = EventQueue(max_size=10)
    queue.subscribe("regression", handler)
    queue.start()
    try:
        for i in range(3):
            assert queue.publish("regression", {"i": i})
        deadline = time.monotonic() + 5
        while len(handled) < 3 and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
    finally:
        queue.stop()

    assert sorted(handled) == [0, 1, 2], "events after the first were dropped (cross-loop lock regression)"


def test_goal_start_reserves_counter_inside_global_lock():
    """The limit check and the counter increment must share the critical section.

    Regression: start_goal only *checked* global_running_count under
    global_lock and incremented later via _acquire_run_slot, so two concurrent
    starts both passed the check at count == limit-1.
    """
    src = (_BACKEND / "app" / "channels" / "services" / "goal_service.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "start_goal")

    with_block = None
    for node in ast.walk(fn):
        if isinstance(node, ast.AsyncWith) and any(
            isinstance(item.context_expr, ast.Name) and item.context_expr.id == "global_lock"
            for item in node.items
        ):
            with_block = node
            break

    assert with_block is not None, "start_goal must keep its `async with global_lock` critical section"

    names_used = {
        n.id
        for n in ast.walk(with_block)
        if isinstance(n, ast.Name)
    }
    assert "global_running_count" in names_used, (
        "global_running_count is not touched inside the global_lock block — "
        "the limit check and the reservation must be atomic again"
    )
    assert any(isinstance(n, ast.AugAssign) and getattr(n.target, "id", "") == "global_running_count"
               for n in ast.walk(with_block)), (
        "global_running_count is read but never incremented inside the critical section"
    )


async def test_persist_flush_leaves_event_loop(tmp_path):
    """Batched persist writes must run off the loop (async flush + thread body).

    Regression: _flush_persist_buffer was a sync function doing up to 50
    write+flush+fsync operations directly on the gateway loop while holding a
    process-wide file lock.
    """
    assert asyncio.iscoroutinefunction(background_worker.StreamBackgroundWorker._flush_persist_buffer), (
        "_flush_persist_buffer must stay async (off-loop flush regression)"
    )
    assert callable(getattr(background_worker.StreamBackgroundWorker, "_write_persist_batch", None)), (
        "thread-side batch writer is missing"
    )

    # Functional: two writers hammered concurrently stay isolated and intact.
    sid_a, sid_b = f"regress-{tmp_path.name}-a", f"regress-{tmp_path.name}-b"
    wa = PersistentStreamWriter(sid_a)
    wb = PersistentStreamWriter(sid_b)
    errors: list[Exception] = []

    def hammer(writer: PersistentStreamWriter, tag: str) -> None:
        for i in range(50):
            try:
                writer({"tag": tag, "i": i})
            except Exception as exc:  # pragma: no cover - surfaced via assert
                errors.append(exc)

    import threading

    threads = [
        threading.Thread(target=hammer, args=(wa, "a1")),
        threading.Thread(target=hammer, args=(wa, "a2")),
        threading.Thread(target=hammer, args=(wb, "b1")),
        threading.Thread(target=hammer, args=(wb, "b2")),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    entries_a = read_stream_output(sid_a)
    entries_b = read_stream_output(sid_b)
    assert len(entries_a) == 100 and all(e["tag"].startswith("a") for e in entries_a)
    assert len(entries_b) == 100 and all(e["tag"].startswith("b") for e in entries_b)
    wa.close()
    wb.close()


@pytest.mark.parametrize(
    ("endpoint", "has_guard"),
    [
        ("get_run_status_endpoint", True),
        ("cancel_run_endpoint", True),
        ("pause_run_endpoint", True),
        ("resume_run_endpoint", True),
        ("recover_run_endpoint", True),
    ],
)
def test_app_run_endpoints_require_run_visible(endpoint: str, has_guard: bool):
    """Every /runs/{run_id} endpoint must call require_run_visible (roadmap P0-1)."""
    src = (_BACKEND / "app" / "gateway" / "routers" / "apps.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == endpoint)
    called = any(
        isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "require_run_visible"
        for n in ast.walk(fn)
    )
    assert called is has_guard, f"{endpoint} lost its require_run_visible guard"
