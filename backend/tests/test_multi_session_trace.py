"""Multi-session diagnostic lines land in subtask-stream.trace.log."""

from __future__ import annotations

from pathlib import Path


def test_multi_session_banner_writes_awaitable_fingerprint(tmp_path: Path, monkeypatch) -> None:
    from evoflow.collab import subtask_stream_trace as trace

    log_path = tmp_path / "subtask-stream.trace.log"
    monkeypatch.setenv("EVOFLOW_SUBTASK_STREAM_LOG", str(log_path))
    monkeypatch.setenv("EVOFLOW_SUBTASK_STREAM_TRACE", "1")
    monkeypatch.setenv("EVOFLOW_GATEWAY_PROCESS", "1")
    monkeypatch.setenv("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS", "1")
    monkeypatch.setenv("BG_JOB_ISOLATED_LOOPS", "true")
    monkeypatch.setattr(trace, "_banner_logged", False)

    # Avoid depending on plugin-control path in unit tests.
    monkeypatch.setattr(trace, "_mirror_plugin_control", lambda _msg: None)

    trace.log_multi_session_runtime_banner(source="unit_test")
    text = log_path.read_text(encoding="utf-8")
    assert "[multi-session]" in text
    assert "inject_port=awaitable_v1" in text
    assert "source=unit_test" in text
    assert "BG_JOB_ISOLATED_LOOPS=true" in text

    # Idempotent — second call must not duplicate.
    before = text
    trace.log_multi_session_runtime_banner(source="unit_test_again")
    assert log_path.read_text(encoding="utf-8") == before


def test_multi_session_warn_writes(tmp_path: Path, monkeypatch) -> None:
    from evoflow.collab import subtask_stream_trace as trace

    log_path = tmp_path / "subtask-stream.trace.log"
    monkeypatch.setenv("EVOFLOW_SUBTASK_STREAM_LOG", str(log_path))
    monkeypatch.setenv("EVOFLOW_SUBTASK_STREAM_TRACE", "1")
    monkeypatch.setattr(trace, "_mirror_plugin_control", lambda _msg: None)

    trace.multi_session_warn("inject_port ERROR TypeError thread=%s", "t1", mirror=False)
    text = log_path.read_text(encoding="utf-8")
    assert "WARN" in text
    assert "[multi-session]" in text
    assert "TypeError" in text
    assert "thread=t1" in text
