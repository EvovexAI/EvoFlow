"""Model call sequence for observability (per thread + run_id)."""

from __future__ import annotations

from evoflow.observability.run_latency_trace import (
    bump_model_call_seq,
    current_model_call_seq,
)


def test_bump_model_call_seq_resets_on_new_run() -> None:
    tid = "thread-seq-test"
    assert bump_model_call_seq(tid, "run-a") == 1
    assert bump_model_call_seq(tid, "run-a") == 2
    assert bump_model_call_seq(tid, "run-a") == 3
    assert bump_model_call_seq(tid, "run-b") == 1
    assert current_model_call_seq() == 1
