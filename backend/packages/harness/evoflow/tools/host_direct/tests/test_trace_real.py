"""Real-world test: call trace_call_chain against the actual workspace index."""
import hashlib
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent.parent))

# The workspace root is D:\example\EvoFlow (NOT backend/)
root = "D:\\example\\EvoFlow"
print(f"Workspace root: {root}")

from evoflow.code_index.store import _connect, _ensure_schema  # noqa: E402
from evoflow.tools.host_direct.trace_call_chain import (  # noqa: E402
    _bfs_trace,
    _find_seed_paths,
    _index_stats,
    trace_call_chain_hd,
)

h = hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
data_dir = os.environ.get("EVOFLOW_DATA_DIR", os.path.join(os.path.expanduser("~"), ".evoflow"))
dbp = os.path.join(data_dir, "code_index", f"{h}.db")
print(f"DB hash: {h}")
print(f"DB path: {dbp}")
print(f"DB exists: {os.path.exists(dbp)}")

if not os.path.exists(dbp):
    print("ERROR: Index DB not found. Trying alternate roots...")
    for alt_root in ["D:\\example\\EvoFlow\\backend", "C:\\Users\\example\\EvoFlow"]:
        alt_h = hashlib.sha256(alt_root.encode("utf-8")).hexdigest()[:16]
        alt_dbp = os.path.join(data_dir, "code_index", f"{alt_h}.db")
        print(f"  Trying {alt_root} -> {alt_dbp} exists={os.path.exists(alt_dbp)}")
        if os.path.exists(alt_dbp):
            root = alt_root
            dbp = alt_dbp
            h = alt_h
            print(f"  FOUND: using {root}")
            break
    else:
        print("No index DB found for any root. Listing all DBs:")
        code_index_dir = os.path.join(data_dir, "code_index")
        if os.path.isdir(code_index_dir):
            for f in os.listdir(code_index_dir):
                print(f"  {f} ({os.path.getsize(os.path.join(code_index_dir, f))} bytes)")
        sys.exit(1)

conn = _connect(root)
_ensure_schema(conn)

# ── Test 1: Index stats ──
print("\n" + "="*60)
print("TEST 1: Index stats")
print("="*60)
stats = _index_stats(conn)
print(f"  files={stats['files']}, symbols={stats['symbols']}, deps={stats['deps']}, refs={stats['refs']}")

# ── Test 2: Find seeds for known symbol ──
print("\n" + "="*60)
print("TEST 2: Find seeds for 'trace_call_chain_hd'")
print("="*60)
seeds = _find_seed_paths(conn, "trace_call_chain_hd", "")
print(f"  Seeds found: {len(seeds)}")
for s in seeds:
    print(f"    path={s['path']}, name={s['name']}, kind={s['kind']}, line={s['line']}")

# ── Test 3: BFS callers of trace_call_chain_hd ──
print("\n" + "="*60)
print("TEST 3: BFS callers of trace_call_chain_hd (depth=3)")
print("="*60)
if seeds:
    result = _bfs_trace(conn, seeds, direction="callers", max_depth=3)
    print(f"  ok={result['ok']}, total_nodes={result['total_nodes']}, truncated={result['truncated']}")
    for layer in result["layers"]:
        print(f"  Layer {layer['depth']}: {len(layer['nodes'])} nodes")
        for node in layer["nodes"]:
            print(f"    {node['path']} (from={node['from']}, via={node['via']})")
else:
    print("  No seeds found, skipping BFS")

# ── Test 4: BFS callees of trace_call_chain.py ──
print("\n" + "="*60)
print("TEST 4: BFS callees of trace_call_chain.py (depth=2)")
print("="*60)
seeds_path = _find_seed_paths(conn, "", "backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py")
print(f"  Seeds by path: {len(seeds_path)}")
for s in seeds_path:
    print(f"    path={s['path']}, name={s['name']}")
if seeds_path:
    result = _bfs_trace(conn, seeds_path, direction="callees", max_depth=2)
    print(f"  ok={result['ok']}, total_nodes={result['total_nodes']}, truncated={result['truncated']}")
    for layer in result["layers"]:
        print(f"  Layer {layer['depth']}: {len(layer['nodes'])} nodes")
        for node in layer["nodes"]:
            print(f"    {node['path']} (from={node['from']}, via={node['via']}, spec={node.get('spec','')})")

