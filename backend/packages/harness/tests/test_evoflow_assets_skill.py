"""Regression: ``ENTITY_ASSETS_BLOCK`` is now a slim pointer that defers
to the ``$evoflow-assets`` skill instead of duplicating paths/deposit rules.

The slim block avoids the previous duplication of:
- 4-class asset layout (memory/journal/craft/episodic)
- write protocol (inbox + first-line tag)
- deposit offer (experience/process/reflection/preference)
- profile upkeep rules

Those now live in ``skills/public/evoflow-assets/SKILL.md`` and are injected
via the same ``<skill_injection>`` channel as other skills.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest


ZH_PATH = Path(__file__).resolve().parents[1] / "evoflow/agents/lead_agent/prompt_blocks_zh.py"
EN_PATH = Path(__file__).resolve().parents[1] / "evoflow/agents/lead_agent/prompt_blocks_en.py"
# Repo skills tree lives at the repo root, two levels above the harness package.
SKILL_PATH = Path(__file__).resolve().parents[4] / "skills/public/evoflow-assets/SKILL.md"


@pytest.mark.parametrize(
    "block_path",
    [
        pytest.param(ZH_PATH, id="zh"),
        pytest.param(EN_PATH, id="en"),
    ],
)
def test_entity_assets_block_is_slim_pointer(block_path: Path) -> None:
    """The block must be a slim pointer that defers to ``$evoflow-assets`` skill."""
    src = block_path.read_text(encoding="utf-8")
    match = re.search(r'ENTITY_ASSETS_BLOCK\s*=\s*"""(.*?)"""', src, re.DOTALL)
    assert match, f"ENTITY_ASSETS_BLOCK not found in {block_path}"
    body = match.group(1)

    # Was ~2.1KB in zh before; the new pointer should be well under 1.5KB.
    assert len(body) < 1500, f"entity_assets_block too large: {len(body)} chars"

    # Must point to the new skill.
    assert "$evoflow-assets" in body, "block must reference $evoflow-assets skill"

    # Must NOT contain the *detailed* rules the skill now owns.
    # (Brief mentions of paths / consolidation / citation are OK in the
    # slim pointer summary; these checks target the migrated detailed rules.)
    forbidden_in_block = [
        # Old 4-row path+write table (header markers).
        "| 沉淀邀约",
        "Deposit offer",
        "| 画像维护",
        "Profile upkeep",
        # Old bullet list of 4 row "ask before write" items.
        "1. **有价值的流程**",
        "1. **Valuable workflow**",
        # Old "画像缺口" strategy block (now in skill).
        "<profile_gaps>",
        "画像缺口策略",
        # Old "Phase2 后台合并" wording (now spelled differently in skill).
        "Phase2 后台合并 inbox",
        "Phase2 merges inbox",
    ]
    for needle in forbidden_in_block:
        assert needle not in body, (
            f"pointer block still contains migrated content {needle!r}; "
            "should live in the skill only"
        )


def test_skill_exists_and_has_frontmatter() -> None:
    """The evoflow-assets skill must exist in the repo skills/public tree."""
    assert SKILL_PATH.is_file(), f"missing skill: {SKILL_PATH}"
    content = SKILL_PATH.read_text(encoding="utf-8")
    assert content.startswith("---\n")
    assert "name: evoflow-assets" in content
    assert "description:" in content
    # Must contain the migrated rules (path layout, write protocol, deposit offer).
    must_have = [
        "memory/_inbox/notes",
        "[experience]",
        "[process]",
        "[reflection]",
        "[preference]",
        "profile/basic-info.md",
        "profile/preferences.md",
        "Phase 2",
        "ask_clarification",
    ]
    for needle in must_have:
        assert needle in content, f"skill missing required rule: {needle!r}"


def test_baseline_skills_include_evoflow_assets() -> None:
    """Lead agent baseline merge must include evoflow-assets so existing agents pick it up."""
    from evoflow.config.agents_config import (
        BASELINE_SKILLS_ALWAYS_MERGE,
        DEFAULT_LEAD_FAMILY_SKILLS_WISHLIST,
    )

    assert "evoflow-assets" in BASELINE_SKILLS_ALWAYS_MERGE
    assert "evoflow-assets" in DEFAULT_LEAD_FAMILY_SKILLS_WISHLIST


def test_router_skill_lists_include_evoflow_assets() -> None:
    """Gateway router + admin agent must include evoflow-assets in default skills."""
    from evoflow.admin.agents import _DEFAULT_SKILLS_FOR_NEW_CUSTOM_AGENT as ADMIN_LIST

    assert "evoflow-assets" in ADMIN_LIST

    from app.gateway.routers.agents import (
        _DEFAULT_SKILLS_FOR_NEW_CUSTOM_AGENT as ROUTER_LIST,
    )

    assert "evoflow-assets" in ROUTER_LIST
