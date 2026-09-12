"""WebUI remote-access authentication core.

Provides:
* Password hashing (PBKDF2-HMAC-SHA256, 100k iterations) — a stdlib alternative
  to bcrypt since the ``bcrypt`` package is not installed.
* JWT generation/verification via PyJWT (HS256, 7-day expiry).
* :class:`QrTokenStore` — one-time QR login tokens with 5-minute TTL.
* Admin-user management against the ``evoflow_webui_users`` table (schema v63).
* WebUI status / LAN access-URL discovery.

All DB access follows the shared ``get_db()`` + ``run_db_transaction`` pattern.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import secrets
import socket
import threading
import time
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction

from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)

_WEBUI_ENABLED_KEY = "webui.enabled"
_WEBUI_JWT_SECRET_KEY = "webui.jwt_secret"
_WEBUI_HTTP_PORT_KEY = "webui.http_port"
WEBUI_DEFAULT_HTTP_PORT = 1420

# ── Constants ────────────────────────────────────────────────

_PBKDF2_ITERATIONS = 100_000
_PBKDF2_ALGO = "sha256"
_SALT_BYTES = 16
_HASH_FORMAT = "pbkdf2${algo}${iterations}${salt_hex}${hash_hex}"

_JWT_EXPIRY_DAYS = 7
_JWT_ALGORITHM = "HS256"

_QR_TOKEN_BYTES = 32
_QR_TOKEN_TTL_MS = 5 * 60 * 1000  # 5 minutes

_PASSWORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*"
_PASSWORD_MIN_LEN = 12

# In-process WebUI enabled flag (persisted to runtime_settings).
_webui_enabled: bool = False
_webui_enabled_lock = threading.Lock()


# ── Password hashing ─────────────────────────────────────────


def hash_password(password: str) -> str:
    """Hash a password using PBKDF2-HMAC-SHA256.

    Args:
        password: The plaintext password.

    Returns:
        A string in the format ``pbkdf2$sha256$100000$<salt_hex>$<hash_hex>``.
    """
    salt = os.urandom(_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac(_PBKDF2_ALGO, password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return _HASH_FORMAT.format(
        algo=_PBKDF2_ALGO,
        iterations=_PBKDF2_ITERATIONS,
        salt_hex=salt.hex(),
        hash_hex=dk.hex(),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a plaintext password against a stored PBKDF2 hash.

    Args:
        password: The plaintext password to check.
        stored_hash: The stored hash string (``pbkdf2$sha256$...``).

    Returns:
        ``True`` if the password matches, ``False`` otherwise.
    """
    try:
        parts = stored_hash.split("$")
        if len(parts) != 5 or parts[0] != "pbkdf2":
            return False
        algo = parts[1]
        iterations = int(parts[2])
        salt = bytes.fromhex(parts[3])
        expected_hash = bytes.fromhex(parts[4])
        dk = hashlib.pbkdf2_hmac(algo, password.encode("utf-8"), salt, iterations)
        # Constant-time comparison
        return secrets.compare_digest(dk, expected_hash)
    except (ValueError, IndexError):
        return False


def generate_password(length: int = 20) -> str:
    """Generate a cryptographically strong random password.

    Guarantees at least one lowercase, one uppercase, one digit, and one
    special character.

    Args:
        length: Desired password length (minimum 12).

    Returns:
        A random password string.
    """
    length = max(length, _PASSWORD_MIN_LEN)
    chars = _PASSWORD_CHARS
    # Guarantee one from each category
    password = [
        secrets.choice("abcdefghijklmnopqrstuvwxyz"),
        secrets.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        secrets.choice("0123456789"),
        secrets.choice("!@#$%^&*"),
    ]
    password.extend(secrets.choice(chars) for _ in range(length - 4))
    # Shuffle
    secrets.SystemRandom().shuffle(password)
    return "".join(password)


# ── JWT ──────────────────────────────────────────────────────


