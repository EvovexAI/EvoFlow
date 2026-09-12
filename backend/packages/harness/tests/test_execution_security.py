"""Tests for runtime-aligned execution_security contracts."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from evoflow.execution_security.approval import (
    AskForApproval,
    decide_shell_approval,
    map_evoflow_policy_to_ask,
    normalize_ask,
)
from evoflow.execution_security.config import (
    ExecutionSecurityConfig,
    get_execution_security_config,
    load_execution_security_config_from_dict,
    set_execution_security_config,
)
from evoflow.execution_security.errors import HelperUnavailable
from evoflow.execution_security.helpers import HelperPaths, discover_helpers
from evoflow.execution_security.profiles import (
    PROFILE_DANGER_FULL_ACCESS,
    PROFILE_READ_ONLY,
    PROFILE_WORKSPACE,
    build_permission_profile_json,
    normalize_profile_id,
    permission_profile_to_json_str,
)
from evoflow.execution_security.runner import (
    build_shell_argv,
    run_sandboxed,
    wrap_argv_for_sandbox,
)


@pytest.fixture(autouse=True)
def _reset_sec_config():
    prev = get_execution_security_config()
    set_execution_security_config(ExecutionSecurityConfig())
    yield
    set_execution_security_config(prev)


def test_normalize_profile_aliases():
    assert normalize_profile_id(":workspace") == PROFILE_WORKSPACE
    assert normalize_profile_id("read_only") == PROFILE_READ_ONLY
    assert normalize_profile_id(":danger-full-access") == PROFILE_DANGER_FULL_ACCESS
    assert normalize_profile_id(None) == PROFILE_WORKSPACE


def test_workspace_profile_json_shape():
    doc = build_permission_profile_json(PROFILE_WORKSPACE)
    assert doc["type"] == "managed"
    assert doc["network"] == "restricted"
    assert doc["file_system"]["type"] == "restricted"
    kinds = [e["path"]["value"]["kind"] for e in doc["file_system"]["entries"]]
    assert "root" in kinds
    assert "project_roots" in kinds
    raw = permission_profile_to_json_str(PROFILE_WORKSPACE)
    assert json.loads(raw) == doc


def test_read_only_and_danger_profiles():
    ro = build_permission_profile_json(PROFILE_READ_ONLY)
    assert ro["type"] == "managed"
    assert len(ro["file_system"]["entries"]) == 1
    assert ro["file_system"]["entries"][0]["access"] == "read"

    danger = build_permission_profile_json(PROFILE_DANGER_FULL_ACCESS)
    assert danger == {"type": "disabled"}


def test_ask_and_evoflow_policy_bridge():
    assert normalize_ask("on-failure") is AskForApproval.ON_REQUEST
    assert map_evoflow_policy_to_ask("grant_all") is AskForApproval.NEVER
    assert map_evoflow_policy_to_ask("prompt") is AskForApproval.UNTRUSTED
    assert map_evoflow_policy_to_ask("session") is AskForApproval.ON_REQUEST

    d = decide_shell_approval(ask=AskForApproval.NEVER, command="rm -rf /")
    assert d.needs_approval is False

    d2 = decide_shell_approval(ask=AskForApproval.UNTRUSTED, command="ls")
    assert d2.needs_approval is True

    d3 = decide_shell_approval(already_granted=True, command="ls")
    assert d3.needs_approval is False


def test_load_config_from_dict():
    load_execution_security_config_from_dict(
        {
            "enabled": True,
            "profile": ":workspace",
            "approval": "never",
            "windows_level": "elevated",
            "allow_passthrough": False,
        }
    )
    cfg = get_execution_security_config()
    assert cfg.enabled is True
    assert cfg.profile == PROFILE_WORKSPACE
    assert cfg.approval == "never"
    assert cfg.windows_level == "elevated"
    assert cfg.allow_passthrough is False


def test_wrap_passthrough_when_disabled(tmp_path: Path):
    argv, mode = wrap_argv_for_sandbox(
        ["echo", "hi"],
        command_cwd=tmp_path,
        cfg=ExecutionSecurityConfig(enabled=False, auto_enable_when_helpers_ready=False),
    )
    assert mode == "passthrough"
    assert argv == ["echo", "hi"]


def test_auto_enable_when_helpers_ready_by_default(tmp_path: Path):
    from evoflow.execution_security.config import is_execution_security_active

    cfg = ExecutionSecurityConfig(enabled=False)  # default auto_enable=True
    assert cfg.auto_enable_when_helpers_ready is True
    fake_ready = HelperPaths(windows_sandbox=tmp_path / "evoflow-windows-sandbox.exe")
    (tmp_path / "evoflow-windows-sandbox.exe").write_bytes(b"x")
    with patch(
        "evoflow.execution_security.helpers.discover_helpers",
        return_value=fake_ready,
    ), patch("sys.platform", "win32"):
        assert is_execution_security_active(cfg) is True

    with patch(
        "evoflow.execution_security.helpers.discover_helpers",
        return_value=HelperPaths(),
    ):
        assert is_execution_security_active(cfg) is False


def test_wrap_passthrough_when_helpers_missing(tmp_path: Path):
    cfg = ExecutionSecurityConfig(enabled=True, allow_passthrough=True)
    fake = HelperPaths()  # nothing resolved
    with patch(
        "evoflow.execution_security.runner.discover_helpers",
        return_value=fake,
    ):
        argv, mode = wrap_argv_for_sandbox(
            ["echo", "hi"],
            command_cwd=tmp_path,
            cfg=cfg,
            helpers=fake,
        )
    assert mode == "passthrough"
    assert argv == ["echo", "hi"]


def test_wrap_raises_when_passthrough_forbidden(tmp_path: Path):
    cfg = ExecutionSecurityConfig(enabled=True, allow_passthrough=False)
    fake = HelperPaths()
    with pytest.raises(HelperUnavailable):
        wrap_argv_for_sandbox(
            ["echo", "hi"],
            command_cwd=tmp_path,
            cfg=cfg,
            helpers=fake,
        )


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="linux helper argv only")
def test_linux_wrapper_argv_shape(tmp_path: Path):
    helper = tmp_path / "codex-linux-sandbox"
    helper.write_text("#!/bin/sh\n", encoding="utf-8")
    helper.chmod(0o755)
    paths = HelperPaths(linux_sandbox=helper)
    cfg = ExecutionSecurityConfig(enabled=True, allow_passthrough=False, profile="workspace")
    argv, mode = wrap_argv_for_sandbox(
        ["uname", "-a"],
        command_cwd=tmp_path,
        cfg=cfg,
        helpers=paths,
    )
    assert mode == "sandboxed"
    assert argv[0] == str(helper)
    assert "--permission-profile" in argv
    assert "--" in argv
    assert argv[argv.index("--") + 1 :] == ["uname", "-a"]
    idx = argv.index("--permission-profile")
    json.loads(argv[idx + 1])  # valid JSON


@pytest.mark.skipif(sys.platform != "win32", reason="windows helper argv only")
def test_windows_wrapper_argv_shape(tmp_path: Path):
    helper = tmp_path / "evoflow-windows-sandbox.exe"
    helper.write_bytes(b"MZ")
    paths = HelperPaths(windows_sandbox=helper)
    cfg = ExecutionSecurityConfig(
        enabled=True,
        allow_passthrough=False,
        profile="workspace",
        windows_level="restricted-token",
    )
    argv, mode = wrap_argv_for_sandbox(
        ["cmd.exe", "/c", "echo hi"],
        command_cwd=tmp_path,
        cfg=cfg,
        helpers=paths,
    )
    assert mode == "sandboxed"
    assert argv[0] == str(helper)
    assert "--run-as-windows-sandbox" in argv
    assert "--windows-sandbox-level" in argv
    assert "restricted-token" in argv
    assert "--" in argv


def test_run_sandboxed_passthrough_echo(tmp_path: Path):
    set_execution_security_config(
        ExecutionSecurityConfig(enabled=False, auto_enable_when_helpers_ready=False)
    )
    if sys.platform == "win32":
        result = run_sandboxed("echo hello-sec", cwd=tmp_path, timeout=30)
    else:
        result = run_sandboxed("echo hello-sec", cwd=tmp_path, timeout=30)
    assert result.mode == "passthrough"
    assert result.exit_code == 0
    assert "hello-sec" in (result.stdout + result.stderr)


def test_build_shell_argv_nonempty():
    argv = build_shell_argv("echo 1")
    assert isinstance(argv, list) and len(argv) >= 2


def test_discover_helpers_does_not_raise():
    paths = discover_helpers()
    assert isinstance(paths, HelperPaths)


def test_execution_security_status_shape():
    from evoflow.execution_security.status import execution_security_status

    st = execution_security_status()
    assert "mode" in st and "helpers_ready" in st and "active" in st


def test_patch_execution_security_settings_updates_memory(monkeypatch, tmp_path):
    from evoflow.execution_security.config import ExecutionSecurityConfig, set_execution_security_config
    from evoflow.execution_security.persist import patch_execution_security_settings

    store: dict = {}

    def _get(key: str):
        return store.get(key)

    def _set(key: str, value):
        store[key] = value

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_app_setting",
        _get,
    )
    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.set_app_setting",
        _set,
    )
    set_execution_security_config(ExecutionSecurityConfig(enabled=False, profile="workspace"))
    st = patch_execution_security_settings(
        {"enabled": True, "profile": "read-only", "approval": "never"}
    )
    assert st["enabled"] is True
    assert st["profile"] == "read-only"
    assert st["approval"] == "never"
    assert store.get("execution.security", {}).get("profile") == "read-only"


def test_windows_level_alias_restricted():
    load_execution_security_config_from_dict({"windows_level": "restricted"})
    assert get_execution_security_config().windows_level == "restricted-token"


def test_tool_risk_respects_execution_security_approval():
    from evoflow.agents.tool_approval_config import RISK_AUTO, RISK_CONFIRM, tool_risk_level

    set_execution_security_config(
        ExecutionSecurityConfig(enabled=True, approval="never", allow_passthrough=True)
    )
    assert tool_risk_level("terminal", {"command": "rm -rf /"}) == RISK_AUTO

    set_execution_security_config(
        ExecutionSecurityConfig(enabled=True, approval="untrusted", allow_passthrough=True)
    )
    assert tool_risk_level("terminal", {"command": "ls"}) == RISK_CONFIRM
    assert tool_risk_level("bash", {"command": "ls"}) == RISK_CONFIRM

    set_execution_security_config(ExecutionSecurityConfig(enabled=False))
    assert tool_risk_level("terminal", {"command": "ls"}) == RISK_CONFIRM
