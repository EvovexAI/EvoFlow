"""Credential pool — multi-key rotation and status tracking for EvoFlow providers.

Enables multiple API keys per provider with automatic rotation on failure,
rate-limit cooldown, and exhausted-key recovery.
"""

import logging
import os
import random
import time
from dataclasses import dataclass
from enum import Enum

from evoflow.models.credential_sanitize import resolve_and_sanitize_api_key

logger = logging.getLogger(__name__)


class CredentialStatus(Enum):
    OK = "ok"
    EXHAUSTED = "exhausted"
    COOLDOWN = "cooldown"


@dataclass
class Credential:
    """A single API credential (API key + optional base URL)."""

    api_key: str
    base_url: str | None = None
    status: CredentialStatus = CredentialStatus.OK
    exhausted_at: float = 0.0
    cooldown_until: float = 0.0
    error_count: int = 0
    success_count: int = 0

    def is_usable(self) -> bool:
        """Check if this credential can be used now."""
        now = time.time()

        if self.status == CredentialStatus.EXHAUSTED:
            # Auto-recover after 1 hour
            if now - self.exhausted_at > 3600:
                logger.info("Credential auto-recovered from exhausted: ...%s", self.api_key[-4:])
                self.status = CredentialStatus.OK
                self.error_count = 0
                return True
            return False

        if self.status == CredentialStatus.COOLDOWN:
            if now < self.cooldown_until:
                return False
            logger.info("Credential cooldown ended: ...%s", self.api_key[-4:])
            self.status = CredentialStatus.OK
            return True

        return self.status == CredentialStatus.OK

    def short_id(self) -> str:
        return f"...{self.api_key[-4:]}" if len(self.api_key) > 8 else self.api_key[:4]


class CredentialPool:
    """Manages multiple API credentials for one provider.

    Strategies:
        fill_first: Always pick the first usable credential (default).
        round_robin: Cycle through usable credentials.
        random: Pick randomly from usable credentials.
        least_used: Pick the credential with fewest errors.
    """

    def __init__(self, credentials: list[Credential], strategy: str = "fill_first"):
        if not credentials:
            raise ValueError("CredentialPool requires at least one credential")
        self.credentials = credentials
        self.strategy = strategy
        self._index = 0

    def get(self) -> Credential | None:
        """Get the next usable credential, or None if all are exhausted."""
        usable = [c for c in self.credentials if c.is_usable()]
        if not usable:
            logger.warning("All %d credentials exhausted", len(self.credentials))
            return None

        if self.strategy == "round_robin":
            cred = usable[self._index % len(usable)]
            self._index += 1
        elif self.strategy == "random":
            cred = random.choice(usable)
        elif self.strategy == "least_used":
            cred = min(usable, key=lambda c: c.error_count)
        else:  # fill_first
            cred = usable[0]

        return cred

    def rotate(self, reason: str = "auth") -> Credential | None:
        """Advance to the next usable credential after marking the current one failed."""
        current = self.get()
        if current is not None:
            self.mark_failed(current, reason)
        return self.get()

    def mark_success(self, cred: Credential):
        """Record a successful API call for *cred*."""
        cred.success_count += 1
        cred.error_count = 0
        if cred.status != CredentialStatus.OK:
            cred.status = CredentialStatus.OK
            logger.info("Credential restored to OK: %s", cred.short_id())

    def mark_failed(self, cred: Credential, reason: str):
        """Record a failed API call and update credential state."""
        cred.error_count += 1

        if reason in ("billing", "auth_permanent"):
            cred.status = CredentialStatus.EXHAUSTED
            cred.exhausted_at = time.time()
            logger.warning("Credential exhausted (reason=%s): %s", reason, cred.short_id())

        elif reason == "rate_limit":
            cred.status = CredentialStatus.COOLDOWN
            cred.cooldown_until = time.time() + 60
            logger.info("Credential cooling down for 60s: %s", cred.short_id())

        elif reason == "auth":
            cred.status = CredentialStatus.EXHAUSTED
            cred.exhausted_at = time.time()
            logger.warning("Credential auth failed, marking exhausted: %s", cred.short_id())

    def status_summary(self) -> str:
        """Return a human-readable status summary."""
        parts = []
        for c in self.credentials:
            parts.append(f"{c.short_id()}={c.status.value}(err={c.error_count})")
        return ", ".join(parts)


def build_pool_from_config(model_config) -> CredentialPool | None:
    """Build a CredentialPool from a ModelConfig's credentials list.

    Looks up API keys from environment variables defined in each credential entry.
    Falls back to the model-level ``api_key`` field if no credential list is present.
    """
    raw_creds = getattr(model_config, "credentials", None) or []
    strategy = getattr(model_config, "credential_strategy", "fill_first")

    credentials: list[Credential] = []

    for entry in raw_creds:
        env_var = entry.get("api_key_env", "")
        key = os.environ.get(env_var) if env_var else None
        if not key:
            # Try the env var name directly
            key = entry.get("api_key")
        if key:
            sanitized = resolve_and_sanitize_api_key(key)
            if sanitized:
                credentials.append(
                    Credential(
                        api_key=sanitized,
                        base_url=entry.get("base_url") or getattr(model_config, "base_url", None),
                    )
                )

    # Fallback: use model-level api_key if available
    if not credentials:
        key = getattr(model_config, "api_key", None) or ""
        if key.startswith("$"):
            env_key = os.environ.get(key[1:].strip().lstrip("{").rstrip("}"))
            if env_key:
                key = env_key
        if key:
            sanitized = resolve_and_sanitize_api_key(key)
            if sanitized:
                credentials.append(Credential(api_key=sanitized))

    if not credentials:
        return None

    return CredentialPool(credentials, strategy=strategy)
