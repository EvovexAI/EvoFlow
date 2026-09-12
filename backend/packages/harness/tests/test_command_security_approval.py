"""Terminal allow-prefix must not bypass approval for compound/destructive commands."""

from __future__ import annotations

from evoflow.agents.tool_approval_config import (
    command_allow_prefix_bypass_ok,
    command_security_decision,
    tool_requires_approval,
)


def test_echo_redirect_chain_requires_approval() -> None:
    cmd = (
        'echo "临时文件" > D:/dev/coding/temp/test_again.txt; '
        "if (Test-Path D:/dev/coding/temp/test_again.txt) { "
        'Remove-Item D:/dev/coding/temp/test_again.txt; Write-Host "ok" }'
    )
    assert command_allow_prefix_bypass_ok(cmd) is False
    assert command_security_decision("terminal", {"command": cmd}) != "allow"
    assert tool_requires_approval("terminal", {"command": cmd}) is True


def test_plain_echo_still_prompts_after_default_change() -> None:
    cmd = 'echo hello'
    assert command_allow_prefix_bypass_ok(cmd) is True
    assert command_security_decision("terminal", {"command": cmd}) == "prompt"
    assert tool_requires_approval("terminal", {"command": cmd}) is True


def test_git_status_allow_bypass_still_works() -> None:
    cmd = "git status"
    assert command_allow_prefix_bypass_ok(cmd) is True
    assert command_security_decision("terminal", {"command": cmd}) == "allow"
    assert tool_requires_approval("terminal", {"command": cmd}) is False
