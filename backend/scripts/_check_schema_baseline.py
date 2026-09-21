import os
import sqlite3
import tempfile

from evoflow.persistence.schema import APP_SCHEMA_VERSION, ensure_app_schema

assert APP_SCHEMA_VERSION == 1
p = tempfile.mktemp(suffix=".db")
c = sqlite3.connect(p)
ensure_app_schema(c)
v = c.execute("PRAGMA user_version").fetchone()[0]
n = c.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
print("fresh", v, "tables", n)
assert v == 1 and n >= 100
c.execute("PRAGMA user_version = 142")
c.commit()
ensure_app_schema(c)
assert c.execute("PRAGMA user_version").fetchone()[0] == 1
ensure_app_schema(c)
assert c.execute("PRAGMA user_version").fetchone()[0] == 1
c.close()
os.remove(p)
print("OK")
