"""Prompt-stack drift guard: retired tool names + dead path promises.

The guard is the CI safety net for the two drift classes that silently rot the
Agent prompt stack:

1. a prompt block tells the model to call a tool that no longer exists;
2. a governance doc points at a path that never ships (e.g. gitignored dirs).

These tests assert the guard itself works and that the current tree is clean.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARD_PATH = REPO_ROOT / "backend" / "scripts" / "prompt_drift_guard.py"


def _load_guard():
    spec = importlib.util.spec_from_file_location("prompt_drift_guard", GUARD_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["prompt_drift_guard"] = module
    spec.loader.exec_module(module)
    return module


guard = _load_guard()


def test_guard_module_loads():
    assert guard.REPO_ROOT == REPO_ROOT
    assert guard.HARNESS.exists()


def test_retired_tool_names_cover_known_retirements():
    for name in ("terminal", "read_file", "write_file", "process", "list_agents", "glob"):
        assert name in guard.RETIRED_TOOL_NAMES


def test_live_tool_names_are_not_flagged_as_retired():
    for name in ("read", "write", "replace", "grep", "search_code_index", "bash", "taskoutput"):
        assert name not in guard.RETIRED_TOOL_NAMES


def test_dead_path_patterns_cover_codebasewiki_and_claude_skills():
    joined = " ".join(guard.DEAD_PATH_PATTERNS)
    assert ".codebasewiki/" in joined
    assert ".claude/skills/" in joined


def test_prompt_source_scan_finds_retired_tool_in_backticks(tmp_path):
    src = tmp_path / "sample.py"
    src.write_text('X = "call `terminal` to run it"\n', encoding="utf-8")
    assert guard._BACKTICK.findall(src.read_text(encoding="utf-8")) == ["terminal"]


def test_current_tree_has_no_prompt_drift():
    """The repo must pass its own guard (no allowlist entries required)."""
    findings = guard._scan_prompt_sources(set()) + guard._scan_governance_docs(set())
    assert findings == [], "prompt-stack drift detected:\n" + "\n".join(findings)


def test_codebasewiki_dir_is_not_tracked_promised():
    """`.codebasewiki/` is gitignored — governance docs must not promise it."""
    for rel in guard.GOVERNANCE_DOCS:
        path = REPO_ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        assert ".codebasewiki/" not in text, f"{rel} still promises .codebasewiki/"
        assert ".claude/skills/" not in text, f"{rel} still promises .claude/skills/"
