"""search_code_index follow-up reads must keep LangGraph stream writer across asyncio.run."""

from evoflow.scheduler.prefetch_stream import emit_prefetch_tool_calls_batch


def test_emit_prefetch_batch_uses_captured_writer(monkeypatch) -> None:
    seen: list[dict] = []

    def fake_writer(payload: dict) -> None:
        seen.append(dict(payload))

    monkeypatch.setattr("evoflow.scheduler.prefetch_stream.capture_stream_writer", lambda: None)
    emit_prefetch_tool_calls_batch(
        [{"tool_call_id": "search-read-0-abc", "path": "/x.py", "index": 1, "total": 1}],
        stream_writer=fake_writer,
    )
    assert len(seen) == 1
    assert seen[0]["type"] == "prefetch_tool_calls_batch"
