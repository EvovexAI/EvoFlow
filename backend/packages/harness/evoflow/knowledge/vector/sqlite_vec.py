"""``sqlite-vec`` backed vector store for the evoflow knowledge base.

Stores chunk embeddings in a ``vec0`` virtual table (``evoflow_kb_vectors``)
on the shared evoflow SQLite connection and performs cosine-distance
similarity recall. The companion ordinary tables
(``evoflow_kb_dataset`` / ``evoflow_kb_source_file`` / ``evoflow_kb_chunk``)
are created by schema migration v64; the ``vec0`` table is created here
lazily because its ``embedding FLOAT[N]`` column width is parameterized per
dataset and cannot be expressed in a single static DDL.

Design notes
------------
* **Shared connection**: all access goes through ``evoflow.persistence.db``
  (``get_db`` / ``db_connection_lock`` / ``run_db_transaction``). No private
  connection is ever opened — this keeps WAL/lock semantics consistent with
  the rest of the app.
* **Embedding format**: ``vec0`` expects embeddings as packed little-endian
  float32 blobs (``struct.pack(f'{n}f', *values)``). Helpers below do the
  (de)serialization.
* **Dimension parameterization**: the dimension ``N`` is read from the
  dataset row (``evoflow_kb_dataset.embedding_dim``, default 1536) at
  :meth:`init` time and used both to build the virtual table DDL and to
  validate every inserted vector.
* **Metric**: ``vec0`` ``MATCH`` queries return cosine *distance*
  (``distance = 1 - cosine_similarity`` in ``[0, 2]``); ``recall`` returns
  ``(chunk_id, distance, score)`` where ``score = 1 - distance`` is the
  similarity in ``[-1, 1]``.
"""

from __future__ import annotations

import logging
import sqlite3
import struct
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from evoflow.persistence.db import db_connection_lock, get_db

logger = logging.getLogger(__name__)

DEFAULT_EMBEDDING_DIM = 1536
_VECTORS_TABLE_PREFIX = "evoflow_kb_vectors_"


class VectorStoreError(RuntimeError):
    """Raised on vector-store misuse (extension missing, bad dims, ...)."""


def _vectors_table_for(dataset_id: str) -> str:
    """Return the per-dataset ``vec0`` virtual table name.

    Each dataset gets its own ``evoflow_kb_vectors_<dataset_id>`` table so
    that datasets with different embedding dimensions can coexist in the same
    database (the ``vec0`` ``FLOAT[N]`` width is fixed per table).
    """
    return f"{_VECTORS_TABLE_PREFIX}{dataset_id}"


@dataclass(frozen=True)
class RecallHit:
    """A single recall result row."""

    chunk_id: str
    distance: float
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {"chunk_id": self.chunk_id, "distance": self.distance, "score": self.score}


def _pack_vector(values: Sequence[float]) -> bytes:
    """Pack a float sequence into the little-endian float32 blob ``vec0`` expects."""
    return struct.pack(f"{len(values)}f", *values)


def _unpack_vector(blob: bytes, dim: int) -> list[float]:
    """Unpack a float32 blob into a list of ``dim`` floats."""
    return list(struct.unpack(f"{dim}f", blob))


