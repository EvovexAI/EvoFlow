"""Diagnostic: why is file_deps so sparse? Test _resolve_py_module directly."""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent.parent))

root = "D:\\example\\EvoFlow"
root_path = Path(root).resolve()

from evoflow.code_index.deps import _resolve_py_module, extract_file_deps  # noqa: E402
from evoflow.code_index.store import _connect, _ensure_schema  # noqa: E402

# Connect to real DB
h = hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
conn = _connect(root)
_ensure_schema(conn)

# ── 1. Check file_deps density ──
print("="*60)
print("1. file_deps density")
print("="*60)
total_files = conn.execute("SELECT COUNT(*) FROM fts_content").fetchone()[0]
total_deps = conn.execute("SELECT COUNT(*) FROM file_deps").fetchone()[0]
files_with_deps = conn.execute("SELECT COUNT(DISTINCT from_path) FROM file_deps").fetchone()[0]
print(f"  Total files: {total_files}")
print(f"  Total deps: {total_deps}")
print(f"  Files with deps: {files_with_deps}")
print(f"  Files WITHOUT deps: {total_files - files_with_deps}")
print(f"  Dep density: {total_deps/max(total_files,1):.2f} deps/file")

# ── 2. Check a specific file's deps in DB ──
print("\n" + "="*60)
print("2. file_deps for trace_call_chain.py in DB")
print("="*60)
tc_path = "backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py"
rows = conn.execute("SELECT from_path, spec, to_path, line FROM file_deps WHERE from_path = ?", (tc_path,)).fetchall()
print(f"  Rows: {len(rows)}")
for r in rows:
    print(f"    spec={r[1]}, to_path={r[2]}, line={r[3]}")

# ── 3. Test _resolve_py_module directly ──
print("\n" + "="*60)
print("3. Test _resolve_py_module for known imports")
print("="*60)
from_rel = tc_path
test_cases = [
    ("evoflow.code_index.store", "evoflow.code_index.store"),
    ("evoflow.tools.host_direct.workspace_path_guard", "evoflow.tools.host_direct.workspace_path_guard"),
    ("evoflow.tools.host_direct.trace_call_chain", "evoflow.tools.host_direct.trace_call_chain"),
    ("langchain.tools", "langchain.tools"),
    ("json", "json"),
]
for module, desc in test_cases:
    result = _resolve_py_module(root_path, from_rel, module)
    print(f"  {desc:60s} → {result}")

# ── 4. Test extract_file_deps directly ──
print("\n" + "="*60)
print("4. extract_file_deps for trace_call_chain.py")
print("="*60)
abs_path = root_path / tc_path
text = abs_path.read_text(encoding="utf-8", errors="replace")
deps = extract_file_deps(abs_path, text, root_path)
print(f"  Deps found: {len(deps)}")
for d in deps:
    print(f"    spec={d['spec']}, to_path={d['to_path']}, line={d['line']}")

# ── 5. Check where evoflow package actually lives ──
print("\n" + "="*60)
print("5. Where does 'evoflow' package live?")
print("="*60)
for candidate in [
    root_path / "evoflow",
    root_path / "backend" / "packages" / "harness" / "evoflow",
    root_path / "backend" / "evoflow",
]:
    exists = candidate.is_dir()
    has_init = (candidate / "__init__.py").exists() if exists else False
    print(f"  {candidate.relative_to(root_path)}: dir={exists}, __init__.py={has_init}")

# ── 6. What does _resolve_py_module try? ──
print("\n" + "="*60)
print("6. What paths does _resolve_py_module try for 'evoflow.code_index.store'?")
print("="*60)
from_dir = (root_path / from_rel).parent
parts = ["evoflow", "code_index", "store"]
candidates = [
    from_dir.joinpath(*parts).with_suffix(".py"),
    from_dir.joinpath(*parts) / "__init__.py",
    root_path.joinpath(*parts).with_suffix(".py"),
    root_path.joinpath(*parts) / "__init__.py",
]
for c in candidates:
    try:
        rel = c.relative_to(root_path)
    except ValueError:
        rel = c
    print(f"  {rel} → exists={c.is_file()}")

# ── 7. Check a few more files ──
print("\n" + "="*60)
print("7. file_deps for other known files")
print("="*60)
test_files = [
    "backend/packages/harness/evoflow/persistence/session_repositories.py",
    "backend/packages/harness/evoflow/agents/lead_agent/intent_tool_profile.py",
    "backend/packages/harness/evoflow/code_index/store.py",
]
for f in test_files:
    rows = conn.execute("SELECT to_path, spec FROM file_deps WHERE from_path = ?", (f,)).fetchall()
    print(f"  {f}: {len(rows)} deps")
    for r in rows[:3]:
        print(f"    → {r[0]} ({r[1][:50]}...)")

# ── 8. What % of .py files have deps? ──
print("\n" + "="*60)
print("8. Python file deps coverage")
print("="*60)
py_files = conn.execute("SELECT COUNT(*) FROM fts_content WHERE path LIKE '%.py'").fetchone()[0]
py_files_with_deps = conn.execute(
    "SELECT COUNT(DISTINCT from_path) FROM file_deps WHERE from_path LIKE '%.py'"
).fetchone()[0]
print(f"  .py files: {py_files}")
print(f"  .py files with deps: {py_files_with_deps}")
print(f"  Coverage: {py_files_with_deps/max(py_files,1)*100:.1f}%")

conn.close()
print("\n" + "="*60)
print("DIAGNOSTIC COMPLETE")
print("="*60)
