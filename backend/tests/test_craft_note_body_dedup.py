"""craft note 正文重复标题回归护栏。

【fullstack-dev · 2026-11-15 · 第11轮】新建（配 ``assets/craft.py`` 的 ``experience_to_skill_body`` 去重）。

为什么单独建一个文件：``assets note kind=experience`` 走 ``hub.save_craft_note`` 时把**整篇正文**
当 ``solution`` 传进来，而正文首行本身就是 ``# 标题``，于是套出双份标题（实测 craft/ 31 个文件里 5 个中招）。
同轮还确认了一条**不能顺手改**的约束：``## 解决方案`` 段落名被 ``_sections_from_body`` 用于取列表/详情的
``solution`` 预览字段（craft.py:270/392），所以改走 ``body_md``（verbatim）分支会让预览变空 ——
这两个断言必须一起钉住，否则下一个改的人会「优化」成更坏的那一版。
"""

from __future__ import annotations

from evoflow.assets.craft import _sections_from_body, experience_to_skill_body


def _h1_count(body: str) -> int:
    return sum(1 for line in body.splitlines() if line.startswith("# "))


def test_duplicate_h1_matching_title_is_dropped() -> None:
    """正文首行与标题同文 → 去掉那一行，只留一个 H1。"""
    body = experience_to_skill_body({"title": "ci-local 门禁配方", "solution": "# ci-local 门禁配方\n\n**起因**：本机无 make。\n"})
    assert _h1_count(body) == 1, body
    assert "**起因**：本机无 make。" in body


def test_different_leading_heading_is_preserved() -> None:
    """正文首行是**另一个**标题时不许动（去重只认同文，不做删内容判断）。"""
    body = experience_to_skill_body({"title": "外层标题", "solution": "# 真正的文档标题\n\n正文\n"})
    assert "# 真正的文档标题" in body


def test_solution_section_still_extracts_for_list_preview() -> None:
    """读侧依赖：去重后 ``## 解决方案`` 仍取得到内容（否则 craft 列表/详情预览会变空）。"""
    body = experience_to_skill_body({"title": "配方", "solution": "# 配方\n\n步骤一\n"})
    sections = _sections_from_body(body)
    assert sections["solution"].strip() == "步骤一", sections


def test_slug_punctuation_variant_is_dropped() -> None:
    """【fullstack-dev · 2026-11-15 · 第12轮】补：title 被 slug 化过（``：``/``+`` 变 ``-``）、正文 H1 是原话 → 仍算同文。

    真样本：craft/会话通知面板-状态中文化与压缩.md，第11轮的等值判断对它完全不命中。
    """
    body = experience_to_skill_body(
        {
            "title": "会话通知面板-状态中文化与压缩",
            "solution": "# 会话通知面板：状态中文化 + 压缩\n\n记录时间：2026-11-06\n",
        }
    )
    assert _h1_count(body) == 1, body
    assert "记录时间：2026-11-06" in body


def test_truncated_title_prefix_is_dropped() -> None:
    """【fullstack-dev · 2026-11-15 · 第12轮】补：title 是正文 H1 被截到 60 字的前缀 → 去掉正文那一行，长措辞不丢（它在正文里）。"""

    long_heading = "ci-local 门禁：本机可用命令与档位（2026-11-15 实测：quick 与全量两档的差别与坑位说明）"
    body = experience_to_skill_body(
        {"title": long_heading[:60], "solution": f"# {long_heading}\n\n正文\n"}
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