# ── Test 5: Full tool call via .func() — callers of derive_session_mode ──
print("\n" + "="*60)
print("TEST 5: Full tool call — callers of derive_session_mode")
print("="*60)
try:
    result_str = trace_call_chain_hd.func(
        symbol="derive_session_mode",
        path="",
        direction="callers",
        max_depth=3,
        runtime=MagicMock(),
    )
    data = json.loads(result_str)
    print(f"  ok={data.get('ok')}, total_nodes={data.get('total_nodes')}, truncated={data.get('truncated')}")
    if data.get("seeds"):
        print(f"  Seeds: {[(s['path'], s['name']) for s in data['seeds']]}")
    if data.get("index_stats"):
        print(f"  Index stats: {data['index_stats']}")
    for layer in data.get("layers", []):
        print(f"  Layer {layer['depth']}: {len(layer['nodes'])} nodes")
        for node in layer["nodes"]:
            print(f"    {node['path']} (from={node['from']}, via={node['via']})")
except Exception as e:
    print(f"  ERROR: {e!r}")

# ── Test 6: Nonexistent symbol ──
print("\n" + "="*60)
print("TEST 6: Nonexistent symbol 'xyz_nonexistent_func'")
print("="*60)
try:
    result_str = trace_call_chain_hd.func(
        symbol="xyz_nonexistent_func",
        path="",
        direction="both",
        max_depth=3,
        runtime=MagicMock(),
    )
    data = json.loads(result_str)
    print(f"  ok={data.get('ok')}, error={data.get('error','')}")
    print(f"  index_stats={data.get('index_stats')}")
except Exception as e:
    print(f"  ERROR: {e!r}")

# ── Test 7: Accuracy — verify trace_call_chain.py's callees match real imports ──
print("\n" + "="*60)
print("TEST 7: Accuracy — verify callees of trace_call_chain.py")
print("="*60)
seeds_tc = _find_seed_paths(conn, "", "backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py")
if seeds_tc:
    result = _bfs_trace(conn, seeds_tc, direction="callees", max_depth=1)
    print(f"  Direct callees found: {result['total_nodes']}")
    found_paths = set()
    for layer in result["layers"]:
        for node in layer["nodes"]:
            found_paths.add(node["path"])
            print(f"    {node['path']} (via={node['via']}, spec={node.get('spec','')})")
    
    expected = [
        "backend/packages/harness/evoflow/code_index/store.py",
        "backend/packages/harness/evoflow/tools/host_direct/workspace_path_guard.py",
    ]
    print("\n  Accuracy check:")
    for exp in expected:
        status = "FOUND" if exp in found_paths else "MISSING"
        print(f"    [{status}] {exp}")
    
    print("\n  Raw file_deps for trace_call_chain.py:")
    rows = conn.execute(
        "SELECT to_path, spec FROM file_deps WHERE from_path = ?",
        ("backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py",),
    ).fetchall()
    for r in rows:
        print(f"    to_path={r[0]}, spec={r[1]}")
else:
    print("  No seeds found for trace_call_chain.py path")

# ── Test 8: Accuracy — who imports trace_call_chain? ──
print("\n" + "="*60)
print("TEST 8: Accuracy — verify callers of trace_call_chain.py")
print("="*60)
rows = conn.execute(
    "SELECT from_path, spec FROM file_deps WHERE to_path = ?",
    ("backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py",),
).fetchall()
print(f"  file_deps callers: {len(rows)}")
for r in rows:
    print(f"    from={r[0]}, spec={r[1]}")

rows_refs = conn.execute(
    "SELECT DISTINCT from_path, symbol FROM internal_refs WHERE to_path = ?",
    ("backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py",),
).fetchall()
print(f"  internal_refs callers: {len(rows_refs)}")
for r in rows_refs:
    print(f"    from={r[0]}, symbol={r[1]}")

if seeds_tc:
    result_callers = _bfs_trace(conn, seeds_tc, direction="callers", max_depth=1)
    print(f"\n  BFS callers found: {result_callers['total_nodes']}")
    for layer in result_callers["layers"]:
        for node in layer["nodes"]:
            print(f"    {node['path']} (via={node['via']})")

# ── Test 9: Both direction on a well-connected module ──
print("\n" + "="*60)
print("TEST 9: Both direction on session_repositories.py")
print("="*60)
seeds_sr = _find_seed_paths(conn, "", "backend/packages/harness/evoflow/persistence/session_repositories.py")
if seeds_sr:
    result = _bfs_trace(conn, seeds_sr, direction="both", max_depth=2)
    print(f"  ok={result['ok']}, total_nodes={result['total_nodes']}, truncated={result['truncated']}")
    for layer in result["layers"]:
        print(f"  Layer {layer['depth']}: {len(layer['nodes'])} nodes")
        for node in layer["nodes"]:
            print(f"    {node['path']} (from={node['from']}, via={node['via']})")

conn.close()
print("\n" + "="*60)
print("ALL REAL TESTS COMPLETE")
print("="*60)
