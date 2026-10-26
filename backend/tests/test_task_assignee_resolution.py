"""Regression: a Task must never be stored with an owner nobody can act on.

The bug
-------
``assert_can_mutate_assigned_task`` compares the ambient actor against the
row's ``assigned_to`` **literally**::

    if who.lower() == owner.lower():
        return          # the owner may mutate its own row

So ``assigned_to='me'`` (or a bare session key like
``automation:90390552:run-<uuid>``) creates a row that **no employee can
progress or close** -- only a privileged actor can.  The automation round
produced exactly one such orphan pending Task per run (2026-10-23 / 10-24 /
10-25 -> three rows with ``assigned_to='me'``), and they recurred every
round because nothing rejected the value at creation time.

The two leaking paths
---------------------
1. ``_infer_duty_create_defaults`` (tool layer): ``assignee="me"`` ->
   ``_resolve_employee_by_code("me")`` returns ``None`` -> the raw value is
   kept and lands in the DB verbatim.
2. the ambient actor itself: an automation run stamps its own session key,
   ``normalize_employee_agent_code("automation:90390552:run-abc")`` returns
   the key **unchanged** (it only strips ``proactive:`` / ``:task:`` /
   ``:duty:`` / ``:chat:``), so the session key becomes the assignee.

The fix
-------
``evoflow.collab.task_assignee.resolve_task_assignee`` is the single source
of truth: human first-person words and employee-less session keys are not
storable owners, and they fall back to the system front desk (``xiaomi``,
a real agent_code) so the row is owned by somebody who can act on it.
The fallback does **not** wake the front desk -- a shell task nobody asked
for should not wake a colleague.

The test
--------
Unit-test the resolver, and pin the tool layer's behaviour on the two
leaking paths.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BACKEND))
sys.path.insert(0, str(_BACKEND / "packages" / "harness"))

from evoflow.collab.task_assignee import (  # noqa: E402
    FALLBACK_ASSIGNEE,
    employee_code_from_session_key,
    is_assignee_usable,
    is_human_assignee_literal,
    resolve_task_assignee,
)


# --- human first-person words -------------------------------------------------

@pytest.mark.parametrize("word", ["me", "user", "human", "manual", "owner", "operator", "self"])
def test_human_words_are_never_storable_owners(word: str) -> None:
    assert is_human_assignee_literal(word)
    assert not is_assignee_usable(word)

    res = resolve_task_assignee(word)
    assert res.code == FALLBACK_ASSIGNEE
    assert res.is_fallback is True
    # The fallback must be a real, mutable agent_code -- otherwise we would
    # have reproduced the very bug we are fixing.
    assert res.code and res.code not in {"me", "user", "human", "owner", "operator"}


def test_human_word_case_insensitive() -> None:
    assert resolve_task_assignee("ME").code == FALLBACK_ASSIGNEE
    assert resolve_task_assignee("  Me  ").code == FALLBACK_ASSIGNEE


def test_no_fallback_keeps_the_row_unassigned() -> None:
    res = resolve_task_assignee("me", allow_fallback=False)
    assert res.code is None
    assert res.is_fallback is False
    assert res.source == "unusable"


# --- session keys -------------------------------------------------------------

def test_proactive_session_key_yields_the_employee() -> None:
    res = resolve_task_assignee("proactive:emp-0b8f4287:duty:round-x")
    assert res.code == "emp-0b8f4287"
    assert res.source == "session_key"
    assert res.is_fallback is False


def test_automation_session_key_keeps_its_own_identity() -> None:
    # normalize_employee_agent_code returns automation keys unchanged, so this
    # value carries no employee code.  It is still a legitimate owner: the run
    # that created the row is the one actor that can also close it (measured
    # 2026-10-25: the run closed its own row 5.8 s after creating it).
    assert employee_code_from_session_key("automation:90390552:run-abc") == ""
    res = resolve_task_assignee("automation:90390552:run-abc")
    assert res.code == "automation:90390552:run-abc"
    assert res.source == "session_key"
    assert res.is_fallback is False
    # ... and it is a usable owner, unlike a human word.
    assert is_assignee_usable("automation:90390552:run-abc")


# --- ordinary values ----------------------------------------------------------

def test_explicit_employee_code_is_kept_verbatim() -> None:
    res = resolve_task_assignee("emp-0b8f4287")
    assert res.code == "emp-0b8f4287"
    assert res.source == "explicit"
    assert res.is_fallback is False


def test_empty_stays_unassigned() -> None:
    res = resolve_task_assignee("")
    assert res.code is None
    assert res.source == "unresolved"
    assert res.is_fallback is False

    res = resolve_task_assignee(None)
    assert res.code is None


# --- the tool layer -----------------------------------------------------------

def test_tool_layer_drops_the_unusable_owner_and_falls_back() -> None:
    """``_infer_duty_create_defaults`` must not hand "me" to create_task."""
    from evoflow.tools.builtins.tasks_tool import _infer_duty_create_defaults

    assignee, _role, _src, _raised, is_fallback = _infer_duty_create_defaults(
        name="自动化壳单",
        assignee="me",
        role_name=None,
        source=None,
        raised_by="user",
        round_id=None,
        runtime=None,
    )
    # "me" must never survive as the owner; the row goes to the system front
    # desk and the caller is told it is a fallback (so it does not get woken).
    assert assignee not in {"me", "user", "human", "owner", "operator", "self"}
    assert assignee == FALLBACK_ASSIGNEE
    assert is_fallback is True


def test_tool_layer_accepts_a_real_employee_code() -> None:
    from evoflow.tools.builtins.tasks_tool import _infer_duty_create_defaults

    assignee, _role, _src, _raised, is_fallback = _infer_duty_create_defaults(
        name="正常派单",
        assignee="emp-0b8f4287",
        role_name=None,
        source=None,
        raised_by="user",
        round_id=None,
        runtime=None,
    )
    assert assignee == "emp-0b8f4287"
    assert is_fallback is False


def test_tool_layer_keeps_a_bare_automation_session_key_as_owner() -> None:
    """An automation run key must not be replaced -- the run owns its rows.

    It is also the only actor that can close them again, so replacing it with
    the front desk would strand the run's own report row.
    """
    from evoflow.tools.builtins.tasks_tool import _infer_duty_create_defaults

    assignee, _role, _src, _raised, is_fallback = _infer_duty_create_defaults(
        name="自动化壳单二",
        assignee="automation:90390552:run-abc",
        role_name=None,
        source=None,
        raised_by="user",
        round_id=None,
        runtime=None,
    )
    assert assignee == "automation:90390552:run-abc"
    assert is_fallback is False


def test_tool_layer_keeps_a_proactive_session_key_employee() -> None:
    """``proactive:<code>:...`` carries a real employee -- keep that code."""
    from evoflow.tools.builtins.tasks_tool import _infer_duty_create_defaults

    assignee, _role, _src, _raised, _fb = _infer_duty_create_defaults(
        name="值班派单",
        assignee="proactive:emp-0b8f4287:duty:round-x",
        role_name=None,
        source=None,
        raised_by="user",
        round_id=None,
        runtime=None,
    )
    assert assignee == "emp-0b8f4287"
