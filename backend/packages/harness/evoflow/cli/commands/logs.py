"""evoflow logs — known log sources, anomaly scan, shareable timeline."""

from __future__ import annotations

import argparse

from evoflow.admin import diagnostics as diag
from evoflow.cli.common import add_output_flags


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "logs",
        help="System log diagnostics (已知日志源 / 异常扫描 / 时间线)",
    )
    sub = parser.add_subparsers(dest="logs_cmd", required=True)

    sources_p = sub.add_parser("sources", help="List known log sources and which have recent errors")
    sources_p.add_argument("--hours", type=int, default=72, help="Lookback window in hours (default 72)")
    add_output_flags(sources_p)
    sources_p.set_defaults(handler=_sources)

    scan_p = sub.add_parser("scan", help="Scan recent ERROR/anomaly lines")
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

    tl_p = sub.add_parser("timeline", help="Build shareable anomaly timeline (markdown + events)")
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


def _sources(args: argparse.Namespace):
    return diag.list_sources(hours=args.hours)


def _scan(args: argparse.Namespace):
    return diag.scan_errors(
        hours=args.hours,
        sources=args.sources,
        max_events=args.limit,
    )


def _timeline(args: argparse.Namespace):
    return diag.anomaly_timeline(
        hours=args.hours,
        sources=args.sources,
        max_events=args.limit,
        format=args.format,
    )
