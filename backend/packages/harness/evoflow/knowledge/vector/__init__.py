"""Vector store sub-package for the evoflow knowledge base.

Backed by ``sqlite-vec`` (the ``vec0`` virtual table) on the shared evoflow
SQLite connection. Embeddings are stored as packed float32 blobs; recall uses
``vec0``'s native cosine distance.

Vector dimensionality is **parameterized per dataset** (default 1536, matching
OpenAI ``text-embedding-3-small`` / ``text-embedding-ada-002``). The ``vec0``
virtual table is created lazily with the dataset's configured dimension — a
single static DDL cannot express a dynamic ``FLOAT[N]`` width, so
:meth:`VectorStore.init` (called per dataset) issues the ``CREATE VIRTUAL
TABLE`` statement with the concrete ``N``.
"""

from evoflow.knowledge.vector.sqlite_vec import VectorStore, VectorStoreError

__all__ = ["VectorStore", "VectorStoreError"]
