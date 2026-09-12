"""通用 platform 工具：catalog + confirm 门 + 知识库动作。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from evoflow.admin.platform_actions import (
    PLATFORM_DOMAINS,
    build_catalog,
    dispatch_platform_action,
    get_registry,
    reset_registry_cache,
)
from evoflow.persistence.db import reset_db_for_tests
from evoflow.tools.builtins.platform_tool import platform_tool


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
        try:
            from evoflow.knowledge.owned.db import reset_db_state_for_tests
            from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

            stop_owned_kb_worker_for_tests()
            reset_db_state_for_tests()
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
        try:
            from evoflow.knowledge.owned.db import reset_db_state_for_tests
            from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

            stop_owned_kb_worker_for_tests()
            reset_db_state_for_tests()
        except Exception:
            pass


def test_registry_has_core_domains() -> None:
    reg = get_registry()
    assert "knowledge.list" in reg
    assert "knowledge.create" in reg
    assert "workflow.list" in reg
    assert "workflow.create" in reg
    assert "workflow.schema" in reg
    assert "workflow.publish" in reg
    assert "workflow.run" in reg
    assert "settings.set_default_model" in reg
    assert "settings.get_web_search" in reg
    assert "settings.patch_web_search" in reg
    assert "settings.test_web_search" in reg
    assert "agents.list" in reg
    assert "employees.hire" in reg
    assert "tasks.list" in reg
    assert "items.list" in reg
    assert "items.create" in reg
    assert "skills.list" in reg
    assert "mcp.get" in reg
    assert "automation.list" in reg
    assert "approvals.list" in reg
    assert "memory.get" in reg
    assert "sessions.search" in reg
    assert "experience.list" in reg
    assert "diagnostics.sources" in reg
    assert "diagnostics.scan" in reg
    assert "diagnostics.timeline" in reg
    assert "verification.start" in reg
    assert "verification.step" in reg
    assert "verification.conclude" in reg
    assert "verification.list" in reg
    assert "verification.get" in reg
    assert "verification.update" in reg
    assert "verification.delete" in reg
    assert "verification.catalog" in reg
    assert "appearance.get" in reg
    assert "appearance.patch" in reg
    assert "appearance" in PLATFORM_DOMAINS
    assert "verification.init" in reg
    domains = {a.domain for a in reg.values()}
    assert domains == set(PLATFORM_DOMAINS)
    assert len(reg) >= 40


def test_catalog_short_and_detailed() -> None:
    short = build_catalog()
    assert short["ok"] is True
    assert short["count"] >= 40
    assert "params" not in (short["items"][0] or {})
    assert isinstance(short.get("domains"), list)
    emp = next(d for d in short["domains"] if d.get("domain") == "employees")
    assert emp.get("when")
    assert any(a.get("name") == "employees.hire" for a in emp.get("actions") or [])
    items_dom = next(d for d in short["domains"] if d.get("domain") == "items")
    assert "备忘" in (items_dom.get("when") or "") or "事项" in (items_dom.get("when") or "")
    assert short.get("routing")

    detail = build_catalog(domain="knowledge", detailed=True)
    assert detail["ok"] is True
    assert all(i.get("domain") == "knowledge" for i in detail["items"])
    assert "params" in detail["items"][0]
    assert detail.get("guide", {}).get("domain") == "knowledge"
    assert detail.get("actions")


def test_employees_and_approvals_preview() -> None:
    hire_preview = dispatch_platform_action(
        "employees.hire",
        args_json=json.dumps({"agent_code": "demo-writer"}),
        confirm=False,
    )
    assert hire_preview.get("pending_confirm") is True

    appr_preview = dispatch_platform_action(
        "approvals.approve",
        args_json=json.dumps({"id": "task:demo"}),
        confirm=False,
    )
    assert appr_preview.get("pending_confirm") is True


def test_write_requires_confirm(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    preview = dispatch_platform_action(
        "knowledge.create",
        args_json=json.dumps({"name": "测试库"}, ensure_ascii=False),
        confirm=False,
    )
    assert preview.get("pending_confirm") is True
    assert preview.get("ok") is True


def test_knowledge_create_list_ingest(sqlite_tmp: Path) -> None:
    created = dispatch_platform_action(
        "knowledge.create",
        args_json=json.dumps({"name": "英语单词"}, ensure_ascii=False),
        confirm=True,
    )
    assert created.get("ok") is True
    assert created.get("provider") == "owned"
    vault = created.get("vault") or created.get("base") or {}
    vid = str(
        created.get("kbId")
        or created.get("vaultId")
        or vault.get("id")
        or ""
    ).strip()
    assert vid.startswith("kb_")
    # Must not create Obsidian managed vault dirs by default
    assert not (sqlite_tmp / "knowledge-vaults").exists()

    listed = dispatch_platform_action("knowledge.list")
    assert listed.get("ok") is True
    assert listed.get("provider") == "owned"
    assert listed.get("count", 0) >= 1

    ingested = dispatch_platform_action(
        "knowledge.ingest",
        args_json=json.dumps(
            {
                "title": "考纲单词",
                "content": "apple 苹果\nbook 书",
                "vaultId": vid,
            },
            ensure_ascii=False,
        ),
        confirm=True,
    )
    assert ingested.get("ok") is True
    assert ingested.get("provider") == "owned" or ingested.get("via") == "owned"


def test_unknown_action_suggests_catalog() -> None:
    miss = dispatch_platform_action("knowledge.nope")
    assert miss.get("ok") is False
    assert "catalog" in str(miss.get("catalog_hint") or miss.get("hint") or "").lower() or miss.get(
        "suggestions"
    ) is not None


def test_tool_wrapper_catalog() -> None:
    # Call .func: runtime/tool_call_id are injected by ToolNode at runtime.
    from unittest.mock import MagicMock

    raw = platform_tool.func(action="catalog", runtime=MagicMock(), tool_call_id="t1")
    data = json.loads(raw)
    assert data.get("ok") is True
    assert data.get("count", 0) >= 1
    assert getattr(platform_tool, "name", "") == "platform"


def test_settings_set_default_model_preview(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    preview = dispatch_platform_action(
        "settings.set_default_model",
        args_json=json.dumps({"model": "glm-demo"}),
        confirm=False,
    )
    assert preview.get("pending_confirm") is True
    assert preview.get("action") == "settings.set_default_model"


def test_settings_web_search_get_patch_confirm(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    got = dispatch_platform_action("settings.get_web_search")
    assert got.get("ok") is True
    assert "assistant_guide" in got
    assert got["assistant_guide"].get("status")
    assert got["assistant_guide"].get("say_to_user")
    assert "settings" in got or "providers" in got

    preview = dispatch_platform_action(
        "settings.patch_web_search",
        args_json=json.dumps(
            {"preferredBackend": "doubao", "doubaoApiKey": "sk-test-websearch-key-9999"},
            ensure_ascii=False,
        ),
        confirm=False,
    )
    assert preview.get("pending_confirm") is True

    patched = dispatch_platform_action(
        "settings.patch_web_search",
        args_json=json.dumps(
            {"preferredBackend": "doubao", "doubaoApiKey": "sk-test-websearch-key-9999"},
            ensure_ascii=False,
        ),
        confirm=True,
    )
    assert patched.get("ok") is True
    assert (patched.get("settings") or {}).get("preferredBackend") == "doubao"
    assert (patched.get("settings") or {}).get("_configured", {}).get("doubaoApiKey") is True
    masked = (patched.get("settings") or {}).get("doubaoApiKey") or ""
    assert "9999" in masked
    assert not masked.startswith("sk-test")
    assert patched.get("assistant_guide", {}).get("doubao_key_configured") is True

    test_preview = dispatch_platform_action(
        "settings.test_web_search",
        args_json=json.dumps({"engines": ["doubao"], "query": "ping"}),
        confirm=False,
    )
    assert test_preview.get("pending_confirm") is True


def test_platform_and_panel_set_eager_on_agent_mode() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import SCENARIO_EAGER_TOOL_NAMES
    from evoflow.tools.tool_catalog import AGENT_MODE_SYSTEM_TOOL_NAMES

    assert "platform" in SCENARIO_EAGER_TOOL_NAMES["agent"]
    assert "panel_set" in SCENARIO_EAGER_TOOL_NAMES["agent"]
    assert AGENT_MODE_SYSTEM_TOOL_NAMES == frozenset({"platform", "panel_set"})


def test_read_actions_have_no_ui_feedback() -> None:
    listed = dispatch_platform_action("knowledge.list")
    assert listed.get("ok") is True
    assert "ui" not in listed


def test_items_create_ui_feedback(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    created = dispatch_platform_action(
        "items.create",
        args_json=json.dumps({"title": "周五交报告"}, ensure_ascii=False),
        confirm=True,
    )
    assert created.get("ok") is True
    ui = created.get("ui") or {}
    assert "周五交报告" in str(ui.get("title") or "")
    assert "待办事项" in str(ui.get("title") or "")
    assert ui.get("kind") == "success"
    assert any(a.get("route") for a in (ui.get("actions") or []))


def test_knowledge_create_preview_has_no_ui(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    preview = dispatch_platform_action(
        "knowledge.create",
        args_json=json.dumps({"name": "测试库"}, ensure_ascii=False),
        confirm=False,
    )
    assert preview.get("pending_confirm") is True
    assert "ui" not in preview


def test_platform_ui_to_chat_artifact() -> None:
    from evoflow.admin.platform_ui_feedback import platform_ui_to_chat_artifact

    item = platform_ui_to_chat_artifact(
        {
            "kind": "success",
            "title": "创建「周五交报告」待办事项成功",
            "domain": "items",
            "action": "items.create",
            "entityId": "item_1",
            "actions": [{"label": "查看事项", "route": "/tasks?tab=items&focus=item_1"}],
        },
        tool_call_id="call_abc",
        action="items.create",
    )
    assert item is not None
    assert item["type"] == "platform"
    assert item["id"] == "platform:call_abc"
    assert item["platformAction"] == "items.create"
    assert item["url"] == "/tasks?tab=items&focus=item_1"


def test_platform_artifact_persist_and_list(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.admin.platform_ui_feedback import platform_ui_to_chat_artifact
    from evoflow.persistence.artifact_repositories import list_session_artifacts, upsert_artifacts

    item = platform_ui_to_chat_artifact(
        {
            "kind": "success",
            "title": "修改待办成功",
            "domain": "items",
            "action": "items.update",
            "actions": [{"label": "查看事项", "route": "/tasks?tab=items"}],
        },
        tool_call_id="call_persist_1",
    )
    assert item is not None
    upsert_artifacts("sess:test", "thread:test", [item])
    rows = list_session_artifacts("sess:test", thread_id="thread:test")
    assert len(rows) == 1
    row = rows[0]
    assert row["type"] == "platform"
    assert row["label"] == "修改待办成功"
    assert row["platformAction"] == "items.update"
    assert row["toolCallId"] == "call_persist_1"
    assert row["platformActions"][0]["route"] == "/tasks?tab=items"


def test_workflow_create_update_publish_delete(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    created = dispatch_platform_action(
        "workflow.create",
        args_json=json.dumps(
            {
                "name": "测试日报流程",
                "goal": "汇总今日工作并生成报告",
                "steps": [
                    {
                        "ref": "s1",
                        "name": "收集",
                        "goal": "收集今日事项",
                        "assigned_agent": "lead",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        confirm=True,
    )
    assert created.get("ok") is True
    app_id = str(created.get("appId") or "")
    assert app_id.startswith("App_")
    ui = created.get("ui") or {}
    assert "测试日报流程" in str(ui.get("title") or "")

    updated = dispatch_platform_action(
        "workflow.update",
        args_json=json.dumps({"appId": app_id, "description": "每日汇总"}, ensure_ascii=False),
        confirm=True,
    )
    assert updated.get("ok") is True

    published = dispatch_platform_action(
        "workflow.publish",
        args_json=json.dumps({"appId": app_id}, ensure_ascii=False),
        confirm=True,
    )
    assert published.get("ok") is True
    assert published.get("status") == "published" or (published.get("app") or {}).get("status") == "published"

    dup = dispatch_platform_action(
        "workflow.duplicate",
        args_json=json.dumps({"appId": app_id}, ensure_ascii=False),
        confirm=True,
    )
    assert dup.get("ok") is True
    dup_id = str(dup.get("appId") or "")
    assert dup_id and dup_id != app_id

    deleted = dispatch_platform_action(
        "workflow.delete",
        args_json=json.dumps({"appId": dup_id}, ensure_ascii=False),
        confirm=True,
    )
    assert deleted.get("ok") is True
    assert deleted.get("deleted") is True


def test_workflow_schema_exposes_step_template() -> None:
    from evoflow.admin.platform_workflow_schema import build_workflow_platform_schema

    schema = build_workflow_platform_schema()
    assert "step" in schema
    assert "ref" in schema["step"]["required"]
    assert schema["step"]["minimal_example"]["assigned_agent"]

    out = dispatch_platform_action("workflow.schema")
    assert out.get("ok") is True
    assert out.get("step", {}).get("linear_chain_example")

    cat = dispatch_platform_action("catalog", domain="workflow")
    assert cat.get("ok") is True
    assert "schema" in cat
    assert cat["schema"]["actions"]["workflow.create"]["example_args"]["name"]


def test_appearance_patch_updates_panel_ui(sqlite_tmp: None) -> None:
    preview = dispatch_platform_action("appearance.patch", args_json=json.dumps({"theme": "dark"}))
    assert preview.get("ok") is True
    assert preview.get("pending_confirm") is True

    result = dispatch_platform_action(
        "appearance.patch",
        args_json=json.dumps(
            {
                "theme": "dark",
                "accentPalette": "violet",
                "liquidGlassEnabled": True,
                "liquidGlassPreset": "aurora",
            }
        ),
        confirm=True,
    )
    assert result.get("ok") is True
    assert result.get("client_effect") == "panel_settings"
    assert result.get("settings", {}).get("theme") == "dark"
    assert result.get("settings", {}).get("accentPalette") == "violet"
    assert result.get("ui", {}).get("title")

    got = dispatch_platform_action("appearance.get")
    assert got.get("ok") is True
    assert got.get("settings", {}).get("theme") == "dark"
    assert "options" in got

