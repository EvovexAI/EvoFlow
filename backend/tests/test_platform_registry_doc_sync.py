"""CI guard: platform registry names stay aligned with docs / domain list (DEF-07)."""

from __future__ import annotations

from pathlib import Path

from evoflow.admin.platform_actions import PLATFORM_DOMAINS, get_registry


def test_assets_in_platform_domains() -> None:
    assert "assets" in PLATFORM_DOMAINS
    assert "experience" not in PLATFORM_DOMAINS


def test_registry_has_no_retired_actions() -> None:
    reg = get_registry()
    for name in (
        "experience.list",
        "experience.get",
        "experience.save",
        "experience.delete",
        "verification.list",
        "appearance.get",
    ):
        assert name not in reg, f"retired action still registered: {name}"


def test_registry_has_knowledge_delete_and_assets() -> None:
    reg = get_registry()
    assert "knowledge.delete" in reg
    assert reg["knowledge.delete"].risk == "destructive"
    assert "assets.get_profile" in reg
    assert "assets.update_profile" in reg
    assert "employees.delete" in reg
    assert reg["employees.delete"].risk == "destructive"


def test_http_platform_doc_lists_registry_actions() -> None:
    """Spot-check 04-http-platform.md mentions key domains present in registry."""
    root = Path(__file__).resolve().parents[2]
    doc = root / "skills" / "public" / "evoflow-admin-external" / "references" / "04-http-platform.md"
    if not doc.is_file():
        # Monorepo layouts may omit skills; skip rather than fail packaging-only trees.
        return
    text = doc.read_text(encoding="utf-8")
    assert "**experience：**" not in text
    assert "**knowledge：**" in text and "delete" in text
    emp_line = text.split("**employees：**", 1)[-1].split("\n", 1)[0]
    assert "delete" in emp_line
    assert "archive" not in emp_line
    assert "已退役" in text
    assert "`employees.delete`" in text
