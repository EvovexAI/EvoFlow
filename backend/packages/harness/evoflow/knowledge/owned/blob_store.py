"""Local filesystem blob store (per-KB layout).

Blobs live inside the KB's own directory::

    <kb_dir>/.evoflow/kb/blobs/{doc_id}/{file_name}

``blob_path`` values stored in ``kb_documents`` are *relative to the KB's blob
root* (e.g. ``blobs/doc_x/report.pdf``), so a KB directory can be copied or
moved without rewriting rows.
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from evoflow.knowledge.owned import store_paths
from evoflow.knowledge.owned.kb_conn import kb_dir_for_kb


def _blob_root_for_kb(kb_id: str) -> Path:
    return store_paths.blobs_dir(kb_dir_for_kb(kb_id))


def put_bytes(kb_id: str, doc_id: str, name: str, data: bytes) -> str:
    """Write bytes; return relative blob_path under the KB's index dir."""
    safe = Path(name).name or "blob.bin"
    dest_dir = _blob_root_for_kb(kb_id) / doc_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe
    dest.write_bytes(data)
    return f"blobs/{doc_id}/{safe}"


def put_file(kb_id: str, doc_id: str, src: Path, name: str | None = None) -> tuple[str, int, str]:
    """Copy a local file into the blob store.

    Returns ``(blob_path, size, sha256_hex)``.
    """
    data = src.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    blob_path = put_bytes(kb_id, doc_id, name or src.name, data)
    return blob_path, len(data), digest


def resolve_blob(blob_path: str, *, kb_id: str) -> Path:
    """Resolve a ``blob_path`` inside *kb_id*'s blob root.

    Accepts both layouts:

    * current — ``blobs/{doc_id}/{name}``
    * legacy  — ``files/{kb_id}/{doc_id}/{name}`` (pre per-KB split)

    Raises:
        ValueError: when the path escapes the KB's blob root.
    """
    root = _blob_root_for_kb(kb_id).resolve()
    rel = str(blob_path or "").replace("\\", "/").lstrip("/")
    if rel.startswith("blobs/"):
        rel = rel[len("blobs/") :]
    elif rel.startswith("files/"):
        # Strip the legacy ``files/{kb_id}/`` prefix so old rows keep working.
        rest = rel[len("files/") :]
        prefix = f"{kb_id}/"
        rel = rest[len(prefix) :] if rest.startswith(prefix) else rest
    path = (root / rel).resolve()
    if not str(path).startswith(str(root)):
        raise ValueError("blob path escapes kb blob root")
    return path


def delete_doc_blobs(kb_id: str, doc_id: str) -> None:
    d = _blob_root_for_kb(kb_id) / doc_id
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)


def delete_kb_blobs(kb_id: str) -> None:
    d = _blob_root_for_kb(kb_id)
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
