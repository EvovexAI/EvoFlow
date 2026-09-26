"""EvoFlow owned knowledge base (local-first RAG).

See ``internal design docs (not published in this repository)``."""

from evoflow.knowledge.owned import service as service
from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

__all__ = ["service", "ensure_owned_kb_worker_started"]
