"""Tests for frozen/desktop stdio helpers."""

from __future__ import annotations

import logging
import os
import sys

from evoflow.desktop_stdio import (
    _is_colorama_wrapped,
    _stream_is_usable,
    apply_windows_stdio_env,
    prepare_frozen_process_stdio,
)


def test_apply_windows_stdio_env_forces_no_color() -> None:
    apply_windows_stdio_env()
    assert os.environ["NO_COLOR"] == "1"
    assert os.environ["FORCE_COLOR"] == "0"
    assert os.environ["COLORAMA_DISABLE"] == "1"


def test_stream_is_usable_for_devnull() -> None:
    with open(os.devnull, "w", encoding="utf-8") as stream:
        assert _stream_is_usable(stream) is True


def test_prepare_frozen_noop_when_not_frozen(monkeypatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    before_out, before_err = sys.stdout, sys.stderr
    prepare_frozen_process_stdio()
    assert sys.stdout is before_out
    assert sys.stderr is before_err


def test_prepare_frozen_replaces_broken_stdio(monkeypatch) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    apply_windows_stdio_env()
    closed = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115
    closed.close()
    sys.stdout = closed
    sys.stderr = closed
    logging.getLogger().addHandler(logging.StreamHandler(closed))
    prepare_frozen_process_stdio()
    assert _stream_is_usable(sys.stdout)
    assert _stream_is_usable(sys.stderr)
    sys.stdout.write("")
    sys.stderr.write("")


def test_is_colorama_wrapped_detects_ansitowin32() -> None:
    try:
        from colorama.ansitowin32 import AnsiToWin32
    except ImportError:
        return
    wrapped = AnsiToWin32(open(os.devnull, "w", encoding="utf-8"))  # noqa: SIM115
    assert _is_colorama_wrapped(wrapped) is True
