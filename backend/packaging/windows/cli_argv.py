"""Pure helpers for gateway ``--mode cli`` argv handling (no side effects)."""

from __future__ import annotations


def is_cli_mode(argv: list[str]) -> bool:
    """True when argv selects ``--mode cli`` / ``--mode=cli``."""
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--mode" and i + 1 < len(argv):
            return argv[i + 1] == "cli"
        if arg.startswith("--mode="):
            return arg.split("=", 1)[1] == "cli"
        i += 1
    return False


def cli_argv_without_mode(argv: list[str]) -> list[str]:
    """Strip ``--mode cli`` / ``--mode=cli`` so evoflow.cli sees only subcommands."""
    out: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--mode" and i + 1 < len(argv) and argv[i + 1] == "cli":
            i += 2
            continue
        if arg == "--mode=cli":
            i += 1
            continue
        out.append(arg)
        i += 1
    return out
