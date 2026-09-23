"""Extract images from parsed Markdown into kb_assets + rewrite as asset:// refs."""

from __future__ import annotations

import base64
import logging
import mimetypes
import re
from pathlib import Path
from typing import Any

from evoflow.knowledge.owned.ids import new_id, utc_now
from evoflow.knowledge.owned.kb_conn import db_for_kb, kb_dir_for_kb
from evoflow.knowledge.owned.store_paths import blobs_dir

logger = logging.getLogger(__name__)

MAX_ASSET_BYTES = 10 * 1024 * 1024
MAX_ASSETS_PER_DOC = 100

_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_DATA_URI_RE = re.compile(
    r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$",
    re.DOTALL,
)
_ASSET_REF_RE = re.compile(r"!\[([^\]]*)\]\((?:asset://|/api/knowledge/owned/assets/)([^)]+?)\)")

# Assets are served by this gateway route; rewriting the body to a real URL keeps
# images renderable in Markdown previews (an ``asset://`` scheme is not a valid
# <img src> for browsers).
ASSET_URL_PREFIX = "/api/knowledge/owned/assets/"

_EXT_BY_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
}


def put_asset_bytes(kb_id: str, doc_id: str, asset_id: str, name: str, data: bytes) -> str:
    """Persist an extracted asset under the KB's blob root.

    The returned ``blob_path`` must be resolvable by
    :func:`evoflow.knowledge.owned.blob_store.resolve_blob`, which is rooted at
    ``<kb_dir>/.evoflow/kb/blobs/`` — so assets live in ``blobs/{doc_id}/``
    alongside document blobs (previously they were written to a sibling
    ``assets/`` dir that ``resolve_blob`` never looked at).
    """
    safe = Path(name).name or f"{asset_id}.bin"
    dest_dir = blobs_dir(kb_dir_for_kb(kb_id)) / doc_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / safe
    dest.write_bytes(data)
    return f"blobs/{doc_id}/{safe}"


def embed_text_for_chunk(content: str) -> str:
    """Replace asset markdown with alt / [图片] for embedding input (spec §7.4)."""

    def _repl(m: re.Match[str]) -> str:
        alt = (m.group(1) or "").strip()
        return alt if alt else "[图片]"

    return _ASSET_REF_RE.sub(_repl, content or "")


def _decode_data_uri(url: str) -> tuple[bytes, str] | None:
    m = _DATA_URI_RE.match(url.strip())
    if not m:
        return None
    mime = m.group(1).lower()
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except Exception:
        return None
    return raw, mime


def _load_local_image(url: str, source_path: Path | None) -> tuple[bytes, str, str] | None:
    """Return (bytes, mime, filename) for a local path reference."""
    raw_url = url.strip().strip("\"'")
    if raw_url.startswith(("http://", "https://", "asset://", "data:")):
        return None
    if raw_url.startswith("file:"):
        raw_url = raw_url[5:]
        if raw_url.startswith("///"):
            raw_url = raw_url[3:]
        elif raw_url.startswith("//"):
            raw_url = raw_url[2:]
    path = Path(raw_url)
    if not path.is_absolute() and source_path is not None:
        path = (source_path.parent / path).resolve()
    if not path.is_file():
        return None
    data = path.read_bytes()
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if not str(mime).startswith("image/"):
        return None
    return data, mime, path.name


