"""Typed Knowledge Vault errors with stable error codes."""

from __future__ import annotations

from typing import Any


class KnowledgeError(Exception):
    """Base error for Knowledge Vault operations."""

    code: str = "invalid_provider_response"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        details: dict[str, Any] | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        if code:
            self.code = code
        self.message = message
        self.details = details or {}
        self.__cause__ = cause

    def to_dict(self, *, sanitize: bool = True) -> dict[str, Any]:
        from evoflow.knowledge.vault.sanitize import sanitize_text

        msg = sanitize_text(self.message) if sanitize else self.message
        out: dict[str, Any] = {"error": self.code, "message": msg}
        if self.details:
            details = dict(self.details)
            if sanitize:
                for k, v in list(details.items()):
                    if isinstance(v, str):
                        details[k] = sanitize_text(v)
            out["details"] = details
        return out


class KnowledgeDisabledError(KnowledgeError):
    code = "knowledge_disabled"


class VaultNotFoundError(KnowledgeError):
    code = "vault_not_found"


class ProviderUnavailableError(KnowledgeError):
    code = "provider_unavailable"


class SearchProviderUnavailableError(KnowledgeError):
    code = "search_provider_unavailable"


class WriteProviderUnavailableError(KnowledgeError):
    code = "write_provider_unavailable"


class ObsidianNotRunningError(KnowledgeError):
    code = "obsidian_not_running"


class ObsidianApiKeyInvalidError(KnowledgeError):
    code = "obsidian_api_key_invalid"


class IndexNotInitializedError(KnowledgeError):
    code = "index_not_initialized"


class NodeRuntimeMissingError(KnowledgeError):
    code = "node_runtime_missing"


class PackageInstallFailedError(KnowledgeError):
    code = "package_install_failed"


class PathForbiddenError(KnowledgeError):
    code = "path_forbidden"


class PathEscapeDetectedError(KnowledgeError):
    code = "path_escape_detected"


class WriteDisabledError(KnowledgeError):
    code = "write_disabled"


class WriteConfirmationRequiredError(KnowledgeError):
    code = "write_confirmation_required"


class ToolTimeoutError(KnowledgeError):
    code = "tool_timeout"


class RequiredToolMissingError(KnowledgeError):
    code = "required_tool_missing"


class NoteConflictError(KnowledgeError):
    code = "note_conflict"


class InvalidProviderResponseError(KnowledgeError):
    code = "invalid_provider_response"


def map_exception(exc: BaseException) -> KnowledgeError:
    """Map arbitrary exceptions to a KnowledgeError without swallowing the cause."""
    if isinstance(exc, KnowledgeError):
        return exc
    text = str(exc) or type(exc).__name__
    lower = text.lower()
    if "timed out" in lower or "timeout" in lower:
        return ToolTimeoutError(text, cause=exc)
    if "connection refused" in lower or "connect" in lower and "obsidian" in lower:
        return ObsidianNotRunningError(text, cause=exc)
    if "401" in lower or "unauthorized" in lower or "api key" in lower:
        return ObsidianApiKeyInvalidError(text, cause=exc)
    if "index" in lower and ("not" in lower or "missing" in lower):
        return IndexNotInitializedError(text, cause=exc)
    return ProviderUnavailableError(text, cause=exc)
