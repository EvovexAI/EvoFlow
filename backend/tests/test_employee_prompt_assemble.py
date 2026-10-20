"""Shared employee prompt skeleton: chat/duty modes, job once, org present."""

from __future__ import annotations

from evoflow.proactive.employee_prompting import (
    assemble_employee_system_prompt,
    build_employee_chat_system_prompt,
)
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.prompt import DUTY_CONTRACT_MARKER, build_system_prompt


def _role(
    *,
    code: str = "code-agent",
    name: str = "实现岗",
    reports_to: str = "product-manager",
    workspace: str = "/tmp/org-a",
) -> ProactiveRole:
    return ProactiveRole(
        agent_code=code,
        role_name=name,
        department="工程",
        status="active",
        config=ProactiveRoleConfig(
            responsibilities=["实现功能", "写测试"],
            workspace_path=workspace,
            reports_to=reports_to,
            soul_md="短人设不要出现在 job 里",
            extra_context={"override_capabilities": True},
        ),
    )


def _identity() -> dict:
    return {
        "code": "code-agent",
        "role_name": "实现岗",
        "department": "工程",
        "responsibilities": ["实现功能"],
        "workspace_path": "/tmp/org-a",
    }


def test_chat_skeleton_order_and_org_compact() -> None:
    job = "只此一份作业说明"
    role = _role()
    role.config.soul_md = ""
    mgr = _role(code="product-manager", name="产品", reports_to="", workspace="/tmp/org-a")
    text = assemble_employee_system_prompt(
        mode="chat",
        role=role,
        roster=[role, mgr],
        identity=_identity(),
        soul="短人设",
        custom_system_prompt=job,
        user_profile_block="<user_profile>u</user_profile>",
        skills_section="skill-a",
        memory_context="记一点",
    )
    assert text.count(job) == 1
    assert "短人设" not in text
    assert "<agent_system_prompt>" in text
    assert "<platform>" not in text
    assert "<employee_org" in text
    assert "<session>" in text
    assert "<memory_assets>" in text
    assert "<duty_workflow>" not in text
    assert text.index("<agent_system_prompt>") < text.index("<employee_org")
    assert text.index("<employee_org") < text.index("<session>")


def test_chat_compat_alias() -> None:
    a = assemble_employee_system_prompt(
        mode="chat",
        identity=_identity(),
        custom_system_prompt="作业",
        user_profile_block="<user_profile>u</user_profile>",
    )
    b = build_employee_chat_system_prompt(
        identity=_identity(),
        custom_system_prompt="作业",
        user_profile_block="<user_profile>u</user_profile>",
    )
    assert a == b


def test_duty_shares_skeleton_job_once_and_workflow() -> None:
    role = _role()
    role.config.soul_md = ""
    mgr = _role(code="product-manager", name="产品", reports_to="", workspace="/tmp/org-a")
    text = assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=[role, mgr],
        custom_system_prompt="值班作业正文",
        soul="不应重复的 soul",
        user_profile_block="<user_profile>u</user_profile>",
    )
    assert DUTY_CONTRACT_MARKER in text
    assert text.count("值班作业正文") == 1
    assert "不应重复的 soul" not in text
    assert "<platform>" not in text
    assert "<employee_org" in text
    assert "<duty_workflow>" in text
    assert "正式交工" in text or "handlers" in text
    assert text.index("<agent_system_prompt>") < text.index("<employee_org")
    assert text.index("<employee_org") < text.index("<duty_workflow>")


def test_build_system_prompt_compat_duty_markers() -> None:
    role = _role()
    role.config.soul_md = ""
    mgr = _role(code="product-manager", name="产品", reports_to="", workspace="/tmp/org-a")
    roster = [role, mgr]
    b = build_system_prompt(role, roster=roster)
    assert DUTY_CONTRACT_MARKER in b
    assert "<platform>" not in b
    assert "<employee_org" in b
    assert "<duty_workflow>" in b


def test_no_system_platform_shell() -> None:
    text = assemble_employee_system_prompt(
        mode="chat",
        identity={
            "code": "solo",
            "role_name": "独立岗",
            "department": "",
            "responsibilities": [],
            "workspace_path": "",
        },
        custom_system_prompt="作业正文",
        user_profile_block="<user_identity>银泰</user_identity>",
        include_memory=False,
    )
    assert "<platform>" not in text
    assert "<communication>" not in text
    assert "<contract>" not in text
    assert "\n<identity>" not in text and not text.startswith("<identity>")
    assert "岗位职责尚未配置" not in text
    assert "<agent_system_prompt>" in text


def test_solo_org_is_one_line_stub() -> None:
    role = _role(code="douyin-analyst", name="抖音拆解师", reports_to="", workspace="")
    role.config.soul_md = ""
    text = assemble_employee_system_prompt(
        mode="chat",
        role=role,
        roster=[role],
        custom_system_prompt="job",
        user_profile_block="<user_identity>u</user_identity>",
        include_memory=False,
    )
    assert "<employee_org" in text
    assert "独立岗" in text
    assert "正式交工 handlers" not in text
    org = text.split("<employee_org", 1)[-1].split("</employee_org>", 1)[0]
    assert "你是「" not in org


def test_memory_strips_duplicate_profile_tags() -> None:
    text = assemble_employee_system_prompt(
        mode="chat",
        identity=_identity(),
        custom_system_prompt="job",
        user_profile_block="<user_identity>银泰</user_identity>",
        memory_context="<user_identity>银泰重复</user_identity>\n用户喜欢结论先行",
        include_memory=True,
    )
    assert text.count("<user_identity>") == 1
    assert "银泰重复" not in text
    assert "用户喜欢结论先行" in text


def test_include_memory_false_skips_memory_assets_and_person_blocks() -> None:
    role = _role()
    role.config.soul_md = ""
    role.config.memory_enabled = False
    mgr = _role(code="product-manager", name="产品", reports_to="", workspace="/tmp/org-a")
    text = assemble_employee_system_prompt(
        mode="duty",
        role=role,
        roster=[role, mgr],
        custom_system_prompt="job",
        user_profile_block="<user_profile>u</user_profile>",
        memory_context="不该出现的用户记忆",
        person_memory_context="不该出现的自传",
        include_memory=False,
    )
    assert "<memory_assets>" not in text
    assert "<person_memory>" not in text
    assert "<person_craft>" not in text
    assert "不该出现的用户记忆" not in text
    assert "<platform>" not in text
    assert "<duty_workflow>" in text


def test_role_memory_enabled_false_defaults_off() -> None:
    role = _role()
    role.config.soul_md = ""
    role.config.memory_enabled = False
    text = assemble_employee_system_prompt(
        mode="chat",
        role=role,
        roster=[role],
        custom_system_prompt="job",
        user_profile_block="<user_profile>u</user_profile>",
        memory_context="关掉了",
    )
    assert "<memory_assets>" not in text
    assert "关掉了" not in text


def test_org_lists_manager_and_peers() -> None:
    impl = _role(code="code-agent", reports_to="product-manager")
    impl.config.soul_md = ""
    qa = _role(code="quality-inspector", name="质检", reports_to="product-manager")
    mgr = _role(code="product-manager", name="产品", reports_to="")
    text = assemble_employee_system_prompt(
        mode="chat",
        role=impl,
        roster=[impl, qa, mgr],
        custom_system_prompt="job",
        user_profile_block="<user_profile>u</user_profile>",
    )
    assert "product-manager" in text
    assert "quality-inspector" in text
