"""Workflow: publish rejects cyclic DAG (422 / validation errors)."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app
from evoflow.eval.scenarios._runtime_contract import runtime_contract_metrics

_APP = "eval_wf_publish_cycle"


def _cyclic_def() -> dict:
    return {
        "name": "环依赖发布拒绝",
        "description": "cycle",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "draft",
        "parameters": [],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "A",
                "assigned_agent": "general-purpose",
                "goal": "A",
                "instruction": "A",
                "depends_on": ["2"],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "B",
                "assigned_agent": "general-purpose",
                "goal": "B",
                "instruction": "B",
                "depends_on": ["1"],
            },
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab.workflow_validator import validate_app_definition
    from evoflow.persistence import app_repositories
    from evoflow.persistence.db import get_db

    get_db()
    doc = _cyclic_def()
    app_repositories.save_app(_APP, doc)
    loaded = app_repositories.load_app(_APP) or doc
    validation = validate_app_definition(loaded)
    valid = bool(validation.get("valid"))
    errors = list(validation.get("errors") or [])

    # Mirror publish gate: invalid defs must not become published
    published = False
    publish_error = ""
    if not valid:
        publish_error = "blocked_by_validation"
    else:
        try:
            loaded["status"] = "published"
            app_repositories.save_app(_APP, loaded)
            published = True
        except Exception as exc:  # noqa: BLE001
            publish_error = str(exc)

    final = app_repositories.load_app(_APP) or {}
    final_status = str(final.get("status") or "")

    assertions = [
        check(
            "validation_invalid",
            valid is False and len(errors) > 0,
            inputs={"app_id": _APP},
            expected="valid=false with errors",
            actual={"valid": valid, "errors": errors[:5]},
            api="validate_app_definition",
        ),
        check(
            "not_published",
            final_status != "published" and not published,
            inputs={"app_id": _APP},
            expected="draft / not published",
            actual={"status": final_status, "publish_error": publish_error},
            api="publish gate",
        ),
    ]
    persist = [expect_app(_APP, name="环依赖发布拒绝")]
    metrics = runtime_contract_metrics(
        extra={
            "eval_pack": "workflow",
            "arch": "wf.define.validate",
            "validation": {"valid": valid, "errors": errors[:8]},
        }
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "save_app cyclic"},
            {"step": 2, "api": "validate_app_definition → reject publish"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
