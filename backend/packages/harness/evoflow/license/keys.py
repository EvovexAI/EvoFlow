"""License key material: Ed25519 (legacy EF2) + HMAC code MAC (EF3 short codes).

- **签发**：``EVOFLOW_LICENSE_PRIVATE_KEY``（Ed25519 私钥，永不进客户端）
- **短码 MAC**：由私钥 HKDF 派生；客户端内置 ``BUILTIN_LICENSE_CODE_MAC_B64`` 仅用于验短码
- **旧 EF2**：仍用内置公钥验签
"""

from __future__ import annotations

import base64
import hmac as std_hmac
import os
from functools import lru_cache
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives import hmac as crypto_hmac
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
# Vendor public key (raw 32 bytes, urlsafe-b64 without padding) — EF2 verify only.
# Private key MUST NOT live in the product — set EVOFLOW_LICENSE_PRIVATE_KEY when issuing.
BUILTIN_LICENSE_PUBLIC_KEY_B64 = "QaUE7y1r5i3GWeogHtJaBe3S_HPOpGq2wC3CggVdq9M"

# HMAC key for EF3 short codes (HKDF from the vendor private key that matches the public above).
# Open-source community sample keypair (rotated 2026-09-11). Commercial / EvovexAI production
# builds MUST inject ops keys via EVOFLOW_LICENSE_PUBLIC_KEY / EVOFLOW_LICENSE_CODE_MAC and
# never reuse keys that were committed historically (see SECURITY.md).
BUILTIN_LICENSE_CODE_MAC_B64 = "k6imVyHO-9fk8fMWzzgX0KA-brTyg1A3Abwvca6owpc"

_CODE_MAC_SALT = b"evoflow-license-code-mac-v3"
_CODE_MAC_INFO = b"activation-code"
CODE_MAC_LEN = 10  # 80-bit truncated HMAC


class LicenseKeyError(RuntimeError):
    """Missing or invalid license key material."""


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(str(text or "").strip() + pad)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def get_public_key_b64() -> str:
    env = (os.environ.get("EVOFLOW_LICENSE_PUBLIC_KEY") or "").strip()
    return env or BUILTIN_LICENSE_PUBLIC_KEY_B64


@lru_cache(maxsize=4)
def load_public_key(b64: str | None = None) -> Ed25519PublicKey:
    raw = _b64url_decode(b64 if b64 is not None else get_public_key_b64())
    if len(raw) != 32:
        raise LicenseKeyError("license public key must be 32 raw bytes")
    return Ed25519PublicKey.from_public_bytes(raw)


def _private_key_file_candidates() -> list[Path]:
    """Likely locations for ops private key file (never shipped to end users)."""
    out: list[Path] = []
    env_path = (os.environ.get("EVOFLOW_LICENSE_PRIVATE_KEY_FILE") or "").strip()
    if env_path:
        out.append(Path(env_path))
    home = (os.environ.get("EVOFLOW_HOME") or "").strip()
    if home:
        out.append(Path(home) / ".evoflow-license-private.key")
    # backend/.evoflow-license-private.key (repo / packaging layout)
    here = Path(__file__).resolve()
    # .../packages/harness/evoflow/license/keys.py → backend/
    backend_root = here.parents[4] if len(here.parents) >= 5 else here.parents[-1]
    out.append(backend_root / ".evoflow-license-private.key")
    out.append(Path.cwd() / ".evoflow-license-private.key")
    out.append(Path.cwd() / "backend" / ".evoflow-license-private.key")
    # de-dupe while preserving order
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def _read_private_key_b64_from_file() -> str:
    for path in _private_key_file_candidates():
        try:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8").strip()
            if text:
                return text.splitlines()[0].strip()
        except OSError:
            continue
    return ""


def ensure_private_key_env_loaded() -> bool:
    """If env unset, try loading private key from known file paths into env.

    Returns True when a usable private key is available afterwards.
    """
    if (os.environ.get("EVOFLOW_LICENSE_PRIVATE_KEY") or "").strip():
        return True
    raw = _read_private_key_b64_from_file()
    if not raw:
        return False
    os.environ["EVOFLOW_LICENSE_PRIVATE_KEY"] = raw
    return True


