"""assistant_guide payloads for employee / knowledge create and bind-channel begin."""

from evoflow.admin.assistant_guides import (
    build_agent_create_assistant_guide,
    build_bind_channel_begin_assistant_guide,
    build_employee_create_assistant_guide,
    build_knowledge_create_assistant_guide,
)
from evoflow.admin.platform_ui_feedback import build_platform_ui_feedback
from evoflow.admin.platform_actions import get_registry


def test_employee_create_guide_has_say_to_user_and_bind_hint():
    guide = build_employee_create_assistant_guide(
        {"agent_code": "duty-ops", "role_name": "运维值班"}
    )
    assert guide["status"] == "employee_created"
    say = guide["say_to_user"]
    assert "运维值班" in say
    assert "duty-ops" in say
    assert "对话" in say or "面板" in say
    assert "飞书" in say or "企微" in say
    assert "派发" in say or "派" in say
    assert "上班" in say or "值班" in say
    # No bindings payload → do not invent inherit-all.
    assert "已绑定" not in say
    assert any("bind_channel_begin" in s for s in guide["next_steps"])


def test_employee_create_guide_lists_bindings():
    guide = build_employee_create_assistant_guide(
        {
            "agent_code": "writer-1",
            "role_name": "文案",
            "bindings_applied": {
                "tools_mode": "allowlist",
                "tools": ["web_search", "write_file"],
                "skills": ["blog-writer"],
                "mcp_servers": [],
                "knowledge_vault_ids": ["kb_docs"],
                "capability_pack": "writer",
            },
        }
    )
    say = guide["say_to_user"]
    assert "已绑定" in say
    assert "writer" in say
    assert "web_search" in say
    assert "blog-writer" in say
    assert "kb_docs" in say
    assert guide["bindings"]["tools_mode"] == "allowlist"


def test_agent_create_guide_lists_bindings():
    guide = build_agent_create_assistant_guide(
        {
            "ok": True,
            "agent": {
                "agent_code": "research-bot",
                "agent_name": "调研助手",
                "bindings_applied": {
                    "tools_mode": "allowlist",
                    "tools": ["web_search"],
                    "skills": [],
                    "mcp_servers": ["browser"],
                    "knowledge_vault_ids": [],
                    "capability_pack": "research",
                },
            },
        }
    )
    assert guide["status"] == "agent_created"
    say = guide["say_to_user"]
    assert "调研助手" in say
    assert "已绑定" in say
    assert "web_search" in say
    assert "browser" in say
    assert "research" in say


def test_knowledge_create_guide_has_say_to_user():
    guide = build_knowledge_create_assistant_guide(
        {"name": "产品手册", "kbId": "kb_abc", "base": {"id": "kb_abc", "name": "产品手册"}}
    )
    assert guide["status"] == "knowledge_created"
    assert "产品手册" in guide["say_to_user"]
    assert "ingest" in " ".join(guide["next_steps"])


def test_bind_channel_begin_guide_is_short():
    guide = build_bind_channel_begin_assistant_guide(
        agent_code="duty-ops",
        role_name="运维值班",
        channel="feishu",
        qr_url="https://example.com/qr",
        session_id="sess_1",
    )
    assert guide["status"] == "bind_qr_ready"
    say = guide["say_to_user"]
    assert "运维值班" in say
    assert "飞书" in say
    assert "二维码" not in say
    assert "右侧" not in say
    assert "![](" not in say
    assert "http" not in say
    assert guide["qr_url"] == "https://example.com/qr"
    assert guide["instruction"] == "向用户复述 say_to_user。"


