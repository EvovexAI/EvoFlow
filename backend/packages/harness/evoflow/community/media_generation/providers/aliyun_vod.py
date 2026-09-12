from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any
from urllib.parse import quote

import httpx

from evoflow.community.media_generation.config_helpers import aliyun_credentials

logger = logging.getLogger(__name__)

_IMS_ENDPOINT = "https://ice.cn-shanghai.aliyuncs.com"


def _percent_encode(s: str) -> str:
    return quote(s, safe="~")


def _sign_rpc(params: dict[str, str], access_key_secret: str) -> str:
    import hashlib
    import hmac

    sorted_params = sorted(params.items())
    canonical = "&".join(f"{_percent_encode(k)}={_percent_encode(v)}" for k, v in sorted_params)
    string_to_sign = f"GET&{_percent_encode('/')}&{_percent_encode(canonical)}"
    key = f"{access_key_secret}&".encode()
    digest = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha1).digest()
    import base64

    return base64.b64encode(digest).decode()


def _rpc(action: str, extra: dict[str, str]) -> dict[str, Any]:
    ak, sk, _bucket = aliyun_credentials()
    if not ak or not sk:
        raise ValueError("Set ALIYUN_ACCESS_KEY_ID and ALIYUN_ACCESS_KEY_SECRET for subtitle extraction")

    params: dict[str, str] = {
        "Action": action,
        "Format": "JSON",
        "Version": "2020-11-27",
        "AccessKeyId": ak,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
        "SignatureNonce": str(uuid.uuid4()),
        "Timestamp": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        **extra,
    }
    params["Signature"] = _sign_rpc(params, sk)
    endpoint = os.getenv("ALIYUN_IMS_ENDPOINT", _IMS_ENDPOINT)
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(endpoint, params=params)
    data = resp.json() if resp.status_code < 500 else {"Message": resp.text}
    if resp.status_code >= 400 or data.get("Code"):
        raise RuntimeError(f"Aliyun IMS {action}: {json.dumps(data, ensure_ascii=False)[:400]}")
    return data


def submit_caption_extraction(*, input_oss: str, output_oss: str, job_params: str | None = None) -> str:
    """Submit CaptionExtraction job. input/output must be oss://bucket/key paths."""
    extra = {
        "FunctionName": "CaptionExtraction",
        "Input": json.dumps({"type": "OSS", "media": input_oss}, ensure_ascii=False),
        "Output": json.dumps({"type": "OSS", "media": output_oss}, ensure_ascii=False),
    }
    if job_params:
        extra["JobParams"] = job_params
    data = _rpc("SubmitIProductionJob", extra)
    job_id = data.get("JobId") or data.get("jobId")
    if not job_id:
        raise RuntimeError(f"SubmitIProductionJob missing JobId: {data}")
    return str(job_id)


def poll_caption_extraction(job_id: str) -> tuple[str, str | None, list[str]]:
    data = _rpc("QueryIProductionJob", {"JobId": job_id})
    status = str(data.get("Status") or "Processing")
    urls: list[str] = []
    for key in ("OutputUrls", "outputUrls"):
        val = data.get(key)
        if isinstance(val, list):
            urls.extend(str(u) for u in val if u)
    st = status.lower()
    if st == "success":
        st = "succeeded"
    return st, urls[0] if urls else None, urls
