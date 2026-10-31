"""Split LangGraph runtime must request multi-session job slots (not N_JOBS=1)."""

from __future__ import annotations


def _patch_stdio_side_effects(monkeypatch) -> None:
    # apply_windows_stdio_fixes closes streams and breaks pytest capture on Windows.
    monkeypatch.setattr(
        "evoflow.desktop_stdio.apply_windows_stdio_fixes",
        lambda: None,
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_stream_trace.log_multi_session_runtime_banner",
        lambda **_kwargs: None,
    )


def test_run_server_kwargs_passes_n_jobs_per_worker(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.delenv("N_JOBS_PER_WORKER", raising=False)
    _patch_stdio_side_effects(monkeypatch)

    from evoflow.langgraph_runtime_env import run_server_kwargs

    kwargs = run_server_kwargs()
    assert kwargs.get("n_jobs_per_worker") == 10
    assert kwargs["n_jobs_per_worker"] is not None


def test_run_server_kwargs_honors_env_override(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("N_JOBS_PER_WORKER", "4")
    _patch_stdio_side_effects(monkeypatch)

    from evoflow.langgraph_runtime_env import run_server_kwargs

    kwargs = run_server_kwargs()
    assert kwargs.get("n_jobs_per_worker") == 4


def test_resolve_honors_evopanel_json_when_env_unset(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.delenv("N_JOBS_PER_WORKER", raising=False)
    (tmp_path / "evopanel.json").write_text(
        '{"langgraphMaxConcurrent": 4}',
        encoding="utf-8",
    )
    _patch_stdio_side_effects(monkeypatch)

    from evoflow.langgraph_runtime_env import _resolve_n_jobs_per_worker

    assert _resolve_n_jobs_per_worker() == 4


def test_resolve_env_overrides_evopanel_json(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("N_JOBS_PER_WORKER", "2")
    (tmp_path / "evopanel.json").write_text(
        '{"langgraphMaxConcurrent": 8}',
        encoding="utf-8",
    )
    _patch_stdio_side_effects(monkeypatch)

    from evoflow.langgraph_runtime_env import _resolve_n_jobs_per_worker

    assert _resolve_n_jobs_per_worker() == 2