def test_bind_channel_begin_ui_includes_qr_fields():
    entry = get_registry().get("employees.bind_channel_begin")
    assert entry is not None
    result = {
        "ok": True,
        "action": "employees.bind_channel_begin",
        "agent_code": "duty-ops",
        "role_name": "运维值班",
        "channel": "feishu",
        "session_id": "sess_1",
        "qr_url": "https://example.com/qr",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops", "channel": "feishu"}, result)
    assert ui is not None
    assert ui.get("qrUrl") == "https://example.com/qr"
    assert ui.get("sessionId") == "sess_1"
    assert ui.get("channel") == "feishu"
    assert ui.get("agentCode") == "duty-ops"
    assert ui.get("bindStatus") == "pending"


def test_employee_create_ui_includes_binding_details():
    entry = get_registry().get("employees.create")
    assert entry is not None
    result = {
        "ok": True,
        "action": "employees.create",
        "agent_code": "writer-1",
        "role_name": "文案",
        "bindings_applied": {
            "tools_mode": "allowlist",
            "tools": ["web_search", "write_file"],
            "skills": ["blog-writer"],
            "mcp_servers": [],
            "knowledge_vault_ids": ["kb_docs"],
            "capability_pack": "writer",
        },
    }
    ui = build_platform_ui_feedback(entry, {"role_name": "文案"}, result)
    assert ui is not None
    assert "web_search" in (ui.get("subtitle") or "")
    labels = {d.get("label") for d in (ui.get("details") or []) if isinstance(d, dict)}
    assert "工具" in labels
    assert "技能" in labels
    assert "知识库" in labels


def test_sse_extract_platform_ui_from_bind_result():
    from app.gateway.sse_ui_normalize import (
        _attach_platform_ui_to_tool_result_frame,
        _extract_platform_ui,
        _slim_tool_result_message,
    )

    content = (
        '{"ok":true,"action":"employees.bind_channel_begin",'
        '"ui":{"kind":"success","title":"扫码绑定","qrUrl":"https://example.com/qr",'
        '"sessionId":"s1","channel":"feishu","bindStatus":"pending"}}'
    )
    ui = _extract_platform_ui(content)
    assert ui is not None
    assert ui.get("qrUrl") == "https://example.com/qr"

    slimmed = _slim_tool_result_message(
        {
            "type": "tool",
            "role": "tool",
            "tool_call_id": "tc1",
            "name": "platform",
            "content": content,
            "status": "ok",
        }
    )
    assert isinstance(slimmed.get("platform_ui"), dict)
    assert slimmed["platform_ui"].get("qrUrl") == "https://example.com/qr"

    frame = _attach_platform_ui_to_tool_result_frame(
        {
            "type": "tool_result",
            "tool": slimmed,
            "tool_call_id": "tc1",
            "content": "",
            "status": "ok",
        },
        slimmed,
    )
    assert frame["platform_ui"]["qrUrl"] == "https://example.com/qr"


def test_v4_platform_ui_display_block_from_wire_and_content():
    from app.gateway.v4.agui_mirror import _platform_ui_display_block

    wire = {
        "action": "employees.bind_channel_begin",
        "title": "扫码绑定",
        "qrUrl": "https://example.com/qr",
        "sessionId": "s1",
        "channel": "feishu",
        "agentCode": "duty-ops",
        "bindStatus": "pending",
    }
    block = _platform_ui_display_block(wire, "")
    assert block is not None
    assert block["kind"] == "platform_ui"
    assert block["schemaVersion"] == 1
    assert block["qrUrl"] == "https://example.com/qr"
    assert block["sessionId"] == "s1"
    assert block["agentCode"] == "duty-ops"

    content = (
        '{"ok":true,"action":"employees.bind_channel_begin",'
        '"qr_url":"https://example.com/from-json","session_id":"s2",'
        '"channel":"wecom","agent_code":"ops"}'
    )
    from_json = _platform_ui_display_block(None, content)
    assert from_json is not None
    assert from_json["qrUrl"] == "https://example.com/from-json"
    assert from_json["sessionId"] == "s2"
    assert from_json["channel"] == "wecom"

    assert _platform_ui_display_block({"title": "noop"}, "") is None
