"""Upload local media to DashScope temporary OSS (oss:// URLs for Wan / multimodal APIs)."""

from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path

import httpx

from evoflow.community.media_generation.config_helpers import dashscope_api_key

logger = logging.getLogger(__name__)


def _base_url() -> str:
    return os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1").rstrip("/")


def _get_upload_policy(*, model_name: str, api_key: str) -> dict:
    url = f"{_base_url()}/uploads"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    params = {"action": "getPolicy", "model": model_name}
    with httpx.Client(timeout=60.0) as client:
        resp = client.get(url, headers=headers, params=params)
    if resp.status_code >= 400:
        raise RuntimeError(f"DashScope upload policy {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError("DashScope upload policy: invalid response")
    policy = data.get("data")
    if not isinstance(policy, dict):
        raise RuntimeError(f"DashScope upload policy missing data: {resp.text[:300]}")
    return policy


def _upload_to_oss(policy: dict, file_path: Path) -> str:
    file_name = file_path.name
    upload_dir = str(policy.get("upload_dir") or "").strip()
    if not upload_dir:
        raise RuntimeError("DashScope upload policy missing upload_dir")
    key = f"{upload_dir}/{file_name}"
    mime, _ = mimetypes.guess_type(str(file_path))
    if not mime:
        mime = "application/octet-stream"

    with file_path.open("rb") as fh:
        files = {
            "OSSAccessKeyId": (None, policy["oss_access_key_id"]),
            "Signature": (None, policy["signature"]),
            "policy": (None, policy["policy"]),
            "x-oss-object-acl": (None, policy.get("x_oss_object_acl", "private")),
            "x-oss-forbid-overwrite": (None, policy.get("x_oss_forbid_overwrite", "false")),
            "key": (None, key),
            "success_action_status": (None, "200"),
            "file": (file_name, fh, mime),
        }
        upload_host = str(policy.get("upload_host") or "").strip()
        if not upload_host:
            raise RuntimeError("DashScope upload policy missing upload_host")
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(upload_host, files=files)

    if resp.status_code >= 400:
        raise RuntimeError(f"DashScope OSS upload {resp.status_code}: {resp.text[:500]}")
    return f"oss://{key}"


def upload_local_file(*, file_path: Path, model_name: str) -> str:
    """Return ``oss://`` URL valid ~48h for the given DashScope model."""
    api_key = dashscope_api_key()
    if not api_key:
        raise ValueError("Set DASHSCOPE_API_KEY for DashScope file upload")
    path = file_path.resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Local media file not found: {path}")
    policy = _get_upload_policy(model_name=model_name, api_key=api_key)
    oss_url = _upload_to_oss(policy, path)
    logger.info("DashScope uploaded %s → %s (model=%s)", path.name, oss_url, model_name)
    return oss_url
