"""Multi-dimension user profile Tier-0 injection."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.agents.lead_agent.prompt import build_memory_injection_sections
from evoflow.assets.profile_injection import (
    build_user_profile_injection_block,
    user_profile_is_placeholder,
)
from evoflow.assets.user_profile_dims import ensure_user_profile_files
from evoflow.config.memory_config import MemoryConfig, set_memory_config
from evoflow.assets.paths import EntityRef, profile_path


@pytest.fixture
def profile_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        set_memory_config(MemoryConfig(injection_mode="asset"))
        yield Path(tmp)
        set_memory_config(MemoryConfig())


def test_placeholder_profile_gets_hint_block(profile_home: Path) -> None:
    ensure_user_profile_files()
    block = build_user_profile_injection_block(prompt_language="zh")
    assert "<user_profile>" in block
    assert "<basic_info>" in block
    assert "<preferences>" in block
    assert "<persona>" in block
    assert "未填写" in block or "暂未补充" in block or "空 — 强制" in block or "强制" in block
    assert "<profile_gaps>" in block
    assert "强制" in block
    assert "必须主动" in block or "主动向用户询问" in block
    assert "assets(action=profile" in block


def test_filled_profile_injected(profile_home: Path) -> None:
    ensure_user_profile_files()
    ent = EntityRef("user", "user")
    profile_path(ent, "basic-info.md").write_text(
        "# 基本信息\n\n## 职业与角色\n\n张三，EvoFlow 维护者，常用 Python。\n",
        encoding="utf-8",
    )
    profile_path(ent, "preferences.md").write_text(
        "# 偏好与爱好\n\n## 回复风格\n\n中文回复，结论先行。\n",
        encoding="utf-8",
    )
    assert user_profile_is_placeholder() is False
    block = build_user_profile_injection_block(prompt_language="zh")
    assert "张三" in block
    assert "结论先行" in block
    assert "<basic_info>" in block
    assert "<preferences>" in block


def test_per_dimension_files_injected(profile_home: Path) -> None:
    ensure_user_profile_files()
    ent = EntityRef("user", "user")
    profile_path(ent, "basic-info.md").write_text(
        "# 基本信息\n\n## 称呼\n\nAlex\n",
        encoding="utf-8",
    )
    block = build_user_profile_injection_block(prompt_language="en")
    assert "Alex" in block
    assert "<basic_info>" in block
    assert "EMPTY" in block or "REQUIRED" in block or "Not filled" in block


def test_identity_scope_omits_preferences_and_persona(profile_home: Path) -> None:
    ensure_user_profile_files()
    ent = EntityRef("user", "user")
    profile_path(ent, "basic-info.md").write_text(
        "# 基本信息\n\n## 称呼\n\nBoss\n",
        encoding="utf-8",
    )
    profile_path(ent, "preferences.md").write_text(
        "# 偏好与爱好\n\n## 回复风格\n\nSECRET_PREF\n",
        encoding="utf-8",
    )
    block = build_user_profile_injection_block(prompt_language="zh", scope="identity")
    assert "<user_identity>" in block
    assert "Boss" in block
    assert "SECRET_PREF" not in block
    assert "<preferences>" not in block
    assert "<persona>" not in block


def test_resolve_scope_employee_vs_main() -> None:
    from evoflow.assets.profile_injection import resolve_profile_injection_scope

    assert resolve_profile_injection_scope(agent_name="main") == "full"
    assert resolve_profile_injection_scope(agent_name="coder") == "full"
    assert resolve_profile_injection_scope(entity_type="employee") == "identity"


def test_build_memory_injection_includes_user_profile(profile_home: Path) -> None:
    ensure_user_profile_files()
    profile_path(EntityRef("user", "user"), "basic-info.md").write_text(
        "# 基本信息\n\n## 职业与角色\n\n李四，测试工程师。\n",
        encoding="utf-8",
    )
    block = build_memory_injection_sections(agent_name="main")
    assert "<user_profile>" in block
    assert "李四" in block


def test_build_memory_injection_employee_identity_only(profile_home: Path) -> None:
    ensure_user_profile_files()
    ent = EntityRef("user", "user")
    profile_path(ent, "basic-info.md").write_text(
        "# 基本信息\n\n## 称呼\n\n王总\n",
        encoding="utf-8",
    )
    profile_path(ent, "preferences.md").write_text(
        "# 偏好与爱好\n\n## 回复风格\n\n不要注入给员工\n",
        encoding="utf-8",
    )
    from evoflow.assets.profile_injection import build_user_profile_injection_block

    emp_block = build_user_profile_injection_block(scope="identity")
    assert "<user_identity>" in emp_block
    assert "王总" in emp_block
    assert "不要注入给员工" not in emp_block
