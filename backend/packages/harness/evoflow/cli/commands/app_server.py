"""evoflow app-server — JSON-RPC mouthpiece for desktop pipe clients."""

from __future__ import annotations

import argparse


def register(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "app-server",
        help="Run local JSON-RPC app-server (stdio or --listen HOST:PORT)",
    )
    parser.add_argument(
        "--listen",
        metavar="HOST:PORT",
        help="TCP JSONL listen address (desktop-friendly). Default: stdio.",
    )
    parser.add_argument(
        "--gateway-url",
        default="",
        help="Gateway base URL for turn/start proxy (e.g. http://127.0.0.1:8012)",
    )
    parser.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> None:
    from evoflow.app_server.stdio_rpc import main_argv

    argv: list[str] = []
    if getattr(args, "gateway_url", None):
        argv.extend(["--gateway-url", str(args.gateway_url)])
    if getattr(args, "listen", None):
        argv.extend(["--listen", str(args.listen)])
    raise SystemExit(main_argv(argv))
