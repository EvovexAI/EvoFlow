"""Base class for external agent execution.

This provides a unified interface for controlling external AI agents,
such as HTTP-based services like Trae.
"""

import asyncio
import logging
import re
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable
from datetime import datetime

from evoflow.subagents.executor import SubagentResult, SubagentStatus

from .models import AgentState, ExternalAgentConfig, ExternalAgentRuntime

logger = logging.getLogger(__name__)


class BaseExternalAgent(ABC):
    """Abstract base class for external agent executors.

        This class provides a unified interface for controlling external AI agents,
    similar to how SubagentExecutor works for internal agents.

        Key differences from SubagentExecutor:
        - SubagentExecutor: Runs Python agents inside EvoFlow process
        - BaseExternalAgent: Controls external CLI/API processes (PTY/HTTP/WebSocket)

        Usage:
            >>> agent = TraeAgent(config)
            >>> session_id = await agent.launch("task-123", "Refactor code", "/project")
            >>> result = await agent.execute(task_config)

        Attributes:
            config: ExternalAgentConfig instance
            runtime: ExternalAgentRuntime instance (set after launch)
            on_output: Optional callback for output streaming
            on_state_change: Optional callback for state changes
            on_progress: Optional callback for progress updates
    """

    def __init__(
        self,
        config: ExternalAgentConfig,
        on_output: Callable[[str], None] | None = None,
        on_state_change: Callable[[AgentState, AgentState], None] | None = None,
        on_progress: Callable[[int], None] | None = None,
    ):
        self.config = config
        self.runtime: ExternalAgentRuntime | None = None
        self.on_output = on_output
        self.on_state_change = on_state_change
        self.on_progress = on_progress

        # Internal state
        self._monitor_task: asyncio.Task | None = None
        self._stop_monitor = asyncio.Event()

    @abstractmethod
    async def launch(self, task_id: str, prompt: str, cwd: str | None = None) -> str:
        """Launch the external agent.

        Args:
            task_id: EvoFlow task identifier
            prompt: Initial task description/prompt
            cwd: Working directory

        Returns:
            session_id: Unique session identifier
        """
        pass

    @abstractmethod
    async def send_message(self, message: str) -> bool:
        """Send a message to the running agent.

        This is the key method for interactive control.
        When the agent asks a question (WAITING_INPUT state),
        use this to respond.

        Args:
            message: Message to send

        Returns:
            True if sent successfully, False otherwise
        """
        pass

    @abstractmethod
    async def terminate(self, force: bool = False) -> bool:
        """Terminate the agent.

        Args:
            force: If True, force kill (SIGKILL). Otherwise graceful (SIGTERM).

        Returns:
            True if terminated successfully
        """
        pass

    @abstractmethod
    async def get_status(self) -> AgentState:
        """Get current execution status."""
        pass

    @abstractmethod
    async def get_output(self, lines: int = 50) -> list[str]:
        """Get recent output lines.

        Args:
            lines: Number of lines to retrieve (0 = all)

        Returns:
            List of output line strings
        """
        pass

    @abstractmethod
    def parse_progress(self, output_lines: list[str]) -> tuple[int, str]:
        """Parse progress from output lines.

        Args:
            output_lines: Recent output lines to analyze

        Returns:
            Tuple of (progress_percentage, current_step_description)
        """
        pass

    async def execute(self, task: dict, timeout: int | None = None) -> SubagentResult:
        """Execute a task (compatible with SubagentExecutor interface).

        This is the main entry point for supervisor integration.

        Args:
            task: Task configuration dict with keys:
                - id: Task ID
                - description: Task prompt
                - project_path: Working directory
                - assigned_to: Agent type
                - config: Additional config
            timeout: Execution timeout in seconds

        Returns:
            SubagentResult with execution result
        """
        task_id = task.get("id", "unknown")
        prompt = task.get("description", "")
        cwd = task.get("project_path")

        logger.info(f"[ExternalAgent] Starting task {task_id} with {self.config.agent_type}")

        try:
            # Step 1: Launch
            self.runtime = ExternalAgentRuntime(
                session_id="",  # Will be set by launch()
                task_id=task_id,
                agent_type=self.config.agent_type,
                state=AgentState.STARTING,
                output_buffer_max_size=self.config.max_output_lines,
                started_at=datetime.now(),
            )

            session_id = await self.launch(task_id, prompt, cwd)
            self.runtime.session_id = session_id

            # Step 2: Start monitoring loop
            self._monitor_task = asyncio.create_task(self._monitor_loop())

            # Step 3: Wait for completion or timeout
            timeout = timeout or self.config.timeout_seconds
            await asyncio.wait_for(self._wait_for_terminal_state(), timeout=timeout)

            # Step 4: Build result
            return self._build_result()

        except TimeoutError:
            logger.warning(f"[ExternalAgent] Task {task_id} timed out")
            await self.terminate(force=True)
            return SubagentResult(
                task_id=task_id,
                trace_id=task_id,
                status=SubagentStatus.TIMED_OUT,
                error=f"Execution timed out after {timeout}s",
                started_at=self.runtime.started_at if self.runtime else None,
                completed_at=datetime.now(),
            )

        except Exception as e:
            logger.error(f"[ExternalAgent] Task {task_id} failed: {e}")
            await self.terminate(force=True)
            return SubagentResult(
                task_id=task_id,
                trace_id=task_id,
                status=SubagentStatus.FAILED,
                error=str(e),
                started_at=self.runtime.started_at if self.runtime else None,
                completed_at=datetime.now(),
            )

    async def _monitor_loop(self) -> None:
        """Monitor loop - reads output and updates state.

        This is similar to SubagentExecutor's monitoring loop.
        It continuously reads output, detects state changes,
        and triggers callbacks.
        """
        if not self.runtime:
            return

        logger.info(f"[ExternalAgent] Monitor loop started for {self.runtime.session_id}")

        try:
            async for line in self._read_output_stream():
                # Update output buffer
                self.runtime.append_output(line)

                # Detect state change
                old_state = self.runtime.state
                new_state = self._detect_state(line)

                if new_state != old_state:
                    logger.info(f"[ExternalAgent] State change: {old_state.value} -> {new_state.value}")
                    self.runtime.state = new_state
                    if self.on_state_change:
                        self.on_state_change(old_state, new_state)

                    # Special handling for WAITING_INPUT
                    if new_state == AgentState.WAITING_INPUT:
                        logger.info("[ExternalAgent] Agent is waiting for input")

                # Parse and update progress
                progress, step = self.parse_progress([line])
                if progress != self.runtime.progress:
                    self.runtime.progress = progress
                    self.runtime.current_step = step
                    if self.on_progress:
                        self.on_progress(progress)

                # Callback for output
                if self.on_output:
                    self.on_output(line)

                # Check stop signal
                if self._stop_monitor.is_set():
                    break

        except Exception as e:
            logger.error(f"[ExternalAgent] Monitor loop error: {e}")
            if self.runtime:
                self.runtime.state = AgentState.ERROR

        logger.info("[ExternalAgent] Monitor loop ended")

    @abstractmethod
    async def _read_output_stream(self) -> AsyncIterator[str]:
        """Yield output lines as they become available.

        Subclasses must implement this based on their protocol:
        - PTY: Read from file descriptor
        - HTTP: Poll or use SSE
        - WebSocket: Receive messages
        """
        pass

    def _detect_state(self, line: str) -> AgentState:
        """Detect agent state from output line.

        Default implementation uses regex patterns.
        Subclasses can override for protocol-specific detection.
        """
        if not self.runtime:
            return AgentState.ERROR

        # Check for waiting input patterns
        for pattern in self.config.waiting_input_patterns:
            try:
                if re.search(pattern, line, re.IGNORECASE):
                    return AgentState.WAITING_INPUT
            except re.error:
                logger.warning(f"[ExternalAgent] Invalid regex pattern: {pattern}")

        # Check for error indicators
        error_keywords = ["error", "错误", "exception", "failed", "失败", "fatal"]
        if any(kw in line.lower() for kw in error_keywords):
            # Don't immediately go to ERROR state here
            # Let subclasses decide based on context
            pass

        # Check for completion indicators
        completion_keywords = ["completed", "done", "finished", "完成", "结束", "successfully", "已成功"]
        if any(kw in line.lower() for kw in completion_keywords):
            return AgentState.COMPLETED

        # Default: assume still executing
        if self.runtime.state not in [AgentState.COMPLETED, AgentState.ERROR, AgentState.TERMINATED]:
            return AgentState.EXECUTING

        return self.runtime.state

    async def _wait_for_terminal_state(self) -> None:
        """Wait until agent reaches a terminal state."""
        terminal_states = {
            AgentState.COMPLETED,
            AgentState.ERROR,
            AgentState.TERMINATED,
        }

        while self.runtime and self.runtime.state not in terminal_states:
            await asyncio.sleep(0.1)

    def _build_result(self) -> SubagentResult:
        """Build SubagentResult from runtime state."""
        if not self.runtime:
            return SubagentResult(
                task_id="unknown",
                trace_id="unknown",
                status=SubagentStatus.FAILED,
                error="Runtime not initialized",
            )

        # Map AgentState to SubagentStatus
        status_map = {
            AgentState.COMPLETED: SubagentStatus.COMPLETED,
            AgentState.ERROR: SubagentStatus.FAILED,
            AgentState.TERMINATED: SubagentStatus.CANCELLED,
            AgentState.TIMED_OUT: SubagentStatus.TIMED_OUT,
        }

        # Collect output
        output = "\n".join(item["content"] for item in self.runtime.output_buffer)

        # Extract AI messages from interaction log
        ai_messages = [msg for msg in self.runtime.interaction_log if msg.get("direction") == "from_agent"]

        return SubagentResult(
            task_id=self.runtime.task_id,
            trace_id=self.runtime.session_id,
            status=status_map.get(self.runtime.state, SubagentStatus.FAILED),
            result=output if self.runtime.state == AgentState.COMPLETED else None,
            error=output if self.runtime.state == AgentState.ERROR else None,
            started_at=self.runtime.started_at,
            completed_at=datetime.now(),
            ai_messages=ai_messages,
            stream_messages=self.runtime.output_buffer,
        )

    async def pause_monitoring(self) -> None:
        """Pause the monitoring loop (for interactive mode)."""
        self._stop_monitor.set()
        if self._monitor_task:
            await self._monitor_task
            self._monitor_task = None

    async def resume_monitoring(self) -> None:
        """Resume the monitoring loop."""
        self._stop_monitor.clear()
        self._monitor_task = asyncio.create_task(self._monitor_loop())
