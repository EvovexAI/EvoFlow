import logging

try:
    from typing import override
except ImportError:
    from typing import override

try:
    from typing import NotRequired
except ImportError:
    from typing import NotRequired

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from evoflow.agents.thread_state import SandboxState, ThreadDataState
from evoflow.sandbox import get_sandbox_provider

logger = logging.getLogger(__name__)


class SandboxMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    sandbox: NotRequired[SandboxState | None]
    thread_data: NotRequired[ThreadDataState | None]


class SandboxMiddleware(AgentMiddleware[SandboxMiddlewareState]):
    """Sandbox lifecycle for the agent.

    Default ``lazy_init=True``: acquire on first tool call — **no** ``before_agent``
    override (avoids an extra LangGraph node every turn).

    ``lazy_init=False``: returns :class:`EagerSandboxMiddleware` which acquires in
    ``before_agent``.
    """

    state_schema = SandboxMiddlewareState

    def __new__(cls, lazy_init: bool = True):
        if cls is SandboxMiddleware and not lazy_init:
            return object.__new__(EagerSandboxMiddleware)
        return object.__new__(cls)

    def __init__(self, lazy_init: bool = True):
        super().__init__()
        self._lazy_init = lazy_init

    def _acquire_sandbox(self, thread_id: str) -> str:
        provider = get_sandbox_provider()
        sandbox_id = provider.acquire(thread_id)
        logger.info(f"Acquiring sandbox {sandbox_id}")
        return sandbox_id

    @override
    def after_agent(self, state: SandboxMiddlewareState, runtime: Runtime) -> dict | None:
        sandbox = state.get("sandbox")
        if sandbox is not None:
            sandbox_id = sandbox["sandbox_id"]
            logger.info(f"Releasing sandbox {sandbox_id}")
            get_sandbox_provider().release(sandbox_id)
            return None

        if (runtime.context or {}).get("sandbox_id") is not None:
            sandbox_id = runtime.context.get("sandbox_id")
            logger.info(f"Releasing sandbox {sandbox_id} from context")
            get_sandbox_provider().release(sandbox_id)
            return None

        return super().after_agent(state, runtime)


class EagerSandboxMiddleware(SandboxMiddleware):
    """Acquire sandbox in ``before_agent`` (``lazy_init=False``)."""

    def __init__(self, lazy_init: bool = False):
        super().__init__(lazy_init=False)

    @override
    def before_agent(self, state: SandboxMiddlewareState, runtime: Runtime) -> dict | None:
        if "sandbox" not in state or state["sandbox"] is None:
            thread_id = (runtime.context or {}).get("thread_id")
            if thread_id is None:
                return None
            sandbox_id = self._acquire_sandbox(thread_id)
            logger.info(f"Assigned sandbox {sandbox_id} to thread {thread_id}")
            return {"sandbox": {"sandbox_id": sandbox_id}}
        return None
