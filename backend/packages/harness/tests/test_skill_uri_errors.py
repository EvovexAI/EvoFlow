"""Tests for skill URI error messages."""

from __future__ import annotations

from evoflow.skills.skill_uri import format_skill_uri_error


def test_format_skill_uri_error_directory_hint():
    msg = format_skill_uri_error("skill:aihot/scripts")
    assert "terminal" in msg
    assert "skill:aihot" in msg
