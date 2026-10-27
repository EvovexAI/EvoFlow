"""Gate: blocking calls inside async def must not regress (CI 门禁).

Runs backend/scripts/check_async_blocking_calls.scan() — the AST sweep that
keeps sync FS/HTTP/subprocess/sleep off the Gateway event loop. New violations
fail this test; provably-cheap calls take an inline '# async-block-ok: <reason>'
waiver; the baseline file may only shrink.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

from check_async_blocking_calls import _load_baseline, scan  # noqa: E402


def test_no_new_blocking_calls_in_async_def():
    current = scan()
    baseline = set(_load_baseline())
    new = [hit for hit in current if hit not in baseline]
    assert not new, (
        "Blocking calls inside async def will stall the Gateway event loop.\n"
        + "\n".join(new)
        + "\nFix: move off the loop (asyncio.to_thread) or waive inline with "
        "'# async-block-ok: <reason>'. Baseline: backend/scripts/async_blocking_calls_baseline.txt"
    )
