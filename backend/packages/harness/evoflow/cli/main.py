"""EvoFlow CLI — manage models, skills, agents, MCP, memory, experience, and more."""

from __future__ import annotations

import argparse
import sys

from evoflow.cli.commands import (
    agents,
    app_server,
    approvals,
    assets,
    automation,
    employees,
    eval_cmd,
    experience,
    items,
    knowledge,
    logs,
    mcp,
    memory,
    models,
    org,
    sessions,
    skills,
    tasks,
    workflow,
    workspace,
)
from evoflow.cli.common import run_handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="evoflow",
        description=(
            "EvoFlow admin CLI — models, skills, agents, employees, workflow, items, "
            "knowledge, experience, automation, memory, eval, …"
        ),
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="Path to config.yaml (sets EVOFLOW_CONFIG_PATH for this process)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    app_server.register(subparsers)
    models.register(subparsers)
    skills.register(subparsers)
    agents.register(subparsers)
    employees.register(subparsers)
    org.register(subparsers)
    approvals.register(subparsers)
    mcp.register(subparsers)
    memory.register(subparsers)
    assets.register(subparsers)
    experience.register(subparsers)
    knowledge.register(subparsers)
    automation.register(subparsers)
    sessions.register(subparsers)
    tasks.register(subparsers)
    workflow.register(subparsers)
    items.register(subparsers)
    workspace.register(subparsers)
    eval_cmd.register(subparsers)
    logs.register(subparsers)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.config:
        import os

        os.environ["EVOFLOW_CONFIG_PATH"] = args.config
        from evoflow.config.app_config import reload_app_config

        reload_app_config(args.config)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help()
        return 2
    return run_handler(handler, args)


if __name__ == "__main__":
    sys.exit(main())