def generate_jwt(
    webui_user_id: int | None,
    username: str,
    secret: str,
    *,
    principal_id: str | None = None,
    auth_method: str = "password",
) -> str:
    """Generate a JWT token for an authenticated WebUI / SSO user."""
    import jwt

    now = int(time.time())
    pid = str(principal_id or "").strip()
    sub = pid if pid else str(webui_user_id or "")
    payload: dict[str, Any] = {
        "sub": sub,
        "username": username,
        "auth_method": auth_method,
        "iat": now,
        "exp": now + _JWT_EXPIRY_DAYS * 86400,
    }
    if pid:
        payload["principal_id"] = pid
    if webui_user_id is not None:
        payload["webui_user_id"] = int(webui_user_id)
    return jwt.encode(payload, secret, algorithm=_JWT_ALGORITHM)


def verify_jwt(token: str, secret: str) -> dict[str, Any] | None:
    """Verify a JWT token and return its payload.

    Args:
        token: The JWT string to verify.
        secret: The JWT signing secret.

    Returns:
        The decoded payload dict, or ``None`` if the token is invalid/expired.
    """
    import jwt

    try:
        payload = jwt.decode(token, secret, algorithms=[_JWT_ALGORITHM])
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


# ── QR Token Store ───────────────────────────────────────────


class _QrTokenData:
    """Internal storage for a single QR token."""

    __slots__ = ("created_at_ms", "used")

    def __init__(self) -> None:
        self.created_at_ms = int(time.time() * 1000)
        self.used = False


class QrTokenStore:
    """In-memory store for one-time QR login tokens.

    Tokens are 64-character hex strings with a 5-minute TTL. Each token can
    be consumed exactly once (via :meth:`validate_and_consume`).
    """

    def __init__(self) -> None:
        self._tokens: dict[str, _QrTokenData] = {}
        self._lock = threading.Lock()

    def generate_with_expiry(self) -> tuple[str, int]:
        """Generate a new QR token and return it with its expiry timestamp.

        Returns:
            A ``(token, expires_at_ms)`` tuple where ``expires_at_ms`` is the
            absolute Unix time in milliseconds when the token expires.
        """
        token = secrets.token_hex(_QR_TOKEN_BYTES)
        data = _QrTokenData()
        with self._lock:
            self._tokens[token] = data
        expires_at_ms = data.created_at_ms + _QR_TOKEN_TTL_MS
        return token, expires_at_ms

    def validate_and_consume(self, token: str) -> bool:
        """Validate and consume a QR token (one-time use).

        Args:
            token: The QR token string to validate.

        Returns:
            ``True`` if the token was valid and is now consumed, ``False``
            if it was not found, already used, or expired.
        """
        now_ms = int(time.time() * 1000)
        with self._lock:
            data = self._tokens.get(token)
            if data is None:
                return False
            if data.used:
                return False
            if now_ms > data.created_at_ms + _QR_TOKEN_TTL_MS:
                # Expired — clean up
                del self._tokens[token]
                return False
            data.used = True
            # Clean up consumed token after a short grace period
            del self._tokens[token]
            return True

    def cleanup_expired(self) -> int:
        """Remove all expired tokens from the store.

        Returns:
            The number of tokens removed.
        """
        now_ms = int(time.time() * 1000)
        removed = 0
        with self._lock:
            expired = [
                token for token, data in self._tokens.items()
                if now_ms > data.created_at_ms + _QR_TOKEN_TTL_MS
            ]
            for token in expired:
                del self._tokens[token]
                removed += 1
        return removed


# Module-level singleton.
qr_token_store = QrTokenStore()


# ── WebUI secret ─────────────────────────────────────────────


def get_webui_secret() -> str:
    """Get or create the JWT signing secret for WebUI auth.

    The secret is generated on first call and persisted to
    ``evoflow_app_settings`` so it survives restarts.

    Returns:
        The JWT signing secret string.
    """
    # Check environment variable first
    env_secret = os.environ.get("EVOFLOW_WEBUI_SECRET", "").strip()
    if env_secret:
        return env_secret

    # Check app settings in DB
    try:
        stored = cfg_repo.get_app_setting(_WEBUI_JWT_SECRET_KEY)
        if stored:
            return str(stored)
    except Exception:
        pass

    # Generate and persist
    secret = secrets.token_hex(32)
    try:
        cfg_repo.set_app_setting(_WEBUI_JWT_SECRET_KEY, secret)
    except Exception:
        logger.warning("Failed to persist WebUI JWT secret", exc_info=True)
    return secret


# ── Admin user management ────────────────────────────────────


