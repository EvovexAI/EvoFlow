"""小V（用户全局前台）— 独立于 lead_agent 通用提示词/工具面。

能力盘点（应有工具 / 值班 / 禁止面）：``internal design docs (not published in this repository)``。
"""

from evoflow.agents.xiaomi.duty import (
    ensure_xiaomi_proactive_role,
    format_global_boards_for_duty,
    should_skip_xiaomi_idle_patrol,
)
from evoflow.agents.xiaomi.identity import (
    XIAOMI_AGENT_CODE,
    XIAOMI_DISPLAY_NAME_EN,
    XIAOMI_DISPLAY_NAME_ZH,
    is_xiaomi_agent,
)
from evoflow.agents.xiaomi.prompt import (
    format_page_context_block,
    policy_block,
    role_block,
    strip_xiaomi_ui_context_from_system_prompt,
)
from evoflow.agents.xiaomi.tool_policy import filter_xiaomi_tools
from evoflow.agents.xiaomi.tools import get_xiaomi_tools

__all__ = [
    "XIAOMI_AGENT_CODE",
    "XIAOMI_DISPLAY_NAME_ZH",
    "XIAOMI_DISPLAY_NAME_EN",
    "is_xiaomi_agent",
    "role_block",
    "policy_block",
    "format_page_context_block",
    "strip_xiaomi_ui_context_from_system_prompt",
    "filter_xiaomi_tools",
    "get_xiaomi_tools",
    "ensure_xiaomi_proactive_role",
    "format_global_boards_for_duty",
    "should_skip_xiaomi_idle_patrol",
]
