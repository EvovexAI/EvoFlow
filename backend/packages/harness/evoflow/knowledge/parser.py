"""Document parser for the evoflow knowledge base.

Converts source files (PDF, DOCX, PPTX, XLSX, TXT, MD) to plain text using
``markitdown`` (already a dependency in ``pyproject.toml``). For ``.txt`` /
``.md`` files, content is read directly without conversion.

.. note::
    Some ``markitdown`` converter sub-modules (e.g. PDF/DOCX readers) reference
    ``os`` at module level without importing it themselves.  Because converters
    are loaded *inside* the ``markitdown`` package namespace, the bare name
    lookup falls through to the *importing* module's globals.  Importing ``os``
    here ensures it is available in that scope and prevents the
    ``name 'os' is not defined`` ``NameError``.
"""

from __future__ import annotations

import logging
import os
import traceback
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Extensions handled by markitdown (binary / rich formats)
_MARKITDOWN_EXTENSIONS = {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}

# Extensions read directly as UTF-8 text
# Align with owned KB formats: documents / text only (no source code for now).
_TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".mdx",
    ".csv",
    ".json",
    ".xml",
    ".html",
    ".htm",
    ".log",
    ".yaml",
    ".yml",
    ".toml",
}


def parse_file(
    file_path: str | Path,
    *,
    doc_id: str | None = None,
    kb_id: str | None = None,
) -> str:
    """Parse a document file into plain text.

    Uses ``markitdown`` for binary/rich formats (PDF, DOCX, PPTX, XLSX).
    Reads ``.txt`` / ``.md`` / source code files directly as UTF-8.

    Args:
        file_path: Path to the source file.
        doc_id: Optional owning document id (added to error context).
        kb_id: Optional owning KB id (added to error context).

    Returns:
        The extracted plain text content.

    Raises:
        FileNotFoundError: If the file does not exist (the message includes
            ``doc_id`` / ``kb_id`` so the UI can show a "重新上传" action).
        ValueError: If the file extension is not supported.
        RuntimeError: If markitdown conversion fails (the original exception
            class — typically ``NameError`` from a converter sub-module that
            forgot to ``import os`` — is preserved as ``__cause__``).
    """
    p = Path(file_path)
    if not p.exists():
        ctx = _format_context(doc_id=doc_id, kb_id=kb_id, path=p)
        raise FileNotFoundError(f"File not found: {p} ({ctx})")

    ext = p.suffix.lower()

    # Direct text read
    if ext in _TEXT_EXTENSIONS:
        return p.read_text(encoding="utf-8", errors="replace")

    # markitdown conversion
    if ext in _MARKITDOWN_EXTENSIONS:
        return _convert_with_markitdown(p, doc_id=doc_id, kb_id=kb_id)

    # Try markitdown for unknown extensions as a last resort
    logger.warning("Unknown extension '%s', attempting markitdown conversion", ext)
    return _convert_with_markitdown(p, doc_id=doc_id, kb_id=kb_id)


def _format_context(*, doc_id: str | None, kb_id: str | None, path: Path) -> str:
    parts: list[str] = []
    if kb_id:
        parts.append(f"kb_id={kb_id}")
    if doc_id:
        parts.append(f"doc_id={doc_id}")
    parts.append(f"path={path}")
    return ", ".join(parts) if parts else str(path)


def _convert_with_markitdown(
    p: Path,
    *,
    doc_id: str | None = None,
    kb_id: str | None = None,
) -> str:
    """Convert a file to text, with lightweight fallbacks for common formats.

    Catches ``NameError`` from converter sub-modules (a known hazard when a
    third-party converter forgets to ``import os`` in a sub-scope) and re-raises
    a ``RuntimeError`` that keeps the original traceback so the worker can
    surface a useful message instead of a bare ``name 'os' is not defined``.
    """
    ctx = _format_context(doc_id=doc_id, kb_id=kb_id, path=p)
    try:
        from markitdown import MarkItDown

        result = MarkItDown().convert(str(p))
        text = result.text_content or ""
        if text.strip():
            return text
        logger.warning("markitdown returned empty content for %s; trying fallback", p.name)
    except NameError as exc:
        # e.g. ``name 'os' is not defined`` from a converter sub-module.
        tb = traceback.format_exc()
        logger.error(
            "markitdown NameError for %s: %s\n%s",
            p.name,
            exc,
            tb,
        )
        raise RuntimeError(
            f"无法解析 {p.name}：markitdown 转换器缺少依赖（{exc}）。"
            f"({ctx})"
        ) from exc
    except Exception as exc:
        logger.warning("markitdown failed for %s: %s; trying fallback", p.name, exc)

    try:
        if p.suffix.lower() == ".pdf":
            import pdfplumber

            with pdfplumber.open(str(p)) as pdf:
                return "\n\n".join((page.extract_text() or "") for page in pdf.pages).strip()
        if p.suffix.lower() in {".docx", ".xlsx"}:
            return _convert_office_fallback(p)
    except ImportError as exc:
        raise RuntimeError(f"无法解析 {p.name}：缺少文档解析依赖（{exc.name}）({ctx})") from exc
    except Exception as exc:
        raise RuntimeError(f"无法解析 {p.name}：{exc} ({ctx})") from exc

    raise RuntimeError(f"无法解析 {p.name}：MarkItDown 未提取到正文 ({ctx})")


def _convert_office_fallback(p: Path) -> str:
    """Extract basic text when optional MarkItDown converters are unavailable."""
    if p.suffix.lower() == ".xlsx":
        from openpyxl import load_workbook

        book = load_workbook(p, read_only=True, data_only=True)
        try:
            rows = []
            for sheet in book.worksheets:
                rows.append(f"## {sheet.title}")
                rows.extend(" | ".join("" if value is None else str(value) for value in row) for row in sheet.iter_rows(values_only=True))
            return "\n".join(rows).strip()
        finally:
            book.close()

    from zipfile import ZipFile
    from xml.etree import ElementTree

    with ZipFile(p) as archive:
        xml = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    return "\n".join(node.text or "" for node in root.iter() if node.tag.endswith("}t")).strip()


def supported_extensions() -> set[str]:
    """Return the set of all supported file extensions."""
    return _MARKITDOWN_EXTENSIONS | _TEXT_EXTENSIONS
