"""App-run write-path SSOT emits with reason."""

from __future__ import annotations

from evoflow.collab.app_run_events import emit_app_run_from_main_task


def test_emit_skips_non_app_task(monkeypatch):
    called: list = []
    monkeypatch.setattr(
        "evoflow.collab.app_runner.push_app_run_from_main_task",
        lambda task: called.append(task) or "executing",
    )
    assert emit_app_run_from_main_task({"id": "t1"}, reason="test") == "executing"
    assert called == [{"id": "t1"}]
    assert emit_app_run_from_main_task(None, reason="test") is None


def test_emit_swallows_push_errors(monkeypatch):
    def _boom(_task):
        raise RuntimeError("db down")

    monkeypatch.setattr(
        "evoflow.collab.app_runner.push_app_run_from_main_task",
        _boom,
    )
    assert emit_app_run_from_main_task({"id": "t1", "source_app_id": "A"}, reason="x") is None
