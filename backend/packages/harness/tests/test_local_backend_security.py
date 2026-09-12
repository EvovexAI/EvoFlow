"""Tests for LocalContainerBackend Docker security hardening.

Verifies that the container start command includes:
  - --read-only
  - --cap-drop ALL
  - --security-opt no-new-privileges
  - --tmpfs /mnt/user-data:rw,size=512m
and does NOT include seccomp=unconfined.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.community.aio_sandbox.local_backend import LocalContainerBackend


def _make_backend():
    return LocalContainerBackend(
        image="test-image:latest",
        base_port=9000,
        container_prefix="test-sandbox",
        config_mounts=[],
        environment={},
    )


def _capture_start_cmd(backend, extra_mounts=None):
    """Run _start_container with mocked subprocess and return the cmd list."""
    captured_cmd = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        result = MagicMock()
        result.stdout = "fake-container-id-123\n"
        result.stderr = ""
        result.returncode = 0
        return result

    with patch("subprocess.run", side_effect=fake_run):
        backend._start_container("test-container", 9001, extra_mounts=extra_mounts)

    return captured_cmd


class TestDockerSecurityHardening:
    def test_read_only_root_filesystem(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(backend)
        assert "--read-only" in cmd, f"--read-only missing from cmd: {cmd}"

    def test_cap_drop_all(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(backend)
        # --cap-drop ALL is two args
        assert "--cap-drop" in cmd, f"--cap-drop missing from cmd: {cmd}"
        idx = cmd.index("--cap-drop")
        assert cmd[idx + 1] == "ALL", f"cap-drop value is not ALL: {cmd[idx+1]}"

    def test_no_new_privileges(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(backend)
        assert "--security-opt" in cmd, f"--security-opt missing from cmd: {cmd}"
        idx = cmd.index("--security-opt")
        assert cmd[idx + 1] == "no-new-privileges", (
            f"security-opt value is not no-new-privileges: {cmd[idx+1]}"
        )

    def test_seccomp_unconfined_removed(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(backend)
        assert "seccomp=unconfined" not in cmd, (
            f"seccomp=unconfined should be removed: {cmd}"
        )
        # Also verify no seccomp option at all referencing unconfined
        for i, arg in enumerate(cmd):
            if arg == "--security-opt":
                val = cmd[i + 1] if i + 1 < len(cmd) else ""
                assert "unconfined" not in val, f"seccomp=unconfined still present: {val}"

    def test_tmpfs_user_data_writable(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(backend)
        assert "--tmpfs" in cmd, f"--tmpfs missing from cmd: {cmd}"
        idx = cmd.index("--tmpfs")
        tmpfs_spec = cmd[idx + 1]
        assert tmpfs_spec.startswith("/mnt/user-data"), (
            f"tmpfs not on /mnt/user-data: {tmpfs_spec}"
        )
        assert "rw" in tmpfs_spec, f"tmpfs not rw: {tmpfs_spec}"
        assert "size=512m" in tmpfs_spec, f"tmpfs size not 512m: {tmpfs_spec}"

    def test_skills_mount_preserved_readonly(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(
            backend, extra_mounts=[("/host/skills", "/mnt/skills", True)]
        )
        # -v /host/skills:/mnt/skills:ro
        assert "-v" in cmd
        idx = cmd.index("-v")
        mount_spec = cmd[idx + 1]
        assert "/host/skills:/mnt/skills:ro" == mount_spec, (
            f"skills mount not read-only: {mount_spec}"
        )

    def test_acp_workspace_mount_preserved_readonly(self):
        backend = _make_backend()
        cmd = _capture_start_cmd(
            backend, extra_mounts=[("/host/acp", "/mnt/acp-workspace", True)]
        )
        mounts = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-v"]
        assert any("/mnt/acp-workspace:ro" in m for m in mounts), (
            f"acp-workspace mount not read-only: {mounts}"
        )

    def test_user_data_bindmount_writable(self):
        """Per-thread workspace bind-mount must remain writable (not :ro)."""
        backend = _make_backend()
        cmd = _capture_start_cmd(
            backend,
            extra_mounts=[("/host/ws", "/mnt/user-data/workspace", False)],
        )
        mounts = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-v"]
        assert any(
            m == "/host/ws:/mnt/user-data/workspace" for m in mounts
        ), f"workspace mount should be writable (no :ro): {mounts}"
