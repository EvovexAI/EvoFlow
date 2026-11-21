"""platform 卡头：与 action 同级的中文 title；无则不发明技术串。"""

from __future__ import annotations

import json

from evoflow.admin.platform_actions import dispatch_platform_action, get_registry


def test_read_action_stamps_action_summary_not_fake_title():
    out = dispatch_platform_action("knowledge.list")
    assert out.get("ok") is True
    entry = get_registry()["knowledge.list"]
    assert out.get("action_summary") == entry.summary
    # 无作者 title：不 stamp 假 title（前端用中文动作短标签）
    assert not str(out.get("title") or "").strip()


def test_authored_title_sibling_of_action():
    """模型/入参 title → 结果与 action 同级保留，作卡头。"""
    out = dispatch_platform_action(
        "knowledge.ingest",
        args_json=json.dumps({"title": "英语大纲", "content": "hello"}),
    )
    assert out.get("pending_confirm") is True
    assert out.get("action") == "knowledge.ingest"
    assert out.get("title") == "英语大纲"
    assert out.get("action_summary")


def test_ui_panel_without_title_does_not_invent_cdp_string():
    out = dispatch_platform_action(
        "ui.panel",
        args_json=json.dumps(
            {
                "op": "cdp",
                "method": "Runtime.evaluate",
                "params": {"expression": "1+1", "returnByValue": True},
            }
        ),
    )
    assert out.get("action") == "ui.panel"
    title = str(out.get("title") or "")
    assert "Runtime.evaluate" not in title
    assert "CDP" not in title
    assert out.get("action_summary")


def test_mirror_only_lifts_authored_title():
    from app.gateway.v4.agui_mirror import _platform_ui_display_block

    with_title = json.dumps(
        {
            "ok": True,
            "action": "ui.panel",
            "title": "查看主界面字号",
            "action_summary": "控制主窗口……很长……",
        },
        ensure_ascii=False,
    )
    block = _platform_ui_display_block(None, with_title)
    assert block is not None
    assert block.get("title") == "查看主界面字号"

    no_title = json.dumps(
        {
            "ok": True,
            "action": "ui.panel",
            "action_summary": "控制主窗口（非侧栏浏览器）：snapshot/cdp…",
        },
        ensure_ascii=False,
    )
    assert _platform_ui_display_block(None, no_title) is None


def test_mirror_pending_confirm_with_authored_title():
    from app.gateway.v4.agui_mirror import _platform_ui_display_block

    content = json.dumps(
        {
            "ok": True,
            "pending_confirm": True,
            "action": "knowledge.ingest",
            "title": "英语大纲",
            "action_summary": "写入一篇笔记",
        },
        ensure_ascii=False,
    )
    block = _platform_ui_display_block(None, content)
    assert block is not None
    assert block.get("title") == "英语大纲"


def test_platform_activity_prefers_authored_title():
    from evoflow.tools.tool_activity_ui import labels_for_tool_call

    labels = labels_for_tool_call(
        {
            "name": "platform",
            "args": {
                "action": "ui.panel",
                "title": "查看主界面字号",
                "args_json": json.dumps({"op": "cdp", "method": "Runtime.evaluate"}),
            },
        }
    )
    assert len(labels) == 1
    assert "查看主界面字号" in labels[0]
    assert "Runtime.evaluate" not in labels[0]
