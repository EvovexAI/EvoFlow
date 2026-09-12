"""Trae Agent implementation using Trae HTTP bridge API.

This agent interacts with Trae desktop editor through the Trae HTTP bridge.
It uses the existing HTTP API rather than PTY/CLI.

The Trae bridge API provides:
- POST /v1/sessions - Create a session
- GET /v1/sessions/{id} - Get session status
- POST /v1/sessions/{id}/messages - Send message
- POST /v1/sessions/{id}/messages/stream - Stream messages (SSE)

Configuration (from config.yaml):
    trae:
        base_url: http://127.0.0.1:8787
        timeout_seconds: 20
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import datetime

import httpx

from evoflow.subagents.executor import SubagentResult

from .base import BaseExternalAgent
from .models import AgentState, ExternalAgentRuntime

logger = logging.getLogger(__name__)


class TraeAgent(BaseExternalAgent):
    """Trae agent using Trae HTTP bridge API.

    This agent wraps the existing Trae HTTP bridge API to provide:
    - Session management
    - Message sending/receiving
    - Status monitoring
    - Streaming output

    Configuration example (config.yaml):
        trae:
            enabled: true
            base_url: http://127.0.0.1:8787
            timeout_seconds: 20

    Usage:
        >>> config = ExternalAgentConfig(
        ...     agent_type="trae",
        ...     protocol="http",
        ...     base_url="http://127.0.0.1:8787"
        ... )
        >>> agent = TraeAgent(config)
        >>> session_id = await agent.launch("task-123", "Refactor code")
        >>> result = await agent.execute({"id": "task-123", "description": "Refactor"})
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http_client: httpx.AsyncClient | None = None
        self._stream_task: asyncio.Task | None = None

    async def launch(self, task_id: str, prompt: str, cwd: str | None = None) -> str:
        """Launch Trae agent by creating an HTTP session.

        Args:
            task_id: EvoFlow task ID
            prompt: Initial task description
            cwd: Working directory (project path)

        Returns:
            Session ID
        """
        # Initialize HTTP client
        base_url = self.config.base_url or "http://127.0.0.1:8787"
        self._http_client = httpx.AsyncClient(
            base_url=base_url,
            timeout=30.0,
            headers={"Content-Type": "application/json"},
        )

        logger.info(f"[TraeAgent] Connecting to Trae bridge at {base_url}")

        # Check if Trae is available
        try:
            health = await self._http_client.get("/health")
            if health.status_code != 200:
                raise RuntimeError(f"Trae not available: {health.status_code}")
        except Exception as e:
            raise RuntimeError(f"Failed to connect to Trae: {e}")

        # Step 1: Create session
        create_payload = {
            "metadata": {
                "task_id": task_id,
                "project_path": cwd,
                "prompt": prompt,
            },
            "prepare": True,  # Switch Trae to a fresh conversation
        }

        try:
            response = await self._http_client.post("/v1/sessions", json=create_payload)
            response.raise_for_status()
            data = response.json()

            trae_session_id = data["data"]["session"]["sessionId"]
            logger.info(f"[TraeAgent] Created session {trae_session_id}")

        except Exception as e:
            raise RuntimeError(f"Failed to create Trae session: {e}")

        # Step 2: Initialize runtime
        self.runtime = ExternalAgentRuntime(
            session_id=task_id,  # Use task_id as session_id for EvoFlow tracking
            task_id=task_id,
            agent_type="trae",
            state=AgentState.STARTING,
            http_session=self._http_client,
            external_session_id=trae_session_id,
            output_buffer_max_size=self.config.max_output_lines,
            started_at=datetime.now(),
        )

        # Step 3: Send initial prompt if provided
        if prompt:
            await self.send_message(prompt)

        return task_id

    async def send_message(self, message: str) -> bool:
        """Send a message to Trae.

        Args:
            message: Message content

        Returns:
            True if sent successfully
        """
        if not self.runtime or not self._http_client:
            logger.error("[TraeAgent] Cannot send message: not initialized")
            return False

        trae_session_id = self.runtime.external_session_id
        if not trae_session_id:
            logger.error("[TraeAgent] No Trae session ID")
            return False

        # Update state
        self.runtime.state = AgentState.EXECUTING
        self.runtime.log_interaction("to_agent", message)

        # Choose endpoint: stream for monitoring, regular for simple send
        # For interactive mode, we use stream to get real-time updates
        endpoint = f"/v1/sessions/{trae_session_id}/messages/stream"

        payload = {
            "content": message,
            "metadata": {},
        }

        try:
            logger.info(f"[TraeAgent] Sending message to Trae: {message[:100]}...")

            # Start streaming in background
            self._stream_task = asyncio.create_task(self._stream_messages(endpoint, payload))

            return True

        except Exception as e:
            logger.error(f"[TraeAgent] Failed to send message: {e}")
            return False

    async def _stream_messages(self, endpoint: str, payload: dict) -> None:
        """Stream messages from Trae using SSE.

        This runs in the background and updates the runtime state.
        """
        if not self._http_client:
            return

        try:
            async with self._http_client.stream("POST", endpoint, json=payload) as response:
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue

                    # Parse SSE event
                    if line.startswith("event: "):
                        line[7:].strip()
                        continue

                    if line.startswith("data: "):
                        data = line[6:].strip()

                        try:
                            event = json.loads(data)
                            await self._process_sse_event(event)
                        except json.JSONDecodeError:
                            # Not JSON, treat as raw output
                            self.runtime.append_output(data)

        except Exception as e:
            logger.error(f"[TraeAgent] Stream error: {e}")
            if self.runtime:
                self.runtime.state = AgentState.ERROR

    async def _process_sse_event(self, event: dict) -> None:
        """Process SSE event from Trae."""
        if not self.runtime:
            return

        event_type = event.get("event", "unknown")
        data = event.get("data", {})

        if event_type == "open":
            logger.info("[TraeAgent] Stream opened")
            self.runtime.state = AgentState.EXECUTING

        elif event_type == "delta":
            # Output delta
            content = data.get("content", "")
            if content:
                self.runtime.append_output(content)
                if self.on_output:
                    self.on_output(content)

        elif event_type == "tool":
            # Tool call info
            tool_name = data.get("tool", "unknown")
            self.runtime.append_output(f"[Tool: {tool_name}]")

        elif event_type == "done":
            logger.info("[TraeAgent] Stream completed")
            result = data.get("result", {})

            if result.get("status") == "success":
                self.runtime.state = AgentState.COMPLETED
            else:
                self.runtime.state = AgentState.ERROR

        elif event_type == "error":
            error_msg = data.get("message", "Unknown error")
            logger.error(f"[TraeAgent] Stream error: {error_msg}")
            self.runtime.append_output(f"Error: {error_msg}")
            self.runtime.state = AgentState.ERROR

    async def get_status(self) -> AgentState:
        """Get current status by checking Trae session."""
        if not self.runtime or not self._http_client:
            return AgentState.ERROR

        trae_session_id = self.runtime.external_session_id
        if not trae_session_id:
            return self.runtime.state

        try:
            response = await self._http_client.get(f"/v1/sessions/{trae_session_id}")

            if response.status_code == 200:
                data = response.json()
                session = data["data"]["session"]

                # Map Trae status to our AgentState
                status_map = {
                    "idle": AgentState.PENDING,
                    "running": AgentState.EXECUTING,
                    "completed": AgentState.COMPLETED,
                    "error": AgentState.ERROR,
                }

                trae_status = session.get("status", "unknown")
                new_state = status_map.get(trae_status, AgentState.EXECUTING)

                # Update
                if new_state != self.runtime.state:
                    old_state = self.runtime.state
                    self.runtime.state = new_state
                    if self.on_state_change:
                        self.on_state_change(old_state, new_state)

                # Check for result
                if session.get("lastResult"):
                    result = session["lastResult"]
                    self.runtime.progress = result.get("progress", 0)

            return self.runtime.state

        except Exception as e:
            logger.error(f"[TraeAgent] Failed to get status: {e}")
            return AgentState.ERROR

    async def get_output(self, lines: int = 50) -> list[str]:
        """Get recent output from buffer."""
        if not self.runtime:
            return []

        buffer = self.runtime.output_buffer
        if lines == 0:
            return [item["content"] for item in buffer]

        recent = buffer[-lines:] if len(buffer) > lines else buffer
        return [item["content"] for item in recent]

    async def terminate(self, force: bool = False) -> bool:
        """Terminate Trae session.

        Note: Trae doesn't have a direct terminate API.
        We can only delete the session or switch mode.
        """
        if not self.runtime or not self._http_client:
            return False

        trae_session_id = self.runtime.external_session_id

        try:
            # Option: Switch to SOLO mode (safer than killing)
            await self._http_client.post("/v1/modes/switch", json={"mode": "SOLO"})

            self.runtime.state = AgentState.TERMINATED
            logger.info(f"[TraeAgent] Terminated session {trae_session_id}")

            # Close HTTP client
            await self._http_client.aclose()
            self._http_client = None

            return True

        except Exception as e:
            logger.error(f"[TraeAgent] Failed to terminate: {e}")
            return False

    async def _read_output_stream(self) -> AsyncIterator[str]:
        """Read output from buffer (for base class compatibility).

        Trae uses HTTP/SSE rather than direct stream reading.
        We yield from the buffer instead.
        """
        if not self.runtime:
            return

        last_index = 0

        while True:
            buffer = self.runtime.output_buffer

            if len(buffer) > last_index:
                for item in buffer[last_index:]:
                    yield item["content"]
                last_index = len(buffer)

            # Check if terminal state
            if self.runtime.state in [AgentState.COMPLETED, AgentState.ERROR, AgentState.TERMINATED]:
                break

            await asyncio.sleep(0.5)

    def parse_progress(self, output_lines: list[str]) -> tuple[int, str]:
        """Parse progress from output (if Trae provides it).

        Trae doesn't always provide explicit progress, so we estimate
        based on output length or look for patterns.
        """
        if not output_lines:
            return self.runtime.progress if self.runtime else 0, ""

        # Check last few lines for progress indicators
        for line in reversed(output_lines[-20:]):
            # Look for common patterns in Trae output
            if "已完成" in line or "completed" in line.lower():
                return 100, line

            if "正在" in line or "working" in line.lower():
                # Estimate progress based on output length
                # This is heuristic
                return min(90, self.runtime.progress + 5 if self.runtime else 10), line

        return self.runtime.progress if self.runtime else 0, "Processing..."

    async def execute(self, task: dict, timeout: int | None = None) -> SubagentResult:
        """Execute task with Trae-specific handling.

        For HTTP-based agents, the standard execute flow works,
        but we also start streaming immediately.
        """
        # Call base execute
        result = await super().execute(task, timeout)

        # Additional Trae-specific cleanup
        if self._stream_task:
            try:
                await asyncio.wait_for(self._stream_task, timeout=5.0)
            except TimeoutError:
                self._stream_task.cancel()

        # Ensure HTTP client closed
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

        return result