class VectorStore:
    """Cosine-similarity vector store over ``sqlite-vec`` ``vec0``.

    A single ``VectorStore`` instance is bound to one dataset (and thus one
    embedding dimension). Use :meth:`init` (idempotent) to ensure the
    dataset row + virtual table exist before inserting/recalling.
    """

    def __init__(self, dataset_id: str, dim: int | None = None) -> None:
        if not dataset_id:
            raise VectorStoreError("dataset_id is required")
        self.dataset_id = dataset_id
        # ``dim`` may be None until ``init`` resolves it from the dataset row.
        self._dim: int | None = dim
        if dim is not None and dim <= 0:
            raise VectorStoreError(f"dim must be positive, got {dim}")

    @property
    def dim(self) -> int:
        if self._dim is None:
            raise VectorStoreError("VectorStore not initialized; call init() first")
        return self._dim

    # ------------------------------------------------------------------ init
    def init(self, *, name: str | None = None, embedding_model: str = "") -> int:
        """Ensure the dataset row + ``vec0`` virtual table exist.

        Resolves the embedding dimension from the dataset row if it already
        exists; otherwise creates the dataset row with ``self._dim`` (or
        :data:`DEFAULT_EMBEDDING_DIM`). Then creates the ``vec0`` virtual
        table with the concrete dimension if missing.

        Returns the resolved embedding dimension.
        """
        with db_connection_lock():
            conn = get_db()
            dim = self._resolve_or_create_dataset(conn, name=name, embedding_model=embedding_model)
            self._dim = dim
            self._ensure_vectors_table(conn, dim)
        return dim

    def _resolve_or_create_dataset(
        self, conn: Any, *, name: str | None, embedding_model: str
    ) -> int:
        row = conn.execute(
            "SELECT embedding_dim FROM evoflow_kb_dataset WHERE dataset_id = ?",
            (self.dataset_id,),
        ).fetchone()
        if row is not None:
            return int(row["embedding_dim"])
        dim = self._dim or DEFAULT_EMBEDDING_DIM
        conn.execute(
            """
            INSERT INTO evoflow_kb_dataset (dataset_id, name, embedding_model, embedding_dim)
            VALUES (?, ?, ?, ?)
            """,
            (self.dataset_id, name or self.dataset_id, embedding_model, dim),
        )
        conn.commit()
        return dim

    def _ensure_vectors_table(self, conn: Any, dim: int) -> None:
        """Create the per-dataset ``vec0`` virtual table if it does not yet exist.

        Each dataset owns ``evoflow_kb_vectors_<dataset_id>`` so datasets with
        different embedding dimensions can coexist. ``vec0`` supports
        ``IF NOT EXISTS``. The dimension is interpolated into the DDL — this is
        the only place where the parameterized dimension materializes.
        """
        table = _vectors_table_for(self.dataset_id)
        ddl = (
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {table} "
            f"USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[{dim}])"
        )
        try:
            conn.execute(ddl)
            conn.commit()
        except sqlite3.OperationalError as exc:
            # Surface a clear error if the sqlite-vec extension is missing —
            # the most common cause of "no such module: vec0".
            if "vec0" in str(exc).lower() or "no such module" in str(exc).lower():
                raise VectorStoreError(
                    "sqlite-vec extension is not loaded; cannot create vec0 "
                    "virtual table. Install the `sqlite-vec` package and ensure "
                    "the shared DB connection loads it."
                ) from exc
            raise

    # ---------------------------------------------------------------- insert
    def insert(self, chunk_id: str, embedding: Sequence[float]) -> None:
        """Insert (or replace) a single chunk embedding.

        Args:
            chunk_id: Stable chunk identifier (must match an
                ``evoflow_kb_chunk`` row for full recall joins).
            embedding: Float vector whose length must equal the dataset dim.
        """
        dim = self.dim
        if len(embedding) != dim:
            raise VectorStoreError(
                f"embedding dimension mismatch: expected {dim}, got {len(embedding)}"
            )
        blob = _pack_vector(embedding)
        table = _vectors_table_for(self.dataset_id)
        with db_connection_lock():
            conn = get_db()
            conn.execute(
                f"INSERT OR REPLACE INTO {table} (chunk_id, embedding) VALUES (?, ?)",
                (chunk_id, blob),
            )
            conn.commit()

    def insert_many(self, items: Iterable[tuple[str, Sequence[float]]]) -> int:
        """Batch insert/replace. Returns the number of rows written."""
        dim = self.dim
        rows: list[tuple[str, bytes]] = []
        for chunk_id, embedding in items:
            if len(embedding) != dim:
                raise VectorStoreError(
                    f"embedding dimension mismatch for chunk {chunk_id}: "
                    f"expected {dim}, got {len(embedding)}"
                )
            rows.append((chunk_id, _pack_vector(embedding)))
        if not rows:
            return 0
        with db_connection_lock():
            conn = get_db()
            conn.executemany(
                f"INSERT OR REPLACE INTO {_vectors_table_for(self.dataset_id)} (chunk_id, embedding) VALUES (?, ?)",
                rows,
            )
            conn.commit()
        return len(rows)

    # ---------------------------------------------------------------- delete
    def delete(self, chunk_id: str) -> None:
        """Delete a single chunk's embedding (no-op if absent)."""
        with db_connection_lock():
            conn = get_db()
            conn.execute(f"DELETE FROM {_vectors_table_for(self.dataset_id)} WHERE chunk_id = ?", (chunk_id,))
            conn.commit()

    def delete_many(self, chunk_ids: Iterable[str]) -> int:
        """Delete many chunks by id. Returns the count actually removed."""
        ids = [cid for cid in chunk_ids]
        if not ids:
            return 0
        with db_connection_lock():
            conn = get_db()
            cur = conn.executemany(
                f"DELETE FROM {_vectors_table_for(self.dataset_id)} WHERE chunk_id = ?",
                [(cid,) for cid in ids],
            )
            conn.commit()
            return int(cur.rowcount or 0)

    def delete_by_dataset(self) -> int:
        """Delete all vectors whose chunk belongs to this dataset.

        The ``vec0`` table does not carry a dataset column, so we resolve
        chunk ids from ``evoflow_kb_chunk`` first.
        """
        with db_connection_lock():
            conn = get_db()
            ids = [
                r["chunk_id"]
                for r in conn.execute(
                    "SELECT chunk_id FROM evoflow_kb_chunk WHERE dataset_id = ?",
                    (self.dataset_id,),
                ).fetchall()
            ]
        if not ids:
            return 0
        return self.delete_many(ids)

    # ----------------------------------------------------------------- recall
    def recall(
        self, query_embedding: Sequence[float], *, top_k: int = 5
    ) -> list[RecallHit]:
        """Return the ``top_k`` nearest chunks by cosine similarity.

        Args:
            query_embedding: Query vector; length must equal the dataset dim.
            top_k: Maximum number of hits.

        Returns:
            Hits sorted by ascending cosine *distance* (most similar first).
            ``score`` is ``1 - distance`` (cosine similarity in ``[-1, 1]``).
        """
        dim = self.dim
        if len(query_embedding) != dim:
            raise VectorStoreError(
                f"query embedding dimension mismatch: expected {dim}, got {len(query_embedding)}"
            )
        k = max(1, int(top_k))
        blob = _pack_vector(query_embedding)
        table = _vectors_table_for(self.dataset_id)
        with db_connection_lock():
            conn = get_db()
            rows = conn.execute(
                f"SELECT chunk_id, distance FROM {table} "
                f"WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                (blob, k),
            ).fetchall()
        return [
            RecallHit(chunk_id=str(r["chunk_id"]), distance=float(r["distance"]), score=1.0 - float(r["distance"]))
            for r in rows
        ]

    # -------------------------------------------------------------- get_count
    def get_count(self) -> int:
        """Return the number of vectors currently stored for this dataset.

        Each dataset owns its own ``vec0`` virtual table
        (``evoflow_kb_vectors_<dataset_id>``), so this counts only this
        dataset's rows.
        """
        with db_connection_lock():
            conn = get_db()
            row = conn.execute(
                f"SELECT COUNT(*) AS c FROM {_vectors_table_for(self.dataset_id)}"
            ).fetchone()
        return int(row["c"]) if row is not None else 0

    def get_dataset_count(self) -> int:
        """Return the number of vectors belonging to this dataset."""
        with db_connection_lock():
            conn = get_db()
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM evoflow_kb_chunk WHERE dataset_id = ?",
                (self.dataset_id,),
            ).fetchone()
        return int(row["c"]) if row is not None else 0
