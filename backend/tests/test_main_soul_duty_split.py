"""main SOUL is ZH style-only; system_prompt stays empty (no 编排/派岗 duty)."""

from __future__ import annotations

from evoflow.config.agents_config import (
    _main_system_prompt_should_clear,
    _soul_looks_like_person_kernel_en,
    load_bundled_soul,
)


def test_bundled_main_soul_is_chinese_style_only():
    soul = load_bundled_soul("main") or ""
    assert soul.strip()
    assert not _soul_looks_like_person_kernel_en(soul)
    assert "默认主智能体" not in soul.replace("**", "")
    assert "Identity" not in soul
    assert "收工后由系统自动补充" not in soul
    assert "编排" not in soul
    assert "派岗" not in soul
    assert "能委派就委派" not in soul


def test_clear_stale_orchestration_and_mirrored_soul():
    soul = load_bundled_soul("main") or ""
    assert _main_system_prompt_should_clear(
        "# 编排职责\n\n你是任务编排伙伴：拆事、派岗、收结果。",
        soul,
    )
    assert _main_system_prompt_should_clear(soul, soul)
    assert _main_system_prompt_should_clear("", soul) is False


def test_person_kernel_en_detector():
    bad = (
        "**Identity**\n\n超级助手\n\n**Core Traits**\n\n先弄清\n\n"
        "**Lessons Learned**\n\n_(收工后由系统自动补充；主会话聊天不注入此段。)_"
    )
    assert _soul_looks_like_person_kernel_en(bad) is True
    assert _soul_looks_like_person_kernel_en("# EvoFlow\n\n气质：务实。") is False
