from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import uuid

import httpx

from app.gateway.speech.volcengine_asr_ws import transcribe_audio_nostream_ws

logger = logging.getLogger(__name__)

OPENSPEECH_BASE = "https://openspeech.bytedance.com"
OPENSPEECH_WS_BASE = "wss://openspeech.bytedance.com"

TTS_URL_STANDARD = f"{OPENSPEECH_BASE}/api/v3/tts/unidirectional"
TTS_URL_AGENT_PLAN = f"{OPENSPEECH_BASE}/api/v3/plan/tts/unidirectional"
ASR_FLASH_URL_STANDARD = f"{OPENSPEECH_BASE}/api/v3/auc/bigmodel/recognize/flash"
ASR_FLASH_URL_AGENT_PLAN = f"{OPENSPEECH_BASE}/api/v3/plan/auc/bigmodel/recognize/flash"
ASR_WS_NOSTREAM_STANDARD = f"{OPENSPEECH_WS_BASE}/api/v3/sauc/bigmodel_nostream"
ASR_WS_NOSTREAM_AGENT_PLAN = f"{OPENSPEECH_WS_BASE}/api/v3/plan/sauc/bigmodel_nostream"
ASR_WS_ASYNC_STANDARD = f"{OPENSPEECH_WS_BASE}/api/v3/sauc/bigmodel_async"
ASR_WS_ASYNC_AGENT_PLAN = f"{OPENSPEECH_WS_BASE}/api/v3/plan/sauc/bigmodel_async"

DEFAULT_TTS_RESOURCE_ID = "seed-tts-2.0"
DEFAULT_TTS_SPEAKER = "zh_female_vv_uranus_bigtts"
DEFAULT_ASR_RESOURCE_ID = "volc.bigasr.auc_turbo"
DEFAULT_AGENT_PLAN_ASR_RESOURCE_ID = "volc.seedasr.sauc.duration"

SPEECH_CONSOLE_URL = "https://console.volcengine.com/speech/service/8"
AGENT_PLAN_DOC_URL = "https://www.volcengine.com/docs/82379/2516286?lang=zh"

_AGENT_PLAN_DEDUCT_MARKERS = (
    "AgentPlanDeductNotEnabled",
    "Agent Plan deduction is not enabled",
    "未开通 Agent Plan",
)

_STREAMING_ASR_RESOURCE_IDS = frozenset(
    {
        "volc.seedasr.sauc.duration",
        "volc.seedasr.sauc.concurrent",
        "volc.bigasr.sauc.duration",
        "volc.bigasr.sauc.concurrent",
    }
)


def _normalize_key(raw: str) -> str:
    return str(raw or "").strip().strip('"').strip("'")


def _is_agent_plan_key(api_key: str) -> bool:
    """Check if API key belongs to Agent Plan (legacy, use config-based check)."""
    return _normalize_key(api_key).lower().startswith("ark-")


def get_model_plan_config(model_name: str) -> dict | None:
    """Get plan configuration for a model from database."""
    from evoflow.persistence.db import get_db
    conn = get_db()
    row = conn.execute(
        "SELECT plan_type, plan_config FROM evoflow_models WHERE name = ?",
        (model_name,)
    ).fetchone()
    if not row:
        return None
    import json
    config = json.loads(row["plan_config"]) if row["plan_config"] else {}
    return {
        "plan_type": row["plan_type"] or "none",
        **config
    }


def is_agent_plan(model_name: str) -> bool:
    """Check if model has Agent Plan enabled via config."""
    config = get_model_plan_config(model_name)
    if not config:
        return False
    # Check explicit config first (preferred)
    if config.get("plan_type") == "volcengine_agent":
        return True
    # Fallback to legacy prefix check for backward compatibility
    api_key = config.get("api_key", "")
    return _is_agent_plan_key(api_key)


def get_plan_resources(model_name: str) -> tuple[str, str]:
    """Get TTS/ASR resource IDs for Agent Plan models."""
    config = get_model_plan_config(model_name)
    if not config:
        return DEFAULT_TTS_RESOURCE, DEFAULT_ASR_RESOURCE
    
    if config.get("plan_type") == "volcengine_agent" or _is_agent_plan_key(config.get("api_key", "")):
        return (
            config.get("tts_resource", DEFAULT_TTS_RESOURCE),
            config.get("asr_resource", DEFAULT_ASR_RESOURCE),
        )
    
    return DEFAULT_TTS_RESOURCE, DEFAULT_ASR_RESOURCE


