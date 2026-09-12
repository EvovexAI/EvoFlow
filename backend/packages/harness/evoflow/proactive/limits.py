"""LangGraph step budgets for proactive think / execute runs.

``max_turns`` is semantic model rounds; LangGraph ``recursion_limit`` counts
graph **super-steps** (model + middleware + tools), not tool rounds.

Lead-agent middleware burns many super-steps per tool. Empirically ~45–60
steps/tool on proactive patrols. When ``EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS`` is
set (>0), dig budget can also reset after successful ``tasks progress`` /
wake / approvals, so one run may cover multiple dig windows before
``AutomationRunGuard`` hard-stops on **total** tool count.

When tool rounds are ``0`` (default: guard off), recursion uses a wide
default budget so LangGraph does not become the mid-task choke.

With an explicit tool-round cap the limit is:

    max_tool_rounds × steps_per_tool × dig_windows + headroom

— not a hard-coded 1500 that becomes both floor and ceiling when
``max_turns * 40`` is smaller than 1500.
"""

from __future__ import annotations

import os

# Aligned with AutomationRunGuard: 0 = no tool-round wrap (default).
_DEFAULT_PROACTIVE_MAX_TOOL_ROUNDS = 0
_DEFAULT_STEPS_PER_TOOL = 55
_DEFAULT_DIG_WINDOWS = 2
_HEADROOM = 400
_MIN_LIMIT = 2000
_MAX_LIMIT = 12000
# When tool-round guard is off, still give a wide graph budget so recursion
# does not become the new mid-task choke (was ~80×55×2 under the old default).
_DEFAULT_UNLIMITED_TOOL_RECURSION = 10000
# Legacy turn-based signal (kept as a secondary lower bound).
_DEFAULT_STEPS_PER_TURN = 40


def _env_int(name: str, default: int, *, lo: int, hi: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(lo, min(int(raw), hi))
    except ValueError:
        return default


def resolve_proactive_recursion_limit(
    max_turns: int | None = None,
    *,
    for_execute: bool = False,
) -> int:
    """Map role / tool budgets → LangGraph ``recursion_limit``.

    Prefer tool-round math (aligned with ``EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS``)
    over the old ``max_turns * 10`` / sticky 1500 floor. ``0`` tool rounds
    means the step guard is off — use a wide default graph budget instead.
    """
    explicit = (os.getenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT") or "").strip()
    if explicit:
        try:
            return max(_MIN_LIMIT, min(int(explicit), _MAX_LIMIT))
        except ValueError:
            pass

    tool_rounds = _env_int(
        "EVOFLOW_PROACTIVE_MAX_TOOL_ROUNDS",
        _DEFAULT_PROACTIVE_MAX_TOOL_ROUNDS,
        lo=0,
        hi=2000,
    )
    steps_per_tool = _env_int(
        "EVOFLOW_PROACTIVE_RECURSION_STEPS_PER_TOOL",
        _DEFAULT_STEPS_PER_TOOL,
        lo=20,
        hi=120,
    )
    dig_windows = _env_int(
        "EVOFLOW_PROACTIVE_DIG_WINDOWS",
        _DEFAULT_DIG_WINDOWS,
        lo=1,
        hi=5,
    )
    if tool_rounds <= 0:
        from_tools = _DEFAULT_UNLIMITED_TOOL_RECURSION
    else:
        from_tools = tool_rounds * steps_per_tool * dig_windows + _HEADROOM

    mt = max(1, int(max_turns or 10))
    mult = _env_int(
        "EVOFLOW_PROACTIVE_RECURSION_STEPS_PER_TURN",
        _DEFAULT_STEPS_PER_TURN,
        lo=4,
        hi=80,
    )
    from_turns = mt * mult

    computed = max(from_tools, from_turns, _MIN_LIMIT)
    if for_execute:
        # Post-approve execute often still digs; give a little extra headroom.
        computed = int(computed * 1.15)

    env_cap = (os.getenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT_MAX") or "").strip()
    cap = _MAX_LIMIT
    if env_cap:
        try:
            cap = max(_MIN_LIMIT, min(int(env_cap), 12000))
        except ValueError:
            pass

    env_floor = (os.getenv("EVOFLOW_PROACTIVE_RECURSION_LIMIT_MIN") or "").strip()
    floor = _MIN_LIMIT
    if env_floor:
        try:
            floor = max(500, min(int(env_floor), cap))
        except ValueError:
            pass

    return max(floor, min(cap, computed))
