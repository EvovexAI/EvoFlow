"""Event-driven triggers for proactive roles (O3.1).

Instead of pure timed heartbeats, external events (git push, CI failure, PR
creation) can trigger targeted patrols with debounce so a burst of pushes
only fires one patrol.

Usage::

    from evoflow.proactive.triggers import get_event_bus
    bus = get_event_bus()
    await bus.emit("git_push", "code-agent", description="abc1234..def5678")
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Debounce delays per event type (seconds).
# git_push: batch rapid commits into one patrol.
# ci_failed: immediate – build is red, act now.
# pr_*: short debounce for rapid pushes to a PR branch.
_DEBOUNCE_DELAYS: dict[str, int] = {
    "git_push": 60,
    "ci_failed": 0,  # immediate
    "pr_created": 30,
    "pr_updated": 30,
}

_DEFAULT_GOALS: dict[str, str] = {
    "git_push": "检查工作空间最近的代码提交，评估是否需要跟进代码审查、测试补充或修复",
    "ci_failed": "CI 构建失败，立即排查失败原因并提交修复方案",
    "pr_created": "有新的 Pull Request，进行代码审查并给出反馈建议",
    "pr_updated": "Pull Request 有更新，重新审查变更内容",
}


class EventTriggerBus:
    """Debouncing event bus that triggers proactive patrols.

    Events are debounced per ``(agent_code, event_type)`` so a burst of git
    pushes to the same role's workspace only triggers one patrol after the
    debounce window expires.
    """

    def __init__(self, runner: Any) -> None:
        self._runner = runner
        self._pending: dict[tuple[str, str], asyncio.Task[Any]] = {}

    # ── public API ─────────────────────────────────────────────

    async def emit(
        self,
        event_type: str,
        agent_code: str,
        *,
        goal: str = "",
        description: str = "",
    ) -> None:
        """Emit an event that may trigger a debounced patrol.

        If a previous event of the same type for the same role is still
        pending, it is cancelled (replaced by this one).
        """
        key = (agent_code, event_type)
        delay = _DEBOUNCE_DELAYS.get(event_type, 60)

        # Cancel any existing pending task for this key
        old = self._pending.pop(key, None)
        if old and not old.done():
            old.cancel()

        if delay <= 0:
            # Immediate trigger (e.g. CI failure)
            await self._fire(agent_code, event_type, goal, description)
        else:
            task = asyncio.create_task(
                self._debounced_fire(key, agent_code, event_type, goal, description, delay)
            )
            self._pending[key] = task

    def cancel_all(self) -> None:
        """Cancel all pending debounced tasks (e.g. on shutdown)."""
        for task in self._pending.values():
            if not task.done():
                task.cancel()
        self._pending.clear()

    @property
    def pending_count(self) -> int:
        """Number of currently pending debounced triggers."""
        return sum(1 for t in self._pending.values() if not t.done())

    # ── internals ──────────────────────────────────────────────

    async def _debounced_fire(
        self,
        key: tuple[str, str],
        agent_code: str,
        event_type: str,
        goal: str,
        description: str,
        delay: int,
    ) -> None:
        try:
            await asyncio.sleep(delay)
            await self._fire(agent_code, event_type, goal, description)
        except asyncio.CancelledError:
            pass
        finally:
            self._pending.pop(key, None)

    async def _fire(
        self,
        agent_code: str,
        event_type: str,
        goal: str,
        description: str,
    ) -> None:
        source = f"event:{event_type}"
        if not goal:
            goal = _DEFAULT_GOALS.get(event_type, "事件触发巡检")
        try:
            result = await self._runner.dispatch_task(
                agent_code,
                goal,
                description=description,
                source=source,
            )
            logger.info(
                "proactive.triggers: fired event=%s role=%s ok=%s busy=%s",
                event_type,
                agent_code,
                result.get("ok"),
                result.get("busy", False),
            )
        except Exception:
            logger.exception(
                "proactive.triggers: fire failed event=%s role=%s",
                event_type,
                agent_code,
            )


# ── Singleton ─────────────────────────────────────────────────

_event_bus: EventTriggerBus | None = None


def get_event_bus(runner: Any = None) -> EventTriggerBus:
    """Get or create the global EventTriggerBus singleton.

    On first call, ``runner`` may be passed explicitly; if omitted the
    global ProactiveRunner singleton is used.
    """
    global _event_bus
    if _event_bus is None:
        if runner is None:
            from evoflow.proactive.runner import get_proactive_runner

            runner = get_proactive_runner()
        _event_bus = EventTriggerBus(runner)
    return _event_bus


def reset_event_bus() -> None:
    """Reset the singleton (for tests)."""
    global _event_bus
    if _event_bus is not None:
        _event_bus.cancel_all()
    _event_bus = None
