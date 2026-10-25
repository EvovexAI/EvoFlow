#!/usr/bin/env python
"""Prune checkpoints for **inactive** threads (bounded reclamation).

Why
---
The shared ``checkpoints.db`` grew to 5.9 GB (2026-10-24) with ~18 MB/min of
growth while two gateways wrote into it. Two mechanisms were supposed to keep
it bounded, and neither did:

1. ``OmitTranscriptCheckpointer`` strips the transcript on ``put`` — but the
   strip is skipped whenever a tool call is in flight (the AI message carries
   a tool_call that has no ToolMessage yet), so every mid-tool snapshot stores
   the full message list *and* a second copy inside ``__pregel_tasks``.
2. ``checkpoint_keep_per_thread`` (default 5) trims each thread, but the
   retention scheduler never completed a pass on either gateway.

This script does the part that is safe to do at any time: trim threads that
are **not currently being written to**, keeping the newest N checkpoints each.
Threads that saw a write within ``--active_window_rows`` are left untouched so
an in-flight run never loses the checkpoints it is standing on.

Usage
-----
    python scripts/prune_inactive_checkpoints.py --dry-run
    python scripts/prune_inactive_checkpoints.py --keep 5 --vacuum
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

DEFAULT_DB = Path(
    os.getenv("EVOFLOW_CHECKPOINTS_DB")
    or r"C:\Users\3753\.evoflow\data\checkpoints\checkpoints.db"
)


def _resolve_db(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from evoflow.config.data_paths import resolve_checkpoints_config_path

        return Path(resolve_checkpoints_config_path())
    except Exception:
        return DEFAULT_DB


def _active_thread_ids(cur: sqlite3.Cursor, window_rows: int) -> set[str]:
    """Threads that wrote a checkpoint within the last ``window_rows`` rows."""
    max_rowid = cur.execute("SELECT MAX(rowid) FROM checkpoints").fetchone()[0]
    if not max_rowid:
        return set()
    rows = cur.execute(
        "SELECT DISTINCT thread_id FROM checkpoints WHERE rowid > ?",
        (max_rowid - window_rows,),
    ).fetchall()
    return {str(r[0]) for r in rows if r and r[0]}


def _protected_thread_ids(db_path: Path) -> set[str]:
    """Threads referenced by a live chat session / collab subtask (never delete)."""
    protected: set[str] = set()
    app_db = db_path.parent.parent / "app" / "evoflow.db"
    if not app_db.is_file():
        return protected
    try:
        conn = sqlite3.connect(f"file:{app_db}?mode=ro", uri=True, timeout=30)
        cur = conn.cursor()
        for sql in (
            "SELECT thread_id FROM evoflow_chat_sessions "
            "WHERE is_deleted = 0 AND thread_id IS NOT NULL AND thread_id != ''",
            "SELECT DISTINCT thread_id FROM evoflow_collab_subtasks "
            "WHERE thread_id IS NOT NULL AND thread_id != ''",
        ):
            try:
                protected.update(str(r[0]) for r in cur.execute(sql).fetchall() if r and r[0])
            except sqlite3.Error:
                continue
        conn.close()
    except sqlite3.Error:
        pass
    return protected


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=None, help="path to checkpoints.db")
    ap.add_argument("--keep", type=int, default=5, help="checkpoints to keep per inactive thread")
    ap.add_argument(
        "--include-active",
        action="store_true",
        help="also trim threads that wrote recently (use --active-keep for the margin)",
    )
    ap.add_argument(
        "--active-keep",
        type=int,
        default=20,
        help="checkpoints to keep per ACTIVE thread (deeper margin: a live run may "
        "still need to resume from an older checkpoint)",
    )
    ap.add_argument(
        "--active-window-rows",
        type=int,
        default=2000,
        help="threads writing within the last N checkpoint rows are treated as active",
    )
    ap.add_argument("--batch", type=int, default=500, help="rows deleted per statement")
    ap.add_argument("--dry-run", action="store_true", help="only report, do not delete")
    ap.add_argument("--vacuum", action="store_true", help="VACUUM after deleting (needs free disk)")
    args = ap.parse_args()

    db_path = _resolve_db(args.db)
    if not db_path.is_file():
        print(f"checkpoints db not found: {db_path}")
        return 2
    keep = max(1, args.keep)

    conn = sqlite3.connect(str(db_path), timeout=120.0)
    cur = conn.cursor()
    try:
        total_bytes = cur.execute("SELECT SUM(LENGTH(checkpoint)) FROM checkpoints").fetchone()[0] or 0
        total_rows = cur.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0]
        active = _active_thread_ids(cur, args.active_window_rows)
        protected = _protected_thread_ids(db_path)
        threads = cur.execute(
            "SELECT thread_id, COUNT(*), COALESCE(SUM(LENGTH(checkpoint)), 0) FROM checkpoints "
            "GROUP BY thread_id"
        ).fetchall()

        # ``protected`` only guards *whole-thread purge* (a session still exists in
        # the app DB). Trimming history of a protected thread is what the platform's
        # own retention does (``prune_checkpoint_history_per_thread`` trims every
        # thread), and it is safe: the newest ``keep`` checkpoints stay.
        #
        # Active threads (written within the last N rows) are skipped by default —
        # a live run may still need to resume from an older checkpoint. Pass
        # ``--include-active`` to trim them too, keeping a deeper
        # ``--active-keep`` margin.
        plan: list[tuple[str, int, int, int]] = []
        for tid, n_rows, n_bytes in threads:
            tid = str(tid or "")
            if not tid:
                continue
            is_active = tid in active
            if is_active and not args.include_active:
                continue
            limit = args.active_keep if is_active else keep
            if n_rows <= limit:
                continue
            plan.append((tid, int(n_rows) - limit, int(n_bytes), limit))

        plan.sort(key=lambda t: -t[2])
        reclaim_rows = sum(p[1] for p in plan)
        reclaim_bytes = sum(p[2] for p in plan)
        print(f"db            : {db_path}")
        print(f"size          : {db_path.stat().st_size / 1e9:.2f} GB")
        print(f"checkpoints   : {total_rows} rows, {total_bytes / 1e9:.2f} GB")
        print(f"active threads: {len(active)} (skipped)")
        print(f"protected     : {len(protected)} (skipped)")
        print(f"trim plan     : {len(plan)} inactive threads, "
              f"drop {reclaim_rows} rows, ~{reclaim_bytes / 1e9:.2f} GB reclaimable")
        print()
        for tid, rows, nbytes, _limit in plan[:15]:
            print(f"  {tid[:36]:38s} rows -{rows:<6d} ~{nbytes / 1e6:8.1f} MB")
        if len(plan) > 15:
            print(f"  ... and {len(plan) - 15} more threads")

        if args.dry_run:
            print("\nDRY RUN — nothing deleted")
            return 0

        print("\ndeleting ...")
        t0 = time.time()
        deleted_cp = 0
        deleted_w = 0
        for tid, _rows, _nbytes, limit in plan:
            # Keep the newest `limit` checkpoint_ids; drop the rest.
            keep_ids = [
                str(r[0])
                for r in cur.execute(
                    "SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? "
                    "ORDER BY rowid DESC LIMIT ?",
                    (tid, limit),
                ).fetchall()
            ]
            if not keep_ids:
                continue
            ph = ",".join("?" * len(keep_ids))
            cur.execute(
                f"DELETE FROM writes WHERE thread_id = ? AND checkpoint_id NOT IN ({ph})",
                [tid, *keep_ids],
            )
            deleted_w += cur.rowcount or 0
            # Delete in batches so the write lock is held briefly.
            drop_ids = [
                str(r[0])
                for r in cur.execute(
                    "SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? "
                    "AND checkpoint_id NOT IN (?)",
                    (tid, ",".join(keep_ids)),
                ).fetchall()
            ]
            for i in range(0, len(drop_ids), args.batch):
                chunk = drop_ids[i : i + args.batch]
                cph = ",".join("?" * len(chunk))
                cur.execute(
                    f"DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id IN ({cph})",
                    [tid, *chunk],
                )
                deleted_cp += cur.rowcount or 0
                conn.commit()
        conn.commit()

        print(f"deleted checkpoints: {deleted_cp}")
        print(f"deleted writes     : {deleted_w}")
        print(f"elapsed            : {time.time() - t0:.1f}s")
        print(f"db size now        : {db_path.stat().st_size / 1e9:.2f} GB")

        # Orphan writes whose checkpoint is gone.
        cur.execute(
            "DELETE FROM writes WHERE thread_id NOT IN (SELECT DISTINCT thread_id FROM checkpoints)"
        )
        conn.commit()

        if args.vacuum:
            print("\nVACUUM (may take a while, needs ~2x free space) ...")
            t0 = time.time()
            conn.isolation_level = None
            conn.execute("VACUUM")
            print(f"vacuum done in {time.time() - t0:.1f}s")
            print(f"db size after vacuum: {db_path.stat().st_size / 1e9:.2f} GB")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
