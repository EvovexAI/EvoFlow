"""evoflow memory — retired (Asset Hub is the SoT for long-term memory)."""

from __future__ import annotations

import argparse

from evoflow.admin.errors import ValidationError

_RETIRED_MSG = (
    "evoflow memory is retired. Long-term memory lives in Asset Hub "
    "(panel #/assets, dialogue `assets` tool, skill evoflow-assets). "
    "Migrate old SQLite facts: evoflow assets migrate --only memory. "
    "Workspace project memory remains: evoflow workspace memory …"
)


def register(subparsers: argparse._SubParsersAction) -> None:
    memory_parser = subparsers.add_parser(
        "memory",
        help="(retired) use Asset Hub / assets tool — see evoflow-assets",
        description=_RETIRED_MSG,
    )
    memory_sub = memory_parser.add_subparsers(dest="memory_cmd", required=False)
    memory_parser.set_defaults(handler=_cmd_retired)
    for name in ("show", "status", "reload", "clear", "agents"):
        p = memory_sub.add_parser(name, help="(retired)")
        p.set_defaults(handler=_cmd_retired)
    facts = memory_sub.add_parser("facts", help="(retired)")
    facts.set_defaults(handler=_cmd_retired)
    facts_sub = facts.add_subparsers(dest="facts_cmd", required=False)
    delete_p = facts_sub.add_parser("delete", help="(retired)")
    delete_p.set_defaults(handler=_cmd_retired)


def _cmd_retired(_args: argparse.Namespace) -> None:
    raise ValidationError(_RETIRED_MSG)
