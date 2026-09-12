"""Eval engine mode filtering + isolation does not wipe production case registry."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def eval_home(monkeypatch: pytest.MonkeyPatch):
    import gc
    import shutil

    tmp = tempfile.mkdtemp(prefix="eval_modes_")
    root = Path(tmp)
    db_path = root / "data" / "app" / "evoflow.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_HOME", str(root))
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
    try:
        from evoflow.config.app_config import reset_app_config

        reset_app_config()
    except Exception:
        pass
    try:
        from evoflow.config.paths import reset_paths_cache

        reset_paths_cache()
    except Exception:
        pass
    reset_db_for_tests()
    get_db()
    yield root
    reset_db_for_tests()
    gc.collect()
    shutil.rmtree(tmp, ignore_errors=True)


def test_select_modes(eval_home: Path) -> None:
    del eval_home
    from evoflow.eval.eval_engine import _select_cases_for_mode, list_eval_cases

    all_cases = list_eval_cases()["cases"]
    assert any(c["category"] == "scenario" for c in all_cases)

    scenario = _select_cases_for_mode("scenario", None, all_cases)
    assert scenario and all(c["category"] == "scenario" for c in scenario)

    smoke = _select_cases_for_mode("smoke", None, all_cases)
    assert any(c["category"] == "scenario" for c in smoke)
    assert any(c["category"] == "security" for c in smoke)

    obs = _select_cases_for_mode("observational", None, all_cases)
    assert all(c["category"] != "scenario" for c in obs)

    full = _select_cases_for_mode("full", None, all_cases)
    assert len(full) == len(all_cases)


def test_scenario_isolation_preserves_prod_cases(eval_home: Path) -> None:
    """Running a scenario must leave production eval_cases intact."""
    del eval_home
    from evoflow.eval import eval_engine as engine
    from evoflow.eval.scenarios import items_link

    before = engine.list_eval_cases()["total"]
    result = items_link.run()
    assert result.get("status") == "passed", result
    after = engine.list_eval_cases()["total"]
    assert after == before
    # Production DB still writable for runs
    runs = engine.list_eval_runs(limit=1)
    assert "_table_missing" not in runs or runs.get("_table_missing") is False


def test_async_run_completes(eval_home: Path) -> None:
    """Async observational run (no scenario isolation) completes and is queryable."""
    del eval_home
    import time

    from evoflow.eval import eval_engine as engine

    started = engine.run_eval(
        name="async observational",
        type="observational",
        config={"mode": "observational", "days": 7},
        async_mode=True,
    )
    assert started.get("async") is True
    run_id = started["run_id"]
    assert run_id
    # Row must exist immediately (inserted before background thread).
    assert engine.get_eval_run(run_id).get("run") is not None
    for _ in range(120):
        prog = engine.get_eval_progress(run_id)
        if prog.get("status") not in ("running", "queued"):
            break
        time.sleep(0.25)
    detail = engine.get_eval_run(run_id)
    assert detail.get("run")
    assert detail["run"]["status"] in ("completed", "completed_with_failures", "error")
