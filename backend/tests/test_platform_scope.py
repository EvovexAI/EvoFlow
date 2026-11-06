"""员工平台能力清单（platform scope）测试.

覆盖 docs/design/agent-employee-capability-manifest.md §8：
scope 解析穷举、dispatch 闸门（capability_denied）、catalog 过滤、
AgentConfig extra_json 往返、提示词段与降级、存量兼容（None = 不设限）。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from evoflow.config.platform_scope import (
    PlatformScope,
    action_allowed,
    allowed_action_names,
    parse_action_grants,
    platform_scope_fingerprint,
    resolve_agent_platform_scope,
)


# --- parse_action_grants ---


def test_parse_action_grants_bare_and_denied():
    allow, deny = parse_action_grants(["media.catalog", "-media.generate_video", " knowledge.search ", "", "--"])
    assert allow == {"media.catalog", "knowledge.search"}
    assert deny == {"media.generate_video"}


def test_parse_action_grants_empty():
    assert parse_action_grants(None) == (set(), set())
    assert parse_action_grants([]) == (set(), set())


# --- PlatformScope normalization ---


def test_platform_scope_normalizes_and_dumps_canonical():
    scope = PlatformScope(mode="custom", domains=["Knowledge", " MEDIA "], actions=["media.catalog", "media.catalog"], max_risk="write")
    assert scope.domains == ["knowledge", "media"]
    assert scope.actions == ["media.catalog"]
    assert scope.max_risk == "write"
    assert scope.model_dump_canonical() == {
        "mode": "custom",
        "domains": ["knowledge", "media"],
        "actions": ["media.catalog"],
        "max_risk": "write",
    }


# --- action_allowed matrix ---


def test_scope_none_is_unrestricted_legacy():
    # 存量岗位：连 destructive 也放行（confirm 闸门另行兜底）——行为零突变。
    assert action_allowed(None, "knowledge.delete", "destructive") == (True, None)
    assert action_allowed(None, "settings.set_default_model", "write") == (True, None)


def test_mode_all_applies_ceiling_only():
    scope = PlatformScope(mode="all", max_risk="write")
    assert action_allowed(scope, "knowledge.list", "read") == (True, None)
    assert action_allowed(scope, "knowledge.create", "write") == (True, None)
    ok, reason = action_allowed(scope, "knowledge.delete", "destructive")
    assert not ok and reason == "risk_exceeds_ceiling"

    scope_full = PlatformScope(mode="all", max_risk="destructive")
    assert action_allowed(scope_full, "knowledge.delete", "destructive") == (True, None)


def test_mode_none_denies_everything():
    scope = PlatformScope(mode="none", max_risk="destructive")
    ok, reason = action_allowed(scope, "knowledge.list", "read")
    assert not ok and reason == "scope_none"


def test_mode_custom_domain_and_action_grants():
    scope = PlatformScope(
        mode="custom",
        domains=["knowledge"],
        actions=["media.catalog", "-media.generate_video"],
        max_risk="destructive",
    )
    assert action_allowed(scope, "knowledge.list", "read") == (True, None)
    assert action_allowed(scope, "media.catalog", "read") == (True, None)
    ok, reason = action_allowed(scope, "media.generate_video", "write")
    assert not ok and reason == "action_denied"
    ok, reason = action_allowed(scope, "workflow.create", "write")
    assert not ok and reason == "not_in_scope"


def test_mode_custom_respects_ceiling():
    scope = PlatformScope(mode="custom", domains=["knowledge"], max_risk="write")
    ok, reason = action_allowed(scope, "knowledge.delete", "destructive")
    assert not ok and reason == "risk_exceeds_ceiling"


# --- allowed_action_names ---


def test_allowed_action_names_none_is_no_filter_sentinel():
    reg = [SimpleNamespace(name="a.list", risk="read"), SimpleNamespace(name="b.op", risk="write")]
    assert allowed_action_names(None, reg) == []
    assert allowed_action_names(PlatformScope(mode="all"), reg) == []


def test_allowed_action_names_filters_by_scope():
    reg = [
        SimpleNamespace(name="knowledge.list", risk="read"),
        SimpleNamespace(name="knowledge.delete", risk="destructive"),
        SimpleNamespace(name="media.catalog", risk="read"),
    ]
    scope = PlatformScope(mode="custom", domains=["knowledge"], max_risk="write")
    assert allowed_action_names(scope, reg) == ["knowledge.list"]


# --- resolve_agent_platform_scope ---


def test_resolve_privileged_codes_return_none(monkeypatch):
    from evoflow.config import agents_config as ac

    def _fake_load(name):
        raise AssertionError("should not load config for privileged codes")

    monkeypatch.setattr(ac, "load_agent_config", _fake_load)
    for code in ("main", "lead_agent", "auto", "user", "", None):
        assert resolve_agent_platform_scope(code) is None


def test_resolve_missing_config_returns_none(monkeypatch):
    from evoflow.config import agents_config as ac

    def _fake_load(name):
        raise FileNotFoundError(name)

    monkeypatch.setattr(ac, "load_agent_config", _fake_load)
    assert resolve_agent_platform_scope("op-ghost") is None


def test_resolve_returns_configured_scope(monkeypatch):
    from evoflow.config import agents_config as ac

    scope = PlatformScope(mode="custom", domains=["knowledge"])
    cfg = SimpleNamespace(platform_scope=scope)
    monkeypatch.setattr(ac, "load_agent_config", lambda name: cfg)
    assert resolve_agent_platform_scope("op-1") is scope


def test_scope_fingerprint_changes_with_scope(monkeypatch):
    from evoflow.config import platform_scope as ps

    monkeypatch.setattr(ps, "resolve_agent_platform_scope", lambda code: None)
    assert platform_scope_fingerprint("op-1") == ""
    monkeypatch.setattr(ps, "resolve_agent_platform_scope", lambda code: PlatformScope(mode="none"))
    fp1 = platform_scope_fingerprint("op-1")
    assert fp1
    monkeypatch.setattr(ps, "resolve_agent_platform_scope", lambda code: PlatformScope(mode="all"))
    assert platform_scope_fingerprint("op-1") != fp1


# --- persistence round trip (extra_json) ---


def test_agent_doc_extra_json_round_trip():
    from evoflow.persistence.row_mappers import agent_doc_to_parts, agent_parts_to_doc

    doc = {
        "agent_code": "op-1",
        "platform_scope": {
            "mode": "custom",
            "domains": ["knowledge", "media"],
            "actions": ["items.create", "-items.delete"],
            "max_risk": "write",
        },
    }
    row, lists, env_items = agent_doc_to_parts("op-1", doc)
    extra = json.loads(row["extra_json"])
    assert extra["platform_scope"]["mode"] == "custom"
    back = agent_parts_to_doc(row, lists, env_items)
    assert back["platform_scope"]["domains"] == ["knowledge", "media"]
    assert back["platform_scope"]["actions"] == ["items.create", "-items.delete"]

    # AgentConfig 接受 dict 并归一化
    from evoflow.config.agents_config import AgentConfig

    cfg = AgentConfig(agent_code="op-1", platform_scope=back["platform_scope"])
    assert isinstance(cfg.platform_scope, PlatformScope)
    assert cfg.platform_scope.domains == ["knowledge", "media"]


def test_capability_extra_fingerprint_includes_scope():
    from evoflow.config.agents_config import _capability_extra_fingerprint

    base = _capability_extra_fingerprint(json.dumps({"knowledge_vault_ids": ["v1"]}))
    with_scope = _capability_extra_fingerprint(
        json.dumps({"knowledge_vault_ids": ["v1"], "platform_scope": {"mode": "none"}})
    )
    assert base != with_scope
    assert "scope=" in with_scope


# --- dispatch gate + catalog filter (registry-level, no handler execution) ---


@pytest.fixture()
def employee_scope_ctx(monkeypatch):
    """Patch _employee_scope_for_dispatch to simulate an employee actor."""

    def _install(scope):
        from evoflow.admin import platform_actions as pa

        monkeypatch.setattr(pa, "_employee_scope_for_dispatch", lambda: ("op-1", scope))

    return _install


def test_dispatch_denies_out_of_scope_action(employee_scope_ctx):
    from evoflow.admin.platform_actions import dispatch_platform_action

    employee_scope_ctx(PlatformScope(mode="custom", domains=["knowledge"], max_risk="destructive"))
    out = dispatch_platform_action("workflow.create", args_json='{"name": "x"}', confirm=True)
    assert out["ok"] is False
    assert out["error"] == "capability_denied"
    assert out["reason"] == "not_in_scope"
    assert out["allowed_domains"] == ["knowledge"]


def test_dispatch_denies_above_ceiling_even_with_confirm(employee_scope_ctx):
    from evoflow.admin.platform_actions import dispatch_platform_action

    # 域放行但 destructive 超上限：capability_denied 先于 confirm 闸门。
    employee_scope_ctx(PlatformScope(mode="custom", domains=["knowledge"], max_risk="write"))
    out = dispatch_platform_action("knowledge.delete", args_json='{"kbId": "x"}', confirm=True)
    assert out["ok"] is False
    assert out["error"] == "capability_denied"
    assert out["reason"] == "risk_exceeds_ceiling"
    assert "pending_confirm" not in out


def test_dispatch_scope_none_actor_unrestricted(employee_scope_ctx):
    from evoflow.admin.platform_actions import dispatch_platform_action

    # 存量岗位（scope=None）：不出现 capability_denied（可能 pending_confirm / 其他业务结果）。
    employee_scope_ctx(None)
    out = dispatch_platform_action("knowledge.delete", args_json={"kbId": "x"}, confirm=False)
    assert out.get("error") != "capability_denied"


def test_dispatch_catalog_filtered_by_scope(employee_scope_ctx):
    from evoflow.admin.platform_actions import dispatch_platform_action

    employee_scope_ctx(PlatformScope(mode="custom", domains=["knowledge"], max_risk="write"))
    out = dispatch_platform_action("catalog")
    assert out["ok"] is True
    assert out.get("scope_filtered") is True
    assert out["count"] > 0
    assert all(i["name"].startswith("knowledge.") for i in out["items"])
    # 上限内的域只含 read/write
    assert all(i["risk"] in {"read", "write"} for i in out["items"])

    dom_out = dispatch_platform_action("catalog", domain="workflow")
    assert dom_out["ok"] is True
    assert dom_out["count"] == 0
    assert dom_out.get("scope_filtered") is True


def test_build_catalog_unfiltered_when_allowed_none():
    from evoflow.admin.platform_actions import build_catalog

    out = build_catalog()
    assert out["ok"] is True
    assert "scope_filtered" not in out or out.get("scope_filtered") in (None, False)
    assert out["count"] > 0


# --- <capability_profile> section ---


def test_capability_profile_none_scope_short_section():
    from evoflow.admin.platform_scope_prompt import build_capability_profile_text

    text = build_capability_profile_text(PlatformScope(mode="none"))
    assert "capability_denied" in text
    assert len(text) < 400


def test_capability_profile_all_scope_is_short():
    from evoflow.admin.platform_scope_prompt import build_capability_profile_text

    text = build_capability_profile_text(PlatformScope(mode="all", max_risk="write"))
    assert "24" in text  # 全域数
    assert "confirm=true" in text
    assert len(text) < 400  # 短版，不逐动作罗列


def test_capability_profile_custom_lists_domains_and_negative():
    from evoflow.admin.platform_scope_prompt import build_capability_profile_text

    scope = PlatformScope(
        mode="custom",
        domains=["knowledge", "media"],
        actions=["employees.chat_send"],
        max_risk="write",
    )
    text = build_capability_profile_text(scope)
    assert "knowledge.*" in text
    assert "media.*" in text
    assert "workflow.*" in text  # 负向清单
    assert "employees.chat_send" in text
    assert "confirm=true" in text
    assert len(text) <= 1200


def test_capability_profile_section_requires_platform_mounted():
    from evoflow.admin.platform_scope_prompt import build_capability_profile_section

    # platform 未挂载 → 空段（scope 配了也调不到）
    assert build_capability_profile_section("op-1", loaded_tool_names=["read"]) == ""
    # 未配置 scope（None）→ 空段（存量行为）
    assert build_capability_profile_section("main", loaded_tool_names=["platform"]) == ""
