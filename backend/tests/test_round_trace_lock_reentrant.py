"""RoundTraceMiddleware must not deadlock on nested lock (准备中 hang)."""

from __future__ import annotations

import threading
from unittest.mock import MagicMock

from langchain_core.messages import HumanMessage

from evoflow.agents.middlewares.round_trace_middleware import RoundTraceMiddleware


def test_round_trace_uses_reentrant_lock() -> None:
    assert isinstance(RoundTraceMiddleware._lock, type(threading.RLock()))


def test_log_once_per_user_turn_nested_end_turn_does_not_deadlock() -> None:
    mw = RoundTraceMiddleware()
    # Pretend a previous turn is active so _end_turn_if_active takes the lock.
    fake_turn = object()
    tid = "thread-deadlock-repro"
    RoundTraceMiddleware._turn_traces[tid] = fake_turn
    RoundTraceMiddleware._last_logged_key_by_thread[tid] = "old-key"

    request = MagicMock()
    request.state = {"messages": [HumanMessage(content="hello next turn")]}
    request.tools = []
    request.system_message = None

    # Patch tracer so end_turn is cheap; the bug is lock re-entry before I/O.
    import evoflow.debug.turn_message_trace as tmt

    tracer = MagicMock()
    tracer.end_turn = MagicMock()

    done = threading.Event()
    err: list[BaseException] = []

    def _run() -> None:
        try:
            with _patched_get_tracer(tracer):
                # Directly exercise the nested-lock path.
                mw._log_once_per_user_turn(
                    {
                        "thread_id": tid,
                        "user_key": "text:hello next turn",
                        "user_input": "hello next turn",
                        "activated_scenarios": ["ask"],
                        "request_tool_names": [],
                        "loaded_deferred_tools": [],
                        "model_bound_tools": [],
                        "model_bound_tools_count": 0,
                        "deferred_catalog_tools": [],
                        "deferred_catalog_count": 0,
                        "deferred_not_yet_loaded": [],
                        "deferred_not_yet_loaded_count": 0,
                        "loaded_deferred_count": 0,
                    }
                )
        except BaseException as e:  # noqa: BLE001
            err.append(e)
        finally:
            done.set()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    finished = done.wait(timeout=2.0)
    assert finished, "RoundTraceMiddleware deadlocked on nested Lock"
    assert not err, f"unexpected error: {err}"
    tracer.end_turn.assert_called_once()


class _patched_get_tracer:
    def __init__(self, tracer: MagicMock) -> None:
        self._tracer = tracer
        self._orig = None

    def __enter__(self):
        import evoflow.debug.turn_message_trace as tmt

        self._orig = tmt.get_turn_tracer
        tmt.get_turn_tracer = lambda: self._tracer  # type: ignore[assignment]
        return self

    def __exit__(self, *args):
        import evoflow.debug.turn_message_trace as tmt

        if self._orig is not None:
            tmt.get_turn_tracer = self._orig  # type: ignore[assignment]
