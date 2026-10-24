"""platform ui.show / ui.hide — right panel folded from panel_set."""

from evoflow.admin.platform_actions import dispatch_platform_action, get_registry, reset_registry_cache


def setup_function() -> None:
    reset_registry_cache()


def test_ui_actions_registered():
    reg = get_registry()
    assert "ui.show" in reg
    assert "ui.hide" in reg
    assert "ui.update" in reg
    assert reg["ui.show"].risk == "read"
    assert reg["ui.show"].domain == "ui"


def test_ui_show_collab_workflow():
    result = dispatch_platform_action(
        "ui.show",
        args_json='{"kind":"collab-workflow","data":{"mainTaskId":"mt-ui-1"}}',
    )
    assert result.get("ok") is True
    assert result.get("kind") == "collab-workflow"
    surface = result.get("surface") or {}
    assert surface.get("id") == "workflow:mt-ui-1"
    assert (surface.get("data") or {}).get("mainTaskId") == "mt-ui-1"


def test_ui_show_employee_process():
    result = dispatch_platform_action(
        "ui.show",
        args_json='{"kind":"employeeProcess","taskId":"mt-2","agentCode":"duty-ops"}',
    )
    assert result.get("ok") is True
    assert result.get("kind") == "employeeProcess"
    data = (result.get("surface") or {}).get("data") or {}
    assert data.get("taskId") == "mt-2"
    assert data.get("agentCode") == "duty-ops"


def test_ui_show_requires_kind():
    result = dispatch_platform_action("ui.show", args_json="{}")
    assert result.get("ok") is False


def test_ui_hide():
    result = dispatch_platform_action("ui.hide", args_json="{}")
    assert result.get("ok") is True
    assert result.get("action") == "hide"


def test_catalog_includes_ui_domain():
    cat = dispatch_platform_action("catalog", args_json='{"domain":"ui"}')
    assert cat.get("ok") is True
    names = cat.get("action_names") or [
        a.get("name") for a in (cat.get("actions") or []) if isinstance(a, dict)
    ]
    # detailed domain catalog may nest under domains / actions
    flat = " ".join(str(x) for x in (names or []))
    if not flat:
        # fallback: search whole payload
        flat = str(cat)
    assert "ui.show" in flat
