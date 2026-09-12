"""evoflow eval — run business scenario / observational evaluation."""

from __future__ import annotations

import argparse
import time


def register(subparsers: argparse._SubParsersAction) -> None:
    from evoflow.cli.common import add_output_flags

    parser = subparsers.add_parser(
        "eval",
        help="Run Eval Center scenarios / observational checks",
        description=(
            "Business regression + observational health checks.\n"
            "  evoflow eval run --mode smoke     # 11 scenarios + security smoke\n"
            "  evoflow eval run --mode scenario  # scenarios only\n"
            "  evoflow eval run --mode full      # scenarios + observational\n"
            "  evoflow eval cases\n"
            "  evoflow eval runs\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="eval_cmd", required=True)

    run_p = sub.add_parser("run", help="Start an evaluation run (sync by default in CLI)")
    run_p.add_argument(
        "--mode",
        default="smoke",
        choices=["smoke", "full", "scenario", "observational", "security", "performance", "business"],
        help="Eval mode (default: smoke)",
    )
    run_p.add_argument("--name", default="", help="Run display name")
    run_p.add_argument("--days", type=int, default=7, help="Observational lookback days")
    run_p.add_argument(
        "--async",
        dest="async_mode",
        action="store_true",
        help="Return immediately and poll progress",
    )
    add_output_flags(run_p)
    run_p.set_defaults(handler=_run)

    cases_p = sub.add_parser("cases", help="List eval cases")
    cases_p.add_argument("--category", default="", help="Filter: scenario|business|security|performance")
    add_output_flags(cases_p)
    cases_p.set_defaults(handler=_cases)

    runs_p = sub.add_parser("runs", help="List recent eval runs")
    runs_p.add_argument("--limit", type=int, default=20)
    add_output_flags(runs_p)
    runs_p.set_defaults(handler=_runs)

    show_p = sub.add_parser("show", help="Show one run detail")
    show_p.add_argument("run_id")
    add_output_flags(show_p)
    show_p.set_defaults(handler=_show)


def _run(args: argparse.Namespace):
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()  # ensure migrations
    mode = str(args.mode or "smoke")
    name = str(args.name or "").strip() or f"CLI {mode} {time.strftime('%Y-%m-%d %H:%M')}"
    result = engine.run_eval(
        name=name,
        type=mode,
        config={"mode": mode, "days": int(args.days or 7)},
        async_mode=bool(args.async_mode),
    )
    if result.get("async") and result.get("run_id"):
        run_id = result["run_id"]
        for _ in range(600):
            prog = engine.get_eval_progress(run_id)
            if prog.get("status") not in ("running", "queued"):
                break
            time.sleep(0.5)
        return engine.get_eval_run(run_id)
    return result


def _cases(args: argparse.Namespace):
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    cat = str(args.category or "").strip() or None
    return engine.list_eval_cases(category=cat)


def _runs(args: argparse.Namespace):
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    return engine.list_eval_runs(limit=int(args.limit or 20))


def _show(args: argparse.Namespace):
    from evoflow.eval import eval_engine as engine
    from evoflow.persistence.db import get_db

    get_db()
    return engine.get_eval_run(str(args.run_id))
