"""Local Sign in with ChatGPT for EvoFlow's subscription model provider."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
import uuid
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import jwt
from evoflow.models.codex_oauth import CodexAuthError, _evoflow_home
from filelock import FileLock

ISSUER = "https://auth.openai.com"
API_BASE = "https://api.openai.com/v1"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = f"openid profile email offline_access resource.invoke {PLAN_SCOPE}"
REGISTRATION_CLIENT = "dynamic_agent_client"
CALLBACK_PATH = "/auth/callback"
LOGIN_TIMEOUT = 300
_session_lock = threading.Lock()
_session: dict | None = None


def _store_path() -> Path:
    return _evoflow_home() / "chatgpt_plan" / "profile.json"


def _store_lock() -> FileLock:
    path = _store_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return FileLock(str(path.with_suffix(".lock")), timeout=20, mode=0o600)


def _load_profile() -> dict:
    try:
        return json.loads(_store_path().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _save_profile(profile: dict) -> None:
    path = _store_path()
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(profile, handle)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _discovery_endpoint(field: str) -> str:
    result = httpx.get(DISCOVERY_URL, timeout=8)
    result.raise_for_status()
    metadata = result.json()
    endpoint = metadata.get(field, "")
    url = urlsplit(endpoint)
    if metadata.get("issuer") != ISSUER or (url.scheme, url.netloc) != ("https", "auth.openai.com"):
        raise CodexAuthError("OpenAI authentication metadata did not validate.")
    return endpoint


def _validate_identity(token: str, client_id: str, nonce: str) -> dict:
    jwks = httpx.get(_discovery_endpoint("jwks_uri"), timeout=8)
    jwks.raise_for_status()
    header = jwt.get_unverified_header(token)
    keys = jwt.PyJWKSet.from_dict(jwks.json())
    key = keys[header["kid"]]
    claims = jwt.decode(
        token,
        key.key,
        algorithms=["RS256"],
        issuer=ISSUER,
        audience=client_id,
        options={"require": ["sub", "exp", "nonce"]},
    )
    if claims["nonce"] != nonce:
        raise CodexAuthError("OpenAI login nonce did not match.")
    return claims


def _exchange(data: dict) -> dict:
    try:
        result = httpx.post(TOKEN_URL, data={**data, "resource": API_BASE}, timeout=10)
        body = result.json()
        if not isinstance(body, dict):
            raise TypeError("Unexpected token response")
    except (httpx.HTTPError, TypeError, ValueError):
        raise CodexAuthError("OpenAI token exchange could not be completed.") from None
    if result.status_code != 200:
        terminal = body.get("error") in {"invalid_grant", "invalid_refresh_token", "refresh_token_reused"}
        raise CodexAuthError(
            f"OpenAI rejected the token exchange (HTTP {result.status_code}).",
            relogin_required=terminal,
        )
    return body


def _token_fields(tokens: dict) -> dict:
    scopes = tokens.get("scope", "").split()
    fields = {
        "scopes": scopes,
        "id_token": tokens.get("id_token"),
    }
    if PLAN_SCOPE not in scopes:
        return fields
    if (
        str(tokens.get("token_type", "")).lower() != "bearer"
        or not tokens.get("access_token")
        or not tokens.get("refresh_token")
        or not isinstance(tokens.get("expires_in"), int)
        or tokens["expires_in"] <= 0
    ):
        raise CodexAuthError("OpenAI returned an incomplete subscription grant.")
    return {
        **fields,
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "expires_at": time.time() + tokens["expires_in"],
        "earliest_refresh_at": tokens.get("earliest_refresh_at"),
    }


def _registration(profile: dict) -> dict:
    return {key: profile[key] for key in ("host_id", "client_id", "subject", "email") if key in profile}


def _finish_login(session: dict, query: dict) -> None:
    if query.get("error"):
        raise CodexAuthError("ChatGPT authorization was declined or is unavailable.")
    code = query.get("code", [""])[0]
    issued = query.get("client_id", [""])[0]
    existing = session["client_id"]
    if not code or (existing and issued and issued != existing):
        raise CodexAuthError("OpenAI returned an invalid authorization callback.")
    client_id = existing or issued
    if not client_id or client_id == REGISTRATION_CLIENT:
        raise CodexAuthError("OpenAI did not issue a client registration.")
    tokens = _exchange(
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "code_verifier": session["verifier"],
            "redirect_uri": session["redirect_uri"],
        }
    )
    claims = _validate_identity(tokens.get("id_token", ""), client_id, session["nonce"])
    if session["subject"] and claims["sub"] != session["subject"]:
        raise CodexAuthError("The signed-in account does not match the selected registration.")
    with _store_lock():
        _save_profile(
            {
                "host_id": session["host_id"],
                "client_id": client_id,
                "subject": claims["sub"],
                "email": claims.get("email", ""),
                **_token_fields(tokens),
            }
        )
    if PLAN_SCOPE not in tokens.get("scope", "").split():
        raise CodexAuthError("ChatGPT signed in without granting subscription usage.")


def start_login(*, open_browser: bool = False) -> dict:
    """Start a single, expiring loopback authorization for the local profile."""
    global _session
    with _session_lock:
        if _session and _session["status"] == "pending":
            return _session["public"]
        with _store_lock():
            profile = _load_profile()
            if not profile.get("host_id"):
                profile["host_id"] = f"urn:uuid:{uuid.uuid4()}"
                _save_profile(profile)
        session = {
            "id": secrets.token_urlsafe(24),
            "state": secrets.token_urlsafe(32),
            "nonce": secrets.token_urlsafe(32),
            "verifier": secrets.token_urlsafe(64),
            "host_id": profile["host_id"],
            "client_id": profile.get("client_id"),
            "subject": profile.get("subject"),
            "status": "pending",
        }

        class Callback(BaseHTTPRequestHandler):
            timeout = 3

            def log_message(self, *args) -> None:
                pass

            def do_GET(self) -> None:
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                state = query.get("state", [""])[0]
                if url.path != CALLBACK_PATH or not secrets.compare_digest(state, session["state"]):
                    self.send_error(400, "Invalid authorization callback")
                    return
                try:
                    _finish_login(session, query)
                    session["status"] = "success"
                    body = b"ChatGPT authorization completed. Return to EvoFlow."
                except (CodexAuthError, jwt.PyJWTError, httpx.HTTPError, KeyError, ValueError):
                    session["error"] = "ChatGPT authorization failed or subscription permission was not granted."
                    session["status"] = "failed"
                    body = b"ChatGPT authorization did not complete. Return to EvoFlow."
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

        try:
            server = HTTPServer(("127.0.0.1", 0), Callback)
        except OSError:
            raise CodexAuthError("Unable to open the local ChatGPT authorization callback.") from None
        server.timeout = 0.5
        session["redirect_uri"] = f"http://127.0.0.1:{server.server_port}{CALLBACK_PATH}"
        challenge = hashlib.sha256(session["verifier"].encode("ascii")).digest()
        params = {
            "client_id": session["client_id"] or REGISTRATION_CLIENT,
            "ext_agent_host_id": session["host_id"],
            "redirect_uri": session["redirect_uri"],
            "scope": SCOPES,
            "resource": API_BASE,
            "state": session["state"],
            "nonce": session["nonce"],
            "response_type": "code",
            "code_challenge_method": "S256",
            "code_challenge": base64.urlsafe_b64encode(challenge).decode("ascii").rstrip("="),
        }
        if not session["client_id"]:
            params["agent_name_hint"] = "EvoFlow"
        elif not profile.get("access_token"):
            params["prompt"] = "consent"
        authorization_url = f"{ISSUER}/api/accounts/authorize?{urlencode(params)}"
        session["public"] = {"session_id": session["id"], "verification_url": authorization_url}
        _session = session

        def serve() -> None:
            deadline = time.monotonic() + LOGIN_TIMEOUT
            try:
                with server:
                    while session["status"] == "pending" and time.monotonic() < deadline:
                        server.handle_request()
            finally:
                if session["status"] == "pending":
                    session["error"] = "ChatGPT authorization expired."
                    session["status"] = "failed"
                for name in ("verifier", "state", "nonce", "public"):
                    session.pop(name, None)

        threading.Thread(target=serve, name="chatgpt-plan-login", daemon=True).start()
    if open_browser:
        threading.Thread(target=webbrowser.open, args=(authorization_url,), daemon=True).start()
    return {"session_id": session["id"], "verification_url": authorization_url}


def poll_login(session_id: str) -> dict:
    with _session_lock:
        session = _session
        if not session or not secrets.compare_digest(session["id"], session_id):
            return {"status": "failed", "error": "ChatGPT authorization session not found."}
        return {"status": session["status"], "error": session.get("error")}


def auth_status() -> dict:
    profile = _load_profile()
    return {
        "logged_in": bool(profile.get("access_token") and PLAN_SCOPE in profile.get("scopes", [])),
        "account_hint": profile.get("email"),
        "source": "Sign in with ChatGPT" if profile.get("access_token") else None,
    }


def access_token() -> str:
    with _store_lock():
        profile = _load_profile()
        if PLAN_SCOPE not in profile.get("scopes", []) or not profile.get("refresh_token"):
            raise CodexAuthError("Authorize ChatGPT plan usage in EvoFlow settings.", relogin_required=True)
        now = time.time()
        if profile["expires_at"] > now + 60:
            return profile["access_token"]
        earliest = profile.get("earliest_refresh_at")
        if isinstance(earliest, str):
            earliest = datetime.fromisoformat(earliest).timestamp()
        if isinstance(earliest, (int, float)) and earliest > now:
            if profile["expires_at"] > now:
                return profile["access_token"]
            raise CodexAuthError("OpenAI credentials cannot be refreshed yet.")
        try:
            tokens = _exchange(
                {
                    "grant_type": "refresh_token",
                    "client_id": profile["client_id"],
                    "refresh_token": profile["refresh_token"],
                }
            )
        except CodexAuthError as exc:
            if exc.relogin_required:
                _save_profile(_registration(profile))
            raise
        updated = _token_fields(tokens)
        if "access_token" not in updated:
            _save_profile(_registration(profile))
            raise CodexAuthError("ChatGPT subscription permission was revoked.", relogin_required=True)
        updated["id_token"] = updated["id_token"] or profile.get("id_token")
        _save_profile({**_registration(profile), **updated})
        return updated["access_token"]


def logout() -> None:
    with _session_lock:
        if _session and _session["status"] == "pending":
            raise CodexAuthError("Wait for the current ChatGPT sign-in to finish.")
        with _store_lock():
            profile = _load_profile()
            refresh_token = profile.get("refresh_token")
            try:
                if refresh_token:
                    response = httpx.post(
                        _discovery_endpoint("revocation_endpoint"),
                        data={"token": refresh_token, "client_id": profile["client_id"]},
                        timeout=8,
                    )
                    response.raise_for_status()
            except (httpx.HTTPError, CodexAuthError, ValueError):
                raise CodexAuthError("OpenAI token revocation did not complete. Try again.") from None
            if profile:
                _save_profile(_registration(profile))
