"""craft note 正文重复标题回归护栏。

【fullstack-dev · 2026-11-15 · 第11轮】新建（配 ``assets/craft.py`` 的 ``experience_to_skill_body`` 去重）。

为什么单独建一个文件：``assets note kind=experience`` 走 ``hub.save_craft_note`` 时把**整篇正文**
当 ``solution`` 传进来，而正文首行本身就是 ``# 标题``，于是套出双份标题（实测 craft/ 31 个文件里 5 个中招）。
同轮还确认了一条**不能顺手改**的约束：``## 解决方案`` 段落名被 ``_sections_from_body`` 用于取列表/详情的
``solution`` 预览字段（craft.py:270/392），所以改走 ``body_md``（verbatim）分支会让预览变空 ——
这两个断言必须一起钉住，否则下一个改的人会「优化」成更坏的那一版。
"""

from __future__ import annotations

import re

from evoflow.assets.craft import _sections_from_body, experience_to_skill_body


def _h1_count(body: str) -> int:
    return sum(1 for line in body.splitlines() if line.startswith("# "))


def test_duplicate_h1_matching_title_is_dropped() -> None:
    """正文首行与标题同文 → 去掉那一行，只留一个 H1。

    【fullstack-dev · 2026-11-15 · 第14轮】改：入参从 solution 换成 body_md。
    为什么：驳回意见方向①「限定 verbatim 入口只对 note 路径生效（hub 显式传 body_md 而非复用
    solution 字段）」——去重逻辑只活在 verbatim 通道里，测试契约必须跟着走同一条通道，
    否则测的是已删除的旧兜底路径。
    """
    body = experience_to_skill_body({"title": "ci-local 门禁配方", "body_md": "# ci-local 门禁配方\n\n**起因**：本机无 make。\n"})
    assert _h1_count(body) == 1, body
    assert "**起因**：本机无 make。" in body


def test_different_leading_heading_is_preserved() -> None:
    """正文首行是**另一个**标题时不许动（去重只认同文，不做删内容判断）。"""
    body = experience_to_skill_body({"title": "外层标题", "solution": "# 真正的文档标题\n\n正文\n"})
    assert "# 真正的文档标题" in body


def test_solution_section_still_extracts_for_list_preview() -> None:
    """读侧依赖：去重后 ``## 解决方案`` 仍取得到内容（否则 craft 列表/详情预览会变空）。

    【fullstack-dev · 2026-11-15 · 第14轮】改：入参换 body_md——verbatim 入口收窄后，
    note 形态调用一律走 body_md（hub.save_craft_note 已接线），本用例钉的是同一条通道。
    """
    body = experience_to_skill_body({"title": "配方", "body_md": "# 配方\n\n步骤一\n"})
    sections = _sections_from_body(body)
    assert sections["solution"].strip() == "步骤一", sections


def test_slug_punctuation_variant_is_dropped() -> None:
    """【fullstack-dev · 2026-11-15 · 第12轮】补：title 被 slug 化过（``：``/``+`` 变 ``-``）、正文 H1 是原话 → 仍算同文。

    真样本：craft/会话通知面板-状态中文化与压缩.md，第11轮的等值判断对它完全不命中。
    """
    body = experience_to_skill_body(
        {
            "title": "会话通知面板-状态中文化与压缩",
            "body_md": "# 会话通知面板：状态中文化 + 压缩\n\n记录时间：2026-11-06\n",
        }
    )
    assert _h1_count(body) == 1, body
    assert "记录时间：2026-11-06" in body


def test_truncated_title_prefix_is_dropped() -> None:
    """【fullstack-dev · 2026-11-15 · 第12轮】补：title 是正文 H1 被截到 60 字的前缀 → 去掉正文那一行，长措辞不丢（它在正文里）。"""

    long_heading = "ci-local 门禁：本机可用命令与档位（2026-11-15 实测：quick 与全量两档的差别与坑位说明）"
    body = experience_to_skill_body(
        {"title": long_heading[:60], "body_md": f"# {long_heading}\n\n正文\n"}
    )
    assert _h1_count(body) == 1, body
    assert long_heading in body  # 截断前的完整措辞仍以正文形式保留


def test_short_common_prefix_is_not_merged() -> None:
    """边界钉桩：两条都短、只是开头撞字（< 12 归一化字符）时不许当同文删掉。"""
    body = experience_to_skill_body(
        {"title": "面板压缩", "solution": "# 面板压缩与状态中文化的取舍\n\n正文\n"}
    )
    assert _h1_count(body) == 2, body


def test_title_with_md_suffix_is_cleaned_in_heading() -> None:
    """【fullstack-dev · 2026-11-15 · 第12轮】补：模型把文件名当标题粘进来时，H1 / frontmatter 用的 title 也要去掉 ``.md``。

    真样本：craft/信息条类需求先确认面板归属.md 的 H1 原样写着 ``# …面板归属.md``。
    此前 ``strip_md_ext`` 只接在 ``_slug``（文件名）上，标题渲染路径漏接 —— 同一条规则只修一侧。
    """
    body = experience_to_skill_body(
        {"title": "信息条类需求先确认面板归属.md", "solution": "正文\n"}
    )
    assert "# 信息条类需求先确认面板归属\n" in body, body
    assert ".md" not in body.splitlines()[0], body


def test_structured_caller_unchanged() -> None:
    """结构化调用方（person_wrap_up / workspace_memory 传 problem+solution）不受影响。"""
    body = experience_to_skill_body({"title": "配方", "problem": "p", "solution": "s", "outcome": "o"})
    for marker in ("## 问题", "## 解决方案", "## 结果"):
        assert marker in body, body
    assert "# 配方" in body and _h1_count(body) == 1

# ── 第13轮补：H2 起笔的正文（现网探针实测到的残留面）──────────────────────


def _any_heading_count(body: str) -> int:
    return sum(1 for line in body.splitlines() if re.match(r"^#{1,6}\s", line))


def test_duplicate_h2_matching_title_is_dropped() -> None:
    """assets note 的正文习惯是「## 小节名」起笔，不是「# 标题」。
    第11/12轮判据写死 startswith("# ")，这类正文整段跳过 → 现网探针实测出三层重复标题。"""
    title = "探针第一段（第13轮验收）"
    # 【fullstack-dev · 2026-11-15 · 第14轮】改：入参换 body_md（verbatim 入口收窄后测试契约同步）。
    body = experience_to_skill_body({"title": title, "body_md": f"## {title}\n\n证据行 ALPHA。\n"})
    assert body.count("探针第一段（第13轮验收）") == 1, body
    assert "## 解决方案" in body and "证据行 ALPHA。" in body, body


def test_section_name_heading_is_preserved() -> None:
    """``## 问题``/``## 方案`` 这类段落名与 title 不同文，放宽判据后仍不许被误删。"""
    body = experience_to_skill_body({"title": "外层标题", "solution": "## 问题\n\n真问题正文\n"})
    assert "## 问题" in body and "真问题正文" in body, body


def test_heading_only_body_is_not_emptied() -> None:
    """正文只有一行标题时，去重会让 solution 变空 → 读侧预览字段被清空，故不删。"""
    body = experience_to_skill_body({"title": "配方", "solution": "## 配方"})
    assert "配方" in body, body
    assert _any_heading_count(body) >= 1, body
