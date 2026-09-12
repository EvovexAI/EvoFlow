"""Local filesystem blob store."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from evoflow.knowledge.owned.paths import files_dir


def put_bytes(kb_id: str, doc_id: str, name: str, data: bytes) -> str:
    """Write bytes; return relative blob_path under knowledge root."""
    safe = Path(name).name or "blob.bin"
    dest_dir = files_dir() / kb_id / doc_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe
    dest.write_bytes(data)
    return f"files/{kb_id}/{doc_id}/{safe}"


def put_file(kb_id: str, doc_id: str, src: Path, name: str | None = None) -> tuple[str, int, str]:
    """Copy a local file into the blob store.

    Returns ``(blob_path, size, sha256_hex)``.
    """
    data = src.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    blob_path = put_bytes(kb_id, doc_id, name or src.name, data)
    return blob_path, len(data), digest


def resolve_blob(blob_path: str) -> Path:
    from evoflow.knowledge.owned.paths import knowledge_root

    rel = blob_path.replace("\\", "/").lstrip("/")
    path = (knowledge_root() / rel).resolve()
    root = knowledge_root().resolve()
    if not str(path).startswith(str(root)):
        raise ValueError("blob path escapes knowledge root")
    return path


def delete_doc_blobs(kb_id: str, doc_id: str) -> None:
    d = files_dir() / kb_id / doc_id
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)


def delete_kb_blobs(kb_id: str) -> None:
    d = files_dir() / kb_id
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
