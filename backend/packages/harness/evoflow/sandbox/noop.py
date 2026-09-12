"""No-op sandbox for host_direct desktops (uploads need provider id ``local``).

Replaces deleted LocalSandbox fake jail. Shell/file tools must use
``tools_mode=host_direct`` (``terminal`` / ``read`` / ``write``) or switch
``sandbox.use`` to AioSandboxProvider for a real container.
"""

from __future__ import annotations

from evoflow.sandbox.exceptions import SandboxError
from evoflow.sandbox.sandbox import Sandbox
from evoflow.sandbox.sandbox_provider import SandboxProvider

_MSG = (
    "Host-local fake sandbox was removed. Use tools_mode=host_direct "
    "(terminal + execution_security) or configure AioSandboxProvider."
)


class NoopSandbox(Sandbox):
    """Stub sandbox that keeps id ``local`` so uploads skip container sync."""

    def execute_command(self, command: str) -> str:
        raise SandboxError(_MSG)

    def read_file(self, path: str) -> str:
        raise SandboxError(_MSG)

    def list_dir(self, path: str, max_depth=2) -> list[str]:
        raise SandboxError(_MSG)

    def write_file(self, path: str, content: str, append: bool = False) -> None:
        raise SandboxError(_MSG)

    def update_file(self, path: str, content: bytes) -> None:
        raise SandboxError(_MSG)

    def delete_file(self, path: str) -> None:
        raise SandboxError(_MSG)


_singleton: NoopSandbox | None = None


class NoopSandboxProvider(SandboxProvider):
    """Desktop default provider — no process isolation, no host bash."""

    def acquire(self, thread_id: str | None = None) -> str:
        global _singleton
        if _singleton is None:
            _singleton = NoopSandbox("local")
        return _singleton.id

    def get(self, sandbox_id: str) -> Sandbox | None:
        if sandbox_id != "local":
            return None
        if _singleton is None:
            self.acquire()
        return _singleton

    def release(self, sandbox_id: str) -> None:
        pass
