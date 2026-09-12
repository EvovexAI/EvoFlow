"""Tests for malformed ask_clarification questions repair."""

from evoflow.tools.clarification_questions_repair import (
    MAX_CLARIFICATION_QUESTIONS,
    cap_clarification_questions,
    parse_questions_json_blob,
    repair_clarification_questions,
)

MALFORMED_ID = (
    ': "topic", "prompt": ""agent teme"具体指什么？", "context": "决定了整支视频的讲解内容方向", '
    '"options": ["Agent Team（多智能体团队协作的概念）", "Agent Theme（智能体主题/风格设计）", '
    '"Agent Tempo（智能体节奏/速率相关）", "其他（我来说清楚）"]}, '
    '{"id": "style", "prompt": "视频风格偏好？", "context": "10秒需要高信息密度", '
    '"options": ["炫酷科技感（动态粒子、数据流）", "简洁科普风（信息图表、文字辅助）", '
    '"产品或功能演示式", "你定，我相信你的判断"]}, '
    '{"id": "audio", "prompt": "配音语言？", "context": "Seedance原生支持音频输出", '
    '"options": ["中文配音", "英文配音", "无需配音，纯BGM+字幕"]}]'
)


def test_parse_questions_json_blob_recovers_three_questions() -> None:
    rows = parse_questions_json_blob(MALFORMED_ID)
    assert len(rows) == 3
    assert rows[0]["id"] == "topic"
    assert "agent teme" in rows[0]["prompt"]
    assert len(rows[0]["options"]) >= 4
    assert rows[1]["id"] == "style"
    assert rows[2]["id"] == "audio"


def test_repair_clarification_questions_hoists_title() -> None:
    items = [{"id": MALFORMED_ID, "title": "10秒 Agent Teme 讲解视频 - 需求确认"}]
    repaired, title = repair_clarification_questions(items)
    assert title == "10秒 Agent Teme 讲解视频 - 需求确认"
    assert len(repaired) == 3
    assert all(len(str(q.get("prompt") or "").strip()) > 0 for q in repaired)
    assert all(isinstance(q.get("options"), list) and len(q["options"]) >= 2 for q in repaired)


def test_cap_clarification_questions_limits_to_three() -> None:
    items = [{"prompt": f"问题{i}", "options": ["A", "B"]} for i in range(5)]
    capped = cap_clarification_questions(items)
    assert len(capped) == MAX_CLARIFICATION_QUESTIONS
    assert capped[0]["prompt"] == "问题0"
    assert cap_clarification_questions(items[:2]) == items[:2]
