"""Knowledge search MCP native preflight / permanent-failure heuristics."""

from __future__ import annotations

from evoflow.knowledge.vault import mcp_runtime as mr


def test_permanent_native_failure_sqlite_vec():
    assert mr._looks_like_permanent_native_failure(
        "sqlite-vec: Error: The specified module could not be found. getLoadablePath"
    )


def test_permanent_native_failure_missing_module():
    assert mr._looks_like_permanent_native_failure("Error: Cannot find module 'better-sqlite3'")


def test_abi_mismatch_is_not_permanent():
    # ABI can be healed via rebuild; do not fail-fast as permanent.
    assert not mr._looks_like_permanent_native_failure(
        "Error: The module was compiled against a different Node.js version "
        "(NODE_MODULE_VERSION). ERR_DLOPEN_FAILED"
    )
