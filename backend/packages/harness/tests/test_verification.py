"""System verification rounds: reuse roundId + step evidence."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from evoflow.admin.platform_actions import (
    dispatch_platform_action,
    reset_registry_cache,
)
from evoflow.admin import verification as ver
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        reset_registry_cache()
        try:
            from evoflow.config.paths import reset_paths_cache

            reset_paths_cache()
        except Exception:
            pass
        yield Path(tmp)
        reset_registry_cache()
        reset_db_for_tests()
        try:
            from evoflow.config.paths import reset_paths_cache

            reset_paths_cache()
        except Exception:
            pass


def test_verification_round_reuse_and_steps(sqlite_tmp: Path) -> None:
    started = ver.start_round(
        title="内容运营全流程",
        scenario="items→workflow→knowledge→experience→automation",
    )
    assert started["success"] is True
    assert started["reused"] is False
    rid = started["round"]["roundId"]
    assert rid.startswith("svr_")

    reused = ver.start_round(round_id=rid, title="ignored")
    assert reused["reused"] is True
    assert reused["round"]["roundId"] == rid

    step1 = ver.record_step(
        round_id=rid,
        feature="items",
        api="items.create",
        status="passed",
        request={"title": "制作 AI 工具效率提升短视频"},
        response={"ok": True, "itemId": "item_demo"},
        result="status=todo",
        duration_ms=42,
    )
    assert step1["step"]["seq"] == 1
    assert step1["round"]["status"] == "running"
    assert step1["stats"]["total"] == 1

    ver.record_step(
        round_id=rid,
        feature="workflow",
        api="workflow.run",
        status="failed",
        request={"appId": "content_ops_short_video_demo"},
        response={"ok": False},
        exception="timeout waiting for run",
        duration_ms=1200,
    )

    concluded = ver.conclude_round(
        round_id=rid,
        conclusion="工作流超时；事项创建正常。",
    )
    assert concluded["round"]["status"] == "completed_with_failures"
    assert concluded["round"]["progress"] == 100
    assert concluded["round"]["conclusion"]
    assert isinstance(concluded["round"]["exceptions"], list)
    assert len(concluded["round"]["exceptions"]) >= 1

    got = ver.get_round(rid)
    assert len(got["steps"]) == 2
    assert got["steps"][0]["api"] == "items.create"
    assert got["steps"][0]["request"]["title"]
    assert got["steps"][1]["durationMs"] == 1200

    listed = ver.list_rounds(status="completed_with_failures")
    assert any(r["roundId"] == rid for r in listed["rounds"])

    deleted = ver.delete_round(rid)
    assert deleted["deleted"] is True
    with pytest.raises(Exception):
        ver.get_round(rid)


def test_verification_step_upsert_overwrites_failed(sqlite_tmp: Path) -> None:
    started = ver.start_round(title="upsert-repair", seed=True, domains=["diagnostics"])
    rid = started["round"]["roundId"]
    assert started["seeded"]["added"] >= 1

    failed = ver.record_step(
        round_id=rid,
        api="diagnostics.scan",
        status="failed",
        exception="boom",
        result="fail",
    )
    assert failed["updated"] is True
    assert failed["step"]["status"] == "failed"
    n1 = len(ver.get_round(rid)["steps"])

    fixed = ver.record_step(
        round_id=rid,
        api="diagnostics.scan",
        status="passed",
        response={"ok": True},
        result="repaired",
        duration_ms=9,
    )
    assert fixed["updated"] is True
    assert fixed["step"]["status"] == "passed"
    steps = ver.get_round(rid)["steps"]
    scan_rows = [s for s in steps if s["api"] == "diagnostics.scan"]
    assert len(scan_rows) == 1
    assert scan_rows[0]["result"] == "repaired"
    assert len(steps) == n1  # no duplicate rows after repair


def test_verification_catalog_and_init_seed(sqlite_tmp: Path) -> None:
    catalog = ver.list_api_catalog(domain="items")
    assert catalog["total"] >= 5
    assert all(i["feature"] == "items" for i in catalog["items"])
    assert catalog["domains"][0]["title"]

    full = ver.list_api_catalog()
    assert full["total"] >= 40
    assert not any(i["feature"] == "verification" for i in full["items"])

    started = ver.start_round(
        title="全平台接口验证",
        scenario="platform-api-inventory",
        seed=True,
        domains=["items", "experience"],
    )
    assert started["round"]["status"] == "queued"
    assert started["round"]["statusLabel"] == "待开始"
    assert started["seeded"]["added"] >= 8
    assert all(s["status"] == "pending" for s in started["steps"])
    assert all(s["result"] == "待开始" for s in started["steps"])
    rid = started["round"]["roundId"]

    # Re-init should skip existing apis
    again = ver.seed_pending_steps(round_id=rid, domains=["items", "experience"])
    assert again["added"] == 0
    assert again["skippedExisting"] >= 8

    # Executing a seeded api upserts the pending row
    before_count = len(ver.get_round(rid)["steps"])
    updated = ver.record_step(
        round_id=rid,
        api="items.create",
        status="passed",
        request={"title": "t"},
        response={"ok": True},
        duration_ms=10,
    )
    assert updated["updated"] is True
    assert updated["round"]["status"] == "running"
    assert len(ver.get_round(rid)["steps"]) == before_count
    step = next(s for s in ver.get_round(rid)["steps"] if s["api"] == "items.create")
    assert step["status"] == "passed"
    assert step["statusLabel"] == "通过"


def test_verification_platform_actions(sqlite_tmp: Path) -> None:
    preview = dispatch_platform_action(
        "verification.start",
        args_json=json.dumps({"title": "平台验证"}),
        confirm=False,
    )
    assert preview.get("pending_confirm") is True

    catalog = dispatch_platform_action(
        "verification.catalog",
        args_json=json.dumps({"domain": "diagnostics"}),
        confirm=False,
    )
    assert catalog.get("ok") is True
    assert catalog["total"] >= 3

    started = dispatch_platform_action(
        "verification.init",
        args_json=json.dumps(
            {
                "title": "平台验证",
                "domains": ["diagnostics"],
                "confirm": True,
            }
        ),
        confirm=True,
    )
    assert started.get("ok") is True
    rid = started["round"]["roundId"]
    assert started["seeded"]["added"] >= 3
    assert started["round"]["statusLabel"] == "待开始"

    step = dispatch_platform_action(
        "verification.step",
        args_json=json.dumps(
            {
                "roundId": rid,
                "api": "diagnostics.scan",
                "feature": "diagnostics",
                "status": "passed",
                "request": {"hours": 24},
                "response": {"ok": True, "count": 0},
                "durationMs": 15,
                "confirm": True,
            }
        ),
        confirm=True,
    )
    assert step.get("ok") is True
    assert step["updated"] is True
    assert step["step"]["api"] == "diagnostics.scan"

    got = dispatch_platform_action(
        "verification.get",
        args_json=json.dumps({"roundId": rid}),
        confirm=False,
    )
    assert got.get("ok") is True
    assert got["round"]["roundId"] == rid
    assert len(got["steps"]) >= 3

    done = dispatch_platform_action(
        "verification.conclude",
        args_json=json.dumps(
            {
                "roundId": rid,
                "conclusion": "冒烟通过",
                "confirm": True,
            }
        ),
        confirm=True,
    )
    assert done.get("ok") is True
    # seeded diagnostics still have pending steps → incomplete
    assert done["round"]["status"] == "completed_with_failures"


def test_workflow_get_steps_preview_and_run_status_trail(sqlite_tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.admin import apps as apps_admin
    from evoflow.admin import platform_handlers as ph
    from evoflow.persistence import app_repositories

    app_repositories.save_app(
        "app_verify_preview",
        {
            "id": "app_verify_preview",
            "name": "verify-preview",
            "description": "d",
            "goal_template": "根据主题产出短视频脚本并验收关键词",
            "steps": [
                {
                    "ref": "s1",
                    "name": "选题",
                    "goal": "列出3个可拍选题",
                    "assigned_agent": "main",
                }
            ],
            "parameters": [],
            "tags": [],
        },
    )
    got = apps_admin.get_app("app_verify_preview")
    assert got["app"]["goal_template"]
    assert got["app"]["steps_preview"][0]["goal"].startswith("列出")

    wg = ph.workflow_get({"appId": "app_verify_preview"})
    assert wg["ok"] is True
    assert wg["steps_count"] == 1
    assert wg["steps_preview"][0]["ref"] == "s1"

    monkeypatch.setattr(
        apps_admin,
        "get_run",
        lambda _rid: {
            "status": "executing",
            "run": {
                "status": "executing",
                "progress": 40,
                "steps": [
                    {
                        "ref": "s1",
                        "name": "选题",
                        "status": "completed",
                        "assigned_agent": "main",
                        "description": "列出3个可拍选题",
                        "result_summary": "ok",
                    }
                ],
                "result_summary": "",
            },
        },
    )
    st = ph.workflow_run_status({"runId": "Run_x"})
    assert st["ok"] is True
    assert st["progress"] == 40
    assert st["trail"][0]["ref"] == "s1"
    assert st["trail"][0]["status"] == "completed"
