"""【self-evolution-bot · 2026-11-21 · 第105轮 · 模型:deepseek-v4.1-flash-1017】新增。

班次复盘（duty wrap-up）自动产出的 craft 必须过「可执行性闸门」。

为什么要有这个测试：现网 30 个员工堆了 134 条 `[howto] duty wrap-up` 自动产物 /
85KB，本岗 27 条里 24 条 30 天零读。根因是 wrap-up 每个班次都调
``save_craft_note`` 写一条新配方，判据只看「标题是否同文」，而每班次主题都不同
→ 全部命中不了去重，稳定产出空泛套话。

判据（全平台复算得来，不是拍的）：正文含强判据词 或 含反引号命令 ⇒ 放行；
纯散文且 < 400 字 ⇒ 判为套话不落盘。本岗 162 条人工配方最短 490 字，
自动套话正文中位 152 字。

闸门只作用于 wrap-up 镜像路径，人工 ``assets note path=craft/...`` 不受影响。
"""

from __future__ import annotations

from evoflow.assets.hub import save_craft_note
from evoflow.assets.paths import EntityRef
from evoflow.person_wrap_up_reflect import (
    mirror_wrap_up_to_asset_hub,
    wrap_up_craft_is_substantive,
)


def _entity(tmp_path, monkeypatch) -> EntityRef:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    return EntityRef("employee", "gate-probe-bot")


# ── 纯判据：正反两面都要有 ──────────────────────────────────────────


def test_empty_boilerplate_is_rejected() -> None:
    """典型自动套话：四句「确保/确认/复核」，无命令无判据，应被挡。"""
    content = (
        "## 解决方案\n\n"
        "本地测试运行用例确保符合预期；状态还原立即还原并确认零差异；"
        "远程复核不轻信报错，交叉验证网络与权限状态。"
    )
    keep, why = wrap_up_craft_is_substantive(content)
    assert keep is False
    assert why.startswith("thin_craft:")


def test_short_but_executable_is_kept() -> None:
    """短而准：有反引号命令 + 判据词，必须放行（防误伤真配方）。"""
    content = (
        "别用 npx：`node evopanel/node_modules/typescript/bin/tsc --noEmit`。"
        "判据 TSC_EXIT=0，否则算没验。"
    )
    keep, why = wrap_up_craft_is_substantive(content)
    assert keep is True, why


def test_prose_with_gate_word_is_kept() -> None:
    """纯散文但写明判据，也要放行——判据词本身就是可校验性。"""
    content = "判据：必须先跑不带 WHERE 的 GROUP BY；否则 0 只代表过滤器没命中。"
    keep, why = wrap_up_craft_is_substantive(content)
    assert keep is True, why


def test_long_prose_without_command_is_kept() -> None:
    """够长的叙述通常带具体情境，不该被条数焦虑误杀。"""
    content = "这件事的具体经过是这样子的。" * 60
    keep, why = wrap_up_craft_is_substantive(content)
    assert keep is True, why


def test_auto_stamped_time_line_does_not_count_as_content() -> None:
    """`记录时间：2026-11-16` 是 ad_hoc_note 自动打点，不能让它把套话救活。"""
    content = "记录时间：2026-11-16 21:41\n\n确保通过；确认零差异；复核网络。"
    keep, why = wrap_up_craft_is_substantive(content)
    assert keep is False
    assert why.startswith("thin_craft:")


# ── 接线：走真实入口，看它到底写不写盘 ────────────────────────────


def test_mirror_skips_thin_craft_without_writing_file(tmp_path, monkeypatch) -> None:
    e = _entity(tmp_path, monkeypatch)
    parsed = {
        "craft": {
            "title": "交付闭环双重校验法",
            "kind": "howto",
            "content": "确保通过；确认零差异；复核网络与权限状态。",
        }
    }
    out = mirror_wrap_up_to_asset_hub("gate-probe-bot", parsed, round_id="r-thin")
    craft_out = out.get("craft") or {}
    assert craft_out.get("skipped") is True
    assert str(craft_out.get("reason", "")).startswith("thin_craft:")
    from evoflow.assets.paths import entity_root

    written = list((entity_root(e) / "craft").glob("*.md"))
    assert written == [], f"套话不该落盘，却有 {written}"


def test_mirror_writes_substantive_craft_with_derived_description(
    tmp_path, monkeypatch
) -> None:
    e = _entity(tmp_path, monkeypatch)
    parsed = {
        "craft": {
            "title": "用 node 跑 tsc",
            "kind": "howto",
            "content": "别用 npx：`node .../tsc --noEmit`。判据 TSC_EXIT=0。",
        }
    }
    out = mirror_wrap_up_to_asset_hub("gate-probe-bot", parsed, round_id="r-real")
    craft_out = out.get("craft") or {}
    assert craft_out.get("path"), craft_out
    text = (entity_root_of(e) / "craft" / craft_out["path"].split("/", 1)[1]).read_text(
        encoding="utf-8"
    )
    # description 必须从正文派生，不能再是那个固定模板
    assert "[howto] duty wrap-up" not in text
    assert "别用 npx" in text


def test_manual_asset_note_is_not_gated(tmp_path, monkeypatch) -> None:
    """人工 assets note 走 save_craft_note，绕开 wrap-up 闸门，短内容照写。"""
    e = _entity(tmp_path, monkeypatch)
    res = save_craft_note(e, title="短口诀", content="先跑全量分桶再报零。")
    assert res.get("path")


def entity_root_of(entity: EntityRef):
    from evoflow.assets.paths import entity_root

    return entity_root(entity)
