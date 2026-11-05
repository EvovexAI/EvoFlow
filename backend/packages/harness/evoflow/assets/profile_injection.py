"""Tier-0 user profile injection (single ``profile/USER.md``)."""

from __future__ import annotations

from evoflow.assets.user_profile_dims import (
    ProfileInjectionScope,
    build_user_profile_injection_block,
    dimension_is_filled,
    ensure_user_profile_files,
    missing_profile_dimensions,
    profile_dimensions_for_scope,
    read_user_profile_combined,
    read_user_profile_dimensions,
    resolve_profile_injection_scope,
)

__all__ = [
    "ProfileInjectionScope",
    "build_user_profile_injection_block",
    "dimension_is_filled",
    "ensure_user_profile_files",
    "missing_profile_dimensions",
    "profile_dimensions_for_scope",
    "read_user_profile_combined",
    "read_user_profile_dimensions",
    "read_user_profile_text",
    "resolve_profile_injection_scope",
    "user_profile_is_placeholder",
]


def read_user_profile_text(*, max_chars: int | None = None) -> str:
    return read_user_profile_combined(max_chars=max_chars)


def user_profile_is_placeholder(text: str | None = None) -> bool:
    if text is not None:
        from evoflow.assets.user_profile_dims import _strip_placeholder_body

        return not _strip_placeholder_body(str(text or "")).strip()
    dims = read_user_profile_dimensions(max_chars_per_dim=8000, strip_placeholders=True)
    return not any(v.strip() for v in dims.values())
