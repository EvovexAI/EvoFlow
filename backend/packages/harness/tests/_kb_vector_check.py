"""Functional verification for the kb vector store + schema v64.

Run: python -m tests._kb_vector_check  (or python tests/_kb_vector_check.py)
Uses an isolated EVOFLOW_HOME temp dir so it never touches the real DB.
"""
from __future__ import annotations

import os
import shutil
import sys


def main() -> int:
    home = os.path.join(os.environ.get("TEMP", "/tmp"), "evoflow_kb_test")
    os.environ["EVOFLOW_HOME"] = home
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home, exist_ok=True)

    from evoflow.persistence.db import db_connection_lock, get_db  # noqa: E402

    conn = get_db()
    print("schema version:", conn.execute("PRAGMA user_version").fetchone()[0])
    for t in ["evoflow_kb_dataset", "evoflow_kb_source_file", "evoflow_kb_chunk"]:
        cnt = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(t, "rows", cnt)
    mod = conn.execute("SELECT name FROM pragma_module_list() WHERE name='vec0'").fetchone()
    print("vec0 module:", mod[0] if mod else None)
    assert mod and mod[0] == "vec0", "vec0 extension not loaded"

    from evoflow.knowledge.vector import VectorStore, VectorStoreError  # noqa: E402

    # --- default dim 1536 ---
    vs = VectorStore("ds_1536")
    dim = vs.init(name="default corpus", embedding_model="text-embedding-3-small")
    print("resolved dim:", dim)
    assert dim == 1536

    def unit(i: int, n: int) -> list[float]:
        v = [0.0] * n
        v[i] = 1.0
        return v

    vs.insert("c0", unit(0, 1536))
    vs.insert("c1", unit(1, 1536))
    vs.insert("c2", unit(2, 1536))
    print("count after insert:", vs.get_count())
    assert vs.get_count() == 3

    hits = vs.recall(unit(0, 1536), top_k=2)
    print("recall top2:", [(h.chunk_id, round(h.distance, 4), round(h.score, 4)) for h in hits])
    assert hits[0].chunk_id == "c0" and hits[0].distance < 1e-6, "nearest must be c0"
    # c1 and c2 are both orthogonal to the query (distance 1.4142); either is a valid 2nd hit.
    assert hits[1].chunk_id in {"c1", "c2"} and abs(hits[1].distance - 1.4142135) < 1e-4
    print("recall OK (cosine)")

    vs.delete("c1")
    print("count after delete c1:", vs.get_count())
    assert vs.get_count() == 2
    print("delete OK")

    # --- dim mismatch guard ---
    try:
        vs.insert("bad", [0.0] * 10)
        print("ERROR: dim mismatch not raised")
        return 1
    except VectorStoreError as e:
        print("dim-mismatch guard OK:", e)

    # --- batch insert + count ---
    vs.insert_many([("b0", unit(5, 1536)), ("b1", unit(6, 1536))])
    print("count after batch:", vs.get_count())
    assert vs.get_count() == 4
    vs.delete_many(["b0", "b1"])
    assert vs.get_count() == 2
    print("batch insert/delete OK")

    # --- dimension parameterization on a SECOND per-dataset table ---
    # Each dataset owns its own evoflow_kb_vectors_<dataset_id> vec0 table, so
    # a dataset with a different embedding dimension (e.g. 384 for bge-small)
    # coexists with the 1536-dim dataset above. Insert + recall must work.
    vs384 = VectorStore("ds_384", dim=384)
    dim384 = vs384.init(name="mini", embedding_model="bge-small")
    assert dim384 == 384
    vs384.insert("x0", unit(0, 384))
    vs384.insert("x1", unit(1, 384))
    assert vs384.get_count() == 2
    hits384 = vs384.recall(unit(0, 384), top_k=1)
    assert hits384[0].chunk_id == "x0" and hits384[0].distance < 1e-6
    print("384-dim per-dataset table OK (dim parameterization verified)")

    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
