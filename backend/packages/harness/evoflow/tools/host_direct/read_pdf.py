"""PDF page extraction for the read tool (zcode Read PDF alignment).

zcode reads PDFs either natively (base64 file part) or by rendering pages to
images via Poppler. EvoFlow's read pipeline is text-based, so the equivalent
alignment is **per-page text extraction** via pdfminer.six (already a
transitive dependency through markitdown):

- ``pages`` parameter ("3", "1-5", "10-" open range), 1-indexed;
- at most 20 pages per request (zcode READ_PDF_MAX_PAGES_PER_REQUEST);
- reading without ``pages`` is limited to 10-page PDFs (zcode
  READ_PDF_NATIVE_MAX_PAGES); larger files must use ``pages``;
- structured errors: password-protected / corrupted / out-of-range, with
  actionable guidance (zcode ReadErrorCode semantics).

Each returned page is delimited by a ``--- Page N ---`` marker so the model
can navigate; image-only pages get an explicit no-text note.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# zcode alignment: READ_PDF_NATIVE_MAX_PAGES / READ_PDF_MAX_PAGES_PER_REQUEST.
PDF_NATIVE_MAX_PAGES = 10
PDF_MAX_PAGES_PER_REQUEST = 20

_PAGES_RANGE_RE = re.compile(r"^(\d+)(?:-(\d*))?$")


def is_pdf_path(path: str | Path) -> bool:
    """True when the path points at a .pdf file (extension check, zcode isPdfPath)."""
    return str(path or "").strip().lower().endswith(".pdf")


def parse_pdf_page_range(value: str | None) -> tuple[int, int | None] | None:
    """Parse a zcode-style page range: "3", "1-5", "10-" (open-ended).

    Returns ``(first, last)`` 1-indexed inclusive, with ``last=None`` for the
    open form; ``None`` when the value is invalid.
    """
    s = str(value or "").strip()
    if not s:
        return None
    m = _PAGES_RANGE_RE.match(s)
    if not m:
        return None
    first = int(m.group(1))
    if first < 1:
        return None
    if m.group(2) is None:
        return first, None
    if m.group(2) == "":
        return first, None  # open range "10-"
    last = int(m.group(2))
    if last < first:
        return None
    return first, last


def _pdf_page_count(path: Path) -> int:
    """Total page count via pdfminer; raises on encrypted/corrupted files."""
    from pdfminer.pdfpage import PDFPage

    with open(path, "rb") as fp:
        return sum(1 for _ in PDFPage.get_pages(fp, check_extractable=False))


def _pdf_error_message(exc: Exception, path: Path) -> str:
    """Map pdfminer exceptions to zcode-style structured read errors."""
    try:
        from pdfminer.pdfdocument import PDFPasswordIncorrect
        from pdfminer.pdfparser import PDFSyntaxError
    except ImportError:  # pragma: no cover - pdfminer always present via markitdown
        PDFPasswordIncorrect = ()
        PDFSyntaxError = ()

    if PDFPasswordIncorrect and isinstance(exc, PDFPasswordIncorrect):
        return (
            f"Error: PDF is password-protected: {path}. "
            "Please provide an unprotected version."
        )
    if PDFSyntaxError and isinstance(exc, PDFSyntaxError):
        return f"Error: Failed to parse PDF (corrupted or invalid): {path}"
    return f"Error: Failed to read PDF '{path}': {exc}"


def _extract_pages_text(path: Path, page_numbers: list[int]) -> dict[int, str]:
    """Extract text for the given 1-indexed pages in one document parse.

    Note: pdfminer's ``page_numbers`` argument is 0-indexed; this module's
    public page numbers are 1-indexed (zcode semantics), so convert here.
    """
    from pdfminer.high_level import extract_text

    zero_based = [n - 1 for n in page_numbers]
    text = extract_text(str(path), page_numbers=zero_based) or ""
    # pdfminer separates pages with \x0c (form feed).
    chunks = text.split("\x0c")
    out: dict[int, str] = {}
    for idx, page_num in enumerate(page_numbers):
        chunk = chunks[idx] if idx < len(chunks) else ""
        out[page_num] = chunk.strip("\x0c").strip()
    return out


def read_pdf_file(path: str | Path, pages: str | None = None) -> str:
    """Read a PDF as per-page text (zcode Read PDF alignment, text-extraction variant).

    Returns a model-facing string: header with page count + ``--- Page N ---``
    sections, or a structured ``Error: ...`` message.
    """
    p = Path(path)
    if not p.exists():
        return f"Error: File not found: {path}"
    if not p.is_file():
        return f"Error: Path is a directory, not a file: {path}"

    try:
        total = _pdf_page_count(p)
    except ImportError:
        return "Error: PDF parsing library (pdfminer.six) is not available in this environment."
    except Exception as e:
        return _pdf_error_message(e, p)

    if total <= 0:
        return f"Error: Failed to parse PDF (corrupted or 0 pages): {p}"

    selected: list[int]
    range_note = "all pages"
    if pages is not None:
        parsed = parse_pdf_page_range(pages)
        if parsed is None:
            return (
                f"Error: Invalid pages parameter: {pages!r}. "
                'Use formats like "3", "1-5", or "10-" (1-indexed).'
            )
        first, last = parsed
        if first > total:
            return (
                f"Error: Page range out of bounds: PDF has {total} page(s). "
                f"Use a range within 1-{total}, maximum {PDF_MAX_PAGES_PER_REQUEST} pages per request."
            )
        if last is None:
            # Open range "N-" reads to the end of the document (clamped),
            # then still respects the per-request page cap (zcode semantics).
            effective_last = total
        else:
            # Explicit end beyond the document is an out-of-range error, not a
            # silent clamp (zcode PDF_PAGE_OUT_OF_RANGE behavior).
            if last > total:
                return (
                    f"Error: Page range out of bounds: PDF has {total} page(s). "
                    f"Use a range within 1-{total}, maximum {PDF_MAX_PAGES_PER_REQUEST} pages per request."
                )
            effective_last = last
        selected = list(range(first, effective_last + 1))
        if len(selected) > PDF_MAX_PAGES_PER_REQUEST:
            return (
                f"Error: Too many pages requested ({len(selected)}). "
                f"Maximum {PDF_MAX_PAGES_PER_REQUEST} pages per request; "
                f'split into smaller ranges (e.g. "1-{PDF_MAX_PAGES_PER_REQUEST}", '
                f'"{PDF_MAX_PAGES_PER_REQUEST + 1}-{min(2 * PDF_MAX_PAGES_PER_REQUEST, total)}").'
            )
        range_note = f"pages {selected[0]}-{selected[-1]}"
    else:
        if total > PDF_NATIVE_MAX_PAGES:
            return (
                f"Error: PDF has {total} pages (> {PDF_NATIVE_MAX_PAGES}). "
                f'Use the pages parameter (e.g. "1-{PDF_NATIVE_MAX_PAGES}") to read '
                f"in chunks of at most {PDF_MAX_PAGES_PER_REQUEST} pages per request."
            )
        selected = list(range(1, total + 1))

    try:
        page_texts = _extract_pages_text(p, selected)
    except Exception as e:
        return _pdf_error_message(e, p)

    missing_text_pages = [n for n in selected if not page_texts.get(n)]
    header = f"PDF file read: {p} ({total} pages; showing {range_note})"
    if missing_text_pages and len(missing_text_pages) == len(selected):
        header += (
            "\nNote: no extractable text found (likely a scanned/image-only PDF); "
            "consider visual inspection or OCR."
        )
    sections: list[str] = [header]
    for n in selected:
        body = page_texts.get(n) or "（本页无可提取文本，可能是扫描件/图片型 PDF）"
        sections.append(f"--- Page {n} ---\n{body}")
    return "\n\n".join(sections)


def normalize_pdf_page_url_path(path: str | Path) -> str:
    """Best-effort path cleanup for file:// URLs passed to the PDF reader."""
    s = str(path or "").strip()
    if s.lower().startswith("file://"):
        return urlparse(s).path or s
    return s
