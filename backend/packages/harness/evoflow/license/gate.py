"""FastAPI dependency helpers for premium entitlement."""

from __future__ import annotations

from fastapi import HTTPException

from evoflow.license.entitlements import is_premium_active, premium_denial_code


def require_premium() -> None:
    """Raise 403 when premium entitlement is missing or expired."""
    if is_premium_active():
        return
    code = premium_denial_code()
    messages = {
        "license_expired": "高级功能授权已过期，请在设置 → 授权中续期",
        "license_machine_mismatch": "授权与本机机器码不匹配，请重新激活",
        "license_required": "高级功能未激活，请在设置 → 授权中输入激活码",
    }
    raise HTTPException(
        status_code=403,
        detail={
            "error": code,
            "message": messages.get(code, messages["license_required"]),
        },
    )
