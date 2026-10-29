"""Local HTML paths must become file:// — never https://D:/…"""

from __future__ import annotations

from evoflow.tools.builtins.browser_engine import _coerce_navigate_url, _local_path_to_file_url


def test_windows_drive_path_to_file_url() -> None:
    assert (
        _coerce_navigate_url(r"D:\dev\github\EvoFlow\simple_demo.html")
        == "file:///D:/dev/github/EvoFlow/simple_demo.html"
    )
    assert (
        _coerce_navigate_url("D:/dev/github/EvoFlow/simple_demo.html")
        == "file:///D:/dev/github/EvoFlow/simple_demo.html"
    )


def test_chromium_pathname_to_file_url() -> None:
    assert (
        _coerce_navigate_url("/D:/dev/github/EvoFlow/simple_demo.html")
        == "file:///D:/dev/github/EvoFlow/simple_demo.html"
    )


def test_explicit_file_url_preserved() -> None:
    u = "file:///D:/dev/github/EvoFlow/simple_demo.html"
    assert _coerce_navigate_url(u) == u


def test_https_hosts_unchanged() -> None:
    assert _coerce_navigate_url("https://example.com/a") == "https://example.com/a"
    assert _coerce_navigate_url("example.com") == "example.com"


def test_local_path_helper() -> None:
    assert _local_path_to_file_url("D:/a.html") == "file:///D:/a.html"
    assert _local_path_to_file_url("/D:/a.html") == "file:///D:/a.html"
