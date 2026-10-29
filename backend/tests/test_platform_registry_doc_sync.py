"""CI guard: platform registry names stay aligned with docs / domain list (DEF-07)."""

from __future__ import annotations

from pathlib import Path

from evoflow.admin.platform_actions import PLATFORM_DOMAINS, get_registry


# Keep in sync with 04-http-platform.md / defect-registry scale line.
# Prior stale 153/21; now includes media(5) + openai(3) + settings.invoke_model + other drifts → 179 / 24 domains.
EXPECTED_PLATFORM_ACTION_COUNT = 179


def test_assets_in_platform_domains() -> None:
    assert "assets" in PLATFORM_DOMAINS
    assert "extensions" in PLATFORM_DOMAINS
    assert "plugins" in PLATFORM_DOMAINS
    assert "org" in PLATFORM_DOMAINS
    assert "channels" in PLATFORM_DOMAINS
    assert "eval" in PLATFORM_DOMAINS
    assert "media" in PLATFORM_DOMAINS
    assert "openai" in PLATFORM_DOMAINS
    assert "experience" not in PLATFORM_DOMAINS
    assert "memory" not in PLATFORM_DOMAINS
    assert len(PLATFORM_DOMAINS) == 24


def test_registry_action_count() -> None:
    reg = get_registry()
    assert len(reg) == EXPECTED_PLATFORM_ACTION_COUNT, (
        f"registry size drifted: got {len(reg)}, expected {EXPECTED_PLATFORM_ACTION_COUNT}; "
        "update docs + EXPECTED_PLATFORM_ACTION_COUNT together"
    )


def test_registry_has_no_retired_actions() -> None:
    reg = get_registry()
    for name in (
        "experience.list",
        "experience.get",
        "experience.save",
        "experience.delete",
        "memory.agents",
        "memory.get",
        "memory.clear",
        "memory.delete_fact",
        "verification.list",
        "appearance.get",
    ):
        assert name not in reg, f"retired action still registered: {name}"
    import evoflow.admin.platform_handlers as H

    for attr in (
        "experience_list",
        "experience_get",
        "experience_save",
        "experience_delete",
        "memory_agents",
        "memory_get",
        "memory_clear",
        "memory_delete_fact",
    ):
        assert not hasattr(H, attr), f"retired handler still present: {attr}"


def test_registry_has_knowledge_delete_and_assets() -> None:
    reg = get_registry()
    assert "knowledge.delete" in reg
    assert reg["knowledge.delete"].risk == "destructive"
    assert "assets.get_profile" in reg
    assert "assets.update_profile" in reg
    assert "employees.delete" in reg
    assert reg["employees.delete"].risk == "destructive"
    assert "agents.bindings" in reg
    assert reg["agents.bindings"].risk == "read"


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
    assert "179" in text
    assert "bindings" in text
    assert "**extensions：**" in text
    assert "**plugins：**" in text
    assert "**org：**" in text
    assert "**channels：**" in text
    assert "**eval：**" in text
    assert "**media：**" in text
    assert "**openai：**" in text
    assert "invoke_model" in text
    assert "update_model" in text
    assert "employees.wake" in text or "wake" in text
    assert "**memory：**" not in text
