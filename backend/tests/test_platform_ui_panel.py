"""platform ui.show / ui.hide — right panel folded from panel_set."""

# 【self-evolution-bot · 2026-11-22 · 第122轮 · 模型:deepseek-v4.1-flash】
# 改了什么：把原先散在文件中部（第104轮那段落注释之后）的两条 import 提到顶部。
# 为什么：ruff 报 E402 ×2。已用 `git show HEAD:该文件` 证真这两条在 HEAD **同一行号**
#   就已存在（非本轮引入）；但我改了本文件，门禁就必须全绿，不能让既有红挂在
#   「反正不是我引入的」借口下。纯移动，语义逐字不变。
from unittest.mock import patch

from evoflow.admin.platform_actions import dispatch_platform_action, get_registry, reset_registry_cache
from evoflow.stage.right_panel_kinds import KNOWN_KINDS, is_known_kind


def setup_function() -> None:
    reset_registry_cache()


def test_ui_actions_registered():
    reg = get_registry()
    assert "ui.show" in reg
    assert "ui.hide" in reg
    assert "ui.update" in reg
    assert reg["ui.show"].risk == "read"
    assert reg["ui.show"].domain == "ui"


def test_ui_show_collab_workflow():
    result = dispatch_platform_action(
        "ui.show",
        args_json='{"kind":"collab-workflow","data":{"mainTaskId":"mt-ui-1"}}',
    )
    assert result.get("ok") is True
    assert result.get("kind") == "collab-workflow"
    surface = result.get("surface") or {}
    assert surface.get("id") == "workflow:mt-ui-1"
    assert (surface.get("data") or {}).get("mainTaskId") == "mt-ui-1"


def test_ui_show_employee_process():
    result = dispatch_platform_action(
        "ui.show",
        args_json='{"kind":"employeeProcess","taskId":"mt-2","agentCode":"duty-ops"}',
    )
    assert result.get("ok") is True
    assert result.get("kind") == "employeeProcess"
    data = (result.get("surface") or {}).get("data") or {}
    assert data.get("taskId") == "mt-2"
    assert data.get("agentCode") == "duty-ops"


def test_ui_show_requires_kind():
    result = dispatch_platform_action("ui.show", args_json="{}")
    assert result.get("ok") is False


def test_ui_hide():
    result = dispatch_platform_action("ui.hide", args_json="{}")
    assert result.get("ok") is True
    assert result.get("action") == "hide"


def test_catalog_includes_ui_domain():
    cat = dispatch_platform_action("catalog", args_json='{"domain":"ui"}')
    assert cat.get("ok") is True
    names = cat.get("action_names") or [
        a.get("name") for a in (cat.get("actions") or []) if isinstance(a, dict)
    ]
    # detailed domain catalog may nest under domains / actions
    flat = " ".join(str(x) for x in (names or []))
    if not flat:
        # fallback: search whole payload
        flat = str(cat)
    assert "ui.show" in flat


# ── 第104轮：未知 kind 必须在模型入口被拒（不许开空白签）──────────────────────
# 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
# 真机实测：`ui.show(kind="not-a-kind")` 曾返回 ok:true 并 emit，而前端
# render-right-stage-body.tsx 对未知 kind 走到末尾 `return null` → 用户看到空白页签，
# 原来那一页被顶掉。判据：未知 kind 必须抛错，且文案点名可用清单 + 指路 ui.kinds。
# （两条 import 已提到文件顶部，见第122轮注释。）


def test_unknown_kind_is_rejected_not_opened():
    """判据：ok:false + 文案点名清单，且连 apply_right_panel 都不该被调到（否则已 emit）。"""
    with patch("evoflow.tools.builtins.stage_tool.apply_right_panel") as ap:
        res = dispatch_platform_action("ui.show", args_json='{"kind":"not-a-kind","data":{}}')
    assert res.get("ok") is False
    err = str(res.get("error") or "")
    assert "unknown right-panel kind" in err
    assert "ui.kinds" in err
    assert ap.called is False


