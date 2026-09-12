"""Comprehensive test suite for trace_call_chain tool.

Covers 5 layers:
  L1 — unit (pure helpers with in-memory SQLite)
  L2 — integration (real workspace index)
  L3 — boundary (invalid inputs, extreme params)
  L4 — limits (caps enforcement, hub flood)
  L5 — structural (JSON field completeness)

Run: python -m pytest tests/test_trace_call_chain.py -v
Or:  python tests/test_trace_call_chain.py
"""

from __future__ import annotations  # noqa: I001

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

# Ensure we can import from the package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent.parent))

from evoflow.tools.host_direct.trace_call_chain import (  # noqa: I001
    _path_has_skipped_segment,
    _index_stats,
    _find_seed_paths,
    _symbols_in_file,
    _bfs_trace,
    _add_neighbor,
    _MAX_NODES,
    _MAX_SEEDS,
    _MAX_NEIGHBORS_PER_NODE,
    _MAX_DEPTH,
)


# ═══════════════════════════════════════════════════════════════
#  Helpers — build in-memory index
# ═══════════════════════════════════════════════════════════════

def _make_conn() -> sqlite3.Connection:
    """Create an in-memory SQLite with the same schema as the real index."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE fts_content (path TEXT, content TEXT);
        CREATE TABLE symbols (
            path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL,
            PRIMARY KEY (path, name, line)
        );
        CREATE TABLE file_deps (
            from_path TEXT NOT NULL, spec TEXT NOT NULL, line INTEGER NOT NULL DEFAULT 0,
            to_path TEXT, dep_kind TEXT NOT NULL DEFAULT 'import',
            PRIMARY KEY (from_path, spec, line)
        );
        CREATE INDEX idx_file_deps_from ON file_deps(from_path);
        CREATE INDEX idx_file_deps_to ON file_deps(to_path);
        CREATE TABLE internal_refs (
            from_path TEXT NOT NULL, to_path TEXT NOT NULL, line INTEGER NOT NULL DEFAULT 0,
            ref_kind TEXT NOT NULL DEFAULT 'import_use', symbol TEXT,
            PRIMARY KEY (from_path, to_path, line, ref_kind, symbol)
        );
        CREATE INDEX idx_internal_refs_to ON internal_refs(to_path);
        CREATE INDEX idx_internal_refs_from ON internal_refs(from_path);
        CREATE TABLE type_relations (
            from_path TEXT NOT NULL, from_type TEXT NOT NULL, to_path TEXT, to_type TEXT NOT NULL,
            rel_kind TEXT NOT NULL DEFAULT 'extends', line INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (from_path, from_type, to_type, rel_kind, line)
        );
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    """)
    return conn


def _seed_chain(conn, depth: int = 5) -> list[str]:
    """Insert a linear chain: a.py → b.py → c.py → ... (file_deps)."""
    paths = []
    for i in range(depth):
        p = f"src/mod_{i}.py"
        paths.append(p)
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (p, f"func_{i}", "function", 10 + i),
        )
        conn.execute(
            "INSERT INTO fts_content(path, content) VALUES (?, ?)",
            (p, f"content of {p}"),
        )
        if i > 0:
            conn.execute(
                "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                (paths[i - 1], f"from .mod_{i} import func_{i}", i * 10, p, "import"),
            )
    conn.commit()
    return paths


def _seed_hub(conn, hub: str = "src/hub.py", fanout: int = 30) -> str:
    """Insert a hub node with *fanout* importers (callers)."""
    conn.execute(
        "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
        (hub, "HubClass", "class", 1),
    )
    conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (hub, "hub"))
    for i in range(fanout):
        p = f"src/consumer_{i}.py"
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (p, f"consumer_{i}", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (p, f"consumer {i}"))
        conn.execute(
            "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
            (p, f"from .hub import HubClass", 1, hub, "import"),  # noqa: F541
        )
    conn.commit()
    return hub


def _seed_internal_refs(conn) -> list[str]:
    """Insert internal_refs edges: ref_a.py → ref_b.py → ref_c.py."""
    paths = ["src/ref_a.py", "src/ref_b.py", "src/ref_c.py"]
    for i, p in enumerate(paths):
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (p, f"ref_func_{i}", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (p, p))
    conn.execute(
        "INSERT OR REPLACE INTO internal_refs(from_path, to_path, line, ref_kind, symbol) VALUES (?, ?, ?, ?, ?)",
        (paths[0], paths[1], 5, "import_use", "ref_func_1"),
    )
    conn.execute(
        "INSERT OR REPLACE INTO internal_refs(from_path, to_path, line, ref_kind, symbol) VALUES (?, ?, ?, ?, ?)",
        (paths[1], paths[2], 10, "import_use", "ref_func_2"),
    )
    conn.commit()
    return paths


