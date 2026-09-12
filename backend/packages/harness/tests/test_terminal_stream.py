"""Terminal SSE custom event helpers."""

from __future__ import annotations

from evoflow.tools.host_direct.terminal_stream import (
    emit_terminal_exit,
    emit_terminal_start,
    emit_terminal_stdout,
)


def test_emit_terminal_events_call_writer() -> None:
    emitted: list[dict] = []

    def writer(payload: dict) -> None:
        emitted.append(payload)

    emit_terminal_start(tool_call_id="tc-1", command="echo hi", stream_writer=writer)
    emit_terminal_stdout(tool_call_id="tc-1", text="hi\n", stream_writer=writer)
    emit_terminal_exit(tool_call_id="tc-1", exit_code=0, stream_writer=writer)

    assert emitted[0]["type"] == "terminal_start"
    assert emitted[0]["tool_call_id"] == "tc-1"
    assert emitted[1]["type"] == "terminal_stdout"
    assert emitted[2]["type"] == "terminal_exit"
    assert emitted[2]["success"] is True
