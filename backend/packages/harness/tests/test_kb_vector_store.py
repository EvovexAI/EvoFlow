"""Unit tests for the ``evoflow.knowledge.vector`` store + KB schema v64.

Verifies:
* schema v64 creates ``evoflow_kb_dataset`` / ``evoflow_kb_source_file`` /
  ``evoflow_kb_chunk`` ordinary tables;
* the ``sqlite-vec`` ``vec0`` extension is loaded on the shared connection;
* :class:`VectorStore` supports init / insert / insert_many / delete /
  delete_many / recall / get_count;
* cosine-distance recall returns the nearest chunk first;
* embedding dimension is parameterized per dataset (default 1536; a 384-dim
  dataset coexists with a 1536-dim one via per-dataset ``vec0`` tables).

Uses an isolated ``EVOFLOW_HOME`` temp dir so it never touches the real DB.
"""

from __future__ import annotations

import shutil  # noqa: F401  (kept for potential manual cleanup helpers)
import tempfile  # noqa: F401
from pathlib import Path

import pytest

from evoflow.knowledge.vector import VectorStore, VectorStoreError
from evoflow.persistence.db import get_db, reset_db_for_tests


def _unit(i: int, n: int) -> list[float]:
    """A one-hot unit vector of dimension ``n`` with a 1 at position ``i``."""
    v = [0.0] * n
    v[i] = 1.0
    return v


@pytest.fixture()
def isolated_home(tmp_path, monkeypatch):
    """Point ``EVOFLOW_HOME`` at a clean temp dir and reset the shared connection."""
    home = tmp_path / "evoflow_home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    reset_db_for_tests()
    yield home
    reset_db_for_tests()


def test_schema_v64_tables_exist(isolated_home: Path) -> None:
    conn = get_db()
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    assert version >= 64, f"expected schema version >= 64, got {version}"
    for table in ("evoflow_kb_dataset", "evoflow_kb_source_file", "evoflow_kb_chunk"):
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        assert row is not None, f"missing table {table}"


def test_vec0_extension_loaded(isolated_home: Path) -> None:
    conn = get_db()
    row = conn.execute("SELECT name FROM pragma_module_list() WHERE name='vec0'").fetchone()
    assert row is not None and row[0] == "vec0", "vec0 extension not loaded"


def test_vector_store_init_default_dim(isolated_home: Path) -> None:
    vs = VectorStore("ds_default")
    dim = vs.init(name="default corpus", embedding_model="text-embedding-3-small")
    assert dim == 1536
    assert vs.dim == 1536


def test_insert_recall_cosine(isolated_home: Path) -> None:
    vs = VectorStore("ds_recall")
    vs.init(name="recall corpus", embedding_model="text-embedding-3-small")
    vs.insert("c0", _unit(0, 1536))
    vs.insert("c1", _unit(1, 1536))
    vs.insert("c2", _unit(2, 1536))
    assert vs.get_count() == 3

    hits = vs.recall(_unit(0, 1536), top_k=2)
    assert len(hits) == 2
    # Nearest must be c0 with ~0 distance (cosine similarity 1).
    assert hits[0].chunk_id == "c0"
    assert hits[0].distance < 1e-6
    assert abs(hits[0].score - 1.0) < 1e-6
    # c1 / c2 are orthogonal to the query -> cosine distance ~1.4142.
    assert hits[1].chunk_id in {"c1", "c2"}
    assert abs(hits[1].distance - 1.4142135) < 1e-4


def test_delete_and_delete_many(isolated_home: Path) -> None:
    vs = VectorStore("ds_del")
    vs.init()
    vs.insert_many([("a", _unit(0, 1536)), ("b", _unit(1, 1536)), ("c", _unit(2, 1536))])
    assert vs.get_count() == 3
    vs.delete("a")
    assert vs.get_count() == 2
    removed = vs.delete_many(["b", "c"])
    assert removed == 2
    assert vs.get_count() == 0


def test_insert_many_returns_count(isolated_home: Path) -> None:
    vs = VectorStore("ds_batch")
    vs.init()
    n = vs.insert_many([("x0", _unit(0, 1536)), ("x1", _unit(1, 1536))])
    assert n == 2
    assert vs.get_count() == 2


def test_dimension_mismatch_raises(isolated_home: Path) -> None:
    vs = VectorStore("ds_mismatch")
    vs.init()
    with pytest.raises(VectorStoreError):
        vs.insert("bad", [0.0] * 10)
    with pytest.raises(VectorStoreError):
        vs.recall([0.0] * 10, top_k=1)


def test_dimension_parameterization_per_dataset(isolated_home: Path) -> None:
    """A 384-dim dataset must coexist with a 1536-dim dataset."""
    vs1536 = VectorStore("ds_1536")
    vs1536.init()
    vs1536.insert("p0", _unit(0, 1536))
    assert vs1536.get_count() == 1

    vs384 = VectorStore("ds_384", dim=384)
    dim = vs384.init(name="mini", embedding_model="bge-small")
    assert dim == 384
    vs384.insert("s0", _unit(0, 384))
    vs384.insert("s1", _unit(1, 384))
    assert vs384.get_count() == 2

    hits = vs384.recall(_unit(0, 384), top_k=1)
    assert hits[0].chunk_id == "s0"
    assert hits[0].distance < 1e-6

    # 1536-dim dataset is unaffected by 384-dim dataset.
    assert vs1536.get_count() == 1


def test_init_is_idempotent(isolated_home: Path) -> None:
    vs = VectorStore("ds_idem")
    dim1 = vs.init(name="first", embedding_model="m1")
    dim2 = vs.init(name="second", embedding_model="m2")
    assert dim1 == dim2 == 1536
    # Re-init must not wipe existing rows.
    vs.insert("k", _unit(0, 1536))
    vs.init()
    assert vs.get_count() == 1


def test_empty_dataset_id_rejected() -> None:
    with pytest.raises(VectorStoreError):
        VectorStore("")


def test_legacy_delete_missing_file_returns_false(isolated_home: Path) -> None:
    """Deleting a non-existent file must not report success (A1)."""
    del isolated_home
    from evoflow.knowledge import service as kb_service

    assert kb_service.delete_file("ds_missing", "nonexist_file_123") is False
