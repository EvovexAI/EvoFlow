"""`<域>.catalog` / `<域>.help` 归一化测试。

【self-evolution-bot · 2026-11-19 · 第79轮 · 模型:deepseek-v4.1-flash-1017】

背景：catalog/help 是**顶层动作**（正确写法 ``action="catalog", domain="mcp"``），
但 media 域与 verification 域恰好注册了 ``media.catalog`` / ``verification.catalog``
两个**真动作** —— 模型据此无法从命名规律上分辨「哪些域能点 .catalog」，只能试。
现网近 7 天 platform 600 次里 91 次失败（15.2%），其中 ``mcp./employees./agents./
settings./skills./diagnostics.`` 这一族 ``xxx.catalog`` 猜错占 20 余次，每次白烧
一整个 LLM 轮次。

本测试钉住两条判据：
1. 注册表里**没有**的 ``<域>.catalog`` / ``<域>.help`` → 归一化为顶层动作，ok=True。
2. 注册表里**有**的真动作（media.catalog / verification.catalog）→ 行为不变，
   仍走真动作分支（不能被归一化抢走）。
"""

from __future__ import annotations

import pytest

from evoflow.admin.platform_actions import dispatch_platform_action, get_registry

# 现网实际踩过的写法（obs 近 7 天 platform 失败记录里逐个抄回来的）
_GUESSED = [
    "mcp.catalog",
    "agents.catalog",
    "employees.catalog",
    "settings.catalog",
    "skills.catalog",
    "diagnostics.catalog",
    "extensions.help",
]

# 注册表里真实存在的 .catalog 动作 —— 必须仍走真动作
_REAL = ["media.catalog", "verification.catalog"]


@pytest.mark.parametrize("action", _GUESSED)
def test_unregistered_domain_catalog_is_aliased(action: str) -> None:
    """拼错的 ``<域>.catalog`` 不再回 unknown action，而是给出该域的目录。"""
    assert action not in get_registry(), f"{action} 应是拼错的写法，不该在注册表里"
    out = dispatch_platform_action(action)
    assert out.get("ok") is True, f"{action} 仍失败: {out.get('error')!r}"
    assert "unknown action" not in str(out.get("error") or "")


@pytest.mark.parametrize("action", _REAL)
def test_registered_domain_catalog_unchanged(action: str) -> None:
    """真动作优先：注册表里有的 .catalog 不能被归一化抢走。"""
    assert action in get_registry()
    out = dispatch_platform_action(action)
    assert out.get("ok") is True
    # 判据：真动作响应会回显 action='<name>'；归一化走顶层 catalog 时 action 为 None。
    assert out.get("action") == action, f"{action} 被误当成顶层 catalog（action 未回显）"


def test_unrelated_unknown_action_still_errors() -> None:
    """归一化只吃 catalog/help 两个叶子，别的拼错仍要如实报错（不许扩大豁免面）。"""
    out = dispatch_platform_action("agents.bogus_leaf")
    assert out.get("ok") is False
    assert "unknown action" in str(out.get("error") or "")
    assert out.get("suggestions"), "仍应给出该域下的候选动作"
