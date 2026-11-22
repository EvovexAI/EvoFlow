"""右栏「内容预览」类 kind 必须可被模型查到、且缺参必拒。

【self-evolution-bot · 2026-11-22 · 第120轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新建本测试。
为什么（用户当场质问）：「为什么要说不能支持打开文件呀？可以支持的呀，打开文件、
  图片、视频呀，这种都可以的呀。要不然的话，侧面这不很奇怪吗」
  —— file / asset / codeViewer / screenshot 四种前端**早就有真实渲染分支**、
  第113轮真机实测也全部正常（PNG naturalWidth 2459×1704、MP4 readyState=4、
  PDF canvas 200×200），但它们被放在 FRONTEND_ONLY_KINDS 里、**没进契约表**，
  于是 `platform action=ui.kinds` 只列 8 种，模型读到的清单里没有 file，
  就答出「右栏不能显示 md 文件」。
  这是「能力存在但工具查不到」——比我答错更该修的是那份清单：**子集被当成全集**。
判据（三条，缺一不可）：
  1. ui.kinds 必须列出这 4 种（否则模型永远查不到）；
  2. 每种挨个真调 ui.show，必须 ok:true 且 surface.id 不是 primary
     （id 恒 primary 会让不同文件塌成同一个签，观感是「一次只能开一个文件」）；
  3. 缺必填字段必须 ok:false 并点名字段，不许 emit 空白签。
"""

from __future__ import annotations

import pytest

from evoflow.stage.right_panel_kinds import KNOWN_KINDS, contract_for

CONTENT_KINDS = ("file", "asset", "codeViewer", "screenshot")


def test_ui_kinds_lists_content_preview_kinds() -> None:
    """模型查 ui.kinds 时必须能看到「能打开文件/图片/视频」，不能只看到网页类。"""
    from evoflow.admin.platform_handlers import ui_kinds

    out = ui_kinds({})
    assert out["ok"] is True
    listed = {spec["kind"] for spec in out["kinds"]}

    missing = [k for k in CONTENT_KINDS if k not in listed]
    assert not missing, (
        f"ui.kinds 漏了 {missing}（共列出 {len(listed)} 种）。"
        "前端 render-right-stage-body.tsx 里它们都有真实分支，"
        "放进 FRONTEND_ONLY_KINDS 只会让模型查不到 —— 清单是子集，不能当全集用。"
    )


@pytest.mark.parametrize("kind", CONTENT_KINDS)
def test_content_kind_contract_declares_required_fields(kind: str) -> None:
    """每种都必须声明必填字段，否则模型不知道要传什么。"""
    spec = contract_for(kind)
    assert spec is not None, f"{kind} 不在契约表里（ui.kinds 查不到）"
    assert spec.get("required"), f"{kind} 没声明 required，模型只能猜参数"
    assert spec.get("description"), f"{kind} 没说明用途，模型不知道何时该用它"


@pytest.mark.parametrize("kind", CONTENT_KINDS)
def test_content_kind_missing_field_is_rejected(kind: str) -> None:
    """缺必填字段必须 ok:false 并点名字段 —— 不许 emit 一个空白签。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind=kind, data={})
    assert out.get("ok") is False, f"{kind} 缺参数却返回 ok:true，用户会看到空白签"
    err = str(out.get("error") or "")
    spec = contract_for(kind) or {}
    # 文案里必须出现缺失的那个字段名（去掉 data. 前缀后的键）
    for path in spec.get("required") or []:
        key = str(path).split(".")[-1]
        assert key in err, f"{kind} 的报错没点名缺哪个字段：{err!r}"
    assert "ui.kinds" in err, f"{kind} 的报错没指路 ui.kinds：{err!r}"


def test_file_kind_accepts_markdown_and_keeps_per_file_tab_id() -> None:
    """file 必须能吃 md 路径，且不同路径得到不同签 id（否则互相顶掉）。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    a = apply_right_panel(action="show", kind="file", data={"path": "D:/x/README.md"})
    assert a.get("ok") is True, a.get("error")
    assert a["surface"]["id"] == "D:/x/README.md", (
        "file 的 surface.id 必须等于前端 showRightStageFilePreview 算出的 "
        "normalizePathId(path)，否则 tabKey 对不上（ui.activate 必失败）"
    )

    b = apply_right_panel(action="show", kind="file", data={"path": "D:/x/other.py"})
    assert b.get("ok") is True
    assert a["surface"]["id"] != b["surface"]["id"], (
        "两个不同文件算出了同一个 surface.id —— 会塌成 file:primary 同一个签，"
        "打开第二个就把第一个顶掉"
    )
    assert b["surface"]["id"] != "primary"


def test_file_kind_translates_backslashes_like_frontend() -> None:
    """后端 id 必须与前端 normalizePathId 逐字一致：反斜杠一律转正斜杠。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="file", data={"path": r"D:\dev\github\EvoFlow\README.md"})
    assert out.get("ok") is True
    assert out["surface"]["id"] == "D:/dev/github/EvoFlow/README.md"


def test_asset_kind_builds_entity_scoped_id() -> None:
    """asset 的 id 规则：{entityType}:{entityId}:{path}，与前端逐字一致。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(
        action="show",
        kind="asset",
        data={"path": "/memory/standing.md", "entityType": "employee", "entityId": "bot"},
    )
    assert out.get("ok") is True, out.get("error")
    assert out["surface"]["id"] == "employee:bot:memory/standing.md"
    # 前导 / 必须被剥掉，否则与前端算出的 id 不同
    assert out["surface"]["data"]["assetPath"] == "memory/standing.md"


