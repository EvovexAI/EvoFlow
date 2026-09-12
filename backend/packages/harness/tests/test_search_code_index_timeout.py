"""search_code_index wall-clock timeout and read_limit cap."""

from __future__ import annotations

import time
from unittest.mock import patch

from evoflow.tools.host_direct.search_code_index import (
    _MAX_READ_LIMIT,
    _MAX_WALL_SECONDS,
    _SEARCH_POOL,
    _cap_read_limit,
    _search_code_index_wallclock,
)


def test_cap_read_limit() -> None:
    capped, note = _cap_read_limit(20, 0)
    assert capped == _MAX_READ_LIMIT
    assert "read_limit capped" in note

    unchanged, empty = _cap_read_limit(3, 0)
    assert unchanged == 3
    assert empty == ""


def test_wall_clock_timeout_message() -> None:
    from concurrent.futures import TimeoutError as FuturesTimeoutError

    with patch.object(_SEARCH_POOL, "submit") as submit:
        fut = submit.return_value
        fut.result.side_effect = FuturesTimeoutError()
        out = _search_code_index_wallclock(
            root=".",
            thread_id=None,
            query="foo",
            queries=None,
            read_offset=0,
            read_limit=0,
            limit=15,
        )
    assert "timed out" in out.lower()
    assert str(int(_MAX_WALL_SECONDS)) in out


def test_wall_clock_returns_before_slow_worker_finishes() -> None:
    def slow_lookup(**kwargs):  # noqa: ARG001
        time.sleep(10)
        return None, {"hits": [], "label": "foo"}

    with (
        patch(
            "evoflow.tools.host_direct.search_code_index._run_search_index_lookup",
            side_effect=slow_lookup,
        ),
        patch("evoflow.tools.host_direct.search_code_index._MAX_WALL_SECONDS", 2.0),
    ):
        t0 = time.time()
        out = _search_code_index_wallclock(
            root=".",
            thread_id=None,
            query="foo",
            queries=None,
            read_offset=0,
            read_limit=0,
            limit=15,
        )
        elapsed = time.time() - t0
    assert "timed out" in out.lower()
    assert elapsed < 4.0


def test_wall_clock_passes_capped_read_limit() -> None:
    with patch(
        "evoflow.tools.host_direct.search_code_index._run_search_index_lookup",
        return_value=(None, {"hits": [{"path": "a.py", "snippet": "x"}], "label": "foo"}),
    ):
        capped, note = _cap_read_limit(20, 0)
        with patch(
            "evoflow.tools.host_direct.search_code_index._follow_read_with_timeout",
            return_value="",
        ) as follow:
            out = _search_code_index_wallclock(
                root=".",
                thread_id=None,
                query="foo",
                queries=None,
                read_offset=0,
                read_limit=capped,
                limit=15,
            ) + note
    assert "read_limit capped" in out
    follow.assert_called_once()
    assert follow.call_args.kwargs["read_limit"] == _MAX_READ_LIMIT


def test_wall_clock_appends_catalog_when_read_limit_zero() -> None:
    with patch(
        "evoflow.tools.host_direct.search_code_index._run_search_index_lookup",
        return_value=(None, {"hits": [{"path": "a.py", "snippet": "x"}], "label": "foo"}),
    ):
        with patch(
            "evoflow.tools.host_direct.search_code_index._follow_read_with_timeout",
            return_value="\n\nRead catalog",
        ) as follow:
            out = _search_code_index_wallclock(
                root=".",
                thread_id=None,
                query="foo",
                queries=None,
                read_offset=0,
                read_limit=0,
                limit=15,
            )
    follow.assert_called_once()
    assert "Read catalog" in out
