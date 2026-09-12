"""小V — 用户全局前台（独立内置 agent_code=``xiaomi``，不占用 ``main``）。

与值班岗 / 主会话 ``main``（EvoFlow）不同：小V 只做接待、传讯、分诊与全局查询，
具体执行交给智能体员工或 Plan/supervisor 编排。
"""

from __future__ import annotations

XIAOMI_AGENT_CODE = "xiaomi"
XIAOMI_DISPLAY_NAME_ZH = "小V"
XIAOMI_DISPLAY_NAME_EN = "Xiao V"

# Product copy: roster badge / API reject reason for uninstall attempts.
XIAOMI_SYSTEM_BADGE_ZH = "系统前台"
XIAOMI_PROTECTED_DETAIL_ZH = "小V是系统默认前台岗，不能归档或删除；可下班暂停催办。"

# Codes / legacy display names that identify 小V (never ``main``).
_XIAOMI_CODES = frozenset({"xiaomi", "小v", "小蜜", "xiaov"})


def is_xiaomi_agent(agent_name: str | None) -> bool:
    """True when this lead run is the user-facing 小V (``xiaomi``)."""
    code = str(agent_name or "").strip().lower()
    return code in _XIAOMI_CODES