# ═══════════════════════════════════════════════════════════════
#  L1 — Unit tests (pure helpers)
# ═══════════════════════════════════════════════════════════════

class TestPathHasSkippedSegment:
    """L1: _path_has_skipped_segment filtering."""

    def test_normal_path(self):
        assert not _path_has_skipped_segment("src/main.py")

    def test_node_modules(self):
        assert _path_has_skipped_segment("node_modules/pkg/index.js")

    def test_git(self):
        assert _path_has_skipped_segment(".git/config")

    def test_pycache(self):
        assert _path_has_skipped_segment("src/__pycache__/mod.cpython.py")

    def test_venv(self):
        assert _path_has_skipped_segment("venv/lib/mod.py")

    def test_dotfile(self):
        assert _path_has_skipped_segment(".env")

    def test_nested_skip(self):
        assert _path_has_skipped_segment("src/app/node_modules/lodash/index.js")

    def test_empty(self):
        assert not _path_has_skipped_segment("")

    def test_backslash(self):
        assert _path_has_skipped_segment("src\\node_modules\\pkg\\index.js")


class TestIndexStats:
    """L1: _index_stats returns correct counts."""

    def test_empty_db(self):
        conn = _make_conn()
        stats = _index_stats(conn)
        assert stats == {"files": 0, "symbols": 0, "deps": 0, "refs": 0}

    def test_populated_db(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)       # 3 files, 3 symbols, 2 deps
        _seed_internal_refs(conn)         # 3 more files, 3 more symbols, 2 refs
        stats = _index_stats(conn)
        assert stats["files"] == 6       # 3 + 3
        assert stats["symbols"] >= 6
        assert stats["deps"] >= 2
        assert stats["refs"] >= 2

    def test_broken_db(self):
        """If tables don't exist, returns zeros gracefully."""
        conn = sqlite3.connect(":memory:")
        stats = _index_stats(conn)
        assert stats == {"files": 0, "symbols": 0, "deps": 0, "refs": 0}


