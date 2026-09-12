"""evoflow sessions subcommands — search past chat history."""

from __future__ import annotations

import argparse

from evoflow.admin import sessions as sessions_admin
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("sessions", help="Search past chat sessions (历史会话检索)")
    sub = parser.add_subparsers(dest="sessions_cmd", required=True)

    search_p = sub.add_parser("search", help="Keyword search in past conversations")
    search_p.add_argument("--query", "-q", required=True, help="Search keywords or phrase")
    search_p.add_argument("--titles", action="store_true", help="Also search session titles when no message hits")
    search_p.add_argument("--limit", type=int, default=5, help="Max sessions to return (default 5)")
    search_p.add_argument("--max-age-days", type=int, default=90, help="Look back N days (0 = ~10 years)")
    add_output_flags(search_p)
    search_p.set_defaults(handler=_search)


def _search(args: argparse.Namespace):
    return sessions_admin.search_sessions(
        args.query,
        search_titles=args.titles,
        max_results=args.limit,
        max_age_days=args.max_age_days,
    )
