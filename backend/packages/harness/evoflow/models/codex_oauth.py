"""ChatGPT / Codex subscription OAuth (device-code + refresh).

Ported from Hermes Agent ``hermes_cli.auth`` Codex helpers (device-code login,
``refresh_codex_oauth_pure``). Tokens are stored under EvoFlow home so they do
not fight Codex CLI's ``~/.codex/auth.json`` refresh rotation by default;
CLI import remains an explicit option.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_OAUTH_ISSUER = "https://auth.openai.com"
DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120
CODEX_OAUTH_USER_AGENT = "evoflow-codex-oauth/1.0"
CODEX_RATE_LIMITED_CODE = "codex_rate_limited"

_RUNTIME_USE = "evoflow.models.openai_codex_provider:runtimeChatModel"

_lock = threading.RLock()
_device_sessions: dict[str, dict[str, Any]] = {}


class CodexAuthError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "codex_auth_error",
        relogin_required: bool = False,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.relogin_required = relogin_required
        self.retry_after = retry_after


def codex_runtime_use_path() -> str:
    return _RUNTIME_USE


def _evoflow_home() -> Path:
    home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if home:
        return Path(home).expanduser()
    return Path.home() / ".evoflow"


def auth_store_path() -> Path:
    override = (os.getenv("EVOFLOW_CODEX_AUTH_PATH") or "").strip()
    if override:
        return Path(override).expanduser()
    return _evoflow_home() / "codex_auth.json"


def cli_auth_path() -> Path:
    override = (os.getenv("CODEX_AUTH_PATH") or "").strip()
    if override:
        return Path(override).expanduser()
    codex_home = (os.getenv("CODEX_HOME") or "").strip()
    if codex_home:
        return Path(codex_home).expanduser() / "auth.json"
    return Path.home() / ".codex" / "auth.json"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_retry_after_seconds(headers: Any) -> int | None:
    try:
        raw = headers.get("Retry-After") if headers is not None else None
    except Exception:
        return None
    if raw is None:
        return None
    try:
        return max(0, int(str(raw).strip()))
    except (TypeError, ValueError):
        return None


def decode_jwt_claims(token: Any) -> dict[str, Any]:
    if not isinstance(token, str) or token.count(".") < 2:
        return {}
    try:
        payload = token.split(".")[1]
        pad = "=" * (-len(payload) % 4)
        raw = base64.urlsafe_b64decode(payload + pad)
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def access_token_is_expiring(access_token: Any, skew_seconds: int = CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS) -> bool:
    claims = decode_jwt_claims(access_token)
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= (time.time() + max(0, int(skew_seconds)))


def account_id_from_token(access_token: str, fallback: str = "") -> str:
    claims = decode_jwt_claims(access_token)
    for key in ("chatgpt_account_id", "https://api.openai.com/auth.chatgpt_account_id", "account_id"):
        val = claims.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    auth = claims.get("https://api.openai.com/auth")
    if isinstance(auth, dict):
        val = auth.get("chatgpt_account_id")
        if isinstance(val, str) and val.strip():
            return val.strip()
    return str(fallback or "").strip()


def _extract_tokens_dict(payload: dict[str, Any] | None) -> dict[str, str] | None:
    if not isinstance(payload, dict):
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        tokens = payload
    access = str(tokens.get("access_token") or tokens.get("token") or payload.get("access_token") or "").strip()
    if not access:
        return None
    refresh = str(tokens.get("refresh_token") or payload.get("refresh_token") or "").strip()
    account_id = str(
        tokens.get("account_id")
        or payload.get("account_id")
        or account_id_from_token(access)
        or ""
    ).strip()
    out = {"access_token": access, "refresh_token": refresh, "account_id": account_id}
    return out


def load_auth_store() -> dict[str, Any] | None:
    path = auth_store_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to read Codex auth store %s: %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def save_auth_store(
    tokens: dict[str, str],
    *,
    source: str = "device-code",
    last_refresh: str | None = None,
) -> Path:
    path = auth_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    access = str(tokens.get("access_token") or "").strip()
    refresh = str(tokens.get("refresh_token") or "").strip()
    account_id = str(tokens.get("account_id") or account_id_from_token(access) or "").strip()
    payload = {
        "tokens": {
            "access_token": access,
            "refresh_token": refresh,
            "account_id": account_id,
        },
        "last_refresh": last_refresh or _utc_now_iso(),
        "auth_mode": "chatgpt",
        "source": source,
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def clear_auth_store() -> bool:
    path = auth_store_path()
    if not path.is_file():
        return False
    try:
        path.unlink()
        return True
    except OSError as exc:
        logger.warning("Failed to clear Codex auth store: %s", exc)
        return False


def import_cli_tokens() -> dict[str, str] | None:
    path = cli_auth_path()
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    tokens = _extract_tokens_dict(payload if isinstance(payload, dict) else None)
    if not tokens or not tokens.get("refresh_token"):
        return None
    if access_token_is_expiring(tokens["access_token"], 0):
        # Still import — resolve path can refresh with refresh_token.
        logger.debug("Codex CLI access token at %s looks expired; importing for refresh.", path)
    return tokens


def refresh_codex_oauth_pure(
    access_token: str,
    refresh_token: str,
    *,
    timeout_seconds: float = 20.0,
) -> dict[str, Any]:
    """Refresh Codex OAuth tokens without mutating local state (Hermes-compatible)."""
    del access_token
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        raise CodexAuthError(
            "Codex auth is missing refresh_token. Please sign in again.",
            code="codex_auth_missing_refresh_token",
            relogin_required=True,
        )

    timeout = httpx.Timeout(max(5.0, float(timeout_seconds)))
    with httpx.Client(
        timeout=timeout,
        headers={"Accept": "application/json", "User-Agent": CODEX_OAUTH_USER_AGENT},
    ) as client:
        response = client.post(
            CODEX_OAUTH_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CODEX_OAUTH_CLIENT_ID,
            },
        )

    if response.status_code == 429:
        retry_after = _parse_retry_after_seconds(getattr(response, "headers", None))
        message = (
            f"Codex quota exhausted (429); retry after {retry_after}s. Credentials are still valid."
            if retry_after is not None
            else "Codex quota exhausted (429). Credentials are still valid; retry after the usage limit resets."
        )
        raise CodexAuthError(
            message,
            code=CODEX_RATE_LIMITED_CODE,
            relogin_required=False,
            retry_after=retry_after,
        )

    if response.status_code != 200:
        code = "codex_refresh_failed"
        message = f"Codex token refresh failed with status {response.status_code}."
        relogin_required = False
        try:
            err = response.json()
            if isinstance(err, dict):
                err_obj = err.get("error")
                if isinstance(err_obj, dict):
                    nested_code = err_obj.get("code") or err_obj.get("type")
                    if isinstance(nested_code, str) and nested_code.strip():
                        code = nested_code.strip()
                    nested_msg = err_obj.get("message")
                    if isinstance(nested_msg, str) and nested_msg.strip():
                        message = f"Codex token refresh failed: {nested_msg.strip()}"
                elif isinstance(err_obj, str) and err_obj.strip():
                    code = err_obj.strip()
                    err_desc = err.get("error_description") or err.get("message")
                    if isinstance(err_desc, str) and err_desc.strip():
                        message = f"Codex token refresh failed: {err_desc.strip()}"
        except Exception:
            pass
        if code in {"invalid_grant", "invalid_token", "invalid_request", "refresh_token_reused"}:
            relogin_required = True
        if response.status_code in {401, 403}:
            relogin_required = True
        raise CodexAuthError(message, code=code, relogin_required=relogin_required)

    try:
        refresh_payload = response.json()
    except Exception as exc:
        raise CodexAuthError(
            "Codex token refresh returned invalid JSON.",
            code="codex_refresh_invalid_json",
            relogin_required=True,
        ) from exc

    refreshed_access = refresh_payload.get("access_token")
    if not isinstance(refreshed_access, str) or not refreshed_access.strip():
        raise CodexAuthError(
            "Codex token refresh response was missing access_token.",
            code="codex_refresh_missing_access_token",
            relogin_required=True,
        )

    updated = {
        "access_token": refreshed_access.strip(),
        "refresh_token": refresh_token.strip(),
        "last_refresh": _utc_now_iso(),
    }
    next_refresh = refresh_payload.get("refresh_token")
    if isinstance(next_refresh, str) and next_refresh.strip():
        updated["refresh_token"] = next_refresh.strip()
    updated["account_id"] = account_id_from_token(updated["access_token"])
    return updated


def resolve_runtime_tokens(
    *,
    force_refresh: bool = False,
    refresh_if_expiring: bool = True,
    refresh_skew_seconds: int = CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
    allow_cli_fallback: bool = True,
) -> dict[str, Any]:
    """Return usable Codex tokens, refreshing when needed."""
    store = load_auth_store()
    tokens = _extract_tokens_dict(store)
    source = str((store or {}).get("source") or "evoflow")
    last_refresh = (store or {}).get("last_refresh")

    if tokens is None and allow_cli_fallback:
        cli = import_cli_tokens()
        if cli:
            tokens = cli
            source = "cli"
            last_refresh = None

    if tokens is None or not tokens.get("access_token"):
        raise CodexAuthError(
            "No Codex subscription credentials. Sign in with ChatGPT/Codex or import ~/.codex/auth.json.",
            code="codex_auth_missing",
            relogin_required=True,
        )

    needs_refresh = force_refresh or (
        refresh_if_expiring and access_token_is_expiring(tokens["access_token"], refresh_skew_seconds)
    )
    if needs_refresh:
        if not tokens.get("refresh_token"):
            raise CodexAuthError(
                "Codex access token expired and no refresh_token is available. Please sign in again.",
                code="codex_auth_missing_refresh_token",
                relogin_required=True,
            )
        refreshed = refresh_codex_oauth_pure(tokens["access_token"], tokens["refresh_token"])
        tokens = {
            "access_token": refreshed["access_token"],
            "refresh_token": refreshed["refresh_token"],
            "account_id": refreshed.get("account_id") or tokens.get("account_id") or "",
        }
        last_refresh = refreshed.get("last_refresh") or _utc_now_iso()
        # Persist into EvoFlow store even when source was CLI import, so refresh
        # rotation stays local and does not stomp Codex CLI's file.
        save_auth_store(tokens, source="refresh" if source == "cli" else source, last_refresh=last_refresh)
        source = "evoflow"

    if not tokens.get("account_id"):
        tokens["account_id"] = account_id_from_token(tokens["access_token"])

    return {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token") or "",
        "account_id": tokens.get("account_id") or "",
        "source": source,
        "last_refresh": last_refresh,
        "auth_store": str(auth_store_path()),
        "cli_auth_path": str(cli_auth_path()),
        "base_url": DEFAULT_CODEX_BASE_URL,
        "logged_in": True,
    }


def get_auth_status() -> dict[str, Any]:
    try:
        creds = resolve_runtime_tokens(force_refresh=False, refresh_if_expiring=True)
        access = creds["access_token"]
        claims = decode_jwt_claims(access)
        email = ""
        for key in ("email", "preferred_username", "unique_name"):
            val = claims.get(key)
            if isinstance(val, str) and val.strip():
                email = val.strip()
                break
        return {
            "logged_in": True,
            "auth_mode": "chatgpt",
            "source": creds.get("source"),
            "account_id": creds.get("account_id") or "",
            "account_hint": email or ((creds.get("account_id") or "")[:8] + "…") if creds.get("account_id") else "",
            "last_refresh": creds.get("last_refresh"),
            "auth_store": creds.get("auth_store"),
            "cli_auth_path": creds.get("cli_auth_path"),
            "cli_auth_present": cli_auth_path().is_file(),
            "access_expiring": access_token_is_expiring(access, CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS),
            "runtime_use": _RUNTIME_USE,
        }
    except CodexAuthError as exc:
        return {
            "logged_in": False,
            "auth_mode": "chatgpt",
            "error": str(exc),
            "error_code": exc.code,
            "relogin_required": exc.relogin_required,
            "auth_store": str(auth_store_path()),
            "cli_auth_path": str(cli_auth_path()),
            "cli_auth_present": cli_auth_path().is_file(),
            "runtime_use": _RUNTIME_USE,
        }


def import_cli_and_save() -> dict[str, Any]:
    tokens = import_cli_tokens()
    if not tokens:
        raise CodexAuthError(
            f"No usable Codex CLI credentials at {cli_auth_path()}. Run `codex login` first.",
            code="codex_cli_missing",
            relogin_required=True,
        )
    # Refresh once so we own a rotated refresh token in EvoFlow store.
    if tokens.get("refresh_token"):
        try:
            refreshed = refresh_codex_oauth_pure(tokens["access_token"], tokens["refresh_token"])
            tokens = {
                "access_token": refreshed["access_token"],
                "refresh_token": refreshed["refresh_token"],
                "account_id": refreshed.get("account_id") or tokens.get("account_id") or "",
            }
            last_refresh = refreshed.get("last_refresh")
        except CodexAuthError:
            last_refresh = _utc_now_iso()
    else:
        last_refresh = _utc_now_iso()
    save_auth_store(tokens, source="cli-import", last_refresh=last_refresh)
    return get_auth_status()


def start_device_login(*, open_browser: bool = False) -> dict[str, Any]:
    """Request a device code; poll with ``poll_device_login``."""
    max_attempts = 4
    resp = None
    for attempt in range(1, max_attempts + 1):
        try:
            with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
                resp = client.post(
                    f"{CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode",
                    json={"client_id": CODEX_OAUTH_CLIENT_ID},
                    headers={"Content-Type": "application/json", "User-Agent": CODEX_OAUTH_USER_AGENT},
                )
        except Exception as exc:
            raise CodexAuthError(
                f"Failed to request device code: {exc}",
                code="device_code_request_failed",
            ) from exc

        if resp.status_code != 429:
            break
        if attempt < max_attempts:
            retry_after = _parse_retry_after_seconds(getattr(resp, "headers", None))
            delay = retry_after if retry_after is not None else 2**attempt
            time.sleep(max(1, min(int(delay), 60)))

    if resp is None or resp.status_code == 429:
        retry_after = _parse_retry_after_seconds(getattr(resp, "headers", None)) if resp is not None else None
        raise CodexAuthError(
            "OpenAI is rate-limiting Codex login requests (HTTP 429).",
            code=CODEX_RATE_LIMITED_CODE,
            retry_after=retry_after,
        )
    if resp.status_code != 200:
        raise CodexAuthError(
            f"Device code request returned status {resp.status_code}.",
            code="device_code_request_error",
        )

    device_data = resp.json()
    user_code = str(device_data.get("user_code") or "")
    device_auth_id = str(device_data.get("device_auth_id") or "")
    poll_interval = max(3, int(device_data.get("interval") or 5))
    if not user_code or not device_auth_id:
        raise CodexAuthError(
            "Device code response missing required fields.",
            code="device_code_incomplete",
        )

    verification_url = f"{CODEX_OAUTH_ISSUER}/codex/device"
    session_id = uuid.uuid4().hex
    with _lock:
        _device_sessions[session_id] = {
            "status": "pending",
            "user_code": user_code,
            "device_auth_id": device_auth_id,
            "verification_url": verification_url,
            "interval": poll_interval,
            "expires_at": time.monotonic() + 15 * 60,
            "created_at": time.monotonic(),
            "error": None,
            "error_code": None,
        }

    if open_browser:
        try:
            import webbrowser

            webbrowser.open(verification_url)
        except Exception:
            pass

    return {
        "session_id": session_id,
        "flow": "device_code",
        "user_code": user_code,
        "verification_url": verification_url,
        "expires_in": 15 * 60,
        "poll_interval": poll_interval,
    }


def _exchange_device_authorization(authorization_code: str, code_verifier: str) -> dict[str, str]:
    redirect_uri = f"{CODEX_OAUTH_ISSUER}/deviceauth/callback"
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        token_resp = client.post(
            CODEX_OAUTH_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": redirect_uri,
                "client_id": CODEX_OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": CODEX_OAUTH_USER_AGENT,
            },
        )
    if token_resp.status_code == 429:
        raise CodexAuthError(
            "OpenAI is rate-limiting Codex login during token exchange (HTTP 429).",
            code=CODEX_RATE_LIMITED_CODE,
            retry_after=_parse_retry_after_seconds(getattr(token_resp, "headers", None)),
        )
    if token_resp.status_code != 200:
        raise CodexAuthError(
            f"Token exchange returned status {token_resp.status_code}.",
            code="token_exchange_error",
            relogin_required=True,
        )
    tokens = token_resp.json()
    access_token = str(tokens.get("access_token") or "").strip()
    refresh_token = str(tokens.get("refresh_token") or "").strip()
    if not access_token:
        raise CodexAuthError(
            "Token exchange did not return an access_token.",
            code="token_exchange_no_access_token",
            relogin_required=True,
        )
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "account_id": account_id_from_token(access_token),
    }


def poll_device_login(session_id: str) -> dict[str, Any]:
    sid = str(session_id or "").strip()
    with _lock:
        sess = _device_sessions.get(sid)
        if sess is None:
            raise CodexAuthError("Unknown or expired login session.", code="device_session_unknown")
        if sess.get("status") == "success":
            return {"status": "success", "auth": get_auth_status()}
        if sess.get("status") == "error":
            return {
                "status": "error",
                "error": sess.get("error"),
                "error_code": sess.get("error_code"),
            }
        if time.monotonic() > float(sess.get("expires_at") or 0):
            sess["status"] = "error"
            sess["error"] = "Login timed out after 15 minutes."
            sess["error_code"] = "device_code_timeout"
            return {"status": "error", "error": sess["error"], "error_code": sess["error_code"]}

        user_code = sess["user_code"]
        device_auth_id = sess["device_auth_id"]

    try:
        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            poll_resp = client.post(
                f"{CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token",
                json={"device_auth_id": device_auth_id, "user_code": user_code},
                headers={"Content-Type": "application/json", "User-Agent": CODEX_OAUTH_USER_AGENT},
            )
    except Exception as exc:
        return {"status": "pending", "error": f"poll network error: {exc}"}

    if poll_resp.status_code in {403, 404}:
        return {"status": "pending"}
    if poll_resp.status_code != 200:
        return {
            "status": "error",
            "error": f"Device auth polling returned status {poll_resp.status_code}.",
            "error_code": "device_code_poll_error",
        }

    code_resp = poll_resp.json()
    authorization_code = str(code_resp.get("authorization_code") or "")
    code_verifier = str(code_resp.get("code_verifier") or "")
    if not authorization_code or not code_verifier:
        return {
            "status": "error",
            "error": "Device auth response missing authorization_code or code_verifier.",
            "error_code": "device_code_incomplete_exchange",
        }

    try:
        tokens = _exchange_device_authorization(authorization_code, code_verifier)
        save_auth_store(tokens, source="device-code")
    except CodexAuthError as exc:
        with _lock:
            s = _device_sessions.get(sid)
            if s is not None:
                s["status"] = "error"
                s["error"] = str(exc)
                s["error_code"] = exc.code
        return {"status": "error", "error": str(exc), "error_code": exc.code}

    with _lock:
        s = _device_sessions.get(sid)
        if s is not None:
            s["status"] = "success"
    return {"status": "success", "auth": get_auth_status()}
