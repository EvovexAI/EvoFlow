"""Short local activation codes (EF3) + legacy EF2 verify.

EF3 format (issued)::

    EF3-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX

- Alphabet: uppercase A–Z and digits 2–7（``-`` 仅展示，校验时忽略）
- Payload: ``version(1) | flags(1) | exp_u32_be(4) | [mid_8]``
- Tag: truncated HMAC-SHA256 (10 bytes), key = HKDF(vendor private)
- Floating code ≈ 29 chars compact / ~35 with dashes

Legacy ``EF2.{payload_b64url}.{sig_b64url}`` is still accepted for verify.

``mid`` empty / flag unset = floating code（首次激活绑定本机）。
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import struct
import time
from dataclasses import dataclass
from typing import Any

from evoflow.license.keys import (
    LicenseKeyError,
    hmac_code_tag,
    load_code_mac_key_for_issue,
    load_code_mac_key_for_verify,
    verify_hmac_code_tag,
    verify_signature,
)
from evoflow.license.machine import normalize_machine_id

CODE_PREFIX = "EF3"
LEGACY_PREFIX = "EF2"
PAYLOAD_VERSION = 3
LEGACY_PAYLOAD_VERSION = 2
FEATURE_PREMIUM = "premium"
DEFAULT_FEATURES: tuple[str, ...] = (FEATURE_PREMIUM,)

# Temporarily skip machine-id binding (fingerprint can drift across Gateway restarts).
ENFORCE_MACHINE_BIND = False

_FLAG_HAS_MID = 0x01
_GROUP_SIZE = 5
_MAC_LEN = 10

_LEGACY_CODE_RE = re.compile(
    rf"^{LEGACY_PREFIX}\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$"
)


class LicenseCodecError(ValueError):
    """Invalid or rejected activation code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class LicenseClaims:
    machine_id: str
    expires_at_unix: int
    features: tuple[str, ...]
    version: int = PAYLOAD_VERSION

    @property
    def floating(self) -> bool:
        return not self.machine_id

    @property
    def expired(self) -> bool:
        return int(time.time()) >= int(self.expires_at_unix)


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _normalize_payload_mid(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text or text in {"*", "-", "ANY", "any"}:
        return ""
    mid = normalize_machine_id(text)
    if len(mid) != 16:
        raise LicenseCodecError("invalid_machine", "激活码机器码无效")
    return mid


def _mid_to_bytes(mid: str) -> bytes:
    return bytes.fromhex(mid)


def _mid_from_bytes(raw: bytes) -> str:
    if len(raw) != 8:
        raise LicenseCodecError("invalid_machine", "激活码机器码无效")
    return raw.hex().upper()


def _build_payload(mid: str, exp: int) -> bytes:
    flags = _FLAG_HAS_MID if mid else 0
    body = struct.pack(">BBI", PAYLOAD_VERSION, flags, int(exp) & 0xFFFFFFFF)
    if mid:
        body += _mid_to_bytes(mid)
    return body


def _parse_payload(body: bytes) -> tuple[str, int]:
    if len(body) < 6:
        raise LicenseCodecError("invalid_payload", "激活码内容无效")
    version, flags, exp = struct.unpack_from(">BBI", body, 0)
    if version != PAYLOAD_VERSION:
        raise LicenseCodecError("unsupported_version", "不支持的激活码版本")
    offset = 6
    mid = ""
    if flags & _FLAG_HAS_MID:
        if len(body) < offset + 8:
            raise LicenseCodecError("invalid_payload", "激活码内容无效")
        mid = _mid_from_bytes(body[offset : offset + 8])
        offset += 8
    if offset != len(body):
        raise LicenseCodecError("invalid_payload", "激活码内容无效")
    if exp <= 0:
        raise LicenseCodecError("invalid_expiry", "激活码有效期无效")
    return mid, int(exp)


def _b32_encode(data: bytes) -> str:
    return base64.b32encode(data).decode("ascii").rstrip("=")


def _b32_decode(text: str) -> bytes:
    raw = str(text or "").strip().upper().replace(" ", "")
    pad = "=" * (-len(raw) % 8)
    try:
        return base64.b32decode(raw + pad, casefold=True)
    except Exception as e:
        raise LicenseCodecError("invalid_format", "激活码格式无效") from e


def format_activation_code(code: str) -> str:
    """Insert dashes every 5 chars after the EF3 prefix for readability."""
    compact = normalize_activation_code(code)
    if not compact.startswith(CODE_PREFIX):
        return compact
    body = compact[len(CODE_PREFIX) :]
    groups = [body[i : i + _GROUP_SIZE] for i in range(0, len(body), _GROUP_SIZE)]
    return CODE_PREFIX + "-" + "-".join(groups) if groups else CODE_PREFIX


def normalize_activation_code(code: str) -> str:
    """Uppercase and strip separators; keep EF2 dots for legacy path detection."""
    text = str(code or "").strip().replace(" ", "")
    if text.upper().startswith(f"{LEGACY_PREFIX}."):
        return text
    return re.sub(r"[^A-Za-z0-9]", "", text).upper()


def issue_activation_code(
    *,
    expires_at_unix: int,
    machine_id: str | None = None,
    features: list[str] | tuple[str, ...] | None = None,
    grouped: bool = True,
) -> str:
    """Issue a short vendor activation code (requires private key in env)."""
    mid = _normalize_payload_mid(machine_id)
    exp = int(expires_at_unix)
    if exp <= 0:
        raise LicenseCodecError("invalid_expiry", "有效期无效")
    feat = tuple(features) if features else DEFAULT_FEATURES
    if FEATURE_PREMIUM not in feat:
        feat = (FEATURE_PREMIUM, *feat)
    _ = feat
    payload = _build_payload(mid, exp)
    try:
        mac_key = load_code_mac_key_for_issue()
        tag = hmac_code_tag(payload, mac_key)
    except LicenseKeyError as e:
        raise LicenseCodecError("no_private_key", str(e)) from e
    compact = CODE_PREFIX + _b32_encode(payload + tag)
    return format_activation_code(compact) if grouped else compact


def _verify_ef3(
    compact: str,
    *,
    expected_machine_id: str | None,
    now: int | None,
    allow_expired: bool,
) -> LicenseClaims:
    if not compact.startswith(CODE_PREFIX):
        raise LicenseCodecError("invalid_format", "激活码格式无效")
    blob = _b32_decode(compact[len(CODE_PREFIX) :])
    if len(blob) < 6 + _MAC_LEN:
        raise LicenseCodecError("invalid_format", "激活码格式无效")
    payload, tag = blob[:-_MAC_LEN], blob[-_MAC_LEN:]
    mac_key = load_code_mac_key_for_verify()
    if not verify_hmac_code_tag(payload, tag, mac_key):
        raise LicenseCodecError("bad_signature", "激活码签名无效")
    mid, exp = _parse_payload(payload)
    claims = LicenseClaims(
        machine_id=mid,
        expires_at_unix=exp,
        features=DEFAULT_FEATURES,
        version=PAYLOAD_VERSION,
    )
    return _finalize_claims(
        claims,
        expected_machine_id=expected_machine_id,
        now=now,
        allow_expired=allow_expired,
    )


def _verify_ef2(
    raw: str,
    *,
    expected_machine_id: str | None,
    now: int | None,
    allow_expired: bool,
) -> LicenseClaims:
    m = _LEGACY_CODE_RE.match(raw)
    if not m:
        raise LicenseCodecError(
            "invalid_format",
            "激活码格式无效（需 EF3… 厂商签名码）",
        )
    payload_b64, sig = m.group(1), m.group(2)
    if not verify_signature(payload_b64, sig):
        raise LicenseCodecError("bad_signature", "激活码签名无效")
    try:
        data = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except Exception as e:
        raise LicenseCodecError("invalid_payload", "激活码内容无效") from e
    if not isinstance(data, dict):
        raise LicenseCodecError("invalid_payload", "激活码内容无效")
    version = int(data.get("v") or 0)
    if version != LEGACY_PAYLOAD_VERSION:
        raise LicenseCodecError("unsupported_version", "不支持的激活码版本")
    mid = _normalize_payload_mid(data.get("mid"))
    exp = int(data.get("exp") or 0)
    if exp <= 0:
        raise LicenseCodecError("invalid_expiry", "激活码有效期无效")
    feat_raw = data.get("feat") or []
    if not isinstance(feat_raw, list):
        raise LicenseCodecError("invalid_features", "激活码权益无效")
    features = tuple(str(x) for x in feat_raw if str(x).strip())
    if FEATURE_PREMIUM not in features:
        raise LicenseCodecError("missing_premium", "激活码未包含高级功能权益")
    claims = LicenseClaims(
        machine_id=mid,
        expires_at_unix=exp,
        features=features,
        version=version,
    )
    return _finalize_claims(
        claims,
        expected_machine_id=expected_machine_id,
        now=now,
        allow_expired=allow_expired,
    )


def _finalize_claims(
    claims: LicenseClaims,
    *,
    expected_machine_id: str | None,
    now: int | None,
    allow_expired: bool,
) -> LicenseClaims:
    if (
        ENFORCE_MACHINE_BIND
        and expected_machine_id is not None
        and not claims.floating
    ):
        want = normalize_machine_id(expected_machine_id)
        if want != claims.machine_id:
            raise LicenseCodecError("machine_mismatch", "激活码与本机机器码不匹配")
    ts = int(now if now is not None else time.time())
    if not allow_expired and ts >= claims.expires_at_unix:
        raise LicenseCodecError("expired", "激活码已过期")
    return claims


def verify_activation_code(
    code: str,
    *,
    expected_machine_id: str | None = None,
    now: int | None = None,
    allow_expired: bool = False,
) -> LicenseClaims:
    raw = str(code or "").strip().replace(" ", "")
    if raw.upper().startswith(f"{LEGACY_PREFIX}."):
        return _verify_ef2(
            raw,
            expected_machine_id=expected_machine_id,
            now=now,
            allow_expired=allow_expired,
        )
    compact = normalize_activation_code(raw)
    if compact.startswith(CODE_PREFIX):
        return _verify_ef3(
            compact,
            expected_machine_id=expected_machine_id,
            now=now,
            allow_expired=allow_expired,
        )
    raise LicenseCodecError(
        "invalid_format",
        "激活码格式无效（需 EF3… 厂商签名码）",
    )


def resolve_bind_machine_id(claims: LicenseClaims, local_machine_id: str) -> str:
    local = normalize_machine_id(local_machine_id)
    if len(local) != 16:
        raise LicenseCodecError("invalid_machine", "本机机器码无效")
    if claims.floating:
        return local
    if ENFORCE_MACHINE_BIND and claims.machine_id != local:
        raise LicenseCodecError("machine_mismatch", "激活码与本机机器码不匹配")
    return local


def code_fingerprint(code: str) -> str:
    normalized = normalize_activation_code(code)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"
