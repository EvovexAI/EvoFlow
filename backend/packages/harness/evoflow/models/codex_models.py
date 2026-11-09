"""Codex subscription model catalog (OAuth → chatgpt.com/backend-api/codex/models)."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from evoflow.models.codex_oauth import (
    CODEX_OAUTH_USER_AGENT,
    CodexAuthError,
    DEFAULT_CODEX_BASE_URL,
    resolve_runtime_tokens,
)

logger = logging.getLogger(__name__)

# Match a recent Codex client_version used by the official /models catalog.
CODEX_MODELS_CLIENT_VERSION = "0.162.1"

# Builtin candidates only — account entitlement still comes from auth + live calls.
BUILTIN_CODEX_MODEL_CATALOG: tuple[dict[str, Any], ...] = (
    {
        "id": "gpt-5.4",
        "slug": "gpt-5.4",
        "display_name": "GPT-5.4",
        "context_window": 272000,
        "max_context_window": 272000,
        "supports_reasoning": True,
        "supports_vision": True,
        "source": "builtin",
    },
    {
        "id": "gpt-5.2",
        "slug": "gpt-5.2",
        "display_name": "GPT-5.2",
        "context_window": 272000,
        "max_context_window": 272000,
        "supports_reasoning": True,
        "supports_vision": True,
        "source": "builtin",
    },
    {
        "id": "gpt-5.1",
        "slug": "gpt-5.1",
        "display_name": "GPT-5.1",
        "context_window": 272000,
        "max_context_window": 272000,
        "supports_reasoning": True,
        "supports_vision": True,
        "source": "builtin",
    },
    {
        "id": "gpt-5",
        "slug": "gpt-5",
        "display_name": "GPT-5",
        "context_window": 272000,
        "max_context_window": 272000,
        "supports_reasoning": True,
        "supports_vision": True,
        "source": "builtin",
    },
    {
        "id": "o3",
        "slug": "o3",
        "display_name": "o3",
        "context_window": 200000,
        "max_context_window": 200000,
        "supports_reasoning": True,
        "supports_vision": True,
        "source": "builtin",
    },
    {
        "id": "o4-mini",
        "slug": "o4-mini",
        "display_name": "o4-mini",
        "context_window": 200000,
        "max_context_window": 200000,
        "supports_reasoning": True,
        "supports_vision": True,
        "source": "builtin",
    },
)


def is_codex_subscription_base_url(base_url: str | None) -> bool:
    host_path = str(base_url or "").strip().lower().rstrip("/")
    return "chatgpt.com/backend-api/codex" in host_path or host_path.endswith("/backend-api/codex")


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _visibility_is_listable(raw: Any) -> bool:
    if raw is None or raw == "":
        return True
    text = str(raw).strip().lower()
    # Official enum: list | hide | …
    return text in {"list", "listed", "visible", "show"}


def _supports_reasoning(item: dict[str, Any]) -> bool:
    levels = item.get("supported_reasoning_levels") or item.get("supportedReasoningLevels")
    if isinstance(levels, list) and levels:
        return True
    if item.get("supports_reasoning_summaries") or item.get("supportsReasoningSummaries"):
        return True
    if item.get("default_reasoning_level") or item.get("defaultReasoningLevel"):
        return True
    return False


def _supports_vision(item: dict[str, Any]) -> bool:
    modalities = item.get("input_modalities") or item.get("inputModalities")
    if isinstance(modalities, list):
        lowered = {str(x).strip().lower() for x in modalities}
        return bool(lowered & {"image", "vision", "input_image"})
    return True  # Codex chat models typically accept images; unknown → allow


def normalize_codex_model_row(item: dict[str, Any], *, source: str = "remote") -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    slug = item.get("slug") or item.get("id") or item.get("model")
    mid = str(slug or "").strip()
    if not mid:
        return None
    if not _visibility_is_listable(item.get("visibility")):
        return None

    context_window = _int_or_none(item.get("context_window") if "context_window" in item else item.get("contextWindow"))
    max_context_window = _int_or_none(
        item.get("max_context_window") if "max_context_window" in item else item.get("maxContextWindow")
    )
    # Official: prefer context_window, fall back to max_context_window.
    resolved = context_window or max_context_window

    display = item.get("display_name") or item.get("displayName") or mid
    description = item.get("description")
    row: dict[str, Any] = {
        "id": mid,
        "slug": mid,
        "display_name": str(display).strip() or mid,
        "supports_reasoning": _supports_reasoning(item),
        "supports_vision": _supports_vision(item),
        "source": source,
    }
    if isinstance(description, str) and description.strip():
        row["description"] = description.strip()
    if context_window is not None:
        row["context_window"] = context_window
    if max_context_window is not None:
        row["max_context_window"] = max_context_window
    if resolved is not None:
        row["resolved_context_window"] = resolved
    else:
        row["context_window_missing"] = True
    return row


def builtin_codex_models() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in BUILTIN_CODEX_MODEL_CATALOG:
        row = normalize_codex_model_row(dict(item), source="builtin")
        if row:
            out.append(row)
    return out


def lookup_builtin_codex_model(model_id: str) -> dict[str, Any] | None:
    needle = str(model_id or "").strip().lower()
    if not needle:
        return None
    for row in builtin_codex_models():
        if str(row.get("id") or "").lower() == needle:
            return row
    return None


def _auth_headers(access_token: str, account_id: str) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "User-Agent": CODEX_OAUTH_USER_AGENT,
        "originator": "evoflow",
    }
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
    return headers


def _fetch_models_once(access_token: str, account_id: str, *, timeout: float = 45.0) -> httpx.Response:
    url = f"{DEFAULT_CODEX_BASE_URL.rstrip('/')}/models"
    params = {"client_version": CODEX_MODELS_CLIENT_VERSION}
    with httpx.Client(timeout=timeout) as client:
        return client.get(url, headers=_auth_headers(access_token, account_id), params=params)


def _parse_models_payload(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    rows = payload.get("models")
    if rows is None:
        rows = payload.get("data")
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in rows:
        if isinstance(item, str):
            row = normalize_codex_model_row({"slug": item}, source="remote")
        elif isinstance(item, dict):
            row = normalize_codex_model_row(item, source="remote")
        else:
            continue
        if not row:
            continue
        mid = str(row["id"])
        if mid in seen:
            continue
        seen.add(mid)
        out.append(row)
    return out


def list_codex_subscription_models(*, allow_builtin_fallback: bool = True) -> dict[str, Any]:
    """List models available to the signed-in Codex / ChatGPT subscription.

    Uses OAuth tokens (with refresh-on-401). Builtin catalog is only a degraded
    candidate list when the remote catalog cannot be reached after auth succeeds.
    """
    try:
        creds = resolve_runtime_tokens(force_refresh=False, refresh_if_expiring=True)
    except CodexAuthError as exc:
        return {
            "success": False,
            "message": str(exc),
            "models": [],
            "relogin_required": bool(exc.relogin_required),
            "code": exc.code,
        }

    access = str(creds.get("access_token") or "")
    account_id = str(creds.get("account_id") or "")
    if not access:
        return {
            "success": False,
            "message": "Codex access token missing. Please sign in again.",
            "models": [],
            "relogin_required": True,
            "code": "codex_auth_missing",
        }

    try:
        resp = _fetch_models_once(access, account_id)
        if resp.status_code == 401:
            # Refresh once, then retry — same pattern as inference 401 handling.
            try:
                creds = resolve_runtime_tokens(force_refresh=True, refresh_if_expiring=True)
            except CodexAuthError as exc:
                return {
                    "success": False,
                    "message": str(exc),
                    "models": [],
                    "relogin_required": bool(exc.relogin_required),
                    "code": exc.code,
                }
            access = str(creds.get("access_token") or "")
            account_id = str(creds.get("account_id") or "")
            resp = _fetch_models_once(access, account_id)
    except httpx.TimeoutException:
        if allow_builtin_fallback:
            fb = builtin_codex_models()
            return {
                "success": True,
                "message": f"官方目录请求超时；下列 {len(fb)} 个为内置候选，实际以账号可用范围为准",
                "models": fb,
                "degraded": True,
                "source": "builtin",
            }
        return {"success": False, "message": "请求超时，请检查网络", "models": []}
    except Exception as exc:
        logger.exception("list_codex_subscription_models transport error")
        if allow_builtin_fallback:
            fb = builtin_codex_models()
            return {
                "success": True,
                "message": f"官方目录请求失败（{exc}）；下列 {len(fb)} 个为内置候选",
                "models": fb,
                "degraded": True,
                "source": "builtin",
            }
        return {"success": False, "message": f"请求失败: {exc}", "models": []}

    if resp.status_code == 401:
        return {
            "success": False,
            "message": "Codex 授权已失效，请重新登录 ChatGPT / Codex 账号",
            "models": [],
            "relogin_required": True,
            "code": "codex_unauthorized",
        }

    if resp.status_code != 200:
        snippet = (resp.text or "")[:400].replace("\n", " ")
        if allow_builtin_fallback and resp.status_code in {404, 405, 501}:
            fb = builtin_codex_models()
            return {
                "success": True,
                "message": f"官方目录不可用（HTTP {resp.status_code}）；下列 {len(fb)} 个为内置候选",
                "models": fb,
                "degraded": True,
                "source": "builtin",
            }
        return {
            "success": False,
            "message": f"厂商返回 HTTP {resp.status_code}: {snippet}",
            "models": [],
            "relogin_required": False,
        }

    try:
        payload = resp.json()
    except Exception:
        return {"success": False, "message": "响应不是合法 JSON", "models": []}

    models = _parse_models_payload(payload)
    if not models and allow_builtin_fallback:
        fb = builtin_codex_models()
        return {
            "success": True,
            "message": f"官方目录为空；下列 {len(fb)} 个为内置候选",
            "models": fb,
            "degraded": True,
            "source": "builtin",
        }

    return {
        "success": True,
        "message": f"共 {len(models)} 个 Codex 模型",
        "models": models,
        "source": "remote",
        "base_url": DEFAULT_CODEX_BASE_URL,
    }
