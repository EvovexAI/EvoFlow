"""WebUI remote-access authentication and management.

Exposes password hashing, JWT generation/verification, QR-token store,
and admin-user management for the WebUI remote-access feature.
"""

from .auth import (
    QrTokenStore,
    generate_jwt,
    generate_password,
    get_lan_access_urls,
    get_or_create_admin_user,
    get_webui_secret,
    get_webui_status,
    hash_password,
    is_local_request,
    is_webui_enabled,
    qr_token_store,
    set_webui_enabled,
    verify_jwt,
    verify_password,
)
from .middleware import create_webui_auth_middleware

__all__ = [
    "QrTokenStore",
    "create_webui_auth_middleware",
    "generate_jwt",
    "generate_password",
    "get_lan_access_urls",
    "get_or_create_admin_user",
    "get_webui_secret",
    "get_webui_status",
    "hash_password",
    "is_local_request",
    "is_webui_enabled",
    "qr_token_store",
    "set_webui_enabled",
    "verify_jwt",
    "verify_password",
]