def can_issue_activation_codes() -> bool:
    """True when issuer private key is available (env or file)."""
    try:
        if not ensure_private_key_env_loaded():
            return False
        _private_raw_from_env()
        return True
    except LicenseKeyError:
        return False


def _private_raw_from_env() -> bytes:
    ensure_private_key_env_loaded()
    raw_b64 = (os.environ.get("EVOFLOW_LICENSE_PRIVATE_KEY") or "").strip()
    if not raw_b64:
        raise LicenseKeyError(
            "未设置 EVOFLOW_LICENSE_PRIVATE_KEY：签发端私钥仅保留在运营环境，"
            "可放 backend/.evoflow-license-private.key 或设置环境变量"
        )
    raw = _b64url_decode(raw_b64)
    if len(raw) != 32:
        raise LicenseKeyError("license private key must be 32 raw bytes")
    return raw


def load_private_key_from_env() -> Ed25519PrivateKey:
    """Load signing key from EVOFLOW_LICENSE_PRIVATE_KEY (urlsafe-b64 raw 32 bytes)."""
    return Ed25519PrivateKey.from_private_bytes(_private_raw_from_env())


def derive_code_mac_key(private_raw: bytes) -> bytes:
    """Derive 32-byte HMAC key from Ed25519 private seed (issuer + keygen)."""
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_CODE_MAC_SALT,
        info=_CODE_MAC_INFO,
    ).derive(private_raw)


def load_code_mac_key_for_issue() -> bytes:
    """MAC key for issuing EF3 codes — derived from private key in env."""
    return derive_code_mac_key(_private_raw_from_env())


@lru_cache(maxsize=4)
def load_code_mac_key_for_verify(b64: str | None = None) -> bytes:
    """MAC key embedded in client (or EVOFLOW_LICENSE_CODE_MAC override)."""
    if b64 is None:
        env = (os.environ.get("EVOFLOW_LICENSE_CODE_MAC") or "").strip()
        raw_b64 = env or BUILTIN_LICENSE_CODE_MAC_B64
    else:
        raw_b64 = b64
    raw = _b64url_decode(raw_b64)
    if len(raw) != 32:
        raise LicenseKeyError("license code MAC key must be 32 raw bytes")
    return raw


def clear_key_cache() -> None:
    load_public_key.cache_clear()
    load_code_mac_key_for_verify.cache_clear()


def generate_keypair() -> tuple[str, str, str]:
    """Return (private_b64, public_b64, code_mac_b64) raw urlsafe-b64 without padding."""
    priv = Ed25519PrivateKey.generate()
    priv_raw = priv.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    priv_b64 = _b64url_encode(priv_raw)
    pub_b64 = _b64url_encode(
        priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    )
    mac_b64 = _b64url_encode(derive_code_mac_key(priv_raw))
    return priv_b64, pub_b64, mac_b64


def hmac_code_tag(payload: bytes, mac_key: bytes) -> bytes:
    h = crypto_hmac.HMAC(mac_key, hashes.SHA256())
    h.update(payload)
    return h.finalize()[:CODE_MAC_LEN]


def verify_hmac_code_tag(payload: bytes, tag: bytes, mac_key: bytes) -> bool:
    if len(tag) != CODE_MAC_LEN:
        return False
    expected = hmac_code_tag(payload, mac_key)
    return std_hmac.compare_digest(expected, tag)


def sign(payload_b64: str, private_key: Ed25519PrivateKey | None = None) -> str:
    key = private_key if private_key is not None else load_private_key_from_env()
    sig = key.sign(payload_b64.encode("ascii"))
    return _b64url_encode(sig)


def verify_signature(payload_b64: str, sig_b64: str, public_key: Ed25519PublicKey | None = None) -> bool:
    key = public_key if public_key is not None else load_public_key()
    try:
        key.verify(_b64url_decode(sig_b64), payload_b64.encode("ascii"))
        return True
    except Exception:
        return False
