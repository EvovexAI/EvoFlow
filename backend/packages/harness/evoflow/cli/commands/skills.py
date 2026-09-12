"""evoflow skills subcommands."""

from __future__ import annotations

import argparse

from evoflow.admin import skills as skills_admin
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    skills_parser = subparsers.add_parser("skills", help="Manage agent skills")
    skills_sub = skills_parser.add_subparsers(dest="skills_cmd", required=True)

    list_parser = skills_sub.add_parser("list", help="List skills")
    list_parser.add_argument("--enabled-only", action="store_true")
    add_output_flags(list_parser)
    list_parser.set_defaults(handler=_list)

    get_parser = skills_sub.add_parser("get", help="Get one skill")
    get_parser.add_argument("name")
    add_output_flags(get_parser)
    get_parser.set_defaults(handler=_get)

    enable_parser = skills_sub.add_parser("enable", help="Enable a skill")
    enable_parser.add_argument("name")
    add_output_flags(enable_parser)
    enable_parser.set_defaults(handler=_enable)

    disable_parser = skills_sub.add_parser("disable", help="Disable a skill")
    disable_parser.add_argument("name")
    add_output_flags(disable_parser)
    disable_parser.set_defaults(handler=_disable)

    install_parser = skills_sub.add_parser("install", help="Install a skill archive (.skill or .zip)")
    install_parser.add_argument("path")
    add_output_flags(install_parser)
    install_parser.set_defaults(handler=_install)

    market_parser = skills_sub.add_parser("install-market", help="Install skill from SkillHub market slug")
    market_parser.add_argument("slug")
    add_output_flags(market_parser)
    market_parser.set_defaults(handler=_install_market)

    delete_parser = skills_sub.add_parser("delete", help="Delete a custom skill")
    delete_parser.add_argument("name")
    add_output_flags(delete_parser)
    delete_parser.set_defaults(handler=_delete)


def _list(args: argparse.Namespace):
    return skills_admin.list_skills(enabled_only=args.enabled_only)


def _get(args: argparse.Namespace):
    return skills_admin.get_skill(args.name)


def _enable(args: argparse.Namespace):
    return skills_admin.set_skill_enabled(args.name, enabled=True)


def _disable(args: argparse.Namespace):
    return skills_admin.set_skill_enabled(args.name, enabled=False)


def _install(args: argparse.Namespace):
    return skills_admin.install_skill(args.path)


def _install_market(args: argparse.Namespace):
    return skills_admin.install_skill_from_market(args.slug)


def _delete(args: argparse.Namespace):
    return skills_admin.delete_skill(args.name)
