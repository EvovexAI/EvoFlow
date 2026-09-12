"""Shared argparse helpers for EvoFlow CLI."""

from __future__ import annotations

import argparse
from collections.abc import Callable
from typing import Any

from evoflow.admin.errors import AdminError
from evoflow.admin.io import emit_error, emit_json, read_json_file, read_json_stdin


def add_json_input_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--file", "-f", metavar="PATH", help="Read JSON payload from file")
    group.add_argument("--stdin", action="store_true", help="Read JSON payload from stdin")


def load_json_payload(args: argparse.Namespace) -> Any:
    if getattr(args, "stdin", False):
        return read_json_stdin()
    if getattr(args, "file", None):
        return read_json_file(args.file)
    return None


def add_output_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--compact", action="store_true", help="Emit compact JSON")


def run_handler(handler: Callable[..., Any], args: argparse.Namespace) -> int:
    try:
        result = handler(args)
        if result is not None:
            emit_json(result, pretty=not getattr(args, "compact", False))
        return 0
    except AdminError as e:
        emit_error(e.message, exit_code=e.exit_code)
        return e.exit_code  # unreachable
    except SystemExit:
        raise
    except Exception as e:
        emit_error(str(e))
        return 1  # unreachable
