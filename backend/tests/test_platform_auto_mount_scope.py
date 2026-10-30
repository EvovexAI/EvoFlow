"""platform 自动挂载范围：main/小V 默认带，普通员工默认不带；可勾选 opt-in。"""

from __future__ import annotations

from evoflow.tools.tool_catalog import (
    is_role_editor_configurable_tool,
    should_auto_mount_agent_mode_system_tools,
    should_mount_platform_tool,
)


def test_main_auto_mounts_platform():
    assert should_auto_mount_agent_mode_system_tools("main") is True
    assert should_auto_mount_agent_mode_system_tools("MAIN") is True


def test_xiaomi_auto_mounts_platform():
    assert should_auto_mount_agent_mode_system_tools("xiaomi") is True


def test_employee_does_not_auto_mount_platform():
    assert should_auto_mount_agent_mode_system_tools("duty_clerk") is False
    assert should_auto_mount_agent_mode_system_tools("writer") is False


def test_im_inbound_force_mounts_platform_for_employee():
    # Channel-bound employees need platform to call channels.send_message.
    assert (
        should_auto_mount_agent_mode_system_tools("duty_clerk", im_channel="feishu")
        is True
    )
    assert should_mount_platform_tool("writer", im_channel="wecom") is True
    assert should_mount_platform_tool("writer", im_channel="voice") is False
    assert should_mount_platform_tool("writer", im_channel="") is False


def test_employee_opt_in_via_mount_platform_tools():
    assert (
        should_auto_mount_agent_mode_system_tools(
            "duty_clerk",
            mount_platform_tools=True,
        )
        is True
    )


def test_platform_is_role_editor_selectable():
    assert is_role_editor_configurable_tool("platform") is True


def test_employee_opt_in_via_tools_whitelist():
    assert (
        should_mount_platform_tool(
            "duty_clerk",
            tools_whitelist=["read", "platform", "bash"],
        )
        is True
    )
    assert should_mount_platform_tool("duty_clerk", tools_whitelist=["read", "bash"]) is False


def test_agent_tools_resolver_drops_platform_for_employee(monkeypatch):
    from evoflow.session_tool_binding import agent_tools as at

    at.invalidate_agent_tool_names_cache()

    class _T:
        def __init__(self, name: str):
            self.name = name

    monkeypatch.setattr(
        "evoflow.tools.get_available_tools",
        lambda **_kwargs: [_T("read"), _T("platform"), _T("bash")],
    )
    monkeypatch.setattr(at, "load_agent_config", lambda _aid: None)

    names = at.resolve_agent_tool_names_for_agent("duty_clerk")
    assert "platform" not in names
    assert "read" in names

    names_main = at.resolve_agent_tool_names_for_agent("main")
    assert "platform" in names_main


def test_agent_tools_resolver_keeps_platform_when_whitelisted(monkeypatch):
    from types import SimpleNamespace

    from evoflow.session_tool_binding import agent_tools as at

    at.invalidate_agent_tool_names_cache()

    class _T:
        def __init__(self, name: str):
            self.name = name

    monkeypatch.setattr(
        "evoflow.tools.get_available_tools",
        lambda **_kwargs: [_T("read"), _T("platform"), _T("bash")],
    )
    monkeypatch.setattr(
        at,
        "load_agent_config",
        lambda _aid: SimpleNamespace(
            tools=["read", "platform"],
            disallowed_tools=None,
            mcp_servers=None,
        ),
    )

    names = at.resolve_agent_tool_names_for_agent("duty_clerk")
    assert "platform" in names
    assert "read" in names
