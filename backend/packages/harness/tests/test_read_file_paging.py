"""read_file offset/limit on minified single-line files."""

from __future__ import annotations

from evoflow.tools.host_direct.read_logic import read_file_content


def test_single_line_minified_json_pages_by_chars(tmp_path):
    p = tmp_path / "min.json"
    p.write_text("{" + "x" * 25_000 + "}", encoding="utf-8")
    page1 = read_file_content(str(p), offset=1, limit=50)
    assert "[single-line file: page 1/" in page1
    assert "next: offset=2" in page1
    assert len(page1) < 12_000
    page2 = read_file_content(str(p), offset=2, limit=1)
    assert "[single-line file: page 2/" in page2