def _resolve_api_key(creds: dict | None = None) -> str:
    from evoflow.persistence.media_settings import get_media_credentials

    creds = creds if creds is not None else get_media_credentials()
    return _normalize_key(
        os.getenv("VOLCENGINE_SPEECH_API_KEY", "")
        or os.getenv("BYTEPLUS_SEED_SPEECH_API_KEY", "")
        or str(creds.get("volcengineSpeechApiKey") or "")
        or os.getenv("VOLCENGINE_API_KEY", "")
        or os.getenv("ARK_API_KEY", "")
        or str(creds.get("volcengineApiKey") or "")
        or os.getenv("VOLCENGINE_TTS_ACCESS_TOKEN", "")
    )


def _load_credentials() -> tuple[str, str, str, str, bool]:
    from evoflow.persistence.media_settings import apply_media_credentials_to_environ, get_media_credentials

    apply_media_credentials_to_environ()
    creds = get_media_credentials()
    api_key = _resolve_api_key(creds)
    agent_plan = _is_agent_plan_key(api_key)
    # 直接从 creds 读取，避免环境变量带来的不确定性
    tts_resource = (
        str(creds.get("volcengineTtsResourceId") or "").strip()
        or os.getenv("VOLCENGINE_TTS_RESOURCE_ID", DEFAULT_TTS_RESOURCE_ID).strip()
        or DEFAULT_TTS_RESOURCE_ID
    )
    tts_speaker = (
        str(creds.get("volcengineTtsSpeaker") or "").strip()
        or os.getenv("VOLCENGINE_TTS_SPEAKER", DEFAULT_TTS_SPEAKER).strip()
        or DEFAULT_TTS_SPEAKER
    )
    asr_default = DEFAULT_AGENT_PLAN_ASR_RESOURCE_ID if agent_plan else DEFAULT_ASR_RESOURCE_ID
    asr_resource = (
        str(creds.get("volcengineAsrResourceId") or "").strip()
        or os.getenv("VOLCENGINE_ASR_RESOURCE_ID", asr_default).strip()
        or asr_default
    )
    return api_key, tts_resource, tts_speaker, asr_resource, agent_plan


def speech_configured() -> bool:
    from evoflow.persistence.media_settings import get_enabled_vendors

    if not get_enabled_vendors().get("volcengine-tts", False):
        return False
    api_key, *_ = _load_credentials()
    return bool(api_key)


def _require_credentials() -> tuple[str, str, str, str, bool]:
    api_key, tts_resource, tts_speaker, asr_resource, agent_plan = _load_credentials()
    if not api_key:
        raise ValueError(
            "请在 设置 → 模型 → 创意媒体 → 火山 TTS 填写语音 API Key。"
            "Agent Plan 用户可填火山方舟专属 Key（ark- 开头）；"
            "也可复用同页「火山方舟」里的 Key。"
        )
    if not get_enabled_vendors_safe():
        raise ValueError("Enable 火山 TTS vendor in Settings → Models")
    return api_key, tts_resource, tts_speaker, asr_resource, agent_plan


def get_enabled_vendors_safe() -> bool:
    from evoflow.persistence.media_settings import get_enabled_vendors

    return bool(get_enabled_vendors().get("volcengine-tts", False))


def _speech_headers(*, api_key: str, resource_id: str, request_id: str | None = None) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
    }
    if request_id:
        headers["X-Api-Request-Id"] = request_id
        headers["X-Api-Sequence"] = "-1"
    return headers


def _tts_url(agent_plan: bool) -> str:
    return TTS_URL_AGENT_PLAN if agent_plan else TTS_URL_STANDARD


def _tts_urls_to_try(
    *,
    agent_plan: bool,
    explicit_speaker: bool = False,
    preview: bool = False,
    resource_id: str = "",
) -> list[str]:
    """Resolve TTS endpoints.

    Agent Plan（ark- Key）只走官方 Plan HTTP 口：
    ``https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional``
    （Resource-Id: seed-tts-2.0）。不要回退到标准 ``/api/v3/tts``，
    ark- Key 打标准口会 401，且与 Agent Plan 文档不一致。

    ``explicit_speaker`` / ``preview`` / ``resource_id`` 保留以兼容调用方签名。
    """
    _ = (explicit_speaker, preview, resource_id)
    if agent_plan:
        return [TTS_URL_AGENT_PLAN]
    return [TTS_URL_STANDARD]


