"""Employee chat prompt: one job body, platform under it, employee memory root."""

from __future__ import annotations

from langchain_core.messages import HumanMessage

from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    _drop_model_switch_messages,
)
from evoflow.models.request_payload_logger import extract_system_prompt_full_from_vendor_payload
from evoflow.proactive.employee_prompt import build_employee_chat_system_prompt


def _prompt(**overrides: object) -> str:
    identity = {
        "code": "douyin-analyst",
        "role_name": "抖音拆解师",
        "department": "",
        "responsibilities": ["拆视频"],
        "workspace_path": "",
    }
    job = "按流水线拆解抖音视频，汇报可抄的点。"
    kwargs = {
        "identity": identity,
        "soul": job,
        "custom_system_prompt": job,
        "user_profile_block": "<user_profile>银泰</user_profile>",
        "skills_section": "douyin-video-pipeline",
        "memory_context": "用户喜欢结论先行",
        "person_memory_context": "上次口令要登录",
    }
    kwargs.update(overrides)
    return build_employee_chat_system_prompt(**kwargs)  # type: ignore[arg-type]


def test_job_once_before_platform_and_no_habits() -> None:
    text = _prompt()
    job = "按流水线拆解抖音视频，汇报可抄的点。"
    assert text.count(job) == 1
    assert "<habits>" not in text
    assert text.index("<agent_system_prompt>") < text.index("<platform>")
    assert text.index("<platform>") < text.index("<session>")
    assert text.index("<session>") < text.index("<memory_assets>")
    assert "<memory_policy>" not in text
    assert "<entity_assets>" not in text


def test_different_soul_still_emits_system_prompt_only() -> None:
    text = _prompt(soul="短人设", custom_system_prompt="完整作业说明只此一份")
    assert "完整作业说明只此一份" in text
    assert "短人设" not in text
    assert text.count("<agent_system_prompt>") == 1


def test_memory_assets_region_is_content_only() -> None:
    text = _prompt()
    body = text.split("<memory_assets>", 1)[-1].split("</memory_assets>", 1)[0]
    assert "用户喜欢结论先行" in body
    assert "上次口令要登录" in body
    assert "记忆开关" not in text
    assert "工具说明" not in body
    assert "[experience]" not in body
    assert "Phase2" not in body


def test_model_switch_dropped_from_system_view_and_hydration() -> None:
    payload = {
        "system": "岗位作业",
        "messages": [
            {"role": "system", "content": "[MODEL_SWITCH]已切换至 glm"},
            {"role": "user", "content": "拆这个"},
        ],
    }
    shown = extract_system_prompt_full_from_vendor_payload(payload)
    assert "岗位作业" in shown
    assert "MODEL_SWITCH" not in shown
    kept = _drop_model_switch_messages(
        [
            HumanMessage(content="[MODEL_SWITCH]已切换"),
            HumanMessage(content="拆这个"),
        ]
    )
    assert len(kept) == 1
    assert kept[0].content == "拆这个"
