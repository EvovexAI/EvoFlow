"""Verify user-defined environment variables are filled locally (no remote API calls)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from evoflow.persistence.custom_env_settings import get_custom_env_dict

# Keys we can check locally (grouped to avoid duplicate checks).
_ARK_KEYS = frozenset({"VOLCENGINE_API_KEY", "ARK_API_KEY"})
_AGNES_KEYS = frozenset({"AGNES_API_KEY", "AGNES_API_TOKEN", "APIHUB_AGNES_API_KEY"})
_KLING_PAIR = ("KLING_ACCESS_KEY_ID", "KLING_ACCESS_KEY_SECRET")
_TTS_PAIR = ("VOLCENGINE_TTS_APPID", "VOLCENGINE_TTS_ACCESS_TOKEN")
_ALIYUN_PAIR = ("ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET")

_OK_MSG = "已填写（本地生效）"


def _verify_single(env: dict[str, str], key: str) -> tuple[bool, str]:
    """Check a single-value key is non-empty."""
    value = str(env.get(key) or "").strip()
    if not value:
        return False, "值为空"
    return True, _OK_MSG


def _verify_kling(env: dict[str, str], key: str) -> tuple[bool, str]:
    api_key = str(env.get("KLING_API_KEY") or "").strip()
    key_id = str(env.get("KLING_ACCESS_KEY_ID") or "").strip()
    secret = str(env.get("KLING_ACCESS_KEY_SECRET") or "").strip()

    if key == "KLING_API_KEY":
        if not api_key:
            return False, "值为空"
        return True, _OK_MSG
    if key == "KLING_ACCESS_KEY_ID":
        if not key_id:
            return False, "值为空"
        if not secret:
            return False, "需同时配置 KLING_ACCESS_KEY_SECRET"
        return True, _OK_MSG
    if key == "KLING_ACCESS_KEY_SECRET":
        if not secret:
            return False, "值为空"
        if not key_id:
            return False, "需同时配置 KLING_ACCESS_KEY_ID"
        return True, _OK_MSG
    return False, "未知可灵变量"


def _verify_volcengine_tts(env: dict[str, str], key: str) -> tuple[bool, str]:
    app_id = str(env.get("VOLCENGINE_TTS_APPID") or "").strip()
    token = str(env.get("VOLCENGINE_TTS_ACCESS_TOKEN") or "").strip()

    if key == "VOLCENGINE_TTS_APPID":
        if not app_id:
            return False, "值为空"
        if not token:
            return False, "需同时配置 VOLCENGINE_TTS_ACCESS_TOKEN"
        return True, _OK_MSG
    if not token:
        return False, "值为空"
    if not app_id:
        return False, "需同时配置 VOLCENGINE_TTS_APPID"
    return True, _OK_MSG


def _verify_aliyun_pair(env: dict[str, str], key: str) -> tuple[bool, str]:
    key_id = str(env.get("ALIYUN_ACCESS_KEY_ID") or "").strip()
    secret = str(env.get("ALIYUN_ACCESS_KEY_SECRET") or "").strip()
    if key == "ALIYUN_ACCESS_KEY_ID":
        if not key_id:
            return False, "值为空"
        if not secret:
            return False, "需同时配置 ALIYUN_ACCESS_KEY_SECRET"
        return True, _OK_MSG
    if not secret:
        return False, "值为空"
    if not key_id:
        return False, "需同时配置 ALIYUN_ACCESS_KEY_ID"
    return True, _OK_MSG


_KEY_VERIFIERS: dict[str, Callable[[dict[str, str], str], tuple[bool, str]]] = {
    "VOLCENGINE_API_KEY": _verify_single,
    "ARK_API_KEY": _verify_single,
    "DASHSCOPE_API_KEY": _verify_single,
    "AGNES_API_KEY": _verify_single,
    "AGNES_API_TOKEN": _verify_single,
    "APIHUB_AGNES_API_KEY": _verify_single,
    "KLING_API_KEY": _verify_kling,
    "KLING_ACCESS_KEY_ID": _verify_kling,
    "KLING_ACCESS_KEY_SECRET": _verify_kling,
    "VOLCENGINE_TTS_APPID": _verify_volcengine_tts,
    "VOLCENGINE_TTS_ACCESS_TOKEN": _verify_volcengine_tts,
    "ALIYUN_ACCESS_KEY_ID": _verify_aliyun_pair,
    "ALIYUN_ACCESS_KEY_SECRET": _verify_aliyun_pair,
}


def _merged_env_for_verify(form_vars: list[dict[str, Any]] | None) -> dict[str, str]:
    env: dict[str, str] = {}
    try:
        from evoflow.persistence.media_settings import apply_media_credentials_to_mapping

        apply_media_credentials_to_mapping(env)
    except Exception:
        pass
    for key, value in get_custom_env_dict().items():
        env[key] = value
    for item in form_vars or []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        env[key] = str(item.get("value") or "")
    return env


def verify_custom_env_vars(form_vars: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Return per-key verification results for keys present in *form_vars*.

    Only checks whether values are filled locally — no remote API calls.
    """
    env = _merged_env_for_verify(form_vars)
    results: list[dict[str, Any]] = []
    group_cache: dict[str, dict[str, Any]] = {}

    def _group_for(key: str) -> str:
        if key in _ARK_KEYS:
            return "ark"
        if key in _AGNES_KEYS:
            return "agnes"
        if key in _KLING_PAIR or key == "KLING_API_KEY":
            return "kling"
        if key in _TTS_PAIR:
            return "tts"
        if key in _ALIYUN_PAIR:
            return "aliyun"
        return key

    for item in form_vars or []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        value = str(item.get("value") or "")
        verifier = _KEY_VERIFIERS.get(key)

        if verifier is None:
            if not value.strip():
                results.append({"key": key, "ok": False, "message": "值为空", "skipped": False})
            else:
                results.append(
                    {
                        "key": key,
                        "ok": True,
                        "message": "已填写",
                        "skipped": True,
                    }
                )
            continue

        group = _group_for(key)
        if group not in group_cache:
            try:
                ok, message = verifier(env, key)
            except Exception as exc:
                ok, message = False, str(exc)
            group_cache[group] = {"ok": ok, "message": message, "skipped": False}

        cached = group_cache[group]
        results.append({"key": key, **cached})

    return results
