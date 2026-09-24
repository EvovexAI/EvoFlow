#!/usr/bin/env python
"""ci_probe.py — Runtime probe for Prompt Audit L1.

Runs ``apply_prompt_template`` with a synthetic SOUL that carries an **Identity**
heading so the P-002 / P-011 live bug surface is exercised every CI run.

Regression targets:
  - revert of the omit_identity_section heuristic in ``get_agent_soul``
  - reintroduction of the Identity heading inside <soul>

Exit code 0 = probe wrote output (audit step is separate).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# PYTHONPATH must point at the harness root (backend/).
# The workflow sets PYTHONPATH=${{ github.workspace }}/backend.
_backend_root = Path(__file__).resolve().parents[3]
if str(_backend_root) not in sys.path:
    sys.path.insert(0, str(_backend_root))


def _synthetic_soul() -> str:
    """Return a minimal SOUL block that includes an Identity heading (P-002 surface)."""
    return """
## Identity
- Role: AI coding assistant
- Default display: EvoFlow

## Communication Style
- Be concise and helpful
"""


def main(argv: list[str]) -> int:
    out_path: str | None = None
    for arg in argv:
        if not arg.startswith("-"):
            out_path = arg
            break

    if out_path is None:
        out_path = os.environ.get("PROBE_OUT")
    if not out_path:
        print("ERROR: PROBE_OUT not set and no output path provided", file=sys.stderr)
        return 1

    try:
        # Import after path setup so evoflow.* imports resolve.
        # Defer heavy imports until inside main to keep the script lean.
        from evoflow.agents.lead_agent.prompt import apply_prompt_template
    except Exception as exc:
        print(f"ERROR: failed to import apply_prompt_template: {exc}", file=sys.stderr)
        return 1

    try:
        prompt = apply_prompt_template(
            agent_name="EvoFlow",
            subagent_enabled=False,
            # Inject the synthetic soul via custom_system_prompt to exercise
            # the soul codepath without touching the database.
            custom_system_prompt=_synthetic_soul(),
            include_memory=False,
            # Exercise the plan scenario to include richer blocks.
            intent_hint="plan",
        )
    except Exception as exc:
        print(f"ERROR: apply_prompt_template raised: {exc}", file=sys.stderr)
        return 1

    Path(out_path).write_text(prompt, encoding="utf-8")
    print(f"Probe written to {out_path} ({len(prompt)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
