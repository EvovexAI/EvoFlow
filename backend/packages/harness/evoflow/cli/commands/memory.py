"""evoflow memory subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import memory as memory_admin
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    memory_parser = subparsers.add_parser("memory", help="Manage agent memory")
    memory_sub = memory_parser.add_subparsers(dest="memory_cmd", required=True)

    show_parser = memory_sub.add_parser("show", help="Show memory data")
    show_parser.add_argument("--agent", help="Agent scope (default: global)")
    add_output_flags(show_parser)
    show_parser.set_defaults(handler=_show)

    status_parser = memory_sub.add_parser("status", help="Show memory config + data")
    status_parser.add_argument("--agent", help="Agent scope (default: global)")
    add_output_flags(status_parser)
    status_parser.set_defaults(handler=_status)

    reload_parser = memory_sub.add_parser("reload", help="Reload memory from disk")
    reload_parser.add_argument("--agent", help="Agent scope (default: global)")
    add_output_flags(reload_parser)
    reload_parser.set_defaults(handler=_reload)

    clear_parser = memory_sub.add_parser("clear", help="Clear memory data")
    clear_parser.add_argument("--agent", help="Agent scope (default: global)")
    add_output_flags(clear_parser)
    clear_parser.set_defaults(handler=_clear)

    agents_parser = memory_sub.add_parser("agents", help="List memory agent slots")
    add_output_flags(agents_parser)
    agents_parser.set_defaults(handler=_agents)

    facts_parser = memory_sub.add_parser("facts", help="Memory fact operations")
    facts_sub = facts_parser.add_subparsers(dest="facts_cmd", required=True)
    delete_parser = facts_sub.add_parser("delete", help="Delete one memory fact")
    delete_parser.add_argument("fact_id")
    delete_parser.add_argument("--agent", help="Agent scope (default: global)")
    add_output_flags(delete_parser)
    delete_parser.set_defaults(handler=_delete_fact)


def _show(args: argparse.Namespace):
    return memory_admin.get_memory(agent=args.agent)


def _status(args: argparse.Namespace):
    return memory_admin.get_memory_config_status(agent=args.agent)


def _reload(args: argparse.Namespace):
    return memory_admin.reload_memory(agent=args.agent)


def _clear(args: argparse.Namespace):
    return memory_admin.clear_memory(agent=args.agent)


def _agents(args: argparse.Namespace):
    return memory_admin.list_memory_agents()


def _delete_fact(args: argparse.Namespace):
    return memory_admin.delete_fact(args.fact_id, agent=args.agent)
