"""Security helpers for sandbox capability gating."""

from __future__ import annotations

from evoflow.config import get_app_config

_HOST_PASSTHROUGH_PROVIDER_MARKERS = (
    "evoflow.sandbox.noop:NoopSandboxProvider",
    "evoflow.sandbox.noop.NoopSandboxProvider",
    # Legacy configs still pointing at deleted LocalSandbox — treated as noop.
    "evoflow.sandbox.local:LocalSandboxProvider",
    "evoflow.sandbox.local.local_sandbox_provider:LocalSandboxProvider",
)

HOST_BASH_DISABLED_MESSAGE = (
    "Host bash via LocalSandbox was removed. Use the `terminal` tool with "
    "tools_mode=host_direct (optional execution_security OS jail), or switch "
    "sandbox.use to AioSandboxProvider for container bash."
)

BASH_SUBAGENT_DISABLED_MESSAGE = (
    "Bash subagent requires an isolated sandbox (AioSandboxProvider). "
    "On desktop host_direct use the `terminal` tool instead."
)

# Back-compat aliases
LOCAL_HOST_BASH_DISABLED_MESSAGE = HOST_BASH_DISABLED_MESSAGE
LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE = BASH_SUBAGENT_DISABLED_MESSAGE


def uses_host_passthrough_provider(config=None) -> bool:
    """True when sandbox provider is Noop / legacy Local (no container)."""
    if config is None:
        config = get_app_config()

    sandbox_cfg = getattr(config, "sandbox", None)
    sandbox_use = str(getattr(sandbox_cfg, "use", "") or "")
    if sandbox_use in _HOST_PASSTHROUGH_PROVIDER_MARKERS:
        return True
    if sandbox_use.endswith(":NoopSandboxProvider"):
        return True
    if sandbox_use.endswith(":LocalSandboxProvider") and "evoflow.sandbox.local" in sandbox_use:
        return True
    return False


# Back-compat name used by tools / subagents
def uses_local_sandbox_provider(config=None) -> bool:
    return uses_host_passthrough_provider(config)


def is_host_bash_allowed(config=None) -> bool:
    """Host bash on Noop/legacy-local is never allowed (use ``terminal``).

    Non-passthrough providers (AIO) allow bash inside the container.
    """
    if config is None:
        config = get_app_config()

    sandbox_cfg = getattr(config, "sandbox", None)
    if sandbox_cfg is None:
        return True
    if uses_host_passthrough_provider(config):
        return False
    return True
