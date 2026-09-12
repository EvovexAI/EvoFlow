"""Unit tests for Person Kernel Phase A text helpers."""

from __future__ import annotations

from evoflow.person_kernel import (
    append_lesson_to_soul,
    derive_lesson_from_wrap_up,
    extract_identity_block,
    extract_lessons_section,
    format_identity_prompt_block,
)


SAMPLE_SOUL = """**Identity**

Ada — user's coding partner, not a silent tool. Goal: ship safely.

**Core Traits**

Spot problems early.
Argue the trade-offs.

**Communication**

Default language: Chinese.

**Growth**

Learn the user over time.

**Lessons Learned**

_(Mistakes and insights recorded here to avoid repeating them.)_
"""


def test_extract_identity_block():
    identity = extract_identity_block(SAMPLE_SOUL)
    assert identity.startswith("**Identity**")
    assert "Ada" in identity
    assert "Core Traits" not in identity


def test_append_lesson_replaces_placeholder():
    updated = append_lesson_to_soul(SAMPLE_SOUL, "Always verify deploy env first", stamp="2026-08-10")
    lessons = extract_lessons_section(updated)
    assert "Always verify deploy env first" in lessons
    assert "Mistakes and insights" not in lessons


def test_append_lesson_creates_section_when_missing():
    soul = "**Identity**\n\nBot.\n"
    updated = append_lesson_to_soul(soul, "Ask before deleting", stamp="2026-08-10")
    assert "**Lessons Learned**" in updated
    assert "Ask before deleting" in updated


def test_derive_lesson_prefers_reflection():
    lesson = derive_lesson_from_wrap_up(
        reflection="Checked staging before prod",
        outcome="Deployed",
        observations=["noise"],
    )
    assert lesson == "Checked staging before prod"


def test_derive_lesson_empty_fallback():
    lesson = derive_lesson_from_wrap_up()
    assert "无新教训" in lesson


def test_format_identity_prompt_block_marks_readonly():
    block = format_identity_prompt_block("**Identity**\n\nKeep secrets.")
    assert "<identity>" in block
    assert "READ-ONLY" in block
    assert "Keep secrets." in block


def test_derive_journal_from_wrap_up():
    from evoflow.person_kernel import derive_journal_from_wrap_up

    text = derive_journal_from_wrap_up(
        goal="巡检仓库",
        outcome="清理了 2 个脏文件",
        reflection="下次先看 .gitignore",
    )
    assert "巡检仓库" in text
    assert "清理了 2 个脏文件" in text
    assert "下次先看" in text


def test_format_person_memory_empty_agent():
    from evoflow.person_kernel import format_person_memory_context

    assert format_person_memory_context("") == ""
    assert format_person_memory_context(None) == ""


def test_heuristic_theme_finds_repeat():
    from evoflow.person_kernel import _heuristic_theme

    theme = _heuristic_theme(
        [
            "本轮目标：巡检仓库；反思：部署前要核对环境",
            "产出：修好脚本；反思：部署前要核对环境",
            "观察：部署前要核对环境很重要",
        ]
    )
    assert theme
    assert "部署" in theme or "环境" in theme or "核对" in theme


def test_desensitized_person_brief_has_no_journal_keys():
    from evoflow.person_kernel import desensitized_person_brief

    brief = desensitized_person_brief("nonexistent-agent-xyz")
    assert "affect_summary" in brief
    assert "open_commitment_count" in brief
    assert "relation_highlights" in brief
    blob = str(brief)
    assert "stance_md" not in blob
    assert "journal" not in blob.lower()
    assert "lessons" not in blob.lower()


def test_format_affect_block_empty_agent():
    from evoflow.person_kernel import format_affect_and_commitments_block

    assert format_affect_and_commitments_block("") == ""
    assert format_affect_and_commitments_block(None) == ""


def test_affect_event_deltas_are_small():
    from evoflow.person_kernel import _AFFECT_EVENTS

    for event, deltas in _AFFECT_EVENTS.items():
        for axis, delta in deltas.items():
            assert abs(float(delta)) <= 0.1, f"{event}.{axis} too large"
            assert axis in {
                "curiosity",
                "confidence",
                "pressure",
                "connection",
                "frustration",
                "energy",
            }


