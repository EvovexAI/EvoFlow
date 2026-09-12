"""evoflow workspace subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import workspace_memory as ws_mem_admin
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    workspace_parser = subparsers.add_parser("workspace", help="Workspace-scoped project memory")
    workspace_sub = workspace_parser.add_subparsers(dest="workspace_cmd", required=True)

    memory_parser = workspace_sub.add_parser("memory", help="Workspace memory operations")
    memory_sub = memory_parser.add_subparsers(dest="memory_cmd", required=True)

    show_parser = memory_sub.add_parser("show", help="Show workspace memory")
    show_parser.add_argument("path", help="Workspace root directory")
    add_output_flags(show_parser)
    show_parser.set_defaults(handler=_show)

    status_parser = memory_sub.add_parser("status", help="Show workspace memory config + data")
    status_parser.add_argument("path", help="Workspace root directory")
    add_output_flags(status_parser)
    status_parser.set_defaults(handler=_status)

    clear_parser = memory_sub.add_parser("clear", help="Clear workspace memory")
    clear_parser.add_argument("path", help="Workspace root directory")
    add_output_flags(clear_parser)
    clear_parser.set_defaults(handler=_clear)

    bootstrap_parser = memory_sub.add_parser(
        "bootstrap",
        help="Bootstrap workspace memory from README, manifests, and directory tree",
    )
    bootstrap_parser.add_argument("path", help="Workspace root directory")
    bootstrap_parser.add_argument("--model", dest="model_name", help="LLM model name from config")
    bootstrap_parser.add_argument("--force", action="store_true", help="Rebuild even if memory exists")
    add_output_flags(bootstrap_parser)
    bootstrap_parser.set_defaults(handler=_bootstrap)

    prune_parser = memory_sub.add_parser(
        "prune",
        help="Remove ephemeral / low-quality workspace assets",
    )
    prune_parser.add_argument("path", help="Workspace root directory")
    prune_parser.add_argument("--dry-run", action="store_true", help="Report only; do not delete")
    add_output_flags(prune_parser)
    prune_parser.set_defaults(handler=_prune)

    seed_parser = memory_sub.add_parser(
        "seed",
        help="Write curated project knowledge (no LLM) for known layouts",
    )
    seed_parser.add_argument("path", help="Workspace root directory")
    seed_parser.add_argument("--force", action="store_true", help="Replace existing workspace memory")
    add_output_flags(seed_parser)
    seed_parser.set_defaults(handler=_seed)


def _show(args: argparse.Namespace):
    return ws_mem_admin.get_workspace_memory(args.path)


def _status(args: argparse.Namespace):
    return ws_mem_admin.get_workspace_memory_status(args.path)


def _clear(args: argparse.Namespace):
    return ws_mem_admin.clear_workspace_memory_admin(args.path)


def _bootstrap(args: argparse.Namespace):
    return ws_mem_admin.bootstrap_workspace_memory_admin(
        args.path,
        model_name=args.model_name,
        force=bool(args.force),
    )


def _prune(args: argparse.Namespace):
    return ws_mem_admin.prune_workspace_memory_admin(args.path, dry_run=bool(args.dry_run))


def _seed(args: argparse.Namespace):
    return ws_mem_admin.seed_workspace_memory_admin(args.path, force=bool(args.force))
