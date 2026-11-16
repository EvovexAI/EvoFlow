"""platform 未知 action 的建议必须与被调域相关（第20轮修复契约）。

【为什么有这份测试】现网观测库实测 7 次「unknown action」，横跨 main / xiaomi /
fullstack-dev 三个岗位，全部拿到同一串 knowledge.* 建议 —— 因为原实现 miss 后
回退 `list(reg.keys())[:16]`，而注册表前 16 个键恒为 knowledge.* / workflow.*。
这不是「没给建议」，是**确定地指错**，比不给更坏：调用方会照它再绕一步。

本测试的正向断言必须能挂住「建议与被调域无关」这种回归；反向断言保证
域不存在时不给空话、也不假装有建议。
"""

from __future__ import annotations

import pytest

from evoflow.admin.platform_actions import PLATFORM_DOMAINS, dispatch_platform_action


def _unknown(action: str) -> dict:
    out = dispatch_platform_action(action)
    assert out.get("ok") is False, f"{action} 不应成功"
    assert "unknown action" in str(out.get("error")), out
    return out


@pytest.mark.parametrize(
    ("action", "domain"),
    [
        ("assets.search", "assets"),
        ("employees.status", "employees"),
        ("agents.catalog", "agents"),
        ("settings.catalog", "settings"),
        ("tasks.comment", "tasks"),
        ("employees.help", "employees"),
    ],
)
def test_suggestions_belong_to_called_domain(action: str, domain: str) -> None:
    """核心回归：建议里每个动作都必须属于被调域。"""
    out = _unknown(action)
    suggestions = out.get("suggestions") or []
    assert suggestions, f"{action} 该给出同域动作建议，实际为空"
    wrong = [s for s in suggestions if not s.split(".", 1)[0] == domain]
    assert not wrong, f"{action} 的建议混入了其他域：{wrong}"
    assert out.get("domain_exists") is True


def test_suggestions_are_domain_scoped_not_registry_head() -> None:
    """反证：绝不能退回「注册表前 N 个键」那种与输入无关的输出。"""
    a = _unknown("assets.search").get("suggestions") or []
    b = _unknown("tasks.comment").get("suggestions") or []
    assert a != b, "两个不同域拿到同一串建议 = 又退回了 fallback"


def test_near_name_action_ranks_first() -> None:
    """employees.status 的真实意图是 employees.org_status，应排第一。"""
    suggestions = _unknown("employees.status").get("suggestions") or []
    assert suggestions[0] == "employees.org_status", suggestions


def test_unknown_domain_is_named_and_not_faked() -> None:
    out = _unknown("nosuchdom.whatever")
    assert out.get("domain_exists") is False
    assert not (out.get("suggestions") or []), "域不存在时不该编造建议"
    hint = str(out.get("hint") or "")
    assert "nosuchdom" in hint
    for d in PLATFORM_DOMAINS:
        assert d in hint, f"应把合法域全列出来，缺 {d}"


def test_help_unknown_dotted_topic_is_domain_scoped() -> None:
    """同型第二处：build_help 的 unknown topic 也曾回退成恒 knowledge.*。

    help('assets.nope') 原实现 sug 为空 → list(reg.keys())[:16] → knowledge.*，
    与问的域无关。修后必须落在 assets 域。
    """
    from evoflow.admin.platform_actions import build_help

    out = build_help("assets.nope")
    assert out.get("ok") is False
    suggestions = out.get("suggestions") or []
    assert suggestions
    assert all(s.split(".", 1)[0] == "assets" for s in suggestions), suggestions
    assert out.get("suggestions_scoped") is True


def test_help_fallback_still_works_for_bare_garbage() -> None:
    """无域可依时仍给全量兜底，但不许标成「已按域收窄」。"""
    from evoflow.admin.platform_actions import build_help

    out = build_help("zzzzz")
    assert out.get("ok") is False
    assert out.get("suggestions_scoped") is False
