"""Short policy text for the ``subagent`` tool description."""

from __future__ import annotations

SUBAGENT_TOOL_DESCRIPTION = """\
Delegate a sub-problem to an isolated worker (stream default on). After a plan is \
committed, use **`supervisor`** for batch lifecycle — not this tool.

**Use when**: multi-file/complex edits, long research/recon/log triage, parallel \
independent sub-problems. Prefer `find`/`rg`/`read` for simple locate; \
`read`+`replace` for single-file small edits.

**Types (default = `agent`)**: Prefer the built-in generic **`agent`** unless you \
need a known specialist already listed as a subagent (`code-agent`, `bash` when \
allowed, `media-*` crew, or a custom employee code). Do **not** invent types from \
plugin/skill/MCP names — e.g. `computer-use` / `browser-use` are **tools**, not \
`subagent_type`; for desktop/browser work use those tools in-session or delegate \
with `subagent_type=agent`.

**Don't**: trivial one-shots; clarify with user first via `ask_clarification`; \
set `model` on worker_profile unless the user asks.

**Args order**: `description` (3–5 words), `prompt`, `subagent_type` (default `agent`).
"""
