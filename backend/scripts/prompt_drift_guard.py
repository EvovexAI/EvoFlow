#!/usr/bin/env python
"""CI guard: detect prompt-stack drift (retired tool names + dead path promises).

Two drift classes that silently rot the Agent prompt stack:

1. **Retired tool names** — a prompt block tells the model to call a tool that
   no longer exists in the live catalog (``terminal`` / ``read_file`` / ``process`` …).
   The model then either hallucinates the call or stalls.
2. **Dead path promises** — a governance doc points at a path that is not in the
   repo (e.g. ``.codebasewiki/`` which is gitignored and never shipped).

Usage:
    python backend/scripts/prompt_drift_guard.py            # enforce (exit 1 on findings)
    python backend/scripts/prompt_drift_guard.py --list     # print findings only (exit 0)
    python backend/scripts/prompt_drift_guard.py --update   # regenerate the allowlist

Stdlib-only so it can run in the cheap CI lane without installing dependencies.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS = REPO_ROOT / "backend" / "packages" / "harness" / "evoflow"
ALLOWLIST = Path(__file__).resolve().parent / "prompt_drift_guard_allowlist.txt"

# ---------------------------------------------------------------------------
# 1. Retired tool names
# ---------------------------------------------------------------------------
# Live host-direct catalog: read / write / replace / grep / search_code_index /
# bash / taskoutput / taskstop / web_fetch.
# Everything below is retired from the LLM tool surface (see
# ``evoflow/tools/tools.py::REMOVED_LEGACY_TOOL_NAMES``).
RETIRED_TOOL_NAMES: tuple[str, ...] = (
    "terminal",
    "read_file",
    "write_file",
    "str_replace",
    "replace_in_file",
    "delete_file",
    "find_file",
    "glob",
    "rg",
    "find",
    "ls",
    "list_dir",
    "list_agents",
    "create_agent",
    "update_agent",
    "list_assignable_tools",
    "panel_set",
    "stage_set",
    "process",
    "process_start",
    "process_log",
    "process_wait",
    "process_kill",
    "process_poll",
    "search_content",
    "view_image",
    "read_lints",
)

# Prompt-bearing source files (the L1/L2/L3 prompt stack).
PROMPT_SOURCES: tuple[str, ...] = (
    "agents/lead_agent/prompt_blocks_zh.py",
    "agents/lead_agent/prompt_blocks_en.py",
    "agents/lead_agent/prompt_dynamic_zh.py",
    "agents/lead_agent/prompt_dynamic_en.py",
    "agents/lead_agent/plan_prompt_blocks_zh.py",
    "agents/lead_agent/plan_prompt_blocks_en.py",
    "agents/lead_agent/prompt.py",
    "agents/middlewares/collab_phase_middleware.py",
    "agents/middlewares/uploads_middleware.py",
    "tools/builtins/plan_tool.py",
    "tools/builtins/subagent_tool_description.py",
    "tools/builtins/worker_tool.py",
    "tools/builtins/scenario_activation.py",
    "tools/builtins/tool_search.py",
    "tools/builtins/supervisor_tool.py",
    "tools/builtins/supervisor/orchestration_hints.py",
)

# ---------------------------------------------------------------------------
# 2. Dead path promises (governance layer)
# ---------------------------------------------------------------------------
# Governance docs that are shipped to the repo root / .cursor rules.
GOVERNANCE_DOCS: tuple[str, ...] = (
    "AGENTS.md",
    "docs/contribute/index.md",
    "docs/contribute/repo-map.md",
    "docs/index.md",
    "docs/README.md",
    "scripts/README.md",
)

# Paths that must exist if a doc references them. Gitignored dirs (like
# ``.codebasewiki/``) are intentionally absent — referencing them is drift.
DEAD_PATH_PATTERNS: tuple[str, ...] = (
    r"\.codebasewiki/",
    r"\.claude/skills/",
    r"codebase-navigator",
    r"codebase-bootstrap",
    r"codebase-loop",
    r"codebase-compound",
    r"codebase-wiki",
    r"wiki-config\.yaml",
    r"wiki_audit\.py",
)

# Tool names in backticks (`` `terminal` ``) — prompt-visible mentions only.
# Bare words in prose are ambiguous (e.g. "process" as a noun), so we require
# the backtick form to avoid false positives.
_BACKTICK = re.compile(r"`([^`\n]{1,120})`")


def _iter_lines(path: Path) -> list[tuple[int, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [(i, line) for i, line in enumerate(text.splitlines(), 1)]


def _scan_prompt_sources(allowlist: set[str]) -> list[str]:
    findings: list[str] = []
    for rel in PROMPT_SOURCES:
        path = HARNESS / rel
        if not path.exists():
            continue
        for lineno, line in _iter_lines(path):
            stripped = line.strip()
            # Comments and docstrings are not prompt-visible; skip pure comments.
            if stripped.startswith("#"):
                continue
            for span in _BACKTICK.findall(line):
                for name in RETIRED_TOOL_NAMES:
                    if not re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", span):
                        continue
                    key = f"{rel}:{lineno}"
                    if key in allowlist:
                        break
                    findings.append(f"{key}: retired tool `{name}` in prompt span `{span}`")
                    break
    return findings


def _scan_governance_docs(allowlist: set[str]) -> list[str]:
    findings: list[str] = []
    for rel in GOVERNANCE_DOCS:
        path = REPO_ROOT / rel
        if not path.exists():
            continue
        for lineno, line in _iter_lines(path):
            for pattern in DEAD_PATH_PATTERNS:
                if not re.search(pattern, line):
                    continue
                key = f"{rel}:{lineno}"
                if key in allowlist:
                    break
                findings.append(f"{key}: dead path promise `{pattern}`")
                break
    return findings


def _load_allowlist() -> set[str]:
    if not ALLOWLIST.exists():
        return set()
    return {
        ln.strip()
        for ln in ALLOWLIST.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="print findings only (always exit 0)")
    parser.add_argument("--update", action="store_true", help="regenerate the allowlist")
    args = parser.parse_args()

    allowlist = _load_allowlist()
    findings = _scan_prompt_sources(allowlist) + _scan_governance_docs(allowlist)

    if args.update:
        ALLOWLIST.write_text(
            "# Prompt drift allowlist: one 'file:line' per tolerated finding.\n"
            "# This list may only shrink. New entries require an explicit waiver.\n"
            + "\n".join(sorted(f.split(":")[0] for f in findings))
            + ("\n" if findings else ""),
            encoding="utf-8",
        )
        print(f"allowlist updated: {len(findings)} finding(s) -> {ALLOWLIST}")
        return 0

    if not findings:
        print("OK: no prompt-stack drift detected.")
        return 0

    print(f"FAIL: {len(findings)} prompt-stack drift finding(s).")
    for f in findings:
        print(f"  {f}")
    print()
    print("Retired tool names: the live catalog is read/write/replace/grep/")
    print("search_code_index/bash/taskoutput/taskstop/web_fetch.")
    print("Dead path promises: point at paths that actually ship, or drop them.")
    print("To accept the current state: python backend/scripts/prompt_drift_guard.py --update")
    return 0 if args.list else 1


if __name__ == "__main__":
    sys.exit(main())
