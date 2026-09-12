"""Persist license activation state in ``evoflow_app_settings``."""

from __future__ import annotations

from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

LICENSE_STATE_KEY = "license.state"


def get_license_state() -> dict[str, Any] | None:
    raw = cfg_repo.get_app_setting(LICENSE_STATE_KEY)
    if raw is None:
        return None
    if isinstance(raw, dict):
        return dict(raw)
    return None


def set_license_state(state: dict[str, Any]) -> None:
    cfg_repo.set_app_setting(LICENSE_STATE_KEY, dict(state))


def clear_license_state() -> None:
    def _do(db: Any) -> None:
        db.execute(
            "DELETE FROM evoflow_app_settings WHERE key = ?",
            (LICENSE_STATE_KEY,),
        )

    from evoflow.persistence.db import run_db_transaction

    run_db_transaction(_do)
