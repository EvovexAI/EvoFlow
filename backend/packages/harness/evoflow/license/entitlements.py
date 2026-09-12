"""Entitlement checks for premium features (tasks / apps / proactive)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from evoflow.license.codec import ENFORCE_MACHINE_BIND, FEATURE_PREMIUM
from evoflow.license.machine import get_machine_id, normalize_machine_id
from evoflow.license.store import get_license_state
from evoflow.timeutil import utc_now_iso_z

# Temporarily skip premium entitlement checks (activate/status APIs remain available).
# Set True to re-enable gate for tasks / apps / proactive.
ENFORCE_LICENSE_VERIFY = False


@dataclass(frozen=True)
class LicenseStatus:
    machine_id: str
    activated: bool
    expires_at: str | None
    features: tuple[str, ...]
    status: str  # inactive | active | expired | machine_mismatch
    activated_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        days_remaining: int | None = None
        duration_days: int | None = None
        exp_dt = _parse_expires_at(self.expires_at)
        act_dt = _parse_expires_at(self.activated_at)
        now = datetime.now(UTC)
        if exp_dt is not None:
            days_remaining = max(0, int((exp_dt - now).total_seconds() // 86400))
            if self.status == "expired":
                days_remaining = 0
            if act_dt is not None and exp_dt > act_dt:
                duration_days = max(1, int((exp_dt - act_dt).total_seconds() // 86400))
            elif days_remaining is not None and self.status == "active":
                duration_days = days_remaining
        return {
            "machine_id": self.machine_id,
            "activated": self.activated,
            "expires_at": self.expires_at,
            "features": list(self.features),
            "status": self.status,
            "activated_at": self.activated_at,
            "premium": self.activated and self.status == "active",
            "days_remaining": days_remaining,
            "duration_days": duration_days,
        }


def _parse_expires_at(raw: Any) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except Exception:
        return None


def get_license_status(*, machine_id: str | None = None) -> LicenseStatus:
    mid = normalize_machine_id(machine_id) if machine_id else get_machine_id()
    state = get_license_state() or {}
    if not state.get("activated"):
        return LicenseStatus(
            machine_id=mid,
            activated=False,
            expires_at=None,
            features=(),
            status="inactive",
        )

    stored_mid = normalize_machine_id(str(state.get("machine_id") or ""))
    features = tuple(str(x) for x in (state.get("features") or []) if str(x).strip())
    expires_at = str(state.get("expires_at") or "") or None
    activated_at = str(state.get("activated_at") or "") or None

    if ENFORCE_MACHINE_BIND and stored_mid and stored_mid != mid:
        return LicenseStatus(
            machine_id=mid,
            activated=False,
            expires_at=expires_at,
            features=features,
            status="machine_mismatch",
            activated_at=activated_at,
        )

    exp_dt = _parse_expires_at(expires_at)
    if exp_dt is None:
        return LicenseStatus(
            machine_id=mid,
            activated=False,
            expires_at=expires_at,
            features=features,
            status="inactive",
            activated_at=activated_at,
        )

    now = datetime.now(UTC)
    if now >= exp_dt:
        return LicenseStatus(
            machine_id=mid,
            activated=False,
            expires_at=expires_at,
            features=features,
            status="expired",
            activated_at=activated_at,
        )

    if FEATURE_PREMIUM not in features:
        return LicenseStatus(
            machine_id=mid,
            activated=False,
            expires_at=expires_at,
            features=features,
            status="inactive",
            activated_at=activated_at,
        )

    return LicenseStatus(
        machine_id=mid,
        activated=True,
        expires_at=expires_at,
        features=features,
        status="active",
        activated_at=activated_at,
    )


def is_premium_active(*, machine_id: str | None = None) -> bool:
    if not ENFORCE_LICENSE_VERIFY:
        return True
    st = get_license_status(machine_id=machine_id)
    return bool(st.activated and st.status == "active")


def premium_denial_code(*, machine_id: str | None = None) -> str:
    """Return ``license_required`` / ``license_expired`` / ``license_machine_mismatch``."""
    st = get_license_status(machine_id=machine_id)
    if st.status == "expired":
        return "license_expired"
    if st.status == "machine_mismatch":
        return "license_machine_mismatch"
    return "license_required"


def unix_to_expires_iso(exp_unix: int) -> str:
    dt = datetime.fromtimestamp(int(exp_unix), tz=UTC)
    return dt.isoformat().replace("+00:00", "Z")


def build_activated_state(
    *,
    machine_id: str,
    expires_at_unix: int,
    features: tuple[str, ...] | list[str],
    code_fp: str,
) -> dict[str, Any]:
    return {
        "activated": True,
        "machine_id": normalize_machine_id(machine_id),
        "expires_at": unix_to_expires_iso(expires_at_unix),
        "activated_at": utc_now_iso_z(),
        "features": list(features),
        "code_fp": code_fp,
    }
