#!/usr/bin/env python
"""Reconcile LangGraph thread registries across EvoFlow gateways.

Why this exists
---------------
EvoFlow gateways mount LangGraph **in-process** (``langgraph_api`` runs with
``LANGGRAPH_RUNTIME_EDITION=inmem``), so the thread registry lives in each
gateway's own process memory. Two gateways on one machine therefore keep two
disjoint thread spaces, while the durable data — session index
(``evoflow_chat_sessions``), transcript (``evoflow_chat_messages``) and graph
checkpoints (``checkpoints.db``) — is shared through the same SQLite files.

Result: a thread created on gateway A answers ``404`` on gateway B even though
every durable record of it exists. The fix is cheap — LangGraph lets us
register a known thread id with ``POST /api/langgraph/threads`` and
``if_exists="do_nothing"`` — but nobody had a tool to do it in bulk.

What it does
------------
1. Collects every known thread id from the shared stores:
     * ``evoflow_chat_sessions`` (session index)
     * ``evoflow_chat_messages`` (transcript rows)
     * ``checkpoints.db`` (graph checkpoints)
2. Asks each target gateway for the threads it already knows
   (``POST /api/langgraph/threads/search``).
3. Registers the missing ones (``POST /api/langgraph/threads`` with
   ``if_exists="do_nothing"`` — idempotent, never overwrites).
4. Prints a recoverability report so nobody expects content that no longer
   exists: a thread can be *registered* even when its transcript was pruned.

Usage
-----
    python scripts/reconcile_langgraph_threads.py --gateway http://127.0.0.1:8013
    python scripts/reconcile_langgraph_threads.py --gateway http://127.0.0.1:8012 \
        --gateway http://127.0.0.1:8013 --dry-run

Exit codes: 0 = ok (or dry-run), 1 = a gateway was unreachable, 2 = bad usage.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / ".evoflow" / "data"
DEFAULT_GATEWAYS = ("http://127.0.0.1:8012", "http://127.0.0.1:8013")
HTTP_TIMEOUT = 15.0


# ---------------------------------------------------------------------------
# Durable stores
# ---------------------------------------------------------------------------


def _connect_ro(path: Path) -> sqlite3.Connection | None:
    if not path.exists():
        return None
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def collect_known_threads(data_dir: Path) -> dict[str, dict[str, int]]:
    """Return {thread_id: {"sessions": n, "messages": n, "checkpoints": n}}.

    ``checkpoints`` counts rows in the shared checkpointer, which is the best
    available proxy for "how much of this conversation still exists".
    """
    known: dict[str, dict[str, int]] = {}

    def _bump(tid: str, key: str, n: int) -> None:
        if not tid:
            return
        slot = known.setdefault(tid, {"sessions": 0, "messages": 0, "checkpoints": 0})
        slot[key] = slot.get(key, 0) + n

    app_db = _connect_ro(data_dir / "app" / "evoflow.db")
    if app_db is not None:
        try:
            if _table_exists(app_db, "evoflow_chat_sessions"):
                for (tid,) in app_db.execute(
                    "SELECT DISTINCT thread_id FROM evoflow_chat_sessions "
                    "WHERE thread_id IS NOT NULL AND thread_id <> ''"
                ):
                    _bump(tid, "sessions", 1)
            if _table_exists(app_db, "evoflow_chat_messages"):
                for tid, n in app_db.execute(
                    "SELECT thread_id, COUNT(*) FROM evoflow_chat_messages "
                    "WHERE thread_id IS NOT NULL AND thread_id <> '' GROUP BY thread_id"
                ):
                    _bump(tid, "messages", int(n))
        finally:
            app_db.close()

    cp_db = _connect_ro(data_dir / "checkpoints" / "checkpoints.db")
    if cp_db is not None:
        try:
            if _table_exists(cp_db, "checkpoints"):
                for tid, n in cp_db.execute(
                    "SELECT thread_id, COUNT(*) FROM checkpoints "
                    "WHERE thread_id IS NOT NULL AND thread_id <> '' GROUP BY thread_id"
                ):
                    _bump(tid, "checkpoints", int(n))
        finally:
            cp_db.close()

    return known


def classify(slot: dict[str, int]) -> str:
    """Recoverability class of a thread, based on what still exists."""
    if slot.get("messages", 0) > 0:
        return "recoverable"          # transcript rows still present
    if slot.get("checkpoints", 0) > 1:
        return "registerable"         # graph state exists, transcript pruned
    if slot.get("sessions", 0) > 0 or slot.get("checkpoints", 0) > 0:
        return "registerable-empty"   # only the index/1 checkpoint remains
    return "orphan"


# ---------------------------------------------------------------------------
# Gateway HTTP
# ---------------------------------------------------------------------------


def _http_json(
    method: str, url: str, payload: dict | None = None, timeout: float = HTTP_TIMEOUT
):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(body)
            except json.JSONDecodeError:
                return resp.status, body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, body
    except Exception as exc:  # noqa: BLE001 — network errors are reported, not raised
        return None, f"{type(exc).__name__}: {exc}"


def list_gateway_threads(gateway: str) -> tuple[set[str] | None, str]:
    """Return the set of thread ids the gateway already knows."""
    url = f"{gateway.rstrip('/')}/api/langgraph/threads/search"
    status, body = _http_json("POST", url, {"limit": 1000})
    if status != 200 or not isinstance(body, list):
        return None, f"search failed: HTTP {status} {str(body)[:160]}"
    return {str(t.get("thread_id")) for t in body if isinstance(t, dict)}, "ok"


def register_thread(gateway: str, thread_id: str) -> tuple[bool, str]:
    """Idempotently register one thread id on the gateway."""
    url = f"{gateway.rstrip('/')}/api/langgraph/threads"
    status, body = _http_json(
        "POST",
        url,
        {
            "thread_id": thread_id,
            "if_exists": "do_nothing",
            "metadata": {"source": "thread_reconciler"},
        },
    )
    if status == 200:
        return True, "registered"
    if status == 409:  # already exists
        return True, "already_exists"
    return False, f"HTTP {status} {str(body)[:160]}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=os.environ.get("EVOFLOW_DATA_DIR", str(DEFAULT_DATA_DIR)))
    ap.add_argument("--gateway", action="append", dest="gateways", help="repeatable")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", default="", help="write a JSON report to this path")
    args = ap.parse_args(argv)

    gateways = args.gateways or list(DEFAULT_GATEWAYS)
    data_dir = Path(args.data_dir).expanduser()

    known = collect_known_threads(data_dir)
    if not known:
        print(f"[reconcile] no threads found under {data_dir}", file=sys.stderr)
        return 2

    classes: dict[str, int] = {}
    for slot in known.values():
        cls = classify(slot)
        classes[cls] = classes.get(cls, 0) + 1
    print(f"[reconcile] durable threads: {len(known)}  classes: {classes}")
    print(f"[reconcile] data dir: {data_dir}")

    exit_code = 0
    report: dict[str, object] = {"data_dir": str(data_dir), "gateways": {}}

    for gateway in gateways:
        print(f"\n[reconcile] === {gateway} ===")
        existing, note = list_gateway_threads(gateway)
        if existing is None:
            print(f"[reconcile] SKIP gateway unreachable: {note}")
            report["gateways"][gateway] = {"error": note}
            exit_code = 1
            continue

        missing = sorted(tid for tid in known if tid not in existing)
        print(f"[reconcile] known={len(known)} already={len(existing)} missing={len(missing)}")

        done = 0
        failures: list[dict[str, str]] = []
        for tid in missing:
            if args.dry_run:
                continue
            ok, msg = register_thread(gateway, tid)
            if ok:
                done += 1
            else:
                failures.append({"thread_id": tid, "error": msg})
            if (done + len(failures)) % 25 == 0 and (done + len(failures)) > 0:
                print(f"[reconcile]   progress {done + len(failures)}/{len(missing)}")

        if args.dry_run:
            print(f"[reconcile] DRY-RUN: would register {len(missing)} threads")
        else:
            print(f"[reconcile] registered={done} failed={len(failures)}")
            for f in failures[:10]:
                print(f"[reconcile]   FAIL {f['thread_id'][:8]} {f['error']}")

        report["gateways"][gateway] = {
            "already_known": len(existing),
            "missing": len(missing),
            "registered": done,
            "failures": failures,
            "missing_sample": missing[:50],
        }

    if args.report:
        report["classes"] = classes
        report["total_threads"] = len(known)
        Path(args.report).expanduser().write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n[reconcile] report written: {args.report}")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
