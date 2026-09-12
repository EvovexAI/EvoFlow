"""Business scenario eval pack — deterministic, no live LLM."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def eval_home(monkeypatch: pytest.MonkeyPatch):
    tmp = tempfile.mkdtemp(prefix="eval_home_")
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
    import gc
    import shutil

    gc.collect()
    shutil.rmtree(tmp, ignore_errors=True)


def test_no_tautology_assertions_in_scenarios() -> None:
    """Guardrail: forbid check(..., True) / 'no_crash' style fake greens."""
    root = Path(__file__).resolve().parents[1] / "evoflow" / "eval" / "scenarios"
    offenders: list[str] = []
    for path in root.glob("*.py"):
        if path.name.startswith("_"):
            continue
        text = path.read_text(encoding="utf-8")
        if 'check(\n            "no_crash"' in text or 'check(\n            "no_process_spawn"' in text:
            offenders.append(f"{path.name}: banned assertion name")
        if "or True" in text:
            offenders.append(f"{path.name}: 'or True' softens boolean")
        # crude: check( name, True
        import re

        for m in re.finditer(r'check\(\s*["\']([^"\']+)["\']\s*,\s*True\b', text):
            offenders.append(f"{path.name}: check('{m.group(1)}', True)")
    assert not offenders, offenders

    from evoflow.eval.case_spec import CASE_CATALOG, catalog_by_module

    by_mod = catalog_by_module()
    business = [
        "knowledge",
        "agents",
        "employees",
        "skills",
        "mcp",
        "workflow",
        "tasks",
        "items",
        "platform",
        "cross",
    ]
    for m in business:
        need = 2 if m == "agents" else 4
        assert len(by_mod.get(m) or []) >= need, f"{m} needs >={need} designs"
    # every implemented handler entry must have design fields
    for c in CASE_CATALOG:
        d = c.get("design") or {}
        assert d.get("priority") in ("P0", "P1", "P2")
        assert d.get("flow") in ("happy", "alt", "negative", "boundary", "state_machine")
        assert d.get("steps")
        assert d.get("expected")
        assert d.get("preconditions") is not None

    from evoflow.eval.pack_architecture import assert_architecture_coverage

    assert_architecture_coverage()


SCENARIO_HANDLERS = [
    "eval.scenario.cross_module_saga",
    "eval.scenario.cross_module_saga_reject",
    "eval.scenario.cross_module_saga_no_hire",
    "eval.scenario.item_dispatch_link",
    "eval.scenario.item_dispatch_unknown_agent",
    "eval.scenario.employee_lifecycle",
    "eval.scenario.employee_hire_duplicate",
    "eval.scenario.employee_task_runtime_contract",
    "eval.scenario.employee_task_dispatch_ledger",
    "eval.scenario.employee_task_work_item_gate",
    "eval.scenario.employee_task_tool_binding_negative",
    "eval.scenario.employee_task_pause_blocks_dispatch_intent",
    "eval.scenario.employee_task_pause_rejects_wake",
    "eval.scenario.employee_task_busy_mutex",
    "eval.scenario.employee_task_already_done_skip",
    "eval.scenario.employee_task_org_collab_gate",
    "eval.scenario.approval_ledger",
    "eval.scenario.workflow_dag_validate",
    "eval.scenario.workflow_rollup_stub",
    "eval.scenario.workflow_task_step_binding",
    "eval.scenario.workflow_task_official_outcome_rollup",
    "eval.scenario.workflow_task_step_fail_halts",
    "eval.scenario.workflow_task_inherit_agent_tools",
    "eval.scenario.workflow_task_param_render",
    "eval.scenario.workflow_task_cancel_run",
    "eval.scenario.workflow_publish_rejects_cycle",
    "eval.scenario.workflow_task_retry_unblocks_downstream",
    "eval.scenario.plan_guard_phase",
    "eval.scenario.exec_authorize_gate",
    "eval.scenario.platform_confirm_preview",
    "eval.scenario.knowledge_fs_search",
    "eval.scenario.knowledge_recall_negative",
    "eval.scenario.mcp_binding_boundary",
    "eval.scenario.task_inbox_transitions",
    "eval.scenario.skills_bind_unknown",
    "eval.scenario.module_knowledge",
    "eval.scenario.module_agents",
    "eval.scenario.module_skills",
    "eval.scenario.module_mcp",
    "eval.scenario.module_workflow",
    "eval.scenario.module_tasks",
    "eval.scenario.module_items",
    "eval.scenario.module_knowledge_detail",
    "eval.scenario.module_agents_detail",
    "eval.scenario.module_skills_detail",
    "eval.scenario.module_mcp_detail",
    "eval.scenario.module_workflow_detail",
    "eval.scenario.module_tasks_detail",
    "eval.scenario.module_items_detail",
]


@pytest.mark.parametrize("handler", SCENARIO_HANDLERS)
def test_each_scenario_passes(eval_home: Path, handler: str) -> None:
    del eval_home
    from evoflow.eval.scenarios import HANDLER_MAP

    assert handler in HANDLER_MAP
    result = HANDLER_MAP[handler]()
    assert result.get("status") == "passed", result.get("detail") or result
    assert result.get("ok") is True
    assert float(result.get("score") or 0) >= 60
    metrics = result.get("metrics") or {}
    persist_n = int(metrics.get("persist_assertion_total") or 0)
    assert persist_n >= 1, f"{handler} missing durable reconcile: {result.get('detail')}"
    planes = {
        a.get("plane")
        for a in (result.get("assertions") or [])
        if a.get("plane") in ("sqlite", "json_store")
    }
    assert planes, f"{handler} has no plane=sqlite|json_store assertions"
    if "employee_task_" in handler or "workflow_task_" in handler or handler.endswith(
        "workflow_rollup_stub"
    ):
        rc = metrics.get("runtime_contract") or {}
        assert metrics.get("eval_scope") == "config_and_official_outcome" or rc, (
            f"{handler} missing runtime_contract metrics"
        )


def test_smoke_run_p0_only(eval_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    del eval_home
    # Smoke must use subprocess isolation — inline shares process state / asyncio / workers.
    monkeypatch.delenv("EVOFLOW_EVAL_INLINE", raising=False)
    from evoflow.eval import eval_engine as engine
    from evoflow.eval.case_spec import is_smoke_case

    cases = engine.list_eval_cases(category="scenario")
    assert cases["total"] >= 30, cases

    result = engine.run_eval(
        name="pytest smoke",
        type="smoke",
        config={"mode": "smoke", "days": 7},
        async_mode=False,
    )
    assert result.get("run_id")
    assert result.get("status") in ("completed", "completed_with_failures")
    scenario_results = [r for r in result.get("results") or [] if r.get("category") == "scenario"]
    assert scenario_results, result
    failed_scenarios = [r for r in scenario_results if r.get("status") != "passed"]
    assert not failed_scenarios, failed_scenarios
    # every scenario in smoke must be P0-eligible
    for r in scenario_results:
        row = {
            "id": r.get("case_id") or r.get("id"),
            "level": r.get("level"),
            "params": r.get("params") or {},
            "priority": r.get("priority"),
        }
        # enrich from DB case list
        match = next((c for c in cases["cases"] if c["id"] == row["id"]), None)
        if match:
            assert is_smoke_case(match), match["id"]
    assert any(
        (r.get("case_id") or r.get("id")) == "sc_cross_module_saga" for r in scenario_results
    )


LIVE_LLM_HANDLERS = [
    "eval.scenario.employee_task_live_wake",
    "eval.scenario.workflow_task_live_run",
]


@pytest.mark.live_llm
@pytest.mark.parametrize("handler", LIVE_LLM_HANDLERS)
def test_live_llm_scenarios(handler: str) -> None:
    """Opt-in: requires EVOFLOW_EVAL_LIVE_LLM=1 and a healthy Gateway + model.

    Without the gate, handlers must return status=skipped (never inject outcomes).
    """
    from evoflow.eval.scenarios import HANDLER_MAP
    from evoflow.eval.scenarios._live_gateway import live_llm_enabled, require_live_llm

    assert handler in HANDLER_MAP
    result = HANDLER_MAP[handler]()
    status = str(result.get("status") or "")
    metrics = result.get("metrics") or {}
    if not live_llm_enabled() or not require_live_llm().ok:
        assert status == "skipped", result.get("detail") or result
        assert metrics.get("eval_scope") == "live_llm"
        return
    assert status == "passed", result.get("detail") or result
    assert result.get("ok") is True
    assert metrics.get("eval_scope") == "live_llm"
    assert metrics.get("runner") == "gateway_http"
    assert (result.get("provenance") or {}).get("mock") is False
    planes = {
        a.get("plane")
        for a in (result.get("assertions") or [])
        if a.get("plane") in ("sqlite", "json_store", "api")
    }
    assert planes, f"{handler} missing durable/api reconcile"


def test_live_llm_skips_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EVOFLOW_EVAL_LIVE_LLM", raising=False)
    from evoflow.eval.scenarios.employee_task_live_wake import run

    result = run()
    assert result.get("status") == "skipped"
    assert "EVOFLOW_EVAL_LIVE_LLM" in str(result.get("detail") or "")
