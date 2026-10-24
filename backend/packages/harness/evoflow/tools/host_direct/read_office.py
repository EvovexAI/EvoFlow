"""Office document reading for the read tool.

zcode's read pipeline has NO Office support: docx/xlsx/pptx hit the fs
adapter's binary detection and fail with "Unsupported or binary text
encoding". EvoFlow aligns that binary guard for unknown binaries, but goes
one step further for Office files because the dependency already ships:
``markitdown[all,xlsx]`` is declared in pyproject and used by the upload
pipeline (utils/file_conversion.py) and the knowledge parser.

Strategy:
- markitdown converts doc/docx/ppt/pptx/xls/xlsx to markdown;
- when markitdown fails or returns nothing, fall back to lightweight
  extractors (openpyxl for xlsx/xls-new, zipfile+XML for docx/pptx) —
  same idea as knowledge/parser._convert_office_fallback;
- size guard before conversion (Office → text conversion is expensive);
- output truncation guard with an actionable notice;
- ``offset``/``limit`` paginate the converted markdown by line, matching
  the read tool's text semantics.
"""

from __future__ import annotations

import logging
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

logger = logging.getLogger(__name__)

# Formats the read tool converts to markdown (mirrors utils/file_conversion
# CONVERTIBLE_EXTENSIONS minus .pdf, which has its own branch).
OFFICE_EXTENSIONS = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})

# Refuse conversion above this size — markitdown is single-threaded and can
# stall a request for minutes on giant workbooks.
OFFICE_MAX_FILE_BYTES = 50 * 1024 * 1024  # 50 MB
# Converted markdown longer than this is truncated (model context guard).
OFFICE_MAX_OUTPUT_CHARS = 60_000

_TEXT_TAG_RE = re.compile(r"}t$")


def is_office_path(path: str | Path) -> bool:
    """True when the extension is a convertible Office document."""
    try:
        return Path(path).suffix.lower() in OFFICE_EXTENSIONS
    except Exception:
        return False


def _convert_with_markitdown(path: Path) -> str:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(path))
    return str(getattr(result, "text_content", "") or "")


def _fallback_xlsx(path: Path) -> str:
    """Sheet-by-sheet markdown tables via openpyxl (parser.py style)."""
    from openpyxl import load_workbook

    wb = load_workbook(str(path), read_only=True, data_only=True)
    parts: list[str] = []
    try:
        for ws in wb.worksheets:
            parts.append(f"## Sheet: {ws.title}\n")
            for row in ws.iter_rows(values_only=True):
                cells = ["" if v is None else str(v) for v in row]
                if not any(c.strip() for c in cells):
                    continue
                parts.append("| " + " | ".join(cells) + " |")
            parts.append("")
    finally:
        wb.close()
    return "\n".join(parts)


def _fallback_docx(path: Path) -> str:
    """Paragraph text via zipfile + ElementTree on word/document.xml."""
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    parts: list[str] = []
    with zipfile.ZipFile(path) as zf:
        with zf.open("word/document.xml") as f:
            root = ElementTree.parse(f).getroot()
    for para in root.iter(f"{{{ns}}}p"):
        texts = [node.text or "" for node in para.iter() if _TEXT_TAG_RE.search(node.tag)]
        line = "".join(texts).strip()
        if line:
            parts.append(line)
    return "\n".join(parts)


def _fallback_pptx(path: Path) -> str:
    """Slide text via zipfile + ElementTree on ppt/slides/*.xml."""
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    slide_re = re.compile(r"^ppt/slides/slide(\d+)\.xml$")
    slides: list[tuple[int, str]] = []
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            m = slide_re.match(name)
            if not m:
                continue
            with zf.open(name) as f:
                root = ElementTree.parse(f).getroot()
            texts = [node.text or "" for node in root.iter(f"{{{a}}}t")]
            body = "\n".join(t.strip() for t in texts if t.strip())
            slides.append((int(m.group(1)), body))
    slides.sort()
    parts: list[str] = []
    for num, body in slides:
        parts.append(f"<!-- Slide number: {num} -->")
        if body:
            parts.append(body)
        parts.append("")
    return "\n".join(parts)


def _convert_with_fallback(path: Path, ext: str) -> str:
    try:
        if ext == ".xlsx":
            return _fallback_xlsx(path)
        if ext == ".docx":
            return _fallback_docx(path)
        if ext == ".pptx":
            return _fallback_pptx(path)
    except Exception as exc:
        logger.debug("office fallback failed for %s: %s", path, exc)
    return ""


def read_office_file(
    path: str | Path,
    *,
    offset: int | None = None,
    limit: int | None = None,
) -> str:
    """Convert an Office document to markdown for the model.

    Line-numbered pagination semantics match read_file_content when
    offset/limit are provided.
    """
    p = Path(path)
    ext = p.suffix.lower()

    try:
        size = p.stat().st_size
    except OSError as exc:
        return f"Error: Failed to stat Office document '{path}': {exc}"
    if size > OFFICE_MAX_FILE_BYTES:
        return (
            f"Error: Office document too large to convert ({size:,} bytes; "
            f"limit {OFFICE_MAX_FILE_BYTES:,}): {path}. "
            "Parse it with Python code instead (e.g. openpyxl / python-pptx in the sandbox)."
        )

    md = ""
    try:
        md = _convert_with_markitdown(p)
    except Exception as exc:
        logger.info("markitdown failed for %s (%s); trying fallback", path, exc)
    if not md.strip():
        md = _convert_with_fallback(p, ext)
    if not md.strip():
        return (
            f"Error: Failed to extract text from Office document: {path}. "
            "The file may be corrupted, password-protected, or in a legacy binary "
            "format; parse it with Python code instead."
        )

    # Truncation guard with actionable notice.
    truncated_note = ""
    if len(md) > OFFICE_MAX_OUTPUT_CHARS:
        total_chars = len(md)
        md = md[:OFFICE_MAX_OUTPUT_CHARS]
        truncated_note = (
            f"\n\n[Office document converted to markdown; showing first "
            f"{OFFICE_MAX_OUTPUT_CHARS:,} of {total_chars:,} characters. "
            "Use offset/limit to read the rest, or parse the file with Python "
            "code for targeted extraction.]"
        )

    # offset/limit paginate the converted markdown lines (read text semantics).
    if offset is not None or limit is not None:
        lines = md.splitlines()
        start = max(0, (offset or 1) - 1)
        end = start + limit if limit is not None else len(lines)
        selected = lines[start:end]
        return "\n".join(f"{start + i + 1}:{line}" for i, line in enumerate(selected))

    if truncated_note:
        md = md + truncated_note
    return md
