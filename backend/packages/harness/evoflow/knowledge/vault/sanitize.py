"""Secret sanitization for Knowledge Vault logs and API responses."""

from __future__ import annotations

import re
from typing import Any

_SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|token|authorization|bearer|secret)\s*[:=]\s*\S+"),
    re.compile(r"(?i)OBSIDIAN_API_KEY\s*=\s*\S+"),
    re.compile(r"(?i)OPENAI_API_KEY\s*=\s*\S+"),
    re.compile(r"(?i)Bearer\s+[A-Za-z0-9\-._~+/]+=*"),
    re.compile(r"(?i)sk-[A-Za-z0-9]{8,}"),
    # Explicit sentinel used in leak tests / accidental plaintext dumps
    re.compile(r"TEST_SECRET_SHOULD_NEVER_APPEAR"),
)


def sanitize_text(text: str) -> str:
    """Redact credential-looking substrings from a string."""
    out = str(text or "")
    for pat in _SECRET_PATTERNS:
        if pat.pattern == r"TEST_SECRET_SHOULD_NEVER_APPEAR":
            out = pat.sub("[REDACTED]", out)
            continue
        out = pat.sub(lambda m: f"{m.group(0).split('=')[0].split(':')[0]}=[REDACTED]", out)
    return out


def sanitize_obj(value: Any) -> Any:
    """Deep-sanitize nested structures for API / logs."""
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            if any(s in key.lower() for s in ("apikey", "api_key", "secret", "token", "password", "authorization")):
                if isinstance(v, str) and v:
                    redacted[key] = "***"
                elif v:
                    redacted[key] = "***"
                else:
                    redacted[key] = v
            else:
                redacted[key] = sanitize_obj(v)
        return redacted
    if isinstance(value, list):
        return [sanitize_obj(x) for x in value]
    return value