def test_derive_craft_howto_and_negative():
    from evoflow.person_kernel import derive_craft_from_wrap_up

    howto = derive_craft_from_wrap_up(
        reflection="先跑测试再合并",
        outcome="PR 已合",
        goal="修登录",
    )
    assert howto["kind"] == "howto"
    assert "做法" in howto["title"] or "修登录" in howto["title"] or howto["content"]

    neg = derive_craft_from_wrap_up(
        reflection="漏了环境变量",
        incomplete=True,
        goal="部署",
    )
    assert neg["kind"] == "negative"
    assert "避坑" in neg["title"] or "负约束" in neg["content"]


def test_format_person_craft_empty_agent():
    from evoflow.person_kernel import format_person_craft_context

    assert format_person_craft_context("") == ""
    assert format_person_craft_context(None) == ""


def test_skill_slug_is_valid():
    from evoflow.person_kernel import _skill_slug_for_agent

    slug = _skill_slug_for_agent("Code-Agent", "做法：部署核对")
    assert slug.startswith("craft-")
    assert slug == slug.lower()
    assert len(slug) <= 64


def test_format_person_memory_accepts_query_kwarg():
    from evoflow.person_kernel import format_person_memory_context

    # Empty agent still empty; query kwarg must not crash
    assert format_person_memory_context("", query="部署") == ""
    assert format_person_memory_context(None, query="x") == ""


def test_relevance_overlap_basic():
    from evoflow.persistence.person_memory_repositories import _relevance_overlap

    row = {"title": "howto-deploy", "content": "check env before deploy staging"}
    assert _relevance_overlap("deploy staging", row) > 0
    assert _relevance_overlap("zzzznotrelated", row) == 0


def test_cosine_and_blend_helpers():
    from evoflow.persistence.person_memory_repositories import _cosine

    a = [1.0, 0.0, 0.0]
    b = [1.0, 0.0, 0.0]
    c = [0.0, 1.0, 0.0]
    assert _cosine(a, b) == 1.0
    assert (_cosine(a, c) or 0) < 0.1
    assert _cosine(a, None) is None
    assert _cosine([1.0], [1.0, 2.0]) is None


def test_soul_truncation():
    from evoflow.person_kernel import format_soul_prompt_block

    long = "x" * 2500
    block = format_soul_prompt_block(long, max_chars=100)
    assert "truncated" in block or "…" in block
    assert len(block) < len(long)


def test_build_wrap_up_skips_empty_patrol():
    from evoflow.person_wrap_up_reflect import collect_duty_wrap_up_statements

    assert collect_duty_wrap_up_statements(tasks=[], tool_msg_count=5) is None
    assert collect_duty_wrap_up_statements(environment_context="看板空") is None


def test_build_wrap_up_from_completed_tasks():
    from evoflow.person_wrap_up_reflect import collect_duty_wrap_up_statements

    evidence = collect_duty_wrap_up_statements(
        tasks=[
            {
                "title": "修登录页",
                "status": "completed",
                "outcome": "已合并 PR",
            }
        ]
    )
    assert evidence is not None
    assert evidence["n_done"] == 1
    assert any("修登录页" in s for s in evidence["statements"])


def test_build_wrap_up_run_error_incomplete():
    from evoflow.person_wrap_up_reflect import collect_duty_wrap_up_statements

    evidence = collect_duty_wrap_up_statements(
        tasks=[{"title": "巡检", "status": "pending"}],
        run_error="timeout",
    )
    assert evidence is not None
    assert evidence["run_error"] == "timeout"
    assert any("timeout" in s for s in evidence["statements"])