def _row_to_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def get_or_create_admin_user() -> dict[str, Any]:
    """Get the primary WebUI admin user, creating one if needed.

    If no admin user exists, one is created with username ``admin`` and a
    random password. The password hash is stored; the plaintext is NOT
    returned by this function (use :func:`reset_password` for that).

    Returns:
        A dict with ``id``, ``username``, ``password_hash``, ``is_primary``,
        ``created_at``, ``updated_at``.
    """
    row = (
        get_db()
        .execute(
            "SELECT * FROM evoflow_webui_users WHERE is_primary = 1 LIMIT 1"
        )
        .fetchone()
    )
    if row:
        user = _row_to_dict(row)
        _sync_webui_principal_row(user)
        return user

    # Create admin user with random password
    plaintext = generate_password()
    password_hash = hash_password(plaintext)
    now = int(time.time())

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_webui_users (username, password_hash, is_primary, created_at, updated_at)
            VALUES (?, ?, 1, ?, ?)
            """,
            ("admin", password_hash, now, now),
        )

    run_db_transaction(_write)
    logger.info("Created WebUI admin user with random password")

    # Return the newly created user
    row = (
        get_db()
        .execute(
            "SELECT * FROM evoflow_webui_users WHERE is_primary = 1 LIMIT 1"
        )
        .fetchone()
    )
    user = _row_to_dict(row) if row else {}
    if user:
        _sync_webui_principal_row(user)
    return user


def _sync_webui_principal_row(user: dict[str, Any]) -> None:
    try:
        from evoflow.authz.principals import ensure_webui_principal

        ensure_webui_principal(
            webui_user_id=int(user["id"]),
            username=str(user.get("username") or "admin"),
            is_primary=int(user.get("is_primary") or 0) == 1,
        )
    except Exception:
        logger.debug("ensure_webui_principal sync failed", exc_info=True)


def verify_user_credentials(username: str, password: str) -> dict[str, Any] | None:
    """Verify any WebUI username + password (primary admin or secondary user).

    Used by panel login / switch-user. Deactivated principals are rejected.

    Args:
        username: The username to check.
        password: The plaintext password to check.

    Returns:
        The user dict if credentials are valid, ``None`` otherwise.
    """
    row = (
        get_db()
        .execute(
            "SELECT * FROM evoflow_webui_users WHERE username = ? LIMIT 1",
            (username,),
        )
        .fetchone()
    )
    if not row:
        return None
    if not verify_password(password, str(row["password_hash"])):
        return None
    try:
        from evoflow.authz.principals import resolve_principal_by_identity

        p = resolve_principal_by_identity("webui", str(row["id"]))
        if not p:
            p = resolve_principal_by_identity("webui_username", str(username))
        if p and str(p.get("status") or "") == "deactivated":
            return None
    except Exception:
        logger.debug("principal status check during login failed", exc_info=True)
    return _row_to_dict(row)


def verify_admin_credentials(username: str, password: str) -> dict[str, Any] | None:
    """Verify primary admin username + password and return the user dict if valid.

    Prefer :func:`verify_user_credentials` for panel login (supports all users).

    Args:
        username: The username to check.
        password: The plaintext password to check.

    Returns:
        The user dict if credentials are valid, ``None`` otherwise.
    """
    row = (
        get_db()
        .execute(
            "SELECT * FROM evoflow_webui_users WHERE username = ? AND is_primary = 1 LIMIT 1",
            (username,),
        )
        .fetchone()
    )
    if not row:
        return None
    if not verify_password(password, str(row["password_hash"])):
        return None
    return _row_to_dict(row)


def change_password(user_id: int, new_password: str) -> bool:
    """Change the password for a WebUI user.

    Args:
        user_id: The user's database ID.
        new_password: The new plaintext password.

    Returns:
        ``True`` if the password was changed successfully.
    """
    password_hash = hash_password(new_password)
    now = int(time.time())

    def _write(db: Any) -> bool:
        cur = db.execute(
            "UPDATE evoflow_webui_users SET password_hash = ?, updated_at = ? WHERE id = ?",
            (password_hash, now, user_id),
        )
        return cur.rowcount > 0

    return run_db_transaction(_write)


def change_username(user_id: int, new_username: str) -> bool:
    """Change the username for a WebUI user.

    Args:
        user_id: The user's database ID.
        new_username: The new username.

    Returns:
        ``True`` if the username was changed successfully.
    """
    now = int(time.time())

    def _write(db: Any) -> bool:
        cur = db.execute(
            "UPDATE evoflow_webui_users SET username = ?, updated_at = ? WHERE id = ?",
            (new_username, now, user_id),
        )
        return cur.rowcount > 0

    return run_db_transaction(_write)


def reset_password(user_id: int) -> str:
    """Reset a user's password to a new random one.

    Args:
        user_id: The user's database ID.

    Returns:
        The new plaintext password (returned only here).
    """
    plaintext = generate_password()
    change_password(user_id, plaintext)
    return plaintext


def is_password_set() -> bool:
    """Check whether the admin user has a non-empty password hash.

    Returns:
        ``True`` if a primary admin user exists with a non-empty password hash.
    """
    row = (
        get_db()
        .execute(
            "SELECT password_hash FROM evoflow_webui_users WHERE is_primary = 1 LIMIT 1"
        )
        .fetchone()
    )
    return bool(row and row["password_hash"])


# ── WebUI enabled state ──────────────────────────────────────


def is_webui_enabled() -> bool:
    """Check whether WebUI remote access is enabled.

    Returns:
        ``True`` if WebUI is enabled.
    """
    with _webui_enabled_lock:
        return _webui_enabled


def set_webui_enabled(enabled: bool) -> None:
    """Set the WebUI enabled state.

    Args:
        enabled: Whether WebUI remote access should be enabled.
    """
    global _webui_enabled
    with _webui_enabled_lock:
        _webui_enabled = enabled
    try:
        cfg_repo.set_app_setting(_WEBUI_ENABLED_KEY, "1" if enabled else "0")
    except Exception:
        logger.warning("Failed to persist WebUI enabled state", exc_info=True)


def _load_webui_enabled() -> None:
    """Load the WebUI enabled state from DB on startup."""
    global _webui_enabled
    try:
        stored = cfg_repo.get_app_setting(_WEBUI_ENABLED_KEY)
        if str(stored) == "1":
            with _webui_enabled_lock:
                _webui_enabled = True
    except Exception:
        pass


# ── LAN access URLs ──────────────────────────────────────────


def _parse_port_env(*keys: str) -> int | None:
    """Parse a valid TCP port from the first set environment variable."""
    for key in keys:
        raw = os.environ.get(key, "").strip()
        if not raw:
            continue
        try:
            port = int(raw)
        except ValueError:
            continue
        if 1 < port < 65536:
            return port
    return None


def get_webui_http_port() -> int:
    """Return the EvoPanel Web UI HTTP port (separate from the Gateway API port).

    Resolution order:
    1. ``EVOFLOW_WEBUI_HTTP_PORT`` (explicit WebUI / ``npm run serve`` port)
    2. Persisted ``webui.http_port`` in ``evoflow_app_settings``
    3. ``EVOFLOW_VITE_PORT`` (Vite dev, e.g. 1421 / 1521)
    4. ``PORT`` (generic, e.g. Docker / ``serve.js``)
    5. :data:`WEBUI_DEFAULT_HTTP_PORT` (1420)
    """
    explicit = _parse_port_env("EVOFLOW_WEBUI_HTTP_PORT")
    if explicit is not None:
        return explicit
    try:
        stored = cfg_repo.get_app_setting(_WEBUI_HTTP_PORT_KEY)
        if stored is not None:
            port = int(stored)
            if 1 < port < 65536:
                return port
    except Exception:
        pass
    fallback = _parse_port_env("EVOFLOW_VITE_PORT", "PORT")
    if fallback is not None:
        return fallback
    return WEBUI_DEFAULT_HTTP_PORT


def set_webui_http_port(port: int) -> None:
    """Persist the EvoPanel Web UI HTTP port."""
    if not (1 < port < 65536):
        return
    try:
        cfg_repo.set_app_setting(_WEBUI_HTTP_PORT_KEY, str(port))
    except Exception:
        logger.warning("Failed to persist WebUI HTTP port", exc_info=True)


def _is_frozen_gateway_process() -> bool:
    import sys

    return bool(getattr(sys, "frozen", False))


def gateway_serves_evopanel_webui() -> bool:
    """True when remote browsers should open the Gateway (SPA static + /api), not Vite."""
    if _parse_port_env("EVOFLOW_VITE_PORT") is not None:
        return False
    if _is_frozen_gateway_process():
        return True
    try:
        from evoflow.webui.static import resolve_evopanel_dist_dir

        return resolve_evopanel_dist_dir() is not None
    except Exception:
        return False


def get_webui_access_port(gateway_port: int | None = None) -> int:
    """Port for LAN access URLs shown in settings / QR login.

    Packaged desktop: Gateway serves EvoPanel static on the sidecar port (~38012).
    Dev with Vite: use ``EVOFLOW_VITE_PORT`` (e.g. 1521) and the Vite proxy.
    Standalone ``npm run serve``: use :func:`get_webui_http_port`.
    """
    if is_webui_enabled() and gateway_port and 1 < gateway_port < 65536:
        if gateway_serves_evopanel_webui():
            return gateway_port
    return get_webui_http_port()


def get_lan_access_urls(port: int | None = None) -> list[str]:
    """Discover LAN-accessible URLs for the EvoPanel **Web UI**.

    When the Gateway serves the packaged SPA (desktop installer), ``port`` must be
    the Gateway listen port from :func:`get_webui_access_port`, not the dev-only
    default 1420.

    Args:
        port: Web UI listen port (defaults to :func:`get_webui_http_port`).

    Returns:
        A list of URL strings, localhost first.
    """
    if port is None:
        port = get_webui_http_port()
    urls = [f"http://localhost:{port}"]
    try:
        # Get all network interfaces
        hostname = socket.gethostname()
        # Try to get all IPs by connecting to an external address
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            primary_ip = s.getsockname()[0]
            s.close()
            if primary_ip and primary_ip != "127.0.0.1":
                urls.append(f"http://{primary_ip}:{port}")
        except Exception:
            pass

        # Also try getaddrinfo for multi-homed hosts
        try:
            addrs = socket.getaddrinfo(hostname, None, socket.AF_INET)
            for addr in addrs:
                ip = addr[4][0]
                if ip and ip != "127.0.0.1" and ip != "0.0.0.0":
                    url = f"http://{ip}:{port}"
                    if url not in urls:
                        urls.append(url)
        except Exception:
            pass
    except Exception:
        pass
    return urls


# ── WebUI status ─────────────────────────────────────────────


def get_webui_status(gateway_port: int = 8001) -> dict[str, Any]:
    """Get the current WebUI status.

    Args:
        gateway_port: The Gateway API port (for reference only).

    Returns:
        A dict with ``enabled``, ``running``, ``admin_username``,
        ``password_set``, ``access_urls``, ``webui_http_port``,
        ``gateway_port``, and ``lan_ip``.
    """
    admin = None
    try:
        admin = get_or_create_admin_user()
    except Exception:
        pass

    webui_port = get_webui_access_port(gateway_port)
    access_urls = get_lan_access_urls(webui_port)
    lan_ip = access_urls[1] if len(access_urls) > 1 else None

    return {
        "enabled": is_webui_enabled(),
        "running": is_webui_enabled(),
        "admin_username": admin.get("username", "admin") if admin else "admin",
        "password_set": is_password_set(),
        "access_urls": access_urls,
        "webui_http_port": webui_port,
        "gateway_port": gateway_port,
        "lan_ip": lan_ip,
        **_oidc_status_fields(),
    }


def _oidc_status_fields() -> dict[str, Any]:
    try:
        from evoflow.webui.oidc_config import get_oidc_config, is_oidc_enabled

        cfg = get_oidc_config(include_secret=True)
        return {
            "oidc_enabled": is_oidc_enabled(),
            "oidc_button_label": str(cfg.get("buttonLabel") or "企业 SSO 登录"),
            "password_login_enabled": bool(cfg.get("passwordLoginEnabled", True)),
        }
    except Exception:
        return {
            "oidc_enabled": False,
            "oidc_button_label": "企业 SSO 登录",
            "password_login_enabled": True,
        }


def is_local_request(client_host: str) -> bool:
    """Check whether a request comes from the local machine.

    Args:
        client_host: The client's IP address (from ``request.client.host``).

    Returns:
        ``True`` if the request is from localhost.
    """
    return client_host in ("127.0.0.1", "::1", "localhost")
