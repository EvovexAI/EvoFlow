"""Apply persisted runtime env (media vendor keys + user custom KEY=VALUE) to process env."""

from __future__ import annotations

import os


def apply_runtime_env_to_mapping(env: dict[str, str]) -> None:
    """Load SQLite settings into *env* (media, web search, then custom env overrides)."""
    try:
        from evoflow.persistence.media_settings import apply_media_credentials_to_mapping

        apply_media_credentials_to_mapping(env)
    except Exception:
        pass
    try:
        from evoflow.persistence.web_search_settings import apply_web_search_credentials_to_mapping

        apply_web_search_credentials_to_mapping(env)
    except Exception:
        pass
    try:
        from evoflow.persistence.custom_env_settings import apply_custom_env_to_mapping

        apply_custom_env_to_mapping(env)
    except Exception:
        pass


def apply_runtime_env_to_environ() -> None:
    apply_runtime_env_to_mapping(os.environ)
