"""Verify Agent Plan capabilities with lightweight live probes."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from evoflow.plans import bindings as bindings_store
from evoflow.plans.catalog import get_catalog_entry, tier_entitlements
from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.volc_agent_plan_models import PLAN_CHAT_BASE, PLAN_MEDIA_BASE

logger = logging.getLogger(__name__)

_CHAT_PROBE_MAX = 3
_EMBED_PROBE_MAX = 3


def _ok(capability: str, *, label: str, message: str = "可用", checks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "capability": capability,
        "label": label,
        "ok": True,
        "message": message,
        "checks": checks or [],
    }


def _fail(
    capability: str,
    *,
    label: str,
    message: str,
    checks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "capability": capability,
        "label": label,
        "ok": False,
        "message": message,
        "checks": checks or [],
    }


def _skip(capability: str, *, label: str, message: str) -> dict[str, Any]:
    return {
        "capability": capability,
        "label": label,
        "ok": None,
        "skipped": True,
        "message": message,
        "checks": [],
    }


def _check(id_: str, *, label: str, ok: bool, message: str) -> dict[str, Any]:
    return {"id": id_, "label": label, "ok": ok, "message": message}


def _normalize_base(url: str) -> str:
    return str(url or "").strip().rstrip("/").lower()


def _is_plan_base(url: str) -> bool:
    n = _normalize_base(url)
    return n in {
        _normalize_base(PLAN_CHAT_BASE),
        _normalize_base(PLAN_MEDIA_BASE),
        "https://ark.cn-beijing.volces.com/api/coding/v3",
    } or "/api/plan/v3" in n


def _list_plan_models() -> list[dict[str, Any]]:
    try:
        from evoflow.persistence import config_repositories as cfg_repo

        return list(cfg_repo.list_models() or [])
    except Exception as exc:
        logger.info("list models for plan verify failed: %s", exc)
        return []


def _is_embedding_row(row: dict[str, Any]) -> bool:
    blob = " ".join(
        str(row.get(k) or "").lower()
        for k in ("vendor", "name", "model", "display_name", "description")
    )
    return "embedding" in blob


def _is_plan_vendor_row(row: dict[str, Any]) -> bool:
    vendor = str(row.get("vendor") or "").lower()
    if vendor == "volcengine" or vendor.startswith("volcengine"):
        return True
    return _is_plan_base(str(row.get("base_url") or ""))


async def _post_chat(
    *,
    base_url: str,
    api_key: str,
    model_id: str,
    timeout: float = 25.0,
) -> tuple[bool, str]:
    base = str(base_url or "").strip().rstrip("/")
    if not base or not api_key or not model_id:
        return False, "缺少 base_url / api_key / model"
    url = f"{base}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model_id,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
    }
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=body, headers=headers)
        if resp.status_code == 200:
            return True, "对话可用"
        detail = ""
        try:
            detail = str(resp.json())[:240]
        except Exception:
            detail = (resp.text or "")[:240]
        return False, f"HTTP {resp.status_code}: {detail or '请求失败'}"
    except Exception as exc:
        return False, str(exc)[:240]


async def _probe_embedding(model_name: str) -> tuple[bool, str]:
    try:
        from evoflow.config import get_app_config
        from evoflow.knowledge.embedding import get_embedding

        cfg = get_app_config()
        mc = cfg.get_model_config(model_name)
        if mc is None:
            return False, f"模型配置不存在：{model_name}"
        vec = await get_embedding("probe", mc)
        if vec and len(vec) > 0:
            return True, f"向量可用（dim={len(vec)}）"
        return False, "返回向量为空"
    except Exception as exc:
        return False, str(exc)[:240]


async def _probe_ark_models_list(*, base_url: str, api_key: str) -> tuple[bool, str]:
    base = str(base_url or "").strip().rstrip("/")
    if not base or not api_key:
        return False, "缺少媒体 base_url / api_key"
    url = f"{base}/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code == 200:
            return True, "方舟媒体凭证可用"
        detail = (resp.text or "")[:200]
        return False, f"HTTP {resp.status_code}: {detail or 'models 列表失败'}"
    except Exception as exc:
        return False, str(exc)[:240]


async def _probe_ark_auth_via_invalid_generation(
    *,
    base_url: str,
    api_key: str,
    path: str,
    body: dict[str, Any],
    label: str,
) -> tuple[bool, str]:
    """Agent Plan often has no GET /models — probe auth with a dry generation call.

    Treat auth failures (401/403) as fail. Treat model/param errors (400/404/422)
    or success as evidence the Plan Key can reach the media endpoint.
    """
    base = str(base_url or "").strip().rstrip("/")
    key = str(api_key or "").strip()
    if not base or not key:
        return False, f"缺少{label} base_url / api_key"
    url = f"{base}{path}"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(url, json=body, headers=headers)
    except Exception as exc:
        return False, str(exc)[:240]

    detail = ""
    try:
        detail = str(resp.json())[:240]
    except Exception:
        detail = (resp.text or "")[:240]

    if resp.status_code in (401, 403):
        return False, f"鉴权失败 HTTP {resp.status_code}: {detail or '检查 Agent Plan Key'}"
    if resp.status_code == 200:
        return True, f"{label}通道可达"
    # 400/404/422: typically invalid model / params — Key reached Ark
    if resp.status_code in (400, 404, 422):
        low = detail.lower()
        if any(x in low for x in ("api key", "unauthorized", "authentication", "鉴权", "未授权")):
            return False, f"鉴权失败 HTTP {resp.status_code}: {detail}"
        return True, f"{label}凭证可用（探测未出图/出片）"
    return False, f"HTTP {resp.status_code}: {detail or '请求失败'}"


async def _probe_tts() -> tuple[bool, str]:
    def _run() -> tuple[bool, str]:
        try:
            from app.gateway.speech.volcengine_speech import speech_configured, synthesize_speech_v3

            if not speech_configured():
                return False, "语音未配置（设置 → 模型 → 创意媒体 → 火山 TTS）"
            audio, speaker = synthesize_speech_v3("你好", preview=True)
            if audio and len(audio) > 32:
                return True, f"TTS 可用（音色 {speaker or 'default'}）"
            return False, "TTS 返回音频为空"
        except Exception as exc:
            return False, str(exc)[:240]

    return await asyncio.to_thread(_run)


async def _probe_asr() -> tuple[bool, str]:
    def _run() -> tuple[bool, str]:
        try:
            from app.gateway.speech.volcengine_speech import (
                speech_configured,
                speech_streaming_asr_available,
            )

            if not speech_configured():
                return False, "语音未配置（设置 → 模型 → 创意媒体 → 火山 TTS）"
            if speech_streaming_asr_available():
                return True, "ASR 凭证与流式通道已就绪"
            return False, "ASR 未就绪：请确认火山语音 Key / Resource Id 已写入"
        except Exception as exc:
            return False, str(exc)[:240]

    return await asyncio.to_thread(_run)


def _cap_label(cap_id: str, catalog: dict[str, Any]) -> str:
    for row in catalog.get("capabilities") or []:
        if str(row.get("id") or "") == cap_id:
            return str(row.get("label") or cap_id)
    defaults = {
        "chat": "对话 / 识图模型",
        "embedding": "向量模型",
        "tts": "语音合成",
        "asr": "语音识别",
        "image": "生图",
        "video": "生视频",
        "web_search": "联网搜索",
    }
    return defaults.get(cap_id, cap_id)


async def _verify_chat(
    *,
    api_key: str,
    base_url: str,
    catalog: dict[str, Any],
    model_ids: list[str] | None = None,
) -> dict[str, Any]:
    label = _cap_label("chat", catalog)
    rows = [r for r in _list_plan_models() if _is_plan_vendor_row(r) and not _is_embedding_row(r)]
    if model_ids:
        want = {str(x).strip() for x in model_ids if str(x).strip()}
        rows = [
            r
            for r in rows
            if str(r.get("model") or "") in want or str(r.get("name") or "") in want
        ]
    if not rows:
        return _fail("chat", label=label, message="未找到已写入的对话模型，请先「按套餐目录补齐」")

    primary = ""
    try:
        from evoflow.config import get_app_config

        primary = str(getattr(get_app_config(), "primary_model", "") or "").strip()
    except Exception:
        primary = ""

    def sort_key(r: dict[str, Any]) -> tuple[int, int, str]:
        name = str(r.get("name") or "")
        vision = 0 if bool(r.get("supports_vision")) else 1
        pri = 0 if name == primary else 1
        return (pri, vision, name)

    rows = sorted(rows, key=sort_key)[:_CHAT_PROBE_MAX]
    checks: list[dict[str, Any]] = []
    for row in rows:
        mid = str(row.get("model") or "").strip()
        name = str(row.get("name") or mid)
        disp = str(row.get("display_name") or name)
        bu = str(row.get("base_url") or base_url).strip() or base_url
        key = str(row.get("api_key") or api_key).strip() or api_key
        ok, msg = await _post_chat(base_url=bu, api_key=key, model_id=mid)
        tag = "识图" if bool(row.get("supports_vision")) else "对话"
        checks.append(_check(name, label=f"{tag} · {disp}", ok=ok, message=msg))

    failed = [c for c in checks if not c["ok"]]
    if not failed:
        return _ok("chat", label=label, message=f"已验证 {len(checks)} 个模型", checks=checks)
    if len(failed) == len(checks):
        return _fail("chat", label=label, message=failed[0]["message"], checks=checks)
    return _fail(
        "chat",
        label=label,
        message=f"{len(checks) - len(failed)}/{len(checks)} 可用，部分失败",
        checks=checks,
    )


async def _verify_embedding(
    *,
    catalog: dict[str, Any],
    model_ids: list[str] | None = None,
) -> dict[str, Any]:
    label = _cap_label("embedding", catalog)
    rows = [r for r in _list_plan_models() if _is_plan_vendor_row(r) and _is_embedding_row(r)]
    if model_ids:
        want = {str(x).strip() for x in model_ids if str(x).strip()}
        rows = [
            r
            for r in rows
            if str(r.get("model") or "") in want or str(r.get("name") or "") in want
        ]
    if not rows:
        return _fail("embedding", label=label, message="未找到套餐向量模型，请先补齐")

    def sort_key(r: dict[str, Any]) -> tuple[int, str]:
        mid = str(r.get("model") or "").lower()
        prefer = 0 if "embedding-vision" in mid else 1
        return (prefer, mid)

    rows = sorted(rows, key=sort_key)[:_EMBED_PROBE_MAX]
    checks: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get("name") or row.get("model") or "")
        disp = str(row.get("display_name") or name)
        ok, msg = await _probe_embedding(name)
        checks.append(_check(name, label=disp, ok=ok, message=msg))

    failed = [c for c in checks if not c["ok"]]
    if not failed:
        return _ok("embedding", label=label, message=f"已验证 {len(checks)} 个向量模型", checks=checks)
    if len(failed) == len(checks):
        return _fail("embedding", label=label, message=failed[0]["message"], checks=checks)
    return _fail(
        "embedding",
        label=label,
        message=f"{len(checks) - len(failed)}/{len(checks)} 可用，部分失败",
        checks=checks,
    )


async def _verify_tts(catalog: dict[str, Any]) -> dict[str, Any]:
    label = _cap_label("tts", catalog)
    ok, msg = await _probe_tts()
    check = _check("tts", label="语音合成试听", ok=ok, message=msg)
    return _ok("tts", label=label, message=msg, checks=[check]) if ok else _fail(
        "tts", label=label, message=msg, checks=[check]
    )


async def _verify_asr(catalog: dict[str, Any]) -> dict[str, Any]:
    label = _cap_label("asr", catalog)
    ok, msg = await _probe_asr()
    check = _check("asr", label="语音识别通道", ok=ok, message=msg)
    return _ok("asr", label=label, message=msg, checks=[check]) if ok else _fail(
        "asr", label=label, message=msg, checks=[check]
    )


async def _verify_image(*, api_key: str, catalog: dict[str, Any]) -> dict[str, Any]:
    label = _cap_label("image", catalog)
    endpoints = catalog.get("endpoints") or {}
    base = str((endpoints.get("image") or {}).get("base_url") or PLAN_MEDIA_BASE)
    key = api_key
    try:
        from evoflow.community.media_generation.config_helpers import volcengine_api_key

        key = volcengine_api_key() or api_key
    except Exception:
        pass
    # Prefer catalog Seedream id when present
    model_id = "doubao-seedream-5.0-lite"
    for row in (catalog.get("capabilities") or []):
        if str(row.get("id") or "") == "image":
            items = list(row.get("items") or [])
            if items:
                model_id = str(items[0].get("id") or model_id)
            break
    ok, msg = await _probe_ark_auth_via_invalid_generation(
        base_url=base,
        api_key=key,
        path="/images/generations",
        body={
            "model": "__evoflow_plan_probe__",
            "prompt": "probe",
            "size": "1024x1024",
            "response_format": "url",
        },
        label="生图",
    )
    # Also accept real model path if invalid-name probe is too strict
    if not ok and "鉴权" not in msg:
        ok2, msg2 = await _probe_ark_auth_via_invalid_generation(
            base_url=base,
            api_key=key,
            path="/images/generations",
            body={
                "model": model_id,
                "prompt": "",
                "size": "1024x1024",
                "response_format": "url",
            },
            label="生图",
        )
        if ok2:
            ok, msg = ok2, msg2
    check = _check("image", label="生图凭证", ok=ok, message=msg)
    if ok:
        return _ok("image", label=label, message=msg, checks=[check])
    return _fail("image", label=label, message=msg, checks=[check])


async def _verify_video(*, api_key: str, catalog: dict[str, Any]) -> dict[str, Any]:
    label = _cap_label("video", catalog)
    endpoints = catalog.get("endpoints") or {}
    base = str((endpoints.get("video") or {}).get("base_url") or PLAN_MEDIA_BASE)
    key = api_key
    try:
        from evoflow.community.media_generation.config_helpers import volcengine_api_key

        key = volcengine_api_key() or api_key
    except Exception:
        pass
    ok, msg = await _probe_ark_auth_via_invalid_generation(
        base_url=base,
        api_key=key,
        path="/contents/generations/tasks",
        body={
            "model": "__evoflow_plan_probe__",
            "content": [{"type": "text", "text": "probe"}],
        },
        label="生视频",
    )
    check = _check("video", label="生视频凭证", ok=ok, message=msg)
    if ok:
        return _ok("video", label=label, message=msg, checks=[check])
    return _fail("video", label=label, message=msg, checks=[check])


async def _verify_web_search(*, api_key: str, catalog: dict[str, Any]) -> dict[str, Any]:
    label = _cap_label("web_search", catalog)
    endpoints = catalog.get("endpoints") or {}
    base = str((endpoints.get("chat") or {}).get("base_url") or PLAN_CHAT_BASE)
    # Agent Plan has no reliable GET /models; reuse a tiny chat completion as Key probe.
    model_id = "doubao-seed-2.0-lite"
    try:
        from evoflow.plans.volc_agent_plan_models import chat_models_for_tier

        tier_models = chat_models_for_tier("small")
        if tier_models:
            model_id = str(tier_models[0].get("id") or model_id)
    except Exception:
        pass
    ok, msg = await _post_chat(base_url=base, api_key=api_key, model_id=model_id)
    if ok:
        msg = (
            "套餐 Key 可用。联网搜索还需在控制台「配置 Harness」领取豆包搜索 Key，"
            "填到「设置 → 联网搜索」（不是这把 ark- Key）"
        )
    check = _check("web_search", label="联网搜索凭证", ok=ok, message=msg)
    if ok:
        return _ok("web_search", label=label, message=msg, checks=[check])
    return _fail("web_search", label=label, message=msg, checks=[check])


async def verify_binding(
    binding_id: str,
    *,
    capabilities: list[str] | None = None,
    model_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Run live probes for an Agent Plan binding.

    Returns ``{ok, binding_id, results: [...]}`` where each result has
    ``capability / label / ok / message / checks``.
    ``ok`` on a result may be ``None`` when skipped (not in tier / not bound).
    """
    secret = bindings_store.get_binding_secret(binding_id)
    if not secret:
        raise PlanError(
            PlanErrorCode.BINDING_NOT_FOUND,
            f"绑定不存在：{binding_id}",
            details={"binding_id": binding_id},
        )
    if str(secret.get("status") or "") != "active":
        raise PlanError(PlanErrorCode.INVALID_REQUEST, "套餐未处于已接通状态，无法验证")

    catalog = get_catalog_entry(str(secret["catalog_id"]))
    api_key = str(secret.get("api_key") or "").strip()
    if not api_key:
        raise PlanError(PlanErrorCode.INVALID_REQUEST, "绑定缺少 API Key")

    tier_id = secret.get("tier_id")
    allowed = set(tier_entitlements(catalog, tier_id))
    bound = {str(c) for c in (secret.get("bound_capabilities") or [])}
    endpoints = catalog.get("endpoints") or {}
    chat_base = str((endpoints.get("chat") or {}).get("base_url") or PLAN_CHAT_BASE)

    want = [str(c).strip() for c in (capabilities or []) if str(c).strip()]
    if not want:
        want = sorted(bound & allowed) if bound else sorted(allowed)
    order = [str(c.get("id") or "") for c in (catalog.get("capabilities") or [])]
    want = sorted(want, key=lambda c: order.index(c) if c in order else 99)

    results: list[dict[str, Any]] = []
    for cap in want:
        label = _cap_label(cap, catalog)
        if cap not in allowed:
            results.append(_skip(cap, label=label, message="本档不含此能力"))
            continue
        if bound and cap not in bound:
            results.append(_skip(cap, label=label, message="未启用（绑定能力未包含）"))
            continue
        try:
            if cap == "chat":
                results.append(
                    await _verify_chat(
                        api_key=api_key,
                        base_url=chat_base,
                        catalog=catalog,
                        model_ids=model_ids,
                    )
                )
            elif cap == "embedding":
                results.append(
                    await _verify_embedding(catalog=catalog, model_ids=model_ids)
                )
            elif cap == "tts":
                results.append(await _verify_tts(catalog))
            elif cap == "asr":
                results.append(await _verify_asr(catalog))
            elif cap == "image":
                results.append(await _verify_image(api_key=api_key, catalog=catalog))
            elif cap == "video":
                results.append(await _verify_video(api_key=api_key, catalog=catalog))
            elif cap == "web_search":
                results.append(await _verify_web_search(api_key=api_key, catalog=catalog))
            else:
                results.append(_skip(cap, label=label, message="暂无自动探测"))
        except Exception as exc:
            logger.exception("plan verify failed for %s", cap)
            results.append(_fail(cap, label=label, message=str(exc)[:240]))

    actionable = [r for r in results if r.get("ok") is not None]
    overall_ok = bool(actionable) and all(bool(r.get("ok")) for r in actionable)
    return {
        "ok": overall_ok,
        "binding_id": binding_id,
        "results": results,
    }
