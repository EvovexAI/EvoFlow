import base64
import logging
import posixpath

from agent_sandbox import Sandbox as AioSandboxClient

from evoflow.config.paths import VIRTUAL_PATH_PREFIX
from evoflow.sandbox.sandbox import Sandbox

logger = logging.getLogger(__name__)

# Container-internal paths that may be written to by the sandbox.
# These mirror the bind-mounts created by AioSandboxProvider._get_thread_mounts:
#   /mnt/user-data/{workspace,uploads,outputs} are writable host bind-mounts.
# Everything else (e.g. /bin, /usr/bin, /etc) must be read-only.
_WRITABLE_CONTAINER_PREFIXES = (
    f"{VIRTUAL_PATH_PREFIX}/workspace",
    f"{VIRTUAL_PATH_PREFIX}/uploads",
    f"{VIRTUAL_PATH_PREFIX}/outputs",
)

# Read-only mount roots inside the container (skills + ACP workspace).
# Writing to these is rejected even though they are mounted.
_SKILLS_CONTAINER_PATH = "/mnt/skills"
_ACP_WORKSPACE_CONTAINER_PATH = "/mnt/acp-workspace"


def _reject_path_traversal(path: str) -> None:
    """Reject paths containing '..' segments to prevent directory traversal."""
    normalised = path.replace("\\", "/")
    for segment in normalised.split("/"):
        if segment == "..":
            raise PermissionError("Access denied: path traversal detected")


def _validate_writable_container_path(path: str) -> None:
    """Validate that a container-internal path is within the writable allowlist.

    Only paths under /mnt/user-data/{workspace,uploads,outputs} may be written.
    System directories (/bin, /usr/bin, /etc, ...) and read-only mounts
    (/mnt/skills, /mnt/acp-workspace) are rejected.

    This mirrors the intent of sandbox/tools.py:validate_local_tool_path but
    operates on container-internal paths (the AIO sandbox already has
    /mnt/user-data mounted, so no virtual->host resolution is needed).

    Args:
        path: Absolute container-internal path to validate.

    Raises:
        PermissionError: If the path is outside the writable allowlist or
            contains traversal sequences.
    """
    if not isinstance(path, str) or not path:
        raise PermissionError("Access denied: empty or invalid file path")

    _reject_path_traversal(path)

    # Normalise without resolving symlinks (we cannot stat inside the container
    # from here); posixpath.normpath collapses redundant separators and '.'.
    normalised = posixpath.normpath(path)

    # Reject read-only mount roots explicitly (clearer error).
    if normalised == _SKILLS_CONTAINER_PATH or normalised.startswith(f"{_SKILLS_CONTAINER_PATH}/"):
        raise PermissionError(f"Write access to skills path is not allowed: {path}")
    if normalised == _ACP_WORKSPACE_CONTAINER_PATH or normalised.startswith(f"{_ACP_WORKSPACE_CONTAINER_PATH}/"):
        raise PermissionError(f"Write access to ACP workspace is not allowed: {path}")

    # Allow only under the writable user-data subdirectories.
    for prefix in _WRITABLE_CONTAINER_PREFIXES:
        if normalised == prefix or normalised.startswith(f"{prefix}/"):
            return

    raise PermissionError(
        f"Write access denied: only paths under {VIRTUAL_PATH_PREFIX}/workspace, "
        f"{VIRTUAL_PATH_PREFIX}/uploads, or {VIRTUAL_PATH_PREFIX}/outputs are writable"
    )


class AioSandbox(Sandbox):
    """Sandbox implementation using the agent-infra/sandbox Docker container.

    This sandbox connects to a running AIO sandbox container via HTTP API.
    """

    def __init__(self, id: str, base_url: str, home_dir: str | None = None):
        """Initialize the AIO sandbox.

        Args:
            id: Unique identifier for this sandbox instance.
            base_url: URL of the sandbox API (e.g., http://localhost:8080).
            home_dir: Home directory inside the sandbox. If None, will be fetched from the sandbox.
        """
        super().__init__(id)
        self._base_url = base_url
        self._client = AioSandboxClient(base_url=base_url, timeout=600)
        self._home_dir = home_dir

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def home_dir(self) -> str:
        """Get the home directory inside the sandbox."""
        if self._home_dir is None:
            context = self._client.sandbox.get_context()
            self._home_dir = context.home_dir
        return self._home_dir

    def execute_command(self, command: str) -> str:
        """Execute a shell command in the sandbox.

        Args:
            command: The command to execute.

        Returns:
            The output of the command.
        """
        try:
            result = self._client.shell.exec_command(command=command)
            output = result.data.output if result.data else ""
            return output if output else "(no output)"
        except Exception as e:
            logger.error(f"Failed to execute command in sandbox: {e}")
            return f"Error: {e}"

    def read_file(self, path: str) -> str:
        """Read the content of a file in the sandbox.

        Args:
            path: The absolute path of the file to read.

        Returns:
            The content of the file.
        """
        try:
            result = self._client.file.read_file(file=path)
            return result.data.content if result.data else ""
        except Exception as e:
            logger.error(f"Failed to read file in sandbox: {e}")
            return f"Error: {e}"

    def list_dir(self, path: str, max_depth: int = 2) -> list[str]:
        """List the contents of a directory in the sandbox.

        Args:
            path: The absolute path of the directory to list.
            max_depth: The maximum depth to traverse. Default is 2.

        Returns:
            The contents of the directory.
        """
        try:
            # Use shell command to list directory with depth limit
            # The -L flag limits the depth for the tree command
            result = self._client.shell.exec_command(command=f"find {path} -maxdepth {max_depth} -type f -o -type d 2>/dev/null | head -500")
            output = result.data.output if result.data else ""
            if output:
                return [line.strip() for line in output.strip().split("\n") if line.strip()]
            return []
        except Exception as e:
            logger.error(f"Failed to list directory in sandbox: {e}")
            return []

    def write_file(self, path: str, content: str, append: bool = False) -> None:
        """Write content to a file in the sandbox.

        Args:
            path: The absolute path of the file to write to.
            content: The text content to write to the file.
            append: Whether to append the content to the file.
        """
        # Security gate: reject writes outside the writable allowlist
        # (/mnt/user-data/{workspace,uploads,outputs}).  This mirrors
        # sandbox/tools.py:validate_local_tool_path for the AIO sandbox,
        # whose paths are already container-internal (no virtual->host
        # resolution needed because /mnt/user-data is bind-mounted).
        _validate_writable_container_path(path)
        try:
            if append:
                # Read existing content first and append
                existing = self.read_file(path)
                if not existing.startswith("Error:"):
                    content = existing + content
            self._client.file.write_file(file=path, content=content)
        except Exception as e:
            logger.error(f"Failed to write file in sandbox: {e}")
            raise

    def update_file(self, path: str, content: bytes) -> None:
        """Update a file with binary content in the sandbox.

        Args:
            path: The absolute path of the file to update.
            content: The binary content to write to the file.
        """
        # Security gate: same writable-allowlist check as write_file.
        _validate_writable_container_path(path)
        try:
            base64_content = base64.b64encode(content).decode("utf-8")
            self._client.file.write_file(file=path, content=base64_content, encoding="base64")
        except Exception as e:
            logger.error(f"Failed to update file in sandbox: {e}")
            raise
