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
        # 【self-evolution-bot · 2026-11-20 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：agents.catalog / settings.catalog / employees.help 换成同域不存在的
        #   agents.search / settings.rename / employees.transfer。
        # 为什么：第79轮（f21fc02c）新增「<域>.catalog / <域>.help 归一化为顶层 catalog/help」，
        #   这三个拼法**不再是 unknown action**，本用例 `_unknown()` 的前置断言 ok is False
        #   必然失败（实测 ok=True / domain=None）。参数表跟着契约一起漂移，否则红的是测试自己。
        #   原意图不变：仍是「同域动作拼错 → 建议必须落在被调域」。
        ("agents.search", "agents"),
        ("settings.rename", "settings"),
        ("tasks.comment", "tasks"),
        ("employees.transfer", "employees"),
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
# 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
# 只传域名也是 unknown action，但**域是存在的**，不能谎称「无相近动作」。
#
# 现网原件（2026-11-17T21:42，本岗）：action="agents" →
#   {"ok":false,"error":"unknown action: agents","suggestions":[],"suggestion_basis":"无相近动作",
#    "domains":["knowledge", ..., "agents", "employees", ...]}
# —— 同一个 payload 里 domains 列着 agents，suggestions 却空、basis 说「无相近动作」，
# 注册表里其实有 5 个 agents.* 动作。根因是 raw_dom 只在 act 含 "." 时才非空。
#
# 反向断言同样重要：act 根本不是域名时（zzz_not_a_domain），仍必须 saying nothing
# —— 别为了修这一条把任何字符串都当成域。


@pytest.mark.parametrize("domain", ["agents", "assets", "items", "tasks", "employees"])
def test_domain_only_action_lists_that_domains_actions(domain: str) -> None:
    """只给域名时，建议必须是该域的真实动作，且不得自称「无相近动作」。"""
    out = _unknown(domain)
    suggestions = out.get("suggestions") or []
    assert suggestions, f"{domain} 是合法域，suggestions 不该为空"
    wrong = [s for s in suggestions if s.split(".", 1)[0] != domain]
    assert not wrong, f"{domain} 的建议混入了其他域：{wrong}"
    assert out.get("domain_exists") is True
    basis = str(out.get("suggestion_basis") or "")
    assert "无相近动作" not in basis, f"域存在于 domains 列表里，不能谎称无相近动作：{basis}"
    # 文案不能露出空 leaf（曾经写成「域存在，但没有 ''」）
    assert "''" not in basis, f"只给域名时不应出现空叶子动作占位：{basis}"


@pytest.mark.parametrize("not_a_domain", ["zzz_not_a_domain", "agentsx", "nonsense"])
def test_non_domain_string_is_not_treated_as_domain(not_a_domain: str) -> None:
    """反证：不是域的字符串不得被当域处理（不制造假建议）。"""
    out = _unknown(not_a_domain)
    assert not (out.get("suggestions") or []), f"{not_a_domain} 不是域，不该给出建议"
    assert out.get("domain_exists") is None, "域不存在时不应标 domain_exists=True"
