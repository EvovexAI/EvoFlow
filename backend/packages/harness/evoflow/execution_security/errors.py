"""Typed failures for the execution security layer."""

from __future__ import annotations


class ExecutionSecurityError(Exception):
    """Base class for sandbox / policy / approval failures."""

    code: str = "execution_security_error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code


class SandboxDenied(ExecutionSecurityError):
    """OS sandbox rejected the action (path / network / capability)."""

    code = "sandbox_denied"


class PolicyDenied(ExecutionSecurityError):
    """Permission profile / policy rejected before spawn."""

    code = "policy_denied"


class UserDenied(ExecutionSecurityError):
    """User rejected the approval prompt."""

    code = "user_denied"


class HelperUnavailable(ExecutionSecurityError):
    """OS sandbox helper binary missing or not runnable on this OS."""

    code = "helper_unavailable"
