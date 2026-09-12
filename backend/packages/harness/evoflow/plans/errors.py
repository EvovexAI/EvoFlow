"""Plan Bundle error codes and exceptions."""

from __future__ import annotations

from enum import StrEnum


class PlanErrorCode(StrEnum):
    PLAN_NOT_BOUND = "plan_not_bound"
    CAPABILITY_NOT_IN_TIER = "capability_not_in_tier"
    DEDUCT_NOT_ENABLED = "deduct_not_enabled"
    QUOTA_EXHAUSTED = "quota_exhausted"
    WRONG_KEY_TYPE = "wrong_key_type"
    VENDOR_UNAVAILABLE = "vendor_unavailable"
    INVALID_REQUEST = "invalid_request"
    CATALOG_NOT_FOUND = "catalog_not_found"
    BINDING_NOT_FOUND = "binding_not_found"


class PlanError(Exception):
    def __init__(self, code: PlanErrorCode, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict:
        return {
            "code": str(self.code),
            "message": self.message,
            "details": self.details,
        }
