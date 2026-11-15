"""``tasks create`` 的 description 取值：误传 content 要能救回来，且不许静默。

【fullstack-dev · 2026-11-15 · 第13轮】新建。

为什么钉这一处（现网事故，不是假想）
------------------------------------
本岗 10:38 用 ``tasks create`` 派交接单 2611151038_93ae，把正文写进了 ``content``
（那是 ``handlers[]`` 项的字段名），而 create 只认 ``description``。框架按签名丢弃
未知 kw → 回执 ``ok:true`` + ``auto_woke:true``，但 ``tasks get`` 回来 ``description:""``：
下游被叫醒时**没有任何文件清单与验收命令**。这类"回执成功但数据丢了"比报错更坏，
因为没人会去复查一条成功。

为什么测纯函数而不是整条 create
--------------------------------
``tasks_tool(...)`` 会真往任务库落一行（污染看板、且并发同事在建单），故只测被抽出来的
``_resolve_create_description``；接线正确性由"create 分支只有一处取描述"保证
（见 test_create_uses_the_resolver_exactly_once）。
"""

from __future__ import annotations

from pathlib import Path

from evoflow.tools.builtins.tasks_tool import _resolve_create_description

_TOOL_SRC = (
    Path(__file__).resolve().parents[1]
    / "packages"
    / "harness"
    / "evoflow"
    / "tools"
    / "builtins"
    / "tasks_tool.py"
)


def test_content_alias_is_rescued_and_flagged() -> None:
    desc, warn = _resolve_create_description("", "【本单文件清单 · 共 2 个】…")
    assert desc == "【本单文件清单 · 共 2 个】…", desc
    assert "content" in warn and "description" in warn, warn


def test_explicit_description_wins_over_alias() -> None:
    """两者都给时以 description 为准 —— 别名不许覆盖显式意图。"""
    desc, warn = _resolve_create_description("  正式描述  ", "误传的正文")
    assert desc == "正式描述", desc
    assert warn == "", warn


def test_both_empty_warns_but_does_not_raise() -> None:
    """小V/编排层代用户建单常常只给标题：必须照建，只在回执点名，不许拦住正常动作。"""
    desc, warn = _resolve_create_description("", "")
    assert desc == ""
    assert "为空" in warn, warn


def test_whitespace_only_counts_as_missing() -> None:
    desc, warn = _resolve_create_description("   \n ", "  ")
    assert desc == ""
    assert warn != ""


def test_create_uses_the_resolver_exactly_once() -> None:
    """接线核对：create 分支必须走 _resolve_create_description，且不再裸取 description。

    本岗第3轮、第11轮两次栽在"函数改对了、调用点没接上"，故把接线本身钉成断言。
    """
    src = _TOOL_SRC.read_text(encoding="utf-8")
    assert src.count("_resolve_create_description(") >= 2, "定义 + create 分支调用，缺一即未接线"
    assert "description=desc_v" in src, "create_task 必须收到解析后的值"
    assert 'description=str(description or "").strip()' not in src, "裸取旧写法应已移除"
