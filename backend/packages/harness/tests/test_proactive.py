"""Tests for the proactive (embodied AI) module.

Covers: models, risk matrix, ThinkResult parsing, memory serialization,
and repository CRUD (with in-memory SQLite).
"""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure evoflow is importable
_backend = Path(__file__).resolve().parents[1]
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))


# ── Fixtures ───────────────────────────────────────────────────────────


def _heal_get_db_mocks() -> None:
    """Undo import-time ``get_db`` bindings captured while the patch was active."""
    import sys
    from unittest.mock import MagicMock

    from evoflow.persistence import db as dbmod

    real = dbmod.get_db
    for _name, mod in list(sys.modules.items()):
        if mod is None or not _name.startswith("evoflow."):
            continue
        bound = getattr(mod, "get_db", None)
        if isinstance(bound, MagicMock):
            setattr(mod, "get_db", real)


@pytest.fixture
def db_conn():
    """Create an in-memory SQLite DB with the public baseline schema."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_app_schema(conn)
    yield conn
    conn.close()


@pytest.fixture(autouse=True)
def patch_get_db(db_conn):
    """Patch get_db to the in-memory connection (preload binders first)."""
    # Import modules that bind ``get_db`` at import time *before* patching so
    # they keep the real function; heal any late imports after the patch ends.
    import evoflow.persistence.app_repositories  # noqa: F401

    with patch("evoflow.persistence.db.get_db", return_value=db_conn):
        with patch("evoflow.proactive.repositories.get_db", return_value=db_conn):
            yield
    _heal_get_db_mocks()


# ── Model tests ────────────────────────────────────────────────────────


class TestModels:
    def test_proactive_role_config_roundtrip(self):
        from evoflow.proactive.models import (
            ProactiveAutonomyLevel,
            ProactiveRoleConfig,
            InitiativeRiskLevel,
        )

        cfg = ProactiveRoleConfig(
            responsibilities=["code review", "architecture"],
            domain_scope=["src/", "tests/"],
            kpis=["coverage > 80%", "lint clean"],
            autonomy_level=ProactiveAutonomyLevel.FULL_AUTO,
            risk_threshold=InitiativeRiskLevel.HIGH,
            approval_channels=["feishu", "desktop"],
            approval_timeout_minutes=45,
            soul_md="You are a meticulous architect.",
        )
        json_str = cfg.to_json()
        restored = ProactiveRoleConfig.from_json(json_str)

        assert restored.responsibilities == ["code review", "architecture"]
        assert restored.domain_scope == ["src/", "tests/"]
        assert restored.kpis == ["coverage > 80%", "lint clean"]
        assert restored.autonomy_level == ProactiveAutonomyLevel.FULL_AUTO
        assert restored.risk_threshold == InitiativeRiskLevel.HIGH
        assert restored.approval_channels == ["feishu", "desktop"]
        assert restored.approval_timeout_minutes == 45
        assert restored.soul_md == "You are a meticulous architect."

    def test_proactive_role_config_defaults(self):
        from evoflow.proactive.models import ProactiveRoleConfig, ProactiveAutonomyLevel

        cfg = ProactiveRoleConfig.from_json("")
        assert cfg.responsibilities == []
        assert cfg.autonomy_level == ProactiveAutonomyLevel.APPROVAL_FOR_ALL
        assert cfg.max_initiatives_per_cycle == 3

    def test_proactive_memory_roundtrip(self):
        from evoflow.proactive.models import ProactiveMemory

        mem = ProactiveMemory(
            role_agent_code="test_agent",
            observations=["found issue X", "build is slow"],
            strategies=["focus on build perf"],
            completed_initiatives=5,
            failed_initiatives=1,
            last_think_at="2026-07-15T10:00:00Z",
            last_think_summary="checked build config",
            focus_areas=["build", "tests"],
        )
        json_str = mem.to_json()
        restored = ProactiveMemory.from_json("test_agent", json_str)

        assert restored.role_agent_code == "test_agent"
        assert restored.observations == ["found issue X", "build is slow"]
        assert restored.completed_initiatives == 5
        assert restored.focus_areas == ["build", "tests"]

    def test_proactive_memory_summary(self):
        from evoflow.proactive.models import ProactiveMemory

        mem = ProactiveMemory(
            role_agent_code="test",
            observations=["obs1", "obs2"],
            strategies=["strat1"],
            focus_areas=["area1"],
            last_think_summary="did stuff",
        )
        summary = mem.summary()
        assert "obs1" in summary
        assert "strat1" in summary
        assert "area1" in summary
        assert "did stuff" in summary

    def test_proactive_memory_empty_summary(self):
        from evoflow.proactive.models import ProactiveMemory

        mem = ProactiveMemory(role_agent_code="empty")
        assert mem.summary() == "（暂无历史记忆）"


# ── Risk matrix tests ──────────────────────────────────────────────────


class TestRiskMatrix:
    @pytest.mark.parametrize(
        "risk, autonomy, expected",
        [
            # full_auto: only critical needs approval
            ("low", "full_auto", False),
            ("medium", "full_auto", False),
            ("high", "full_auto", False),
            ("critical", "full_auto", True),
            # approval_for_risky: medium+ needs approval
            ("low", "approval_for_risky", False),
            ("medium", "approval_for_risky", True),
            ("high", "approval_for_risky", True),
            ("critical", "approval_for_risky", True),
            # approval_for_all: everything needs approval
            ("low", "approval_for_all", True),
            ("medium", "approval_for_all", True),
            ("high", "approval_for_all", True),
            ("critical", "approval_for_all", True),
        ],
    )
    def test_needs_approval(self, risk, autonomy, expected):
        from evoflow.proactive.models import needs_approval

        assert needs_approval(risk, autonomy) is expected


# ── ThinkResult parsing tests ─────────────────────────────────────────


class TestThinkResult:
    def test_parse_valid_json(self):
        from evoflow.proactive.models import ThinkResult

        raw = json.dumps({
            "observations": ["code is clean", "tests pass"],
            "initiatives": [
                {
                    "title": "Optimize build",
                    "description": "Split vendor chunk",
                    "action_type": "optimization",
                    "risk_level": "low",
                    "action_plan": {"steps": ["edit webpack config"]},
                    "expected_outcome": "20% faster build",
                }
            ],
            "reflection": "Build is the main bottleneck.",
        })
        result = ThinkResult.from_llm_output(raw)

        assert len(result.observations) == 2
        assert result.observations[0] == "code is clean"
        assert len(result.initiatives) == 1
        assert result.initiatives[0]["title"] == "Optimize build"
        assert result.reflection == "Build is the main bottleneck."

    def test_parse_markdown_fenced(self):
        from evoflow.proactive.models import ThinkResult

        raw = """```json
        {"observations": ["test"], "initiatives": [], "reflection": "ok"}
        ```"""
        result = ThinkResult.from_llm_output(raw)
        assert len(result.observations) == 1
        assert result.observations[0] == "test"
        assert result.reflection == "ok"

    def test_parse_invalid_json(self):
        from evoflow.proactive.models import ThinkResult

        result = ThinkResult.from_llm_output("not json at all")
        assert result.observations == []
        assert result.initiatives == []
        assert "not json" in result.reflection

    def test_parse_empty_initiatives(self):
        from evoflow.proactive.models import ThinkResult

        raw = json.dumps({"observations": [], "initiatives": [], "reflection": "all good"})
        result = ThinkResult.from_llm_output(raw)
        assert len(result.initiatives) == 0
        assert result.reflection == "all good"

    def test_parse_non_list_observations(self):
        from evoflow.proactive.models import ThinkResult

        raw = json.dumps({"observations": "not a list", "initiatives": "also not"})
        result = ThinkResult.from_llm_output(raw)
        assert result.observations == []
        assert result.initiatives == []


# ── Repository tests ───────────────────────────────────────────────────


class TestProactiveRepository:
    def _make_role(self, agent_code="test_role"):
        from evoflow.proactive.models import (
            ProactiveRole,
            ProactiveRoleConfig,
            ProactiveAutonomyLevel,
            InitiativeRiskLevel,
        )

        return ProactiveRole(
            agent_code=agent_code,
            role_name="Test Role",
            department="Engineering",
            config=ProactiveRoleConfig(
                responsibilities=["test responsibility"],
                domain_scope=["src/"],
                kpis=["test kpi"],
                autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_RISKY,
                risk_threshold=InitiativeRiskLevel.MEDIUM,
            ),
            heartbeat_rrule="FREQ=HOURLY;INTERVAL=1",
        )

    def test_save_and_get_role(self):
        from evoflow.proactive.repositories import ProactiveRepository

        role = self._make_role()
        ProactiveRepository.save_role(role)

        fetched = ProactiveRepository.get_role("test_role")
        assert fetched is not None
        assert fetched.role_name == "Test Role"
        assert fetched.department == "Engineering"
        assert fetched.config.responsibilities == ["test responsibility"]
        assert fetched.config.autonomy_level.value == "approval_for_risky"

    def test_reports_to_persisted_in_db_column(self, db_conn):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.repositories import ProactiveRepository

        pm = ProactiveRole(
            agent_code="pm",
            role_name="产品经理",
            config=ProactiveRoleConfig(),
        )
        fe = ProactiveRole(
            agent_code="fe",
            role_name="前端",
            config=ProactiveRoleConfig(reports_to="pm"),
        )
        ProactiveRepository.save_role(pm)
        ProactiveRepository.save_role(fe)
        row = db_conn.execute(
            "SELECT reports_to FROM evoflow_proactive_roles WHERE agent_code = ?",
            ("fe",),
        ).fetchone()
        assert row is not None
        assert row[0] == "pm"
        loaded = ProactiveRepository.get_role("fe")
        assert loaded is not None
        assert loaded.config.reports_to == "pm"

    def test_list_roles(self):
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.save_role(self._make_role("role_a"))
        ProactiveRepository.save_role(self._make_role("role_b"))

        roles = ProactiveRepository.list_roles()
        assert len(roles) == 2

    def test_list_roles_by_status(self):
        from evoflow.proactive.repositories import ProactiveRepository

        role_active = self._make_role("active_role")
        role_paused = self._make_role("paused_role")
        role_paused.status = "paused"
        ProactiveRepository.save_role(role_active)
        ProactiveRepository.save_role(role_paused)

        active = ProactiveRepository.list_roles(status="active")
        paused = ProactiveRepository.list_roles(status="paused")
        assert len(active) == 1
        assert len(paused) == 1

    def test_update_heartbeat(self):
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.save_role(self._make_role())
        ProactiveRepository.update_heartbeat(
            "test_role",
            last_heartbeat_at="2026-07-15T10:00:00Z",
            next_heartbeat_at="2026-07-15T11:00:00Z",
        )
        role = ProactiveRepository.get_role("test_role")
        assert role.last_heartbeat_at == "2026-07-15T10:00:00Z"
        assert role.next_heartbeat_at == "2026-07-15T11:00:00Z"

    def test_list_due_roles(self):
        from evoflow.proactive.repositories import ProactiveRepository

        # Role with past next_heartbeat -> due
        role_past = self._make_role("due_role")
        role_past.next_heartbeat_at = "2020-01-01T00:00:00Z"
        ProactiveRepository.save_role(role_past)

        # Role with future next_heartbeat -> not due
        role_future = self._make_role("future_role")
        role_future.next_heartbeat_at = "2099-01-01T00:00:00Z"
        ProactiveRepository.save_role(role_future)

        due = ProactiveRepository.list_due_roles("2026-07-15T10:00:00Z")
        due_codes = [r.agent_code for r in due]
        assert "due_role" in due_codes
        assert "future_role" not in due_codes

    def test_list_due_roles_skips_auto_patrol_suspended(self):
        from evoflow.proactive.repositories import ProactiveRepository

        role = self._make_role("suspended_patrol")
        role.next_heartbeat_at = "2020-01-01T00:00:00Z"
        role.config.auto_patrol_suspended = True
        ProactiveRepository.save_role(role)

        due = ProactiveRepository.list_due_roles("2026-07-15T10:00:00Z")
        assert "suspended_patrol" not in [r.agent_code for r in due]

    def test_list_due_roles_beijing_vs_utc_z_not_perpetually_due(self):
        """Beijing now must not treat a future UTC-Z next_hb as already due."""
        from evoflow.proactive.repositories import ProactiveRepository
        from evoflow.proactive.schedule import compute_next_duty_iso
        from evoflow.timeutil import BEIJING_TZ
        from datetime import datetime, timedelta

        # 2026-07-16 14:00 +08 == 06:00Z
        now_bj = datetime(2026, 7, 16, 14, 0, 0, tzinfo=BEIJING_TZ)
        # Next via cron — every 10 minutes
        role_ok = self._make_role("bj_ok")
        role_ok.heartbeat_schedule = "*/10 * * * *"
        role_ok.next_heartbeat_at = compute_next_duty_iso(role_ok, now=now_bj)
        ProactiveRepository.save_role(role_ok)

        # Legacy bug shape: UTC Z that is actually in the future (06:10Z = 14:10+08)
        role_legacy = self._make_role("legacy_z")
        role_legacy.next_heartbeat_at = "2026-07-16T06:10:00Z"
        ProactiveRepository.save_role(role_legacy)

        # Past Beijing next → due
        role_past = self._make_role("bj_past")
        role_past.next_heartbeat_at = (now_bj - timedelta(minutes=1)).isoformat(
            timespec="microseconds"
        )
        ProactiveRepository.save_role(role_past)

        due = ProactiveRepository.list_due_roles(now_bj.isoformat(timespec="microseconds"))
        codes = {r.agent_code for r in due}
        assert "bj_ok" not in codes
        assert "legacy_z" not in codes
        assert "bj_past" in codes

    def test_compute_next_duty_iso_from_cron_beijing(self):
        from evoflow.proactive.schedule import compute_next_duty_iso
        from evoflow.timeutil import BEIJING_TZ, parse_iso_to_ms
        from datetime import datetime

        now = datetime(2026, 7, 16, 14, 0, 0, tzinfo=BEIJING_TZ)
        role = self._make_role("cron_role")
        role.heartbeat_schedule = "*/10 * * * *"
        nxt = compute_next_duty_iso(role, now=now)
        assert "+08:00" in nxt
        assert not nxt.endswith("Z")
        delta_ms = parse_iso_to_ms(nxt) - parse_iso_to_ms(now.isoformat())
        assert 9 * 60_000 <= delta_ms <= 11 * 60_000

    def test_archive_role(self):
        from evoflow.proactive.repositories import ProactiveRepository

        ProactiveRepository.save_role(self._make_role())
        role = ProactiveRepository.get_role("test_role")
        role.status = "archived"
        ProactiveRepository.save_role(role)

        archived = ProactiveRepository.get_role("test_role")
        assert archived.status == "archived"

    def test_save_and_get_initiative(self):
        from evoflow.proactive.repositories import ProactiveRepository
        from evoflow.proactive.models import (
            Initiative,
            InitiativeActionType,
            InitiativeRiskLevel,
            InitiativeStatus,
        )

        ProactiveRepository.save_role(self._make_role())
        init_id = ProactiveRepository.new_initiative_id()
        init = Initiative(
            id=init_id,
            role_agent_code="test_role",
            title="Test Initiative",
            description="A test initiative",
            rationale="because testing",
            action_type=InitiativeActionType.CODE_CHANGE,
            risk_level=InitiativeRiskLevel.MEDIUM,
            action_plan={"steps": ["step1", "step2"]},
            expected_outcome="better things",
            status=InitiativeStatus.PROPOSED,
        )
        ProactiveRepository.save_initiative(init)

        fetched = ProactiveRepository.get_initiative(init_id)
        assert fetched is not None
        assert fetched.title == "Test Initiative"
        assert fetched.action_type == InitiativeActionType.CODE_CHANGE
        assert fetched.risk_level == InitiativeRiskLevel.MEDIUM
        assert fetched.action_plan == {"steps": ["step1", "step2"]}
        assert fetched.status == InitiativeStatus.PROPOSED

    def test_update_initiative_status(self):
        from evoflow.proactive.repositories import ProactiveRepository
        from evoflow.proactive.models import Initiative, InitiativeStatus

        ProactiveRepository.save_role(self._make_role())
        init = Initiative(
            id=ProactiveRepository.new_initiative_id(),
            role_agent_code="test_role",
            title="Test",
            description="Test",
            status=InitiativeStatus.PROPOSED,
        )
        ProactiveRepository.save_initiative(init)

        ProactiveRepository.update_initiative_status(
            init.id, InitiativeStatus.COMPLETED, execution_result="done"
        )
        fetched = ProactiveRepository.get_initiative(init.id)
        assert fetched.status == InitiativeStatus.COMPLETED
        assert fetched.execution_result == "done"

    def test_list_initiatives_filter(self):
        from evoflow.proactive.repositories import ProactiveRepository
        from evoflow.proactive.models import Initiative, InitiativeStatus

        ProactiveRepository.save_role(self._make_role())
        for i in range(3):
            init = Initiative(
                id=ProactiveRepository.new_initiative_id(),
                role_agent_code="test_role",
                title=f"Init {i}",
                description="Test",
                status=InitiativeStatus.PROPOSED if i < 2 else InitiativeStatus.COMPLETED,
            )
            ProactiveRepository.save_initiative(init)

        proposed = ProactiveRepository.list_initiatives(status="proposed")
        completed = ProactiveRepository.list_initiatives(status="completed")
        assert len(proposed) == 2
        assert len(completed) == 1


# ── Memory repository tests ────────────────────────────────────────────


class TestProactiveMemoryRepository:
    def test_get_empty_memory(self):
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        mem = ProactiveMemoryRepository.get("nonexistent")
        assert mem.role_agent_code == "nonexistent"
        assert mem.observations == []
        assert mem.completed_initiatives == 0

    def test_save_and_get_memory(self):
        from evoflow.proactive.repositories import ProactiveMemoryRepository
        from evoflow.proactive.models import ProactiveMemory

        mem = ProactiveMemory(
            role_agent_code="test_mem",
            observations=["obs1"],
            strategies=["strat1"],
            focus_areas=["area1"],
        )
        ProactiveMemoryRepository.save(mem)

        fetched = ProactiveMemoryRepository.get("test_mem")
        assert fetched.observations == ["obs1"]
        assert fetched.strategies == ["strat1"]
        assert fetched.focus_areas == ["area1"]

    def test_append_observation(self):
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        ProactiveMemoryRepository.append_observation("test_append", "first obs")
        ProactiveMemoryRepository.append_observation("test_append", "second obs")

        mem = ProactiveMemoryRepository.get("test_append")
        assert len(mem.observations) == 2
        assert mem.observations[0] == "first obs"
        assert mem.observations[1] == "second obs"

    def test_update_after_think(self):
        from evoflow.proactive.repositories import ProactiveMemoryRepository

        mem = ProactiveMemoryRepository.update_after_think(
            "test_think",
            new_observations=["new obs"],
            reflection="thought about stuff",
            completed=2,
            failed=1,
        )
        assert "new obs" in mem.observations
        assert mem.completed_initiatives == 2
        assert mem.failed_initiatives == 1
        assert mem.last_think_summary == "thought about stuff"


# ── Prompt tests ───────────────────────────────────────────────────────


class TestPrompt:
    def test_system_prompt_contains_role_info(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import DUTY_CONTRACT_MARKER, build_system_prompt

        role = ProactiveRole(
            agent_code="test",
            role_name="Code Quality Lead",
            department="Engineering",
            config=ProactiveRoleConfig(
                responsibilities=["ensure code quality"],
                domain_scope=["src/"],
                kpis=["lint clean", "coverage > 80%"],
                soul_md="You are detail-oriented.",
            ),
        )
        prompt = build_system_prompt(role)

        assert DUTY_CONTRACT_MARKER in prompt
        assert "值班" in prompt
        assert "Code Quality Lead" in prompt
        assert "Engineering" in prompt
        assert "ensure code quality" in prompt
        assert "src/" in prompt
        # KPIs live in system duty brief (not only user env)
        assert "lint clean" in prompt
        assert "mode_set" not in prompt
        assert "工具模式" not in prompt
        assert "You are detail-oriented" in prompt
        assert "proactive_submit_work" not in prompt
        assert "Task" in prompt
        assert "协作规则" in prompt or "标准工作流" in prompt
        assert "向下交接" in prompt or "handlers" in prompt
        assert "agent_code=" in prompt or "agent_code=`" in prompt
        assert "结案" in prompt
        assert "验收" in prompt
        assert "待确认" not in prompt
        assert "docs/roles/test/" in prompt
        assert "交付文档目录" in prompt
        # Hour bucket present: docs/roles/test/YYYYMMDD-HH/
        import re

        assert re.search(r"docs/roles/test/\d{8}-\d{2}/", prompt)
        assert "越权" in prompt

    def test_role_duty_prompt_extras_for_reviewer_roles(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_system_prompt

        qi = ProactiveRole(
            agent_code="quality-inspector",
            role_name="技术总监",
            department="Engineering",
            config=ProactiveRoleConfig(responsibilities=["审核方案"]),
        )
        prompt = build_system_prompt(qi)
        assert "本岗工作方式" in prompt
        assert "不要亲自改业务源码" in prompt
        assert "实现岗" in prompt or "下游" in prompt

        fe = ProactiveRole(
            agent_code="code-agent",
            role_name="前端工程师",
            department="Engineering",
            config=ProactiveRoleConfig(responsibilities=["改页面"]),
        )
        fe_prompt = build_system_prompt(fe)
        assert "不要亲自改业务源码" not in fe_prompt

    def test_system_prompt_injects_bound_knowledge_vaults(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_system_prompt

        role = ProactiveRole(
            agent_code="mkt",
            role_name="营销编导",
            department="增长",
            config=ProactiveRoleConfig(
                responsibilities=["包装产品能力"],
                knowledge_vault_ids=["evoflow-marketing-director", "product-docs"],
            ),
        )
        prompt = build_system_prompt(role)
        assert "## 绑定知识库" in prompt
        assert "evoflow-marketing-director" in prompt
        assert "product-docs" in prompt
        assert "优先检索" in prompt

    def test_role_docs_rel_dir_uses_agent_code(self):
        from datetime import datetime, timezone

        from evoflow.proactive.artifacts import (
            role_docs_hour_stamp,
            role_docs_rel_dir,
            role_docs_slug,
        )
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig

        role = ProactiveRole(
            agent_code="code-agent",
            role_name="前端工程师",
            config=ProactiveRoleConfig(),
        )
        when = datetime(2026, 7, 21, 18, 30, tzinfo=timezone.utc)
        assert role_docs_slug(role) == "code-agent"
        assert role_docs_hour_stamp(when) == "20260721-18"
        assert role_docs_rel_dir(role, with_hour=False) == "docs/roles/code-agent/"
        assert role_docs_rel_dir(role, when=when) == "docs/roles/code-agent/20260721-18/"
        assert "前端" not in role_docs_rel_dir(role, when=when)

    def test_user_prompt_patrol_omits_static_workspace_kpi(self):
        from evoflow.proactive.models import ProactiveMemory, ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_user_prompt

        role = ProactiveRole(
            agent_code="product-manager",
            role_name="产品经理",
            config=ProactiveRoleConfig(
                workspace_path="D:/example/EvoFlow",
                domain_scope=["docs/", "evopanel/"],
                kpis=["每轮推进 1 件"],
            ),
        )
        # Patrol env should be dynamic-only (caller no longer injects workspace/KPI)
        prompt = build_user_prompt(
            role,
            ProactiveMemory(role_agent_code="product-manager"),
            environment_context="",
            work_log="（暂无历史记录，这是首次上岗）",
        )
        assert "工作区" not in prompt
        assert "关注范围" not in prompt
        assert "本岗 KPI" not in prompt
        assert "本轮行动" in prompt

    def test_user_prompt_drops_rejection_echo_already_in_work_log(self):
        from evoflow.proactive.models import ProactiveMemory, ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_user_prompt

        role = ProactiveRole(
            agent_code="quality-inspector",
            role_name="技术总监",
            config=ProactiveRoleConfig(),
        )
        note = "用户驳回「有机交班」：无需处理。勿换皮重提同题。"
        mem = ProactiveMemory(
            role_agent_code="quality-inspector",
            observations=[note],
            strategies=[note, "优先推进未结 Task"],
        )
        work_log = (
            "## 工作日志\n"
            "  🚫 [rejected] id=`task:x` 有机交班\n"
            "    -> 驳回原因（勿再提同题）: 无需处理\n"
        )
        prompt = build_user_prompt(role, mem, environment_context="", work_log=work_log)
        assert prompt.count("有机交班") == 1
        assert "用户驳回" not in prompt
        assert "优先推进未结 Task" in prompt
        assert "环境信号" not in prompt
        assert "记忆摘要" in prompt

    def test_user_prompt_dispatch_is_compact(self):
        from evoflow.proactive.models import ProactiveMemory, ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import _DISPATCH_ENV_MARKER, build_user_prompt

        role = ProactiveRole(
            agent_code="product-manager",
            role_name="产品经理",
            config=ProactiveRoleConfig(),
        )
        env = (
            f"{_DISPATCH_ENV_MARKER}（优先执行）\n"
            "**目标：** 优化任务中心描述\n"
            "**Task：** `Task_abc`\n"
        )
        prompt = build_user_prompt(
            role,
            ProactiveMemory(role_agent_code="product-manager"),
            environment_context=env,
            work_log="（暂无历史记录，这是首次上岗）",
        )
        assert prompt.count("# 值班") == 1
        assert "优化任务中心描述" in prompt
        assert "Task_abc" in prompt
        assert "环境信号" not in prompt
        assert "关注指标" not in prompt
        assert "记忆摘要" not in prompt  # empty mem omitted
        assert "近况" not in prompt  # empty first-duty log omitted

    def test_duty_prompt_injects_configured_skills(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_system_prompt

        role = ProactiveRole(
            agent_code="solo-role",
            role_name="独立岗",
            config=ProactiveRoleConfig(
                responsibilities=["推进事项"],
                skills=["superpowers-brainstorming"],
            ),
        )
        prompt = build_system_prompt(role)
        assert "岗位技能" in prompt
        assert "superpowers-brainstorming" in prompt
        assert "标准工作流" in prompt or "交接" in prompt

    def test_resolve_role_duty_skills_falls_back_to_defaults(self, monkeypatch: pytest.MonkeyPatch):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import ROLE_DUTY_SKILL_DEFAULTS, resolve_role_duty_skills

        # Ignore on-disk agent configs so this asserts defaults, not host fixtures.
        monkeypatch.setattr(
            "evoflow.config.agents_config.load_agent_config",
            lambda *_a, **_k: None,
        )
        role = ProactiveRole(
            agent_code="product-manager",
            role_name="产品经理",
            config=ProactiveRoleConfig(skills=[]),
        )
        names = resolve_role_duty_skills(role)
        expected = list(ROLE_DUTY_SKILL_DEFAULTS["product-manager"])
        # May filter by enabled skills; at least subset of defaults or empty if none enabled
        assert all(n in expected for n in names)
        if names:
            assert "superpowers-brainstorming" in names or "superpowers-using-superpowers" in names

    def test_org_section_lists_roster_peers(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_system_prompt

        self_role = ProactiveRole(
            agent_code="product-manager",
            role_name="产品经理",
            department="产品部",
            config=ProactiveRoleConfig(responsibilities=["写 PRD"]),
        )
        tech = ProactiveRole(
            agent_code="quality-inspector",
            role_name="技术总监",
            department="技术部",
            config=ProactiveRoleConfig(
                responsibilities=["拆派技术任务"],
                reports_to="product-manager",
            ),
        )
        prompt = build_system_prompt(self_role, roster=[self_role, tech])
        assert "协作规则" in prompt
        assert "`product-manager` ←你" in prompt or "`product-manager`←你" in prompt
        assert "quality-inspector" in prompt
        assert "技术总监" in prompt
        assert "直属下级" in prompt
        assert "quality-inspector" in prompt and "技术总监" in prompt
        assert "向下交接" in prompt or "handlers" in prompt
        assert "禁止" in prompt
        assert "叫醒" in prompt or "派发" in prompt
        assert "workspace_path" in prompt or "组织边界" in prompt
        # Workflow hard rules for reports vs peers
        assert "handlers" in prompt
        assert "平级" in prompt

    def test_org_helpers_manager_reports_and_cycle(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.org import (
            build_org_forest,
            get_manager,
            list_direct_reports,
            would_create_cycle,
        )

        pm = ProactiveRole(
            agent_code="pm",
            role_name="产品经理",
            config=ProactiveRoleConfig(),
        )
        tech = ProactiveRole(
            agent_code="tech",
            role_name="技术总监",
            config=ProactiveRoleConfig(reports_to="pm"),
        )
        fe = ProactiveRole(
            agent_code="fe",
            role_name="前端",
            config=ProactiveRoleConfig(reports_to="tech"),
        )
        roster = [pm, tech, fe]
        assert get_manager(tech, roster) is pm
        assert [r.agent_code for r in list_direct_reports(pm, roster)] == ["tech"]
        assert [r.agent_code for r in list_direct_reports(tech, roster)] == ["fe"]
        assert would_create_cycle("pm", "fe", roster) is True
        assert would_create_cycle("fe", "pm", roster) is False
        forest = build_org_forest(roster)
        assert len(forest) == 1
        assert forest[0]["agent_code"] == "pm"
        assert forest[0]["children"][0]["agent_code"] == "tech"
        assert forest[0]["children"][0]["children"][0]["agent_code"] == "fe"

    def test_org_forest_keeps_paused_manager_as_bridge(self):
        """Active-only filter must not flatten reports under a paused manager."""
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.org import build_org_forest, with_reporting_bridges

        pm = ProactiveRole(
            agent_code="pm",
            role_name="产品经理",
            status="active",
            config=ProactiveRoleConfig(),
        )
        tech = ProactiveRole(
            agent_code="tech",
            role_name="技术总监",
            status="paused",
            config=ProactiveRoleConfig(reports_to="pm"),
        )
        fe = ProactiveRole(
            agent_code="fe",
            role_name="前端",
            status="active",
            config=ProactiveRoleConfig(reports_to="tech"),
        )
        full = [pm, tech, fe]
        visible = [r for r in full if r.status == "active"]
        # Bug before fix: forest from visible-only → fe becomes a false root.
        broken = build_org_forest(visible)
        assert {n["agent_code"] for n in broken} == {"pm", "fe"}

        bridged = with_reporting_bridges(visible, full)
        assert {r.agent_code for r in bridged} == {"pm", "tech", "fe"}
        forest = build_org_forest(bridged)
        assert len(forest) == 1
        assert forest[0]["agent_code"] == "pm"
        assert forest[0]["children"][0]["agent_code"] == "tech"
        assert forest[0]["children"][0]["status"] == "paused"
        assert forest[0]["children"][0]["children"][0]["agent_code"] == "fe"

    def test_user_prompt_is_short_action_list(self):
        from evoflow.proactive.models import ProactiveMemory, ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_user_prompt

        role = ProactiveRole(
            agent_code="test",
            role_name="Test",
            config=ProactiveRoleConfig(),
        )
        memory = ProactiveMemory(
            role_agent_code="test",
            observations=["found slow query"],
            last_think_summary="analyzed DB perf",
        )
        prompt = build_user_prompt(role, memory, "CI build failed")
        assert "found slow query" in prompt
        assert "analyzed DB perf" in prompt
        assert "CI build failed" in prompt
        assert "本轮行动" in prompt
        assert "结案" in prompt or "推进" in prompt
        assert "check_in" not in prompt
        assert "wrap_up" not in prompt
        # Must not reprint the long protocol
        assert "禁空转" not in prompt
        assert "timeout_rejected" not in prompt

    def test_org_section_filters_by_workspace(self):
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_system_prompt

        self_role = ProactiveRole(
            agent_code="product-manager",
            role_name="产品经理",
            config=ProactiveRoleConfig(
                responsibilities=["写 PRD"],
                workspace_path="D:/example/EvoFlow",
            ),
        )
        same = ProactiveRole(
            agent_code="quality-inspector",
            role_name="技术总监",
            config=ProactiveRoleConfig(
                responsibilities=["拆派"],
                workspace_path="D:/example/EvoFlow",
            ),
        )
        other = ProactiveRole(
            agent_code="other-org",
            role_name="外部岗",
            config=ProactiveRoleConfig(
                responsibilities=["别的仓库"],
                workspace_path="D:/other/repo",
            ),
        )
        prompt = build_system_prompt(self_role, roster=[self_role, same, other])
        assert "quality-inspector" in prompt
        assert "other-org" not in prompt
        assert "组织边界" in prompt

    def test_compose_replaces_legacy_contract_tag(self):
        from evoflow.proactive.prompt import (
            DUTY_BRIEF_CLOSE,
            DUTY_CONTRACT_MARKER,
            compose_proactive_system_message,
        )

        legacy = "<proactive_duty_contract>\nhello\n</proactive_duty_contract>"
        out = compose_proactive_system_message(legacy)
        assert DUTY_CONTRACT_MARKER in out
        assert DUTY_BRIEF_CLOSE in out
        assert "<proactive_duty_contract>" not in out

    def test_employee_chat_framing_is_not_duty_handbook(self):
        from evoflow.proactive.prompt import (
            DUTY_CONTRACT_MARKER,
            EMPLOYEE_CHAT_FRAME_OPEN,
            build_employee_chat_framing,
            build_employee_chat_system_prompt,
        )

        framing = build_employee_chat_framing("frontend_architect", role_name="前端架构师")
        assert EMPLOYEE_CHAT_FRAME_OPEN in framing
        assert DUTY_CONTRACT_MARKER not in framing
        assert "前端架构师" in framing
        assert "<identity>" in framing
        assert "<stance>" not in framing

        v2 = build_employee_chat_system_prompt(
            identity={
                "code": "frontend_architect",
                "role_name": "前端架构师",
                "department": "",
                "responsibilities": ["写前端"],
                "workspace_path": "",
            },
            user_profile_block="<user_profile></user_profile>",
        )
        assert "<identity>" in v2
        assert "前端架构师" in v2
        assert "<role>" not in v2
        assert "<stance>" not in v2
        assert "<employee" not in v2

    def test_employee_chat_framing_strips_task_session_suffix(self):
        from evoflow.proactive.prompt import build_employee_chat_framing

        dirty = "evoflow-fullstack-lead:task:2608280500_e6e3"
        framing = build_employee_chat_framing(
            f"proactive:{dirty}",
            role_name="EvoFlow全栈工程师",
        )
        assert "EvoFlow全栈工程师" in framing
        assert "agent_code=`evoflow-fullstack-lead`" in framing
        assert ":task:" not in framing
        assert "2608280500_e6e3" not in framing

    def test_user_prompt_contains_memory(self):
        from evoflow.proactive.models import ProactiveMemory, ProactiveRole, ProactiveRoleConfig
        from evoflow.proactive.prompt import build_user_prompt

        role = ProactiveRole(agent_code="test", role_name="Test", config=ProactiveRoleConfig())
        memory = ProactiveMemory(
            role_agent_code="test",
            observations=["found slow query"],
            last_think_summary="analyzed DB perf",
        )
        prompt = build_user_prompt(role, memory, "CI build failed")

        assert "found slow query" in prompt
        assert "analyzed DB perf" in prompt
        assert "CI build failed" in prompt
        assert "本轮行动" in prompt
        assert "结案" in prompt or "推进" in prompt
        assert "check_in" not in prompt


# ── Engine init-building tests (no LLM call) ──────────────────────────


class TestEngineInitiativeBuilding:
    def test_build_initiative_from_llm_output(self):
        from evoflow.proactive.engine import ProactiveEngine
        from evoflow.proactive.models import (
            ProactiveRole,
            ProactiveRoleConfig,
            ProactiveAutonomyLevel,
            InitiativeStatus,
        )

        engine = ProactiveEngine()
        role = ProactiveRole(
            agent_code="test",
            role_name="Test",
            config=ProactiveRoleConfig(
                autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_RISKY,
            ),
        )
        data = {
            "title": "Fix bug",
            "description": "Fix the login bug",
            "rationale": "Users can't log in",
            "action_type": "code_change",
            "risk_level": "high",
            "action_plan": {"steps": ["fix auth.py"]},
            "expected_outcome": "Login works",
        }
        init = engine._build_initiative(role, data)

        assert init is not None
        assert init.title == "Fix bug"
        assert init.risk_level.value == "high"
        # Engine always persists as PROPOSED; DecisionGate sets PENDING_APPROVAL
        assert init.status == InitiativeStatus.PROPOSED
        from evoflow.proactive.models import needs_approval

        assert needs_approval(init.risk_level, role.config.autonomy_level) is True

    def test_build_initiative_low_risk_auto(self):
        from evoflow.proactive.engine import ProactiveEngine
        from evoflow.proactive.models import (
            ProactiveRole,
            ProactiveRoleConfig,
            ProactiveAutonomyLevel,
            InitiativeStatus,
        )

        engine = ProactiveEngine()
        role = ProactiveRole(
            agent_code="test",
            role_name="Test",
            config=ProactiveRoleConfig(
                autonomy_level=ProactiveAutonomyLevel.FULL_AUTO,
            ),
        )
        data = {
            "title": "Generate report",
            "description": "Weekly status report",
            "action_type": "report",
            "risk_level": "low",
            "action_plan": {"steps": ["collect metrics"]},
            "expected_outcome": "Report ready",
        }
        init = engine._build_initiative(role, data)

        assert init is not None
        # low risk + full_auto -> no approval needed -> PROPOSED (auto-executable)
        assert init.status == InitiativeStatus.PROPOSED

    def test_build_initiative_no_title(self):
        from evoflow.proactive.engine import ProactiveEngine
        from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig

        engine = ProactiveEngine()
        role = ProactiveRole(agent_code="t", role_name="T", config=ProactiveRoleConfig())
        init = engine._build_initiative(role, {"description": "no title"})
        assert init is None

    def test_decision_gate_promotes_proposed_to_pending(self):
        """Approval path: PROPOSED → DecisionGate → PENDING_APPROVAL + Approval row."""
        import asyncio

        from evoflow.proactive.decision_gate import DecisionGate
        from evoflow.proactive.engine import ProactiveEngine
        from evoflow.proactive.models import (
            InitiativeStatus,
            ProactiveAutonomyLevel,
            ProactiveRole,
            ProactiveRoleConfig,
        )
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRole(
            agent_code="gate_role",
            role_name="Gate Role",
            config=ProactiveRoleConfig(
                autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_RISKY,
                approval_channels=["desktop"],
            ),
        )
        ProactiveRepository.save_role(role)

        engine = ProactiveEngine()
        init = engine._build_initiative(
            role,
            {
                "title": "Risky change",
                "description": "Needs eyes",
                "action_type": "code_change",
                "risk_level": "high",
            },
        )
        assert init is not None
        assert init.status == InitiativeStatus.PROPOSED
        ProactiveRepository.save_initiative(init)

        gate = DecisionGate()

        async def _run():
            with patch.object(gate, "_push_to_channels", return_value=None):
                return await gate.request_approval(role, init)

        approval = asyncio.run(_run())

        fetched = ProactiveRepository.get_initiative(init.id)
        assert fetched is not None
        assert fetched.status == InitiativeStatus.PENDING_APPROVAL
        assert fetched.approval_id == approval.id
        assert ProactiveRepository.get_approval_by_initiative(init.id) is not None


class TestProactiveRecursionLimit:
    def test_resolve_scales_with_tool_budget_not_sticky_1500(self, monkeypatch):
        from evoflow.proactive import limits as lim

        monkeypatch.delenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT", raising=False)
        monkeypatch.delenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT_MIN", raising=False)
        monkeypatch.delenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT_MAX", raising=False)
        monkeypatch.setenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", "36")
        monkeypatch.setenv("EVOFLOW_PROACTIVE_RECURSION_STEPS_PER_TOOL", "55")
        monkeypatch.setenv("EVOFLOW_PROACTIVE_DIG_WINDOWS", "2")

        # 36 * 55 * 2 + 400 = 4360 — must clear the old sticky 1500 ceiling.
        n = lim.resolve_proactive_recursion_limit(10)
        assert n >= 4000
        assert n <= 12000
        n_exec = lim.resolve_proactive_recursion_limit(10, for_execute=True)
        assert n_exec >= n

    def test_explicit_env_still_honoured(self, monkeypatch):
        from evoflow.proactive import limits as lim

        monkeypatch.setenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT", "2500")
        assert lim.resolve_proactive_recursion_limit(10) == 2500

    def test_default_tool_rounds_off_uses_wide_recursion(self, monkeypatch):
        from evoflow.proactive import limits as lim

        monkeypatch.delenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT", raising=False)
        monkeypatch.delenv("EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS", raising=False)
        monkeypatch.delenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT_MIN", raising=False)
        monkeypatch.delenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT_MAX", raising=False)
        n = lim.resolve_proactive_recursion_limit(10)
        assert n >= lim._DEFAULT_UNLIMITED_TOOL_RECURSION
        assert n <= 12000

    def test_triggered_by_proactive_is_unattended(self):
        from evoflow.agents.automation_runtime import triggered_by_automation

        assert triggered_by_automation({"triggered_by": "proactive_engine"})
        assert triggered_by_automation({"triggered_by": "automation_scheduler"})
        assert not triggered_by_automation({"triggered_by": "user"})


class TestProactiveSubmitWork:
    def test_submit_initiatives_and_round_log(self, monkeypatch):
        from evoflow.proactive.models import (
            ProactiveAutonomyLevel,
            ProactiveRole,
            ProactiveRoleConfig,
        )
        from evoflow.proactive.repositories import ProactiveRepository
        from evoflow.proactive.submit_work import apply_proactive_submit_work

        code = "submit_work_role"
        role = ProactiveRole(
            agent_code=code,
            role_name="Submit Tester",
            config=ProactiveRoleConfig(
                autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_RISKY,
                max_initiatives_per_cycle=3,
            ),
        )
        ProactiveRepository.save_role(role)

        rid = "round:test-submit-1"
        res = apply_proactive_submit_work(
            role_agent_code=code,
            round_id=rid,
            goal="巡检提交工具",
            outcome="写了一条事项",
            reflection="工具路径可用",
            observations=["db ok"],
            phase="wrap_up",
            initiatives=[
                {
                    "title": "Fix work log gap",
                    "description": "Submit via tool",
                    "action_type": "analysis",
                    "risk_level": "low",
                    "steps": ["call proactive_submit_work"],
                }
            ],
        )
        assert res["ok"] is True
        # initiatives[] no longer creates Tasks — use evoflow tasks create
        assert res.get("created_task_ids") == []
        assert "Fix work log gap" in (res.get("ignored_initiatives_use_cli") or [])

        rows = [
            i
            for i in ProactiveRepository.list_initiatives(role_agent_code=code, limit=20)
            if i.round_id == rid
        ]
        # Only round_log journal
        assert len(rows) == 1
        journals = [
            i
            for i in rows
            if isinstance(i.action_plan, dict) and i.action_plan.get("kind") == "round_log"
        ]
        assert len(journals) == 1
        assert journals[0].status.value == "completed"

        # Empty initiatives wrap_up → still get a completed round log
        rid2 = "round:test-submit-2"
        res2 = apply_proactive_submit_work(
            role_agent_code=code,
            round_id=rid2,
            goal="无事项巡检",
            outcome="一切正常",
            reflection="下次继续观察",
            observations=["clean"],
            initiatives=[],
            phase="wrap_up",
        )
        assert res2["ok"] is True
        rows2 = [
            i
            for i in ProactiveRepository.list_initiatives(role_agent_code=code, limit=20)
            if i.round_id == rid2
        ]
        assert len(rows2) == 1
        assert rows2[0].status.value == "completed"
        assert rows2[0].goal == "无事项巡检"

        # check_in then wrap_up + initiative_updates (legacy open initiatives)
        rid3 = "round:test-submit-3"
        r_in = apply_proactive_submit_work(
            role_agent_code=code,
            round_id=rid3,
            goal="开工先报",
            phase="check_in",
            observations=["kickoff"],
        )
        assert r_in["ok"] is True
        assert r_in["phase"] == "check_in"
        jid = r_in["journal_id"]
        assert jid

        # progress with initiatives[] → ignored (CLI path); journal not required
        r_mid = apply_proactive_submit_work(
            role_agent_code=code,
            round_id=rid3,
            phase="progress",
            initiatives=[
                {
                    "title": "Track progress item",
                    "description": "will complete",
                    "action_type": "analysis",
                    "risk_level": "low",
                }
            ],
        )
        assert r_mid["ok"] is True
        assert r_mid.get("created_task_ids") == []
        assert "Track progress item" in (r_mid.get("ignored_initiatives_use_cli") or [])

        # Seed a legacy initiative to verify initiative_updates still work
        from evoflow.proactive.models import (
            Initiative,
            InitiativeActionType,
            InitiativeRiskLevel,
            InitiativeStatus,
        )
        from evoflow.timeutil import utc_now_iso_z

        now = utc_now_iso_z()
        legacy = Initiative(
            id=ProactiveRepository.new_initiative_id(),
            role_agent_code=code,
            title="Legacy open item",
            description="update me",
            action_type=InitiativeActionType.ANALYSIS,
            risk_level=InitiativeRiskLevel.LOW,
            status=InitiativeStatus.PROPOSED,
            round_id=rid3,
            created_at=now,
            updated_at=now,
        )
        ProactiveRepository.save_initiative(legacy)
        pid = legacy.id
        r_up = apply_proactive_submit_work(
            role_agent_code=code,
            round_id=rid3,
            phase="wrap_up",
            goal="开工先报",
            outcome="事项已完成",
            reflection="流程OK",
            initiative_updates=[
                {
                    "initiative_id": pid,
                    "status": "completed",
                    "progress_note": "已核对完毕",
                    "execution_result": "ok",
                }
            ],
            initiatives=[],
        )
        assert r_up["ok"] is True
        done = ProactiveRepository.get_initiative(pid)
        assert done is not None
        assert done.status.value == "completed"
        assert "已核对完毕" in (done.execution_result or "")
