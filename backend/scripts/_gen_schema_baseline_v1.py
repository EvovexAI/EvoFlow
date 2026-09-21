"""One-shot: rebuild persistence/schema.py as public 1.0.0 baseline (version 1)."""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path

DUMP = Path(r"C:/Users/admin/AppData/Local/Temp/evoflow-baseline-schema.sql")
OUT = Path(__file__).resolve().parents[1] / "packages" / "harness" / "evoflow" / "persistence" / "schema.py"


def _parse_statements(raw: str) -> list[str]:
    stmts: list[str] = []
    buf: list[str] = []
    for line in raw.splitlines():
        buf.append(line)
        if line.rstrip().endswith(";"):
            stmt = "\n".join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
    if "".join(buf).strip():
        stmts.append("\n".join(buf).strip())
    return stmts


def _idempotent(sql: str) -> str:
    sql = re.sub(
        r"(?i)^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)",
        "CREATE TABLE IF NOT EXISTS ",
        sql,
    )
    sql = re.sub(
        r"(?i)^CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ",
        sql,
    )
    sql = re.sub(
        r"(?i)^CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)",
        "CREATE INDEX IF NOT EXISTS ",
        sql,
    )
    return sql


def main() -> int:
    raw = DUMP.read_text(encoding="utf-8")
    stmts = _parse_statements(raw)
    tables: list[str] = []
    indexes: list[str] = []
    other: list[str] = []
    for s in stmts:
        u = s.lstrip().upper()
        # sqlite_sequence is internal; CREATE TABLE on it fails.
        if "CREATE TABLE" in u and "SQLITE_SEQUENCE" in u:
            continue
        if u.startswith("CREATE TABLE"):
            tables.append(s)
        elif u.startswith("CREATE UNIQUE INDEX") or u.startswith("CREATE INDEX"):
            indexes.append(s)
        else:
            other.append(s)

    ordered = [_idempotent(s) for s in tables + indexes + other]
    conn = sqlite3.connect(":memory:")
    for i, stmt in enumerate(ordered):
        try:
            conn.executescript(stmt if stmt.rstrip().endswith(";") else stmt + ";")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {i}: {e}\n{stmt[:400]}", file=sys.stderr)
            return 1
    n = conn.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
    conn.close()
    print(f"validated tables={n} stmts={len(ordered)}")

    ddl = "\n\n".join(ordered)
    if '"""' in ddl:
        print("DDL contains triple-quotes", file=sys.stderr)
        return 1

    parts = [
        '"""DDL for application tables in ``evoflow.db`` (prefix ``evoflow_``).\n',
        "\n",
        "Public 1.0.0 epoch: schema starts at version 1 (single baseline).\n",
        "Historical pre-1.0 ladder (user_version 1..142) is not shipped; existing DBs\n",
        "with legacy user_version > 1 are snapped to 1 when the physical schema is present.\n",
        '"""\n',
        "\n",
        "from __future__ import annotations\n",
        "\n",
        "import logging\n",
        "import sqlite3\n",
        "\n",
        "# Public source-available schema epoch (was 142 before the 1.0.0 squash).\n",
        "APP_SCHEMA_VERSION = 1\n",
        "# Pre-public ladder peak; used only to recognize legacy installs.\n",
        "_LEGACY_SCHEMA_VERSION_MAX = 142\n",
        "\n",
        "logger = logging.getLogger(__name__)\n",
        "\n",
        '_BASELINE_DDL = """\n',
        ddl,
        "\n",
        '"""\n',
        "\n",
        "\n",
        "def _table_exists(conn: sqlite3.Connection, name: str) -> bool:\n",
        "    row = conn.execute(\n",
        "        \"SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1\",\n",
        "        (name,),\n",
        "    ).fetchone()\n",
        "    return row is not None\n",
        "\n",
        "\n",
        "def _apply_baseline(conn: sqlite3.Connection) -> None:\n",
        "    conn.executescript(_BASELINE_DDL)\n",
        '    conn.execute(f"PRAGMA user_version = {APP_SCHEMA_VERSION}")\n',
        "    conn.commit()\n",
        "\n",
        "\n",
        "def _snap_legacy_user_version(conn: sqlite3.Connection, version: int) -> int:\n",
        '    """Map pre-1.0 ladder versions onto the public epoch."""\n',
        "    if version <= APP_SCHEMA_VERSION:\n",
        "        return version\n",
        "    if version > _LEGACY_SCHEMA_VERSION_MAX:\n",
        "        logger.warning(\n",
        '            "Unexpected PRAGMA user_version=%s (above legacy max %s); leaving as-is",\n',
        "            version,\n",
        "            _LEGACY_SCHEMA_VERSION_MAX,\n",
        "        )\n",
        "        return version\n",
        "    markers = (\n",
        '        "evoflow_proactive_initiatives",\n',
        '        "evoflow_chat_messages",\n',
        '        "evoflow_usage_events",\n',
        '        "evoflow_principals",\n',
        "    )\n",
        "    if any(_table_exists(conn, t) for t in markers):\n",
        "        logger.info(\n",
        '            "Snapping legacy PRAGMA user_version %s -> %s (public 1.0.0 schema epoch)",\n',
        "            version,\n",
        "            APP_SCHEMA_VERSION,\n",
        "        )\n",
        '        conn.execute(f"PRAGMA user_version = {APP_SCHEMA_VERSION}")\n',
        "        conn.commit()\n",
        "        return APP_SCHEMA_VERSION\n",
        "    logger.warning(\n",
        '        "Legacy user_version=%s without expected tables; applying baseline idempotently",\n',
        "        version,\n",
        "    )\n",
        "    _apply_baseline(conn)\n",
        "    return APP_SCHEMA_VERSION\n",
        "\n",
        "\n",
        "def ensure_app_schema(conn: sqlite3.Connection) -> None:\n",
        '    """Ensure ``evoflow.db`` matches the public baseline schema."""\n',
        '    version = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)\n',
        "    if version == 0:\n",
        "        _apply_baseline(conn)\n",
        "        return\n",
        "    if version > APP_SCHEMA_VERSION:\n",
        "        _snap_legacy_user_version(conn, version)\n",
        "        _apply_baseline(conn)\n",
        "        return\n",
        "    _apply_baseline(conn)\n",
        "\n",
        "\n",
        "def ensure_chat_messages_thread_index(conn: sqlite3.Connection) -> None:\n",
        '    """Compatibility shim: index is part of baseline DDL."""\n',
        '    if not _table_exists(conn, "evoflow_chat_messages"):\n',
        "        return\n",
        "    conn.execute(\n",
        '        "CREATE INDEX IF NOT EXISTS idx_evo_chat_messages_thread_seq "\n',
        '        "ON evoflow_chat_messages(thread_id, seq)"\n',
        "    )\n",
        "    conn.commit()\n",
        "\n",
        "\n",
        "_ensure_chat_messages_thread_index = ensure_chat_messages_thread_index\n",
    ]
    OUT.write_text("".join(parts), encoding="utf-8")
    print(f"wrote {OUT} bytes={OUT.stat().st_size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
