"""Tier-0 multi-dimension user profile injection."""

from __future__ import annotations

from evoflow.assets.user_profile_dims import (
    ProfileInjectionScope,
    build_user_profile_injection_block,
    default_user_profile_md,
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
    "default_user_profile_md",
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
        return not str(text or "").strip()
    dims = read_user_profile_dimensions(max_chars_per_dim=8000)
    return not any(v.strip() for v in dims.values())