def test_codeviewer_rejects_source_without_type() -> None:
    """codeViewer 的 source 必须至少带 type；空对象要拒，不许开空白签。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    out = apply_right_panel(action="show", kind="codeViewer", data={"source": {}})
    assert out.get("ok") is False
    assert "source" in str(out.get("error") or "")

    ok = apply_right_panel(
        action="show", kind="codeViewer", data={"source": {"type": "file", "path": "a.py"}}
    )
    assert ok.get("ok") is True, ok.get("error")
    assert ok["surface"]["id"] == "a.py"


def test_screenshot_requires_uri_and_keeps_uri_as_id() -> None:
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    bad = apply_right_panel(action="show", kind="screenshot", data={})
    assert bad.get("ok") is False
    assert "uri" in str(bad.get("error") or "")

    good = apply_right_panel(
        action="show", kind="screenshot", data={"uri": "data:image/png;base64,AAAA"}
    )
    assert good.get("ok") is True, good.get("error")
    assert good["surface"]["id"] == "data:image/png;base64,AAAA"


def test_content_kinds_stay_in_known_set_after_promotion() -> None:
    """提升进契约表后，它们仍必须是「已知 kind」（内部调用方不受影响）。"""
    known = KNOWN_KINDS()
    for k in CONTENT_KINDS:
        assert k in known, f"{k} 从 KNOWN_KINDS 里掉了，内部写文件/截图链路会被误杀"


# ── codeViewer 内容指纹：必须与前端 hashCodeViewerContent 逐值一致 ─────────────
# 【self-evolution-bot · 2026-11-22 · 第120轮 · 模型:deepseek-v4.1-flash-1017】
# 判据来源：用 Node 跑前端真算法得到的同一批输入结果（不是我自己推的算式）。
# 前端算法在 evopanel/src/lib/right-stage/open-right-stage-file.ts:190，
# 关键在 ``| 0`` 的 32 位有符号截断 + charCodeAt 的 UTF-16 code unit 迭代。
# 少任何一条都会算出不同指纹 → 同一路径的新 diff 会更新到旧签（屏幕是旧对比、工具回 ok）。
_NODE_GOLDEN = (
    ("", "0"),
    ("abc", "22ci"),
    ("@@ -1 +1 @@\n-a\n+b", "moukm7"),
    ("改动中文\U0001F600与代理对", "wccuto"),
    ("\u0000", "0"),
    ("x" * 300, "t2j4zk"),
)



@pytest.mark.parametrize(("content", "expected"), _NODE_GOLDEN)
def test_content_hash_matches_frontend_golden(content: str, expected: str) -> None:
    """后端指纹必须逐值等于前端 Node 算出的值（含 emoji 代理对 / NUL / 长串边界）。"""
    from evoflow.tools.builtins.stage_tool import _hash_viewer_content

    assert _hash_viewer_content(content) == expected


def test_codeviewer_patch_id_carries_content_signature() -> None:
    """同一路径的不同 patch 必须得到不同签 id（否则新 diff 更新到旧签）。"""
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    a = apply_right_panel(
        action="show",
        kind="codeViewer",
        data={"source": {"type": "patch", "path": "a.py", "patch": "@@ +a"}},
    )
    b = apply_right_panel(
        action="show",
        kind="codeViewer",
        data={"source": {"type": "patch", "path": "a.py", "patch": "@@ +b"}},
    )
    assert a.get("ok") is True and b.get("ok") is True
    assert a["surface"]["id"] != b["surface"]["id"], (
        "两个不同 patch 算出了同一个签 id —— 与前端 showRightStageCodeViewer 的"
        "「追加内容指纹」规则不一致，新对比会覆盖旧对比"
    )
    # 普通 file 类型不追加指纹，保持按 path 复用同一签
    f1 = apply_right_panel(
        action="show", kind="codeViewer", data={"source": {"type": "file", "path": "a.py"}}
    )
    assert f1["surface"]["id"] == "a.py"
    assert "@" not in f1["surface"]["id"]


def test_xiaomi_kind_is_rejected_instead_of_leaving_a_ghost_tab() -> None:
    """小V 面板不许走通用 ui.show：它的真实签 id 是常量 global，不是 primary。

    【self-evolution-bot · 2026-11-22 · 第121轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本条。
    为什么（现网实测坐实）：`ui.show kind=xiaomi` 曾经返回 ok:true、
    surface.id 恒为 `primary` → keyHint `xiaomi:primary`；而前端
    `open-right-stage-xiaomi.ts` 里 `XIAOMI_STAGE_ID = 'global'`。
    我真跑了一次，右栏当场多出第 12 个标签，而
    `documentElement.dataset.xmStage` 仍是 unset —— 前端没把它当小V 面板，
    留下一个既打不开也收不掉的幽灵签。与第 103 轮 shell-page id 漂移同型。
    判据：show/update 必须 ok:false 并指路 openXiaomi；hide/close 不受影响。
    """
    from evoflow.tools.builtins.stage_tool import apply_right_panel

    for act in ("show", "update"):
        out = apply_right_panel(action=act, kind="xiaomi", data={})
        assert out.get("ok") is False, (
            f"ui.{act} kind=xiaomi 仍被放行 → 会留下 key 为 xiaomi:primary 的幽灵签"
        )
        err = str(out.get("error") or "")
        assert "openXiaomi" in err, "拒绝时必须指路真实开场通道 openXiaomi"
        assert "global" in err, "拒绝文案要点明真实签 id 是常量 global"

    # hide / close 是更上面的独立分支：认得这个 kind，不该被本次拦截影响
    hide_out = apply_right_panel(action="hide", kind="xiaomi", data={})
    assert hide_out.get("ok") is True, "ui.hide kind=xiaomi 不该被挡住（整栏收起是通用动作）"
