from __future__ import annotations

import io
import zipfile
from pathlib import Path

from evoflow.knowledge import parser


def test_pdf_parser_falls_back_when_markitdown_fails(tmp_path: Path, monkeypatch):
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(b"placeholder")

    class FakePage:
        def extract_text(self):
            return "PDF fallback text"

    class FakePdf:
        pages = [FakePage()]

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setitem(
        __import__("sys").modules,
        "pdfplumber",
        type("PdfModule", (), {"open": lambda _path: FakePdf()}),
    )

    class BrokenMarkItDown:
        def convert(self, _path):
            raise RuntimeError("converter unavailable")

    monkeypatch.setitem(
        __import__("sys").modules,
        "markitdown",
        type("MarkModule", (), {"MarkItDown": BrokenMarkItDown}),
    )

    assert parser._convert_with_markitdown(pdf) == "PDF fallback text"


def _write_minimal_pptx(path: Path, slides: list[list[str]]) -> None:
    """Build a tiny OOXML pptx with a:t text runs (no python-pptx needed)."""
    a_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>
"""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("ppt/presentation.xml", "<p:presentation/>")
        for idx, lines in enumerate(slides, start=1):
            runs = "".join(f'<a:t xmlns:a="{a_ns}">{line}</a:t>' for line in lines)
            slide_xml = (
                f'<?xml version="1.0" encoding="UTF-8"?>'
                f'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
                f' xmlns:a="{a_ns}"><p:cSld><p:spTree>{runs}</p:spTree></p:cSld></p:sld>'
            )
            zf.writestr(f"ppt/slides/slide{idx}.xml", slide_xml)


def test_pptx_parser_falls_back_when_markitdown_missing(tmp_path: Path, monkeypatch):
    pptx = tmp_path / "deck.pptx"
    _write_minimal_pptx(pptx, [["产品介绍"], ["型号 A", "售价 99"]])

    class MissingMarkItDown:
        def __init__(self):
            raise ModuleNotFoundError("markitdown")

    monkeypatch.setitem(
        __import__("sys").modules,
        "markitdown",
        type("MarkModule", (), {"MarkItDown": MissingMarkItDown}),
    )

    text = parser._convert_with_markitdown(pptx)
    assert "产品介绍" in text
    assert "型号 A" in text
    assert "<!-- Slide number: 1 -->" in text
    assert "<!-- Slide number: 2 -->" in text


def test_pptx_parser_falls_back_when_markitdown_returns_empty(tmp_path: Path, monkeypatch):
    pptx = tmp_path / "empty-md.pptx"
    _write_minimal_pptx(pptx, [["仍可兜底抽出"]])

    class EmptyMarkItDown:
        def convert(self, _path):
            return type("R", (), {"text_content": "   "})()

    monkeypatch.setitem(
        __import__("sys").modules,
        "markitdown",
        type("MarkModule", (), {"MarkItDown": EmptyMarkItDown}),
    )

    text = parser._convert_with_markitdown(pptx)
    assert "仍可兜底抽出" in text


def test_pptx_fallback_helper_orders_slides(tmp_path: Path):
    pptx = tmp_path / "ordered.pptx"
    # Write slides out of numeric order in the zip to ensure sort by slide number.
    a_ns = "http://schemas.openxmlformats.org/drawingml/2006/main"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        for num, label in ((2, "第二页"), (1, "第一页")):
            xml = (
                f'<?xml version="1.0" encoding="UTF-8"?>'
                f'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
                f' xmlns:a="{a_ns}">'
                f"<a:t>{label}</a:t>"
                f"</p:sld>"
            )
            zf.writestr(f"ppt/slides/slide{num}.xml", xml)
    pptx.write_bytes(buf.getvalue())

    text = parser._fallback_pptx(pptx)
    assert text.index("第一页") < text.index("第二页")