def _tts_url_for_synthesis(
    *,
    agent_plan: bool,
    explicit_speaker: bool,
    preview: bool,
    resource_id: str,
) -> str:
    return _tts_urls_to_try(
        agent_plan=agent_plan,
        explicit_speaker=explicit_speaker,
        preview=preview,
        resource_id=resource_id,
    )[0]


def _is_agent_plan_deduct_error(message: str) -> bool:
    text = str(message or "")
    return any(m in text for m in _AGENT_PLAN_DEDUCT_MARKERS)


def _format_tts_business_error(code, message: str) -> str:
    raw = str(message or "")
    if _is_agent_plan_deduct_error(raw) or code in (45000030, "45000030"):
        return (
            "当前方舟 Key 未开通 Agent Plan 语音抵扣（AgentPlanDeductNotEnabled）。"
            "请确认已订阅 Agent Plan，并在方舟控制台开启语音/AFP 抵扣；"
            f"TTS 应使用 Plan 接口与 Resource-Id=seed-tts-2.0。"
            f"说明：{AGENT_PLAN_DOC_URL}"
        )
    return f"TTS error code={code}: {raw}"


def _raise_tts_business_error(code, message: str) -> None:
    text = _format_tts_business_error(code, message)
    if _is_agent_plan_deduct_error(text) or code in (45000030, "45000030"):
        raise ValueError(text) from None
    raise RuntimeError(text)


def _asr_flash_url(agent_plan: bool) -> str:
    return ASR_FLASH_URL_AGENT_PLAN if agent_plan else ASR_FLASH_URL_STANDARD


def _asr_ws_url(agent_plan: bool) -> str:
    return ASR_WS_NOSTREAM_AGENT_PLAN if agent_plan else ASR_WS_NOSTREAM_STANDARD


def _asr_ws_async_url(agent_plan: bool) -> str:
    return ASR_WS_ASYNC_AGENT_PLAN if agent_plan else ASR_WS_ASYNC_STANDARD


def get_asr_stream_credentials() -> tuple[str, str, str]:
    """Return (api_key, resource_id, ws_url) for live streaming ASR."""
    api_key, _, _, asr_resource, agent_plan = _require_credentials()
    return api_key, asr_resource, _asr_ws_async_url(agent_plan)


def speech_streaming_asr_available() -> bool:
    if not speech_configured():
        return False
    _, _, _, asr_resource, _ = _load_credentials()
    return _asr_uses_streaming(asr_resource)


def _asr_uses_streaming(resource_id: str) -> bool:
    rid = resource_id.strip().lower()
    if rid in _STREAMING_ASR_RESOURCE_IDS:
        return True
    return "sauc" in rid and "turbo" not in rid and "auc_turbo" not in rid


def _parse_tts_ndjson(body: str) -> bytes:
    chunks: list[bytes] = []
    decoder = json.JSONDecoder()
    idx = 0
    raw = body.strip()
    while idx < len(raw):
        while idx < len(raw) and raw[idx].isspace():
            idx += 1
        if idx >= len(raw):
            break
        try:
            obj, end = decoder.raw_decode(raw, idx)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"TTS invalid NDJSON at {idx}: {raw[idx : idx + 120]!r}") from e
        idx = end
        code = obj.get("code")
        if code == 0 and obj.get("data"):
            chunks.append(base64.b64decode(str(obj["data"])))
            continue
        if code == 20000000:
            break
        if code not in (0, 20000000):
            message = obj.get("message") or obj.get("msg") or str(obj)
            _raise_tts_business_error(code, message)
    if not chunks:
        raise RuntimeError("TTS returned empty audio")
    return b"".join(chunks)


def _resolve_tts_resource_id(speaker: str, configured: str) -> str:
    """Map speaker id to X-Api-Resource-Id (seed-tts-2.0 vs seed-tts-1.0 vs seed-icl-2.0)."""
    sid = str(speaker or "").strip().lower()
    fallback = str(configured or "").strip() or DEFAULT_TTS_RESOURCE_ID
    if not sid:
        return fallback
    if sid.startswith("s_"):
        return "seed-icl-2.0"
    if sid.startswith("saturn_") or "_uranus_" in sid:
        return "seed-tts-2.0"
    if sid.startswith("icl_uranus_"):
        return "seed-tts-2.0"
    if sid.startswith("icl_"):
        return "seed-tts-1.0"
    if sid.endswith("_moon_bigtts") or sid.endswith("_mars_bigtts") or "_conversation_wvae_bigtts" in sid:
        return "seed-tts-1.0"
    return fallback