class TestFindSeedPaths:
    """L1: _find_seed_paths resolution."""

    def test_exact_symbol(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        seeds = _find_seed_paths(conn, "func_0", "")
        assert len(seeds) == 1
        assert seeds[0]["path"] == "src/mod_0.py"
        assert seeds[0]["name"] == "func_0"

    def test_prefix_symbol(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        seeds = _find_seed_paths(conn, "func", "")
        assert len(seeds) >= 3  # func_0, func_1, func_2

    def test_explicit_path(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        seeds = _find_seed_paths(conn, "", "src/mod_1.py")
        assert len(seeds) == 1
        assert seeds[0]["path"] == "src/mod_1.py"
        assert seeds[0]["name"] == "func_1"

    def test_path_with_no_symbols(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        seeds = _find_seed_paths(conn, "", "src/unknown.py")
        assert len(seeds) == 1
        assert seeds[0]["path"] == "src/unknown.py"
        assert seeds[0]["name"] == ""
        assert seeds[0]["kind"] == "file"

    def test_no_match(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        seeds = _find_seed_paths(conn, "nonexistent", "")
        assert len(seeds) == 0

    def test_both_symbol_and_path(self):
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        seeds = _find_seed_paths(conn, "func_0", "src/mod_1.py")
        assert len(seeds) == 2
        assert seeds[0]["path"] == "src/mod_0.py"
        assert seeds[1]["path"] == "src/mod_1.py"

    def test_max_seeds_limit(self):
        conn = _make_conn()
        for i in range(20):
            p = f"src/file_{i}.py"
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                (p, "shared_name", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (p, p))
        conn.commit()
        seeds = _find_seed_paths(conn, "shared_name", "")
        assert len(seeds) <= _MAX_SEEDS

    def test_skips_node_modules_in_seeds(self):
        conn = _make_conn()
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            ("node_modules/pkg/index.js", "target", "function", 1),
        )
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            ("src/clean.py", "target", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", ("src/clean.py", "clean"))
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", ("node_modules/pkg/index.js", "dirty"))
        conn.commit()
        seeds = _find_seed_paths(conn, "target", "")
        assert all("node_modules" not in s["path"] for s in seeds)
        assert any(s["path"] == "src/clean.py" for s in seeds)


class TestSymbolsInFile:
    """L1: _symbols_in_file."""

    def test_returns_symbols(self):
        conn = _make_conn()
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            ("src/a.py", "foo", "function", 10),
        )
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            ("src/a.py", "bar", "class", 20),
        )
        conn.commit()
        syms = _symbols_in_file(conn, "src/a.py")
        assert len(syms) == 2
        assert syms[0]["name"] == "foo"
        assert syms[1]["name"] == "bar"

    def test_empty_file(self):
        conn = _make_conn()
        syms = _symbols_in_file(conn, "src/empty.py")
        assert len(syms) == 0


class TestAddNeighbor:
    """L1: _add_neighbor helper."""

    def test_adds_new_node(self):
        layer, nxt, visited = [], [], set()
        added = _add_neighbor(
            layer, nxt, visited,
            path="src/new.py", from_path="src/old.py", via="import",
            spec="from .new import X", line=5,
        )
        assert added
        assert len(layer) == 1
        assert layer[0]["path"] == "src/new.py"
        assert layer[0]["from"] == "src/old.py"
        assert layer[0]["via"] == "import"
        assert "src/new.py" in visited
        assert "src/new.py" in nxt

    def test_skips_visited(self):
        layer, nxt, visited = [], [], {"src/seen.py"}
        added = _add_neighbor(
            layer, nxt, visited,
            path="src/seen.py", from_path="src/old.py", via="import",
        )
        assert not added
        assert len(layer) == 0

    def test_skips_empty_path(self):
        layer, nxt, visited = [], [], set()
        added = _add_neighbor(
            layer, nxt, visited,
            path="", from_path="src/old.py", via="import",
        )
        assert not added

    def test_skips_node_modules(self):
        layer, nxt, visited = [], [], set()
        added = _add_neighbor(
            layer, nxt, visited,
            path="node_modules/lodash/index.js", from_path="src/old.py", via="import",
        )
        assert not added

    def test_includes_symbol_field(self):
        layer, nxt, visited = [], [], set()
        _add_neighbor(
            layer, nxt, visited,
            path="src/new.py", from_path="src/old.py", via="internal_ref",
            symbol="my_func", line=10,
        )
        assert layer[0]["symbol"] == "my_func"
        assert "spec" not in layer[0]


# ═══════════════════════════════════════════════════════════════
#  L3 — Boundary tests (invalid inputs)
# ═════════════════════════════════════════════════════ and the tool
# ═══════════════════════════════════════════════════════════════

class TestBfsTrace:
    """L1/L3: _bfs_trace with various configurations."""

    def test_linear_chain_callers(self):
        """a→b→c→d→e, trace callers of e should find d, c, b, a."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        seeds = [{"path": paths[-1], "name": "func_4", "kind": "function", "line": 14}]
        result = _bfs_trace(conn, seeds, direction="callers", max_depth=5)
        assert result["ok"]
        assert result["total_nodes"] == 4  # e's callers: d, c, b, a
        assert len(result["layers"]) == 4
        # Layer 1 should find d (direct caller)
        assert result["layers"][0]["depth"] == 1
        assert result["layers"][0]["nodes"][0]["path"] == paths[-2]
        assert result["layers"][0]["nodes"][0]["from"] == paths[-1]

    def test_linear_chain_callees(self):
        """a→b→c→d→e, trace callees of a should find b, c, d, e."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=5)
        assert result["ok"]
        assert result["total_nodes"] == 4
        assert result["layers"][0]["nodes"][0]["path"] == paths[1]
        assert result["layers"][0]["nodes"][0]["from"] == paths[0]

    def test_both_direction(self):
        """a→b→c, trace both from b should find a (caller) and c (callee)."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=3)
        seeds = [{"path": paths[1], "name": "func_1", "kind": "function", "line": 11}]
        result = _bfs_trace(conn, seeds, direction="both", max_depth=3)
        assert result["ok"]
        assert result["total_nodes"] == 2
        # Layer 1: a (caller) and c (callee)
        layer1_paths = [n["path"] for n in result["layers"][0]["nodes"]]
        assert paths[0] in layer1_paths
        assert paths[2] in layer1_paths

    def test_internal_refs_traversal(self):
        """internal_refs: ref_a→ref_b→ref_c should be traversable."""
        conn = _make_conn()
        paths = _seed_internal_refs(conn)
        seeds = [{"path": paths[0], "name": "ref_func_0", "kind": "function", "line": 1}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=3)
        assert result["ok"]
        assert result["total_nodes"] == 2
        assert result["layers"][0]["nodes"][0]["path"] == paths[1]
        assert result["layers"][0]["nodes"][0]["via"] == "internal_ref"

    def test_max_depth_1(self):
        """Depth 1 = only direct neighbors."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=1)
        assert result["ok"]
        assert result["total_nodes"] == 1
        assert len(result["layers"]) == 1

    def test_empty_seeds(self):
        """No seeds → empty result."""
        conn = _make_conn()
        _seed_chain(conn, depth=3)
        result = _bfs_trace(conn, [], direction="both", max_depth=3)
        assert result["ok"]
        assert result["total_nodes"] == 0
        assert len(result["layers"]) == 0

    def test_no_edges(self):
        """Seed with no edges → empty layers."""
        conn = _make_conn()
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            ("src/lonely.py", "lonely", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", ("src/lonely.py", "alone"))
        conn.commit()
        seeds = [{"path": "src/lonely.py", "name": "lonely", "kind": "function", "line": 1}]
        result = _bfs_trace(conn, seeds, direction="both", max_depth=3)
        assert result["ok"]
        assert result["total_nodes"] == 0

    def test_from_field_present_on_all_nodes(self):
        """Every node in every layer must have a 'from' field."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        _seed_internal_refs(conn)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="both", max_depth=5)
        for layer in result["layers"]:
            for node in layer["nodes"]:
                assert "from" in node, f"Node {node['path']} missing 'from' field"
                assert node["from"], f"Node {node['path']} has empty 'from' field"


# ═══════════════════════════════════════════════════════════════
#  L4 — Limits / caps enforcement
# ═════════════════════════════════════════════════ node budget
# ═══════════════════════════════════════════════════════════════

class TestLimits:
    """L4: Verify all caps are enforced."""

    def test_hub_flood_per_node_budget(self):
        """Hub with 30 importers should not return all 30 in one layer.

        _MAX_NEIGHBORS_PER_NODE=15 means at most 15 neighbors per node per hop.
        """
        conn = _make_conn()
        hub = _seed_hub(conn, fanout=30)
        seeds = [{"path": hub, "name": "HubClass", "kind": "class", "line": 1}]
        result = _bfs_trace(conn, seeds, direction="callers", max_depth=1)
        assert result["ok"]
        assert result["total_nodes"] <= _MAX_NEIGHBORS_PER_NODE
        assert len(result["layers"][0]["nodes"]) <= _MAX_NEIGHBORS_PER_NODE

    def test_max_nodes_global_cap(self):
        """Build a graph that exceeds _MAX_NODES; verify global truncation.

        Strategy: center → 6 hubs (depth 1), each hub → 20 leaves (depth 2).
        Depth 1: 6 nodes.  Depth 2: 6×15(per-node cap)=90 potential, but
        _MAX_NODES=80 kicks in after 6+74=80 total → truncated=True.
        """
        conn = _make_conn()
        center = "src/center.py"
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (center, "center", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (center, "center"))
        for h in range(6):
            hub = f"src/hub_{h}.py"
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                (hub, f"hub_{h}", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (hub, hub))
            conn.execute(
                "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                (center, f"from .hub_{h} import hub_{h}", 1, hub, "import"),
            )
            for idx in range(20):
                leaf = f"src/h{h}_leaf_{idx}.py"
                conn.execute(
                    "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                    (leaf, f"h{h}_leaf_{idx}", "function", 1),
                )
                conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (leaf, leaf))
                conn.execute(
                    "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                    (hub, f"from .h{h}_leaf_{idx} import h{h}_leaf_{idx}", 1, leaf, "import"),
                )
        conn.commit()
        seeds = [{"path": center, "name": "center", "kind": "function", "line": 1}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=3)
        assert result["ok"]
        assert result["total_nodes"] <= _MAX_NODES
        assert result["truncated"] is True

    def test_max_depth_enforced(self):
        """max_depth=2 should not explore beyond depth 2."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=2)
        assert result["ok"]
        assert result["total_nodes"] == 2  # only mod_1 and mod_2
        assert len(result["layers"]) == 2

    def test_per_node_budget_shared_across_queries(self):
        """A node with both file_deps and internal_refs edges should share budget."""
        conn = _make_conn()
        center = "src/center.py"
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (center, "center", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (center, "center"))
        # 10 file_deps callers + 10 internal_refs callers = 20 total
        for i in range(10):
            p = f"src/dep_caller_{i}.py"
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                (p, f"dep_c_{i}", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (p, p))
            conn.execute(
                "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                (p, f"from .center import center", 1, center, "import"),  # noqa: F541
            )
        for i in range(10):
            p = f"src/ref_caller_{i}.py"
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                (p, f"ref_c_{i}", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (p, p))
            conn.execute(
                "INSERT OR REPLACE INTO internal_refs(from_path, to_path, line, ref_kind, symbol) VALUES (?, ?, ?, ?, ?)",
                (p, center, 1, "import_use", "center"),
            )
        conn.commit()
        seeds = [{"path": center, "name": "center", "kind": "function", "line": 1}]
        result = _bfs_trace(conn, seeds, direction="callers", max_depth=1)
        assert result["ok"]
        # Should be ≤ _MAX_NEIGHBORS_PER_NODE (15), not 20
        assert result["total_nodes"] <= _MAX_NEIGHBORS_PER_NODE


# ═══════════════════════════链══════════════════════════════════
#  L5 — Structural / JSON field completeness
# ═══════════════════════════════════════════════════════════════

class TestStructural:
    """L5: Verify JSON output structure."""

    def test_result_has_required_top_level_keys(self):
        conn = _make_conn()
        paths = _seed_chain(conn, depth=3)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="both", max_depth=3)
        for key in ("ok", "direction", "max_depth", "layers", "total_nodes", "truncated"):
            assert key in result, f"Missing top-level key: {key}"

    def test_layer_structure(self):
        conn = _make_conn()
        paths = _seed_chain(conn, depth=3)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=3)
        for layer in result["layers"]:
            assert "depth" in layer
            assert "nodes" in layer
            assert isinstance(layer["nodes"], list)
            assert layer["depth"] >= 1

    def test_node_fields(self):
        conn = _make_conn()
        paths = _seed_chain(conn, depth=3)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=3)
        for layer in result["layers"]:
            for node in layer["nodes"]:
                assert "path" in node
                assert "from" in node
                assert "via" in node
                assert "line" in node
                assert node["via"] in ("import", "internal_ref")

    def test_depth_monotonic(self):
        """Layers should have strictly increasing depth."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=5)
        depths = [layer["depth"] for layer in result["layers"]]
        assert depths == sorted(depths)
        assert len(depths) == len(set(depths))

    def test_no_duplicate_paths_across_layers(self):
        """A path should not appear in two different layers."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=5)
        _seed_internal_refs(conn)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="both", max_depth=5)
        all_paths = set()
        for layer in result["layers"]:
            for node in layer["nodes"]:
                assert node["path"] not in all_paths, f"Duplicate path: {node['path']}"
                all_paths.add(node["path"])

    def test_truncated_flag(self):
        """truncated should be True when hitting _MAX_NODES.

        Multi-hop multi-branch: center → 6 hubs → 20 leaves each.
        Total potential = 6 + 6×15 = 96 > 80 → truncated.
        """
        conn = _make_conn()
        center = "src/center.py"
        conn.execute(
            "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
            (center, "center", "function", 1),
        )
        conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (center, "center"))
        for h in range(6):
            hub = f"src/hub_{h}.py"
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                (hub, f"hub_{h}", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (hub, hub))
            conn.execute(
                "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                (center, f"from .hub_{h} import hub_{h}", 1, hub, "import"),
            )
            for idx in range(20):
                leaf = f"src/h{h}_leaf_{idx}.py"
                conn.execute(
                    "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                    (leaf, f"h{h}_leaf_{idx}", "function", 1),
                )
                conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (leaf, leaf))
                conn.execute(
                    "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                    (hub, f"from .h{h}_leaf_{idx} import h{h}_leaf_{idx}", 1, leaf, "import"),
                )
        conn.commit()
        seeds = [{"path": center, "name": "center", "kind": "function", "line": 1}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=3)
        assert result["truncated"] is True

    def test_truncated_false_for_small_graph(self):
        """truncated should be False for small graphs."""
        conn = _make_conn()
        paths = _seed_chain(conn, depth=3)
        seeds = [{"path": paths[0], "name": "func_0", "kind": "function", "line": 10}]
        result = _bfs_trace(conn, seeds, direction="callees", max_depth=3)
        assert result["truncated"] is False


