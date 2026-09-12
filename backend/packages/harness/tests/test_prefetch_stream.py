"""Prefetch custom stream events."""

from evoflow.scheduler.prefetch_stream import (
    emit_prefetch_tool_call,
    emit_prefetch_tool_result,
    emit_worker_file_completed,
    prefetch_tool_call_id,
)


def test_prefetch_tool_call_id_stable():
    a = prefetch_tool_call_id("/tmp/foo.py", 0)
    b = prefetch_tool_call_id("/tmp/foo.py", 0)
    assert a == b
    assert a.startswith("prefetch-read-")


def test_emit_prefetch_events(monkeypatch):
    seen: list[dict] = []

    def fake_writer(payload):
        seen.append(dict(payload))

    monkeypatch.setattr(
        "langgraph.config.get_stream_writer",
        lambda: fake_writer,
    )
    emit_prefetch_tool_call(tool_call_id="tc1", path="/x.py", index=1, total=2)
    emit_prefetch_tool_result(
        tool_call_id="tc1",
        path="/x.py",
        ok=True,
        output_preview="hello",
        index=1,
        total=2,
    )
    assert len(seen) == 2
    assert seen[0]["type"] == "prefetch_tool_call"
    assert seen[1]["type"] == "prefetch_tool_result"


def test_emit_worker_file_completed_omits_full_file_bodies(monkeypatch):
    seen: list[dict] = []

    def fake_writer(payload):
        seen.append(dict(payload))

    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: fake_writer)
    big = "x" * 50_000
    emit_worker_file_completed(
        parent_tool_call_id="parent-1",
        tool_call_id="worker-0-abc",
        path="skills/foo/SKILL.md",
        ok=True,
        output_preview="**完成事项摘要：** long narrative…",
        index=0,
        total=2,
        tool_name="replace",
        action="replace",
        old_string="EvoPanel",
        new_string="EvoFlow",
        before_content=big,
        after_content=big,
    )
    assert len(seen) == 1
    payload = seen[0]
    assert payload["type"] == "worker_file_completed"
    assert payload["output_preview"] == ""
    assert "before_content" not in payload
    assert "after_content" not in payload
    assert payload["old_string"] == "EvoPanel"
    assert payload["new_string"] == "EvoFlow"