def test_ui_update_also_rejects_unknown_kind():
    with patch("evoflow.tools.builtins.stage_tool.apply_right_panel") as ap:
        res = dispatch_platform_action("ui.update", args_json='{"kind":"nope","data":{}}')
    assert res.get("ok") is False
    assert "unknown right-panel kind" in str(res.get("error") or "")
    assert ap.called is False


def test_known_kinds_keep_working_including_internal_ones():
    """内部调用方用的 write/file/terminal 也必须算合法，别被白名单误杀。"""
    for k in ("write", "file", "terminal", "web-embed", "shell-page", "collab-workflow"):
        assert is_known_kind(k), k
    # 契约里的 8 种必然在集合内
    assert {"collab-workflow", "sessionRuntime", "shell-page"} <= KNOWN_KINDS()


def test_kind_alias_is_normalized_before_check():
    """别名（employee-process / github web…）归一后必须放行，不许因别名被误拒。"""
    with patch("evoflow.tools.builtins.stage_tool.apply_right_panel") as ap:
        ap.return_value = {"ok": True}
        dispatch_platform_action(
            "ui.show",
            args_json='{"kind":"employee-process","data":{"agentCode":"xiaomi"}}',
        )
    assert ap.call_count == 1
    assert ap.call_args.kwargs["kind"] == "employeeProcess"


# ── 第122轮：ui.panel op=action 的平铺布尔参数必须真的转发────────────────────
# 【self-evolution-bot · 2026-11-22 · 第122轮 · 模型:deepseek-v4.1-flash】
# 为什么：为对齐「语音侧开栏 ↔ ui.show 开栏」逐层比对时，发现 openXiaomi 分支读的是
# params.voiceMode / params.showRightStage / params.navigateToChat（panel-api.ts:332），
# 而平台侧 op=action 只转发 path/hash/route/sessionKey/key/surface/kind 七个键 ——
# 模型平铺写 voiceMode=true 会被静默丢掉：只开文字侧栏、不进语音全屏，回执仍 ok:true。
# 判据：三个布尔任一平铺传入，都必须以 bool 落进转发的 params，且不得被转成字符串。


def _capture_action_params(args_json: str) -> dict:
    """拦住 panel_request，只取它实际收到的 body.params。"""
    from unittest.mock import patch

    import evoflow.tools.builtins.panel_engine as pe

    captured: dict = {}

    def _fake(method, route, *, body=None, timeout=None):
        captured["route"] = route
        captured["body"] = body or {}
        return {"ok": True}

    with patch.object(pe, "panel_request", side_effect=_fake):
        dispatch_platform_action("ui.panel", args_json=args_json)
    return captured.get("body") or {}


def test_ui_panel_open_xiaomi_forwards_voice_mode():
    body = _capture_action_params(
        '{"op":"action","name":"openXiaomi","voiceMode":true,"showRightStage":false}'
    )
    assert body.get("action") == "openXiaomi"
    params = body.get("params") or {}
    assert params.get("voiceMode") is True, params
    assert params.get("showRightStage") is False, params


def test_ui_panel_open_xiaomi_bool_strings_are_normalized():
    """模型常把布尔写成字符串；'false' 必须归一成 False，不能原样传给前端当 truthy。"""
    body = _capture_action_params(
        '{"op":"action","name":"openXiaomi","voiceMode":"true","navigateToChat":"false"}'
    )
    params = body.get("params") or {}
    assert params.get("voiceMode") is True, params
    assert params.get("navigateToChat") is False, params


def test_ui_panel_open_xiaomi_params_object_still_wins():
    """params 里已显式给的值不得被平铺别名覆盖。"""
    body = _capture_action_params(
        '{"op":"action","name":"openXiaomi","voiceMode":false,'
        '"params":{"voiceMode":true}}'
    )
    params = body.get("params") or {}
    assert params.get("voiceMode") is True, params