def synthesize_speech_v3(text: str, *, speaker: str | None = None, preview: bool = False) -> tuple[bytes, str]:
    api_key, configured_resource, default_speaker, _, agent_plan = _require_credentials()
    explicit_speaker = bool(str(speaker or "").strip())
    use_speaker = str(speaker or "").strip() or default_speaker
    resource_id = _resolve_tts_resource_id(use_speaker, configured_resource)
    req_params: dict = {
        "text": text[:4000],
        "speaker": use_speaker,
        "audio_params": {"format": "mp3", "sample_rate": 24000},
    }
    if preview:
        req_params["additions"] = json.dumps(
            {
                "cache_config": {"text_type": 1, "use_cache": False},
                "section_id": str(uuid.uuid4()),
            },
            ensure_ascii=False,
        )
    payload = {
        "user": {"uid": f"evoflow-{'preview' if preview else 'chat'}-{uuid.uuid4().hex[:12]}"},
        "req_params": req_params,
    }
    headers = _speech_headers(
        api_key=api_key,
        resource_id=resource_id,
        request_id=str(uuid.uuid4()),
    )
    urls = _tts_urls_to_try(
        agent_plan=agent_plan,
        explicit_speaker=explicit_speaker,
        preview=preview,
        resource_id=resource_id,
    )
    last_error: BaseException | None = None
    with httpx.Client(timeout=120.0) as client:
        for i, url in enumerate(urls):
            allow_retry = i < len(urls) - 1
            try:
                resp = client.post(url, json=payload, headers=headers)
                if resp.status_code != 200:
                    last_error = RuntimeError(f"TTS HTTP {resp.status_code}: {resp.text[:300]}")
                    if allow_retry:
                        logger.warning(
                            "TTS failed (%s) on %s, trying next",
                            resp.status_code,
                            url,
                        )
                        continue
                    raise last_error
                audio = _parse_tts_ndjson(resp.text)
                digest = hashlib.md5(audio).hexdigest()[:12]
                logger.info(
                    "TTS ok speaker=%s resource=%s url=%s digest=%s",
                    use_speaker,
                    resource_id,
                    url,
                    digest,
                )
                return audio, use_speaker
            except ValueError as e:
                last_error = e
                if allow_retry and _is_agent_plan_deduct_error(str(e)):
                    logger.warning("TTS deduct error on %s, trying next: %s", url, e)
                    continue
                raise
            except Exception as e:
                last_error = e
                if allow_retry:
                    logger.warning("TTS error on %s: %s, trying next", url, e)
                    continue
                raise
    if last_error:
        raise last_error
    raise RuntimeError("TTS returned empty audio")


async def synthesize_speech_v3_stream(text: str, *, speaker: str | None = None, preview: bool = False):
    """Streaming version of synthesize_speech_v3 — yields audio chunks as they arrive.

    Uses httpx async streaming to read the NDJSON response line by line,
    decoding base64 audio data and yielding immediately.  This reduces
    first-byte latency from full-synthesis-wait to first-chunk-wait.
    """
    import base64 as _b64
    import json as _json

    api_key, configured_resource, default_speaker, _, agent_plan = _require_credentials()
    explicit_speaker = bool(str(speaker or "").strip())
    use_speaker = str(speaker or "").strip() or default_speaker
    resource_id = _resolve_tts_resource_id(use_speaker, configured_resource)
    req_params: dict = {
        "text": text[:4000],
        "speaker": use_speaker,
        "audio_params": {"format": "mp3", "sample_rate": 24000},
    }
    if preview:
        req_params["additions"] = _json.dumps(
            {
                "cache_config": {"text_type": 1, "use_cache": False},
                "section_id": str(uuid.uuid4()),
            },
            ensure_ascii=False,
        )
    payload = {
        "user": {"uid": f"evoflow-{'preview' if preview else 'chat'}-{uuid.uuid4().hex[:12]}"},
        "req_params": req_params,
    }
    headers = _speech_headers(
        api_key=api_key,
        resource_id=resource_id,
        request_id=str(uuid.uuid4()),
    )
    urls_to_try = _tts_urls_to_try(
        agent_plan=agent_plan,
        explicit_speaker=explicit_speaker,
        preview=preview,
        resource_id=resource_id,
    )

    async def _drain_response(resp):
        """Parse NDJSON lines from a streaming response, yield audio chunks."""
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line or line == "[DONE]":
                continue
            if not line.startswith("{"):
                continue
            try:
                obj = _json.loads(line)
            except _json.JSONDecodeError:
                continue
            code = obj.get("code")
            if code == 0 and obj.get("data"):
                yield _b64.b64decode(str(obj["data"]))
                continue
            if code == 20000000:
                break
            if code not in (0, 20000000):
                message = obj.get("message") or obj.get("msg") or str(obj)
                _raise_tts_business_error(code, message)

    last_error: BaseException | None = None
    for i, try_url in enumerate(urls_to_try):
        allow_retry = i < len(urls_to_try) - 1
        yielded = False
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream("POST", try_url, json=payload, headers=headers) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        last_error = RuntimeError(f"TTS HTTP {resp.status_code}: {body[:300]!r}")
                        if allow_retry:
                            logger.warning(
                                "TTS stream failed (%s) on %s, trying next",
                                resp.status_code,
                                try_url,
                            )
                            continue
                        raise last_error
                    async for chunk in _drain_response(resp):
                        yielded = True
                        yield chunk
                    if yielded:
                        return
                    last_error = RuntimeError("TTS returned empty audio")
                    if allow_retry:
                        continue
                    raise last_error
        except ValueError as e:
            last_error = e
            if allow_retry and not yielded and _is_agent_plan_deduct_error(str(e)):
                logger.warning("TTS stream deduct error on %s, trying next: %s", try_url, e)
                continue
            raise
        except Exception as e:
            last_error = e
            if allow_retry and not yielded:
                logger.warning("TTS stream error on %s: %s, trying next", try_url, e)
                continue
            raise

    if last_error:
        raise last_error
    raise RuntimeError("TTS returned empty audio")


