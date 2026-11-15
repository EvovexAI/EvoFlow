"""evoflow logs — diagnostics（对齐 platform diagnostics.*）。

历史子命令名仍是 ``logs``；新增 ``run`` / ``status`` 与 platform
``diagnostics.run`` / ``diagnostics.status`` 对齐。
"""

from __future__ import annotations

import argparse

from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "logs",
        help="System diagnostics (sources / scan / timeline / run / status)",
        description=(
            "Mirrors platform diagnostics.*:\n"
            "  sources → diagnostics.sources\n"
            "  scan → diagnostics.scan\n"
            "  timeline → diagnostics.timeline\n"
            "  run → diagnostics.run\n"
            "  status → diagnostics.status"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="logs_cmd", required=True)

    sources_p = sub.add_parser("sources", help="List known log sources (platform: diagnostics.sources)")
    sources_p.add_argument("--hours", type=int, default=72, help="Lookback window in hours (default 72)")
    add_output_flags(sources_p)
    sources_p.set_defaults(handler=_sources)

    scan_p = sub.add_parser("scan", help="Scan recent ERROR/anomaly lines (platform: diagnostics.scan)")
    scan_p.add_argument("--hours", type=int, default=24, help="Lookback window in hours (default 24)")
    scan_p.add_argument(
        "--source",
        "-s",
        action="append",
        dest="sources",
        help="Source id (repeatable): gateway, langgraph, frontend, startup, …",
    )
    scan_p.add_argument("--limit", type=int, default=200, help="Max events (default 200)")
    add_output_flags(scan_p)
    scan_p.set_defaults(handler=_scan)

    tl_p = sub.add_parser(
        "timeline",
        help="Build shareable anomaly timeline (platform: diagnostics.timeline)",
    )
    tl_p.add_argument("--hours", type=int, default=24, help="Lookback window in hours (default 24)")
    tl_p.add_argument(
        "--source",
        "-s",
        action="append",
        dest="sources",
        help="Source id (repeatable)",
    )
    tl_p.add_argument("--limit", type=int, default=80, help="Max events (default 80)")
    tl_p.add_argument(
        "--format",
        choices=("both", "markdown", "json"),
        default="both",
        help="Output payload shape (default both)",
    )
    add_output_flags(tl_p)
    tl_p.set_defaults(handler=_timeline)

    run_p = sub.add_parser(
        "run",
        help="Composite health report (platform: diagnostics.run)",
    )
    run_p.add_argument(
        "--focus",
        default="",
        help="logs|knowledge|models|employees|automation（或中文别名）",
    )
    add_output_flags(run_p)
    run_p.set_defaults(handler=_run)

    status_p = sub.add_parser(
        "status",
        help="Runtime snapshot (platform: diagnostics.status)",
    )
    add_output_flags(status_p)
    status_p.set_defaults(handler=_status)


def _sources(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import diagnostics_sources

    return diagnostics_sources({"hours": int(args.hours or 72)})


def _scan(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import diagnostics_scan

    return diagnostics_scan(
        {
            "hours": int(args.hours or 24),
            "sources": args.sources,
            "limit": int(args.limit or 200),
        }
    )


def _timeline(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import diagnostics_timeline

    return diagnostics_timeline(
        {
            "hours": int(args.hours or 24),
            "sources": args.sources,
            "limit": int(args.limit or 80),
            "format": args.format,
        }
    )


def _run(args: argparse.Namespace):
    from evoflow.admin.platform_handlers import diagnostics_run

    body: dict = {}
    focus = str(getattr(args, "focus", "") or "").strip()
    if focus:
        body["focus"] = focus
    return diagnostics_run(body)


def _status(_args: argparse.Namespace):
    from evoflow.admin.platform_handlers import diagnostics_status

    return diagnostics_status({})