def extract_and_rewrite_images(
    text: str,
    *,
    kb_id: str,
    doc_id: str,
    source_path: Path | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Rewrite Markdown images to ``asset://`` and return asset row dicts (not yet inserted)."""
    assets: list[dict[str, Any]] = []
    if not text:
        return text or "", assets

    now = utc_now()
    count = 0

    def _replace(match: re.Match[str]) -> str:
        nonlocal count
        alt = match.group(1) or ""
        url = (match.group(2) or "").strip()
        if url.startswith(("asset://", ASSET_URL_PREFIX)):
            return match.group(0)
        if count >= MAX_ASSETS_PER_DOC:
            return match.group(0)

        data: bytes | None = None
        mime = "application/octet-stream"
        filename = "image.bin"

        decoded = _decode_data_uri(url)
        if decoded:
            data, mime = decoded
            filename = f"embed{_EXT_BY_MIME.get(mime, '.bin')}"
        else:
            local = _load_local_image(url, source_path)
            if local:
                data, mime, filename = local

        if data is None:
            return match.group(0)
        if len(data) > MAX_ASSET_BYTES or len(data) == 0:
            logger.debug("skip asset too large/empty (%s bytes)", len(data))
            return match.group(0)

        asset_id = new_id("ast_")
        ext = _EXT_BY_MIME.get(mime) or Path(filename).suffix or ".bin"
        store_name = f"{asset_id}{ext}"
        try:
            blob_path = put_asset_bytes(kb_id, doc_id, asset_id, store_name, data)
        except Exception:
            logger.debug("asset write failed", exc_info=True)
            return match.group(0)

        width = height = None
        try:
            from io import BytesIO

            from PIL import Image

            with Image.open(BytesIO(data)) as im:
                width, height = im.size
        except Exception:
            pass

        assets.append(
            {
                "id": asset_id,
                "kb_id": kb_id,
                "doc_id": doc_id,
                "chunk_id": None,
                "kind": "image",
                "blob_path": blob_path,
                "alt_text": alt,
                "caption_status": "skipped",
                "caption_text": "",
                "width": width,
                "height": height,
                "created_at": now,
            }
        )
        count += 1
        return f"![{alt}]({ASSET_URL_PREFIX}{asset_id})"

    rewritten = _MD_IMAGE_RE.sub(_replace, text)
    return rewritten, assets


def insert_assets(conn: Any, assets: list[dict[str, Any]]) -> None:
    if not assets:
        return
    conn.executemany(
        """
        INSERT INTO kb_assets(
          id, kb_id, doc_id, chunk_id, kind, blob_path, alt_text,
          caption_status, caption_text, width, height, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        [
            (
                a["id"],
                a["kb_id"],
                a["doc_id"],
                a.get("chunk_id"),
                a.get("kind") or "image",
                a["blob_path"],
                a.get("alt_text") or "",
                a.get("caption_status") or "skipped",
                a.get("caption_text") or "",
                a.get("width"),
                a.get("height"),
                a["created_at"],
            )
            for a in assets
        ],
    )
    # Assets live in the KB's index DB; register the id -> kb map centrally so
    # ``get_asset(asset_id)`` can locate the owning KB.
    _remember_assets(assets)


def _remember_assets(assets: list[dict[str, Any]]) -> None:
    try:
        from evoflow.knowledge.owned.db import db

        now = utc_now()
        with db() as conn:
            conn.executemany(
                """
                INSERT INTO kb_asset_index(asset_id, kb_id, created_at) VALUES (?,?,?)
                ON CONFLICT(asset_id) DO UPDATE SET kb_id=excluded.kb_id
                """,
                [(a["id"], a["kb_id"], now) for a in assets if a.get("id") and a.get("kb_id")],
            )
    except Exception:
        logger.debug("kb_asset_index write skipped", exc_info=True)


def link_assets_to_chunks(conn: Any, assets: list[dict[str, Any]], chunk_rows: list[tuple]) -> None:
    """Set chunk_id when chunk content references the asset (legacy or URL form)."""
    for a in assets:
        aid = a["id"]
        needles = (f"asset://{aid}", f"{ASSET_URL_PREFIX}{aid}")
        for row in chunk_rows:
            # row: (id, kb_id, doc_id, ordinal, content, ...)
            content = row[4] if len(row) > 4 else ""
            if any(n in (content or "") for n in needles):
                conn.execute(
                    "UPDATE kb_assets SET chunk_id=? WHERE id=?",
                    (row[0], aid),
                )
                a["chunk_id"] = row[0]
                break


def assets_for_chunks(chunk_ids: list[str], *, kb_id: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Return ``{chunk_id: [asset, ...]}`` for the given chunks.

    Assets live in per-KB index DBs. When ``kb_id`` is omitted the owning KBs are
    resolved from the central doc/asset registry so cross-KB callers still work.
    """
    if not chunk_ids:
        return {}
    placeholders = ",".join("?" * len(chunk_ids))

    if kb_id:
        scopes = [str(kb_id)]
    else:
        from evoflow.knowledge.owned.service import list_bases

        scopes = [str(b.get("id") or "") for b in list_bases() if b.get("id")]

    rows: list[Any] = []
    for scope in scopes:
        try:
            with db_for_kb(scope) as conn:
                rows.extend(
                    conn.execute(
                        f"""
                        SELECT id, chunk_id, alt_text, caption_text, blob_path, width, height, kind
                        FROM kb_assets
                        WHERE chunk_id IN ({placeholders})
                        """,
                        chunk_ids,
                    ).fetchall()
                )
        except Exception:
            continue
    out: dict[str, list[dict[str, Any]]] = {cid: [] for cid in chunk_ids}
    for r in rows:
        cid = r["chunk_id"]
        if not cid:
            continue
        out.setdefault(cid, []).append(
            {
                "id": r["id"],
                "alt": r["alt_text"] or "",
                "caption": r["caption_text"] or "",
                "url": f"/api/knowledge/owned/assets/{r['id']}",
                "width": r["width"],
                "height": r["height"],
                "kind": r["kind"],
            }
        )
    return out


def get_asset(asset_id: str) -> dict[str, Any] | None:
    from evoflow.knowledge.owned.service import _kb_id_for_asset

    kid = _kb_id_for_asset(asset_id)
    if not kid:
        return None
    with db_for_kb(kid) as conn:
        row = conn.execute("SELECT * FROM kb_assets WHERE id=?", (asset_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    return {
        "id": d["id"],
        "kbId": d["kb_id"],
        "docId": d["doc_id"],
        "chunkId": d.get("chunk_id"),
        "kind": d.get("kind") or "image",
        "blobPath": d["blob_path"],
        "altText": d.get("alt_text") or "",
        "captionText": d.get("caption_text") or "",
        "width": d.get("width"),
        "height": d.get("height"),
        "url": f"/api/knowledge/owned/assets/{d['id']}",
    }