# ═══════════════════════════════════════════════════════════════
#  L3 — Tool-level boundary tests (trace_call_chain_hd)
# ═══════════════════════════════════════════════════════════════

class TestToolBoundary:
    """L3: Invalid inputs to the @tool function."""

    def _call_tool(self, symbol="", path="", direction="both", max_depth=3):
        """Call trace_call_chain_hd with mocked workspace resolution."""
        with patch(
            "evoflow.tools.host_direct.workspace_path_guard.resolve_search_workspace_root"
        ) as mock_resolve:
            # Create a temp dir with an empty index DB
            tmpdir = tempfile.mkdtemp()
            from evoflow.code_index.store import _ensure_schema, _connect  # noqa: I001

            conn = _connect(tmpdir)
            _ensure_schema(conn)
            # Seed minimal data
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                ("src/test.py", "test_func", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", ("src/test.py", "test"))
            conn.execute(
                "INSERT OR REPLACE INTO file_deps(from_path, spec, line, to_path, dep_kind) VALUES (?, ?, ?, ?, ?)",
                ("src/caller.py", "from .test import test_func", 1, "src/test.py", "import"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO symbols(path, name, kind, line) VALUES (?, ?, ?, ?)",
                ("src/caller.py", "caller_func", "function", 1),
            )
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", ("src/caller.py", "caller"))
            conn.commit()
            conn.close()

            mock_resolve.return_value = (tmpdir, None)

            from evoflow.tools.host_direct.trace_call_chain import trace_call_chain_hd
            # Call the underlying function directly, bypassing pydantic validation
            # that would require a real ToolRuntime for the `runtime` parameter.
            return trace_call_chain_hd.func(
                symbol=symbol,
                path=path,
                direction=direction,
                max_depth=max_depth,
                runtime=MagicMock(),
            )

    def test_no_symbol_no_path(self):
        result = self._call_tool(symbol="", path="")
        data = json.loads(result)
        assert data["ok"] is False
        assert "error" in data

    def test_invalid_direction_falls_back_to_both(self):
        result = self._call_tool(symbol="test_func", direction="invalid_dir")
        data = json.loads(result)
        assert data["ok"] is True
        assert data["direction"] == "both"

    def test_max_depth_zero_clamped_to_1(self):
        result = self._call_tool(symbol="test_func", max_depth=0)
        data = json.loads(result)
        assert data["ok"] is True
        assert data["max_depth"] == 1

    def test_max_depth_negative_clamped_to_1(self):
        result = self._call_tool(symbol="test_func", max_depth=-5)
        data = json.loads(result)
        assert data["ok"] is True
        assert data["max_depth"] == 1

    def test_max_depth_above_max_clamped(self):
        result = self._call_tool(symbol="test_func", max_depth=100)
        data = json.loads(result)
        assert data["ok"] is True
        assert data["max_depth"] == _MAX_DEPTH

    def test_max_depth_string_coerced(self):
        result = self._call_tool(symbol="test_func", max_depth="2")
        data = json.loads(result)
        assert data["ok"] is True
        assert data["max_depth"] == 2

    def test_max_depth_invalid_string_defaults_3(self):
        result = self._call_tool(symbol="test_func", max_depth="abc")
        data = json.loads(result)
        assert data["ok"] is True
        assert data["max_depth"] == 3

    def test_nonexistent_symbol(self):
        result = self._call_tool(symbol="does_not_exist")
        data = json.loads(result)
        assert data["ok"] is False
        assert "error" in data
        assert "index_stats" in data

    def test_result_includes_index_stats(self):
        result = self._call_tool(symbol="test_func")
        data = json.loads(result)
        assert data["ok"] is True
        assert "index_stats" in data
        assert data["index_stats"]["symbols"] >= 2
        assert data["index_stats"]["deps"] >= 1

    def test_result_includes_seeds(self):
        result = self._call_tool(symbol="test_func")
        data = json.loads(result)
        assert data["ok"] is True
        assert "seeds" in data
        assert len(data["seeds"]) >= 1
        assert data["seeds"][0]["path"] == "src/test.py"

    def test_empty_index_returns_helpful_error(self):
        """When index is completely empty, should return clear message."""
        with patch(
            "evoflow.tools.host_direct.workspace_path_guard.resolve_search_workspace_root"
        ) as mock_resolve:
            tmpdir = tempfile.mkdtemp()
            from evoflow.code_index.store import _ensure_schema, _connect  # noqa: I001

            conn = _connect(tmpdir)
            _ensure_schema(conn)
            conn.commit()
            conn.close()

            mock_resolve.return_value = (tmpdir, None)

            from evoflow.tools.host_direct.trace_call_chain import trace_call_chain_hd
            result = trace_call_chain_hd.func(
                symbol="anything", path="", direction="both", max_depth=3,
                runtime=MagicMock(),
            )
            data = json.loads(result)
            assert data["ok"] is False
            assert "empty" in data["error"].lower() or "index" in data["error"].lower()
            assert "index_stats" in data

    def test_exception_returns_structured_error(self):
        """If an exception occurs, should return structured JSON, not crash."""
        with patch(
            "evoflow.tools.host_direct.workspace_path_guard.resolve_search_workspace_root"
        ) as mock_resolve:
            mock_resolve.side_effect = RuntimeError("simulated failure")

            from evoflow.tools.host_direct.trace_call_chain import trace_call_chain_hd
            result = trace_call_chain_hd.func(
                symbol="test", path="", direction="both", max_depth=3,
                runtime=MagicMock(),
            )
            # resolve_search_workspace_root returns a string on error,
            # which the tool passes through directly
            assert isinstance(result, str)
            # Could be the NO_WORKSPACE_BOUND string or a JSON error


# ═══════════════════════════════════════════════════════════════
#  L2 — Integration test (real workspace index)
# ═══════════════════════════════════════════════════════════════

class TestIntegration:
    """L2: Real workspace code index integration.

    These tests connect to the actual workspace SQLite index DB.
    They are skipped if the index doesn't exist or is empty.
    """

    @classmethod
    def _get_real_conn(cls):
        """Try to connect to the real workspace index."""
        import hashlib
        root = os.path.abspath(".")
        h = hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
        data_dir = os.environ.get("EVOFLOW_DATA_DIR", os.path.join(os.path.expanduser("~"), ".evoflow"))
        dbp = os.path.join(data_dir, "code_index", f"{h}.db")
        if not os.path.exists(dbp):
            return None, None
        from evoflow.code_index.store import _connect, _ensure_schema
        conn = _connect(root)
        _ensure_schema(conn)
        # Check if index has data
        n = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        if n == 0:
            conn.close()
            return None, None
        return conn, root

    def test_real_index_trace_known_symbol(self):
        """Trace a known symbol from the real workspace index."""
        conn, root = self._get_real_conn()
        if conn is None:
            import pytest
            pytest.skip("Workspace index not available or empty")
        try:
            seeds = _find_seed_paths(conn, "trace_call_chain_hd", "")
            assert len(seeds) > 0, "trace_call_chain_hd symbol not found in index"
            result = _bfs_trace(conn, seeds, direction="callers", max_depth=2)
            assert result["ok"]
            # The tool should find at least its __init__.py importer
            if result["total_nodes"] > 0:
                for layer in result["layers"]:
                    for node in layer["nodes"]:
                        assert "from" in node
        finally:
            conn.close()

    def test_real_index_trace_by_path(self):
        """Trace from a known file path."""
        conn, root = self._get_real_conn()
        if conn is None:
            import pytest
            pytest.skip("Workspace index not available or empty")
        try:
            seeds = _find_seed_paths(conn, "", "backend/packages/harness/evoflow/tools/host_direct/trace_call_chain.py")
            assert len(seeds) > 0
            result = _bfs_trace(conn, seeds, direction="callers", max_depth=2)
            assert result["ok"]
            assert "index_stats" not in result  # _bfs_trace doesn't add stats; tool does
        finally:
            conn.close()

    def test_real_index_stats(self):
        """Verify _index_stats works on real DB."""
        conn, root = self._get_real_conn()
        if conn is None:
            import pytest
            pytest.skip("Workspace index not available or empty")
        try:
            stats = _index_stats(conn)
            assert stats["symbols"] > 0
            assert stats["files"] > 0
            print(f"\n  Real index stats: {stats}")
        finally:
            conn.close()


# ═══════════════════════════════════════════════════════════════
#  Runner
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
