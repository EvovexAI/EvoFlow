"""Admin service errors (CLI and programmatic callers)."""

from __future__ import annotations


class AdminError(Exception):
    """Raised when an admin operation fails with a user-facing message."""

    def __init__(self, message: str, *, exit_code: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code


class NotFoundError(AdminError):
    def __init__(self, message: str) -> None:
        super().__init__(message, exit_code=2)


class ConflictError(AdminError):
    def __init__(self, message: str) -> None:
        super().__init__(message, exit_code=3)


class ValidationError(AdminError):
    def __init__(self, message: str) -> None:
        super().__init__(message, exit_code=4)


class ForbiddenError(AdminError):
    def __init__(self, message: str) -> None:
        super().__init__(message, exit_code=5)
