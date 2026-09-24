"""One-shot migration: rename legacy webui principal_id to sanitized username.

Old:   principal_id = 'webui:1'  (uid-based)
New:   principal_id = 'admin'    (sanitized username, no provider prefix)

This rewrites every column referencing ``principal_id`` across the
application DB.  Filesystem: ``~/.evoflow/assets/users/webui_1/`` is moved
to ``~/.evoflow/assets/users/admin/`` when present.

Re-runnable: if old principal_id no longer exists, no DB writes happen.

Usage:
    python backend/scripts/migrations/rename_webui_principal.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "backend"))

DEFAULT_DB = Path(os.environ.get("EVOFLOW_HOME", str(Path.home() / ".evoflow"))) / "data" / "app" / "evoflow.db"
DEFAULT_HOME = Path(os.environ.get("EVOFLOW_HOME", str(Path.home() / ".evoflow")))


def _candidate_db_paths() -> list[Path]:
    """Return all candidate DB paths so legacy fallback dirs are covered too."""
    home = DEFAULT_HOME
    return [
        home / "data" / "app" / "evoflow.db",
        home / "data" / "evoflow.db",
        home / "evoflow.db",
    ]


def find_target_rows(conn: sqlite3.Connection) -> dict[str, list[str]]:
    """Return per-table list of 'webui:1' rows for visibility (count + sample)."""
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()]
    hits: dict[str, list[str]] = {}
    for t in tables:
        try:
            info = conn.execute(f"PRAGMA table_info({t})").fetchall()
        except sqlite3.Error:
            continue
        cols = [c[1] for c in info]
        if "principal_id" not in cols:
            continue
        rows = conn.execute(
            f"SELECT principal_id FROM {t} WHERE principal_id = ?",
            ("webui:1",),
        ).fetchall()
        if rows:
            hits[t] = [r[0] for r in rows]
    return hits


def migrate_db(conn: sqlite3.Connection, dry_run: bool) -> dict[str, int]:
    """Rewrite principal_id 'webui:1' -> 'admin' in every affected table."""
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()]
    updates: dict[str, int] = {}
    for t in tables:
        try:
            info = conn.execute(f"PRAGMA table_info({t})").fetchall()
        except sqlite3.Error:
            continue
        cols = [c[1] for c in info]
        if "principal_id" not in cols:
            continue
        # Skip views/virtual tables
        kind = conn.execute(
            "SELECT type FROM sqlite_master WHERE name = ?", (t,)
        ).fetchone()
        if kind and kind[0] != "table":
            continue
        n = conn.execute(
            f"SELECT COUNT(*) FROM {t} WHERE principal_id = ?", ("webui:1",)
        ).fetchone()[0]
        if not n:
            continue
        if not dry_run:
            conn.execute(
                f"UPDATE {t} SET principal_id = ? WHERE principal_id = ?",
                ("admin", "webui:1"),
            )
        updates[t] = n
    return updates


def migrate_fs(home: Path, dry_run: bool) -> list[str]:
    """Rename ``assets/users/webui_1/`` -> ``assets/users/admin/`` if present."""
    moves: list[str] = []
    src = home / "assets" / "users" / "webui_1"
    dst = home / "assets" / "users" / "admin"
    if src.exists() and not dst.exists():
        if not dry_run:
            shutil.move(str(src), str(dst))
        moves.append(f"{src} -> {dst}")
    return moves


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    db_paths = _candidate_db_paths()
    db_used = next((d for d in db_paths if d.exists()), None)
    if not db_used:
        print(f"[skip] no app DB found under candidates: {db_paths}")
    else:
        print(f"DB: {db_used}")
        conn = sqlite3.connect(str(db_used))
        try:
            hits = find_target_rows(conn)
            print("Pre-migration rows with principal_id='webui:1':")
            for t, rs in hits.items():
                print(f"  {t}: {len(rs)}")
            if not hits:
                print("  (none — nothing to migrate)")
            else:
                updates = migrate_db(conn, args.dry_run)
                print(f"\n{'[dry-run] ' if args.dry_run else ''}DB updates:")
                for t, n in updates.items():
                    print(f"  {t}: {n} rows -> principal_id='admin'")
                if not args.dry_run:
                    conn.commit()
                    print("Committed.")
        finally:
            conn.close()

    moves = migrate_fs(DEFAULT_HOME, args.dry_run)
    if moves:
        print(f"\n{'[dry-run] ' if args.dry_run else ''}FS moves:")
        for m in moves:
            print(f"  {m}")
    else:
        print("\nNo FS moves needed (already migrated or no legacy dir).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
