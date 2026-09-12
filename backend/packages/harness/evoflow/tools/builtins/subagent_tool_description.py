"""Short policy text for the ``subagent`` tool description."""

from __future__ import annotations

SUBAGENT_TOOL_DESCRIPTION = """\
Delegate a sub-problem to an isolated worker (stream default on). After a plan is \
committed, use **`supervisor`** for batch lifecycle — not this tool.

**Use when**: multi-file/complex edits, long research/recon/log triage, parallel \
independent sub-problems. Prefer `find`/`rg`/`read` for simple locate; \
`read`+`replace` for single-file small edits.

**Types**: `general-purpose` | `code-agent` (preferred for coding/repo work) | \
`bash` (when allowed) | `media-*` crew for creative pipelines. Do **not** use \
`claude-code` — prefer `code-agent`.

**Don't**: trivial one-shots; clarify with user first via `ask_clarification`; \
set `model` on worker_profile unless the user asks.

**Args order**: `description` (3–5 words), `prompt`, `subagent_type`.
"""
