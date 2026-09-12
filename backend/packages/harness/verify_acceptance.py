"""Acceptance self-check script for the sandbox security hardening task."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "packages", "harness"))

from evoflow.community.aio_sandbox.aio_sandbox import _validate_writable_container_path

print("=" * 70)
print("ACCEPTANCE CHECK 1: write_file path allowlist rejects system dirs")
print("=" * 70)
system_paths = ["/bin/sh", "/usr/bin/python3", "/etc/passwd", "/sbin/init", "/opt/exploit", "/root/.bashrc"]
all_rejected = True
for p in system_paths:
    try:
        _validate_writable_container_path(p)
        print(f"  FAIL: {p} was NOT rejected")
        all_rejected = False
    except PermissionError:
        print(f"  OK rejected: {p}")

# Verify writable paths are allowed
writable_paths = [
    "/mnt/user-data/workspace/file.txt",
    "/mnt/user-data/uploads/img.png",
    "/mnt/user-data/outputs/report.md",
]
for p in writable_paths:
    try:
        _validate_writable_container_path(p)
        print(f"  OK allowed: {p}")
    except PermissionError as e:
        print(f"  FAIL: {p} was wrongly rejected: {e}")
        all_rejected = False

# Read-only mounts rejected for write
ro_paths = ["/mnt/skills/x", "/mnt/acp-workspace/x"]
for p in ro_paths:
    try:
        _validate_writable_container_path(p)
        print(f"  FAIL: {p} was NOT rejected (read-only mount)")
        all_rejected = False
    except PermissionError:
        print(f"  OK rejected (read-only mount): {p}")

print(f"\n  CHECK1 RESULT: {'PASS' if all_rejected else 'FAIL'}")
