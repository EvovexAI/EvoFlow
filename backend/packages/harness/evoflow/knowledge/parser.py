"""Document parser for the evoflow knowledge base.

Converts source files (PDF, DOCX, PPTX, XLSX, TXT, MD) to plain text using
``markitdown`` (already a dependency in ``pyproject.toml``). For ``.txt`` /
``.md`` files, content is read directly without conversion.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Extensions handled by markitdown (binary / rich formats)
_MARKITDOWN_EXTENSIONS = {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}

# Extensions read directly as UTF-8 text
_TEXT_EXTENSIONS = {".txt", ".md", ".markdown", ".csv", ".json", ".xml", ".html", ".htm", ".log", ".py", ".js", ".ts", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".yaml", ".yml", ".toml", ".ini", ".cfg"}


def parse_file(file_path: str | Path) -> str:
    """Parse a document file into plain text.

    Uses ``markitdown`` for binary/rich formats (PDF, DOCX, PPTX, XLSX).
    Reads ``.txt`` / ``.md`` / source code files directly as UTF-8.

    Args:
        file_path: Path to the source file.

    Returns:
        The extracted plain text content.

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the file extension is not supported.
        RuntimeError: If markitdown conversion fails.
    """
    p = Path(file_path)
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")

    ext = p.suffix.lower()

    # Direct text read
    if ext in _TEXT_EXTENSIONS:
        return p.read_text(encoding="utf-8", errors="replace")

    # markitdown conversion
    if ext in _MARKITDOWN_EXTENSIONS:
        return _convert_with_markitdown(p)

    # Try markitdown for unknown extensions as a last resort
    logger.warning("Unknown extension '%s', attempting markitdown conversion", ext)
    return _convert_with_markitdown(p)


def _convert_with_markitdown(p: Path) -> str:
    """Convert a file to text using markitdown."""
    try:
        from markitdown import MarkItDown

        md = MarkItDown()
        result = md.convert(str(p))
        text = result.text_content or ""
        if not text.strip():
            logger.warning("markitdown returned empty content for %s", p.name)
        return text
    except ImportError:
        raise RuntimeError(
            "markitdown is not installed. Run 'pip install markitdown[all]' to enable "
            f"parsing of {p.suffix} files."
        )
    except Exception as e:
        raise RuntimeError(f"Failed to parse {p.name} with markitdown: {e}") from e


def supported_extensions() -> set[str]:
    """Return the set of all supported file extensions."""
    return _MARKITDOWN_EXTENSIONS | _TEXT_EXTENSIONS