def _parse_asr_flash_response(resp: httpx.Response) -> str:
    status = str(resp.headers.get("X-Api-Status-Code") or "").strip()
    if status and status != "20000000":
        msg = resp.headers.get("X-Api-Message") or resp.text[:300]
        raise RuntimeError(f"ASR failed ({status}): {msg}")
    try:
        data = resp.json()
    except Exception as e:
        raise RuntimeError(f"ASR invalid JSON: {resp.text[:300]}") from e
    result = data.get("result") if isinstance(data, dict) else None
    if not isinstance(result, dict):
        result = data if isinstance(data, dict) else {}
    text = str(result.get("text") or data.get("text") or "").strip()
    if text:
        return text
    utterances = result.get("utterances")
    if isinstance(utterances, list):
        parts = [str(u.get("text") or "").strip() for u in utterances if isinstance(u, dict)]
        joined = "".join(p for p in parts if p)
        if joined:
            return joined
    raise RuntimeError("ASR returned empty transcript")


def _raise_asr_http_error(resp: httpx.Response, *, agent_plan: bool) -> None:
    body = resp.text[:500]
    msg = body
    try:
        data = resp.json()
        header = data.get("header") if isinstance(data, dict) else None
        if isinstance(header, dict):
            code = header.get("code")
            message = header.get("message") or header.get("msg")
            if message:
                msg = f"{message} (code={code})"
    except Exception:
        pass
    if "Invalid X-Api-Key" in msg or "45000010" in msg:
        if agent_plan:
            raise ValueError(
                "语音 API Key 无效。Agent Plan 请确认已开通语音权益，并使用火山方舟专属 Key（ark- 开头）。"
                f"配置说明：{AGENT_PLAN_DOC_URL}"
            ) from None
        raise ValueError(
            "语音 API Key 无效。请使用豆包语音控制台创建的 Speech Key，"
            f"或 Agent Plan 专属 Key。控制台：{SPEECH_CONSOLE_URL}"
        ) from None
    raise RuntimeError(f"ASR HTTP {resp.status_code}: {msg}")


def transcribe_audio_flash(audio_bytes: bytes, *, audio_format: str = "wav") -> str:
    api_key, _, _, asr_resource, agent_plan = _require_credentials()
    if _asr_uses_streaming(asr_resource):
        return transcribe_audio_nostream_ws(
            audio_bytes=audio_bytes,
            api_key=api_key,
            resource_id=asr_resource,
            ws_url=_asr_ws_url(agent_plan),
        )

    req_id = str(uuid.uuid4())
    headers = _speech_headers(api_key=api_key, resource_id=asr_resource, request_id=req_id)
    payload = {
        "user": {"uid": "evoflow-chat"},
        "audio": {
            "data": base64.b64encode(audio_bytes).decode("ascii"),
            "format": audio_format or "wav",
        },
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
        },
    }
    url = _asr_flash_url(agent_plan)
    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, json=payload, headers=headers)
    if resp.status_code != 200:
        _raise_asr_http_error(resp, agent_plan=agent_plan)
    return _parse_asr_flash_response(resp)