def test_parse_wrap_up_llm_json():
    from evoflow.person_wrap_up_reflect import parse_wrap_up_llm_result

    raw = """
    {
      "skip": false,
      "mood": "steady",
      "arc_label": "steady",
      "journal": "我核对了环境变量后合并了登录页修复。",
      "state_summary": "登录页已修；部署前先查 env。",
      "lesson": "当准备上线时，先核对环境变量再发布。",
      "craft": {"title": "部署前查 env", "kind": "howto", "content": "发布清单含 env 核对"},
      "insights": [{"text": "同类故障重复出现", "evidence": [1]}],
      "affect_delta": {"confidence": 0.05, "pressure": -0.02},
      "poignancy": 6,
      "unresolved": [],
      "incomplete": false
    }
    """
    parsed = parse_wrap_up_llm_result(raw)
    assert parsed is not None
    assert parsed["poignancy"] == 6
    assert "环境变量" in parsed["journal"]
    assert parsed["lesson"] and parsed["lesson"].startswith("当")
    assert parsed["craft"]["kind"] == "howto"
    assert parsed["affect_delta"]["confidence"] == 0.05


def test_build_latest_wrap_up_from_memory_rows():
    from evoflow.person_kernel import _build_latest_wrap_up

    rows = [
        {
            "id": "j1",
            "layer": "journal",
            "source": "duty_llm",
            "round_id": "round:1",
            "created_at": "2026-08-10T12:00:00Z",
            "content": "我修完了登录页。",
            "evidence": {
                "mood": "steady",
                "arc_label": "steady",
                "poignancy": 5,
                "unresolved": ["等验收"],
            },
        },
        {
            "id": "s1",
            "layer": "semantic_self",
            "source": "duty_llm:state_summary",
            "round_id": "round:1",
            "created_at": "2026-08-10T12:00:01Z",
            "content": "登录页已修；部署前查 env。",
            "evidence": {},
        },
        {
            "id": "i1",
            "layer": "semantic_self",
            "source": "duty_llm:insight",
            "round_id": "round:1",
            "created_at": "2026-08-10T12:00:02Z",
            "content": "反思洞察：同类故障重复",
            "evidence": {},
        },
    ]
    wrap = _build_latest_wrap_up(rows)
    assert wrap is not None
    assert wrap["mood"] == "steady"
    assert "登录页" in wrap["journal"]
    assert "env" in wrap["state_summary"]
    assert wrap["unresolved"] == ["等验收"]
    assert len(wrap["insights"]) == 1


def test_person_presence_block_stance():
    from evoflow.person_kernel import format_person_presence_block

    chat = format_person_presence_block(None)
    assert "<person_presence>" in chat
    assert "连续" in chat
    assert "对话" in chat or "不是定时巡检" in chat
    assert "DutyMask" not in chat
    assert "无状态工具" in chat or "不是无状态工具" in chat
    assert "待办" in chat or "旧任务" in chat
    assert "<standing_summary>" not in chat

    duty = format_person_presence_block(None, for_duty=True)
    assert "DutyMask" in duty
    assert "结案" in duty


def test_soul_block_marks_live_it():
    from evoflow.person_kernel import format_soul_prompt_block

    block = format_soul_prompt_block("Be concise.")
    assert "<soul>" in block
    assert "habits" in block or "Live it" in block


def test_soul_block_can_omit_lessons_learned():
    from evoflow.person_kernel import format_soul_prompt_block, omit_lessons_learned_section

    soul = (
        "# Agent\n\nBe helpful.\n\n"
        "**Lessons Learned**\n\n"
        "- [2026-08-21] when timeout, note it\n\n"
        "**Communication**\n\n"
        "Be concise.\n"
    )
    stripped = omit_lessons_learned_section(soul)
    assert "Lessons Learned" not in stripped
    assert "Be concise" in stripped
    block = format_soul_prompt_block(soul, omit_lessons_learned=True)
    assert "Lessons Learned" not in block
    assert "timeout" not in block
    assert "Be concise" in block


def test_soul_block_can_omit_identity_section():
    from evoflow.person_kernel import format_soul_prompt_block, omit_identity_section

    soul = (
        "**Identity**\n\n"
        "I am the lead assistant.\n\n"
        "**Core Traits**\n\n"
        "Be helpful.\n"
    )
    stripped = omit_identity_section(soul)
    assert "Identity" not in stripped
    assert "lead assistant" not in stripped
    assert "Be helpful" in stripped
    block = format_soul_prompt_block(soul, omit_identity=True)
    assert "lead assistant" not in block
    assert "Be helpful" in block
