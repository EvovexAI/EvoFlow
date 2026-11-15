"""evoflow sessions subcommands — search past chat history."""

from __future__ import annotations

import argparse

from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "sessions",
        help="Search / status / compact chat sessions (历史会话)",
    )
    sub = parser.add_subparsers(dest="sessions_cmd", required=True)

    search_p = sub.add_parser("search", help="Keyword search in past conversations")
    search_p.add_argument("--query", "-q", required=True, help="Search keywords or phrase")
    search_p.add_argument("--titles", action="store_true", help="Also search session titles when no message hits")
    search_p.add_argument("--limit", type=int, default=5, help="Max sessions to return (default 5)")
    search_p.add_argument("--max-age-days", type=int, default=90, help="Look back N days (0 = ~10 years)")
    add_output_flags(search_p)
    search_p.set_defaults(handler=_search)

    status_p = sub.add_parser(
        "status",
        help="Session / context status (platform: sessions.status)",
    )
    status_p.add_argument("--session-key", default="", help="Session key")
    status_p.add_argument("--thread-id", default="", help="Thread id")
    add_output_flags(status_p)
    status_p.set_defaults(handler=_status)

    compact_p = sub.add_parser(
        "compact",
        help="Compact session context (platform: sessions.compact)",
    )
    compact_p.add_argument("--session-key", default="", help="Session key")
    compact_p.add_argument("--thread-id", default="", help="Thread id")
    add_output_flags(compact_p)
    compact_p.set_defaults(handler=_compact)


def _search(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import sessions_search

    return sessions_search(
        {
            "query": args.query,
            "search_titles": bool(args.titles),
            "limit": int(args.limit or 5),
            "max_age_days": int(args.max_age_days or 90),
        }
    )


def _status(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import sessions_status

    return sessions_status(
        {
            "session_key": str(getattr(args, "session_key", "") or "").strip() or None,
            "thread_id": str(getattr(args, "thread_id", "") or "").strip() or None,
        }
    )


def _compact(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import sessions_compact

    return sessions_compact(
        {
            "session_key": str(getattr(args, "session_key", "") or "").strip() or None,
            "thread_id": str(getattr(args, "thread_id", "") or "").strip() or None,
        }
    )
