"""Terminal foreground timeout defaults and recovery hints."""

from __future__ import annotations

from evoflow.tools.host_direct.terminal_tool import (
    _DEFAULT_TIMEOUT,
    _foreground_timeout,
    _timeout_recovery_hint,
)


def test_default_timeout_constant_is_30():
    assert _DEFAULT_TIMEOUT == 30


def test_omitted_timeout_uses_default_30():
    assert _foreground_timeout("git status", _DEFAULT_TIMEOUT, explicit_timeout=False) == 30


def test_omitted_curl_timeout_capped_at_15():
    assert _foreground_timeout("curl -I http://127.0.0.1:8080", _DEFAULT_TIMEOUT, explicit_timeout=False) == 15


def test_explicit_timeout_honored_even_when_short():
    assert _foreground_timeout("git add -A", 10, explicit_timeout=True) == 10


def test_timeout_hint_prefers_process_for_npm_test():
    hint = _timeout_recovery_hint("npm run test", 30, explicit_timeout=False)
    assert "process" in hint


def test_timeout_hint_warns_on_short_explicit_git_add():
    hint = _timeout_recovery_hint("git add -A", 10, explicit_timeout=True)
    assert "git add -A" in hint
    assert "timeout=10" in hint
    assert "30" in hint
