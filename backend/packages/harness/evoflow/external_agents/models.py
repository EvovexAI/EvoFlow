"""Data models for external agent execution."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class AgentState(Enum):
    """External agent execution state machine.

    States:
        PENDING: Waiting to start
        STARTING: Starting up
        EXECUTING: Running task
        WAITING_INPUT: Waiting for human/lead agent input ⭐
        OUTPUTTING: Producing output
        PAUSED: Paused
        COMPLETED: Task finished successfully
        ERROR: Error occurred
        TERMINATED: Forcefully stopped
    """

    PENDING = "pending"
    STARTING = "starting"
    EXECUTING = "executing"
    WAITING_INPUT = "waiting"  # Key state: agent is asking a question
    OUTPUTTING = "outputting"
    PAUSED = "paused"
    COMPLETED = "completed"
    ERROR = "error"
    TERMINATED = "terminated"


@dataclass
class ExternalAgentConfig:
    """Configuration for an external agent.

    Attributes:
        agent_type: Type identifier (e.g., "trae")
        protocol: Communication protocol ("pty", "http", "websocket", "lsp")
        executable: CLI executable path (for PTY protocol)
        default_args: Default command arguments
        base_url: Base URL (for HTTP/WebSocket protocols)
        timeout_seconds: Execution timeout
        max_output_lines: Output buffer size limit
        waiting_input_patterns: Regex patterns to detect waiting for input
        progress_patterns: Regex patterns to parse progress from output
        env: Environment variables
    """

    agent_type: str = "generic"
    protocol: str = "pty"  # pty, http, websocket, lsp

    # PTY-specific
    executable: str = ""
    default_args: list[str] = field(default_factory=list)

    # HTTP/WebSocket-specific
    base_url: str = ""
    ws_url: str = ""
    api_key: str | None = None

    # Common
    timeout_seconds: int = 3600
    max_output_lines: int = 10000

    # State detection patterns
    waiting_input_patterns: list[str] = field(
        default_factory=lambda: [
            r"需要.*吗[?？]",
            r"你.*吗[?？]",
            r"请.*确认",
            r"\(y/n\)",
            r"\[Y/n\]",
            r"\[y/N\]",
            r"Press .* to continue",
            r"Waiting for input",
        ]
    )

    progress_patterns: list[dict] = field(
        default_factory=lambda: [
            {"pattern": r"Step\s+(\d+)\s*/\s*(\d+)", "type": "fraction"},
            {"pattern": r"(\d+)", "type": "percentage"},
            {"pattern": r"Progress[:\s]*(\d+)", "type": "percentage"},
            {"pattern": r"Completed[:\s]*(\d+)\s*/\s*(\d+)", "type": "fraction"},
        ]
    )

    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict) -> "ExternalAgentConfig":
        """Create config from dictionary."""
        return cls(
            agent_type=data.get("agent_type", "generic"),
            protocol=data.get("protocol", "pty"),
            executable=data.get("executable", ""),
            default_args=data.get("default_args", []),
            base_url=data.get("base_url", ""),
            ws_url=data.get("ws_url", ""),
            api_key=data.get("api_key"),
            timeout_seconds=data.get("timeout_seconds", 3600),
            max_output_lines=data.get("max_output_lines", 10000),
            waiting_input_patterns=data.get("waiting_input_patterns"),
            progress_patterns=data.get("progress_patterns"),
            env=data.get("env", {}),
        )


@dataclass
class ExternalAgentRuntime:
    """Runtime state for an external agent session.

    This mirrors the structure used by SubagentExecutor for compatibility.
    """

    # Identifiers
    session_id: str = ""
    task_id: str = ""  # EvoFlow task ID
    agent_type: str = ""

    # State
    state: AgentState = AgentState.PENDING
    progress: int = 0  # 0-100
    current_step: str = ""  # Current step description

    # Process info (PTY protocol)
    pid: int | None = None
    master_fd: int | None = None
    process: Any = None  # asyncio.subprocess.Process

    # Connection info (HTTP/WebSocket protocol)
    http_session: Any = None  # httpx.AsyncClient
    ws_connection: Any = None  # websockets.WebSocketClientProtocol
    external_session_id: str = ""  # Remote session ID (e.g., Trae session)

    # Output buffer (ring buffer)
    output_buffer: list[dict] = field(default_factory=list)
    output_buffer_max_size: int = 10000

    # Statistics
    started_at: datetime | None = None
    last_activity: datetime = field(default_factory=datetime.now)
    total_output_lines: int = 0
    total_messages_sent: int = 0

    # Interaction log
    interaction_log: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "session_id": self.session_id,
            "task_id": self.task_id,
            "agent_type": self.agent_type,
            "state": self.state.value,
            "progress": self.progress,
            "current_step": self.current_step,
            "pid": self.pid,
            "external_session_id": self.external_session_id,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "last_activity": self.last_activity.isoformat(),
            "total_output_lines": self.total_output_lines,
            "total_messages_sent": self.total_messages_sent,
        }

    def append_output(self, line: str) -> None:
        """Append output line to buffer (ring buffer)."""
        from datetime import datetime

        self.output_buffer.append(
            {
                "timestamp": datetime.now().isoformat(),
                "content": line,
            }
        )
        self.total_output_lines += 1
        self.last_activity = datetime.now()

        # Trim buffer if too large
        if len(self.output_buffer) > self.output_buffer_max_size:
            self.output_buffer = self.output_buffer[-self.output_buffer_max_size :]

    def log_interaction(self, direction: str, content: str) -> None:
        """Log an interaction (message sent or received)."""
        from datetime import datetime

        self.interaction_log.append(
            {
                "timestamp": datetime.now().isoformat(),
                "direction": direction,  # "to_agent" or "from_agent"
                "content": content,
            }
        )

        if direction == "to_agent":
            self.total_messages_sent += 1
