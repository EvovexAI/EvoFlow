"""Scenario: platform write with confirm=false is preview-only."""

from __future__ import annotations

import json
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_user_item


def _run(home: Path) -> dict:
    del home
    from evoflow.admin.platform_actions import dispatch_platform_action, reset_registry_cache

    reset_registry_cache()
    preview_args = {"title": "预览不应落库"}
    preview = dispatch_platform_action(
        "items.create",
        args_json=json.dumps(preview_args, ensure_ascii=False),
        confirm=False,
    )
    listed_before = dispatch_platform_action("items.list", args_json="{}", confirm=False)
    total_before = int(listed_before.get("total") or 0)

    create_args = {"title": "确认后落库"}
    created = dispatch_platform_action(
        "items.create",
        args_json=json.dumps(create_args, ensure_ascii=False),
        confirm=True,
    )
    listed_after = dispatch_platform_action("items.list", args_json="{}", confirm=False)
    total_after = int(listed_after.get("total") or 0)
    item_id = str((created.get("item") or {}).get("id") or "").strip()

    assertions = [
        check(
            "preview_pending",
            bool(preview.get("pending_confirm"))
            or (preview.get("ok") is True and not preview.get("item")),
            inputs={"action": "items.create", "confirm": False, "args": preview_args},
            expected="pending_confirm 或无 item 落库",
            actual={k: preview.get(k) for k in ("ok", "pending_confirm", "item")},
            api="dispatch_platform_action",
        ),
        check(
            "preview_no_mutate",
            total_before == 0,
            inputs={"action": "items.list", "after_preview": True},
            expected=0,
            actual=total_before,
            api="dispatch_platform_action(items.list)",
        ),
        check(
            "confirm_ok",
            created.get("ok") is True and bool(created.get("item")),
            inputs={"action": "items.create", "confirm": True, "args": create_args},
            expected={"ok": True, "item": "present"},
            actual={"ok": created.get("ok"), "item_id": (created.get("item") or {}).get("id")},
            api="dispatch_platform_action",
        ),
        check(
            "confirm_mutates",
            total_after >= 1,
            inputs={"action": "items.list", "after_confirm": True},
            expected=">=1",
            actual=total_after,
            api="dispatch_platform_action(items.list)",
        ),
    ]
    persist = [expect_user_item(item_id, title="确认后落库")] if item_id else []
    return finalize(
        assertions + persist,
        metrics={"total_after": total_after, "item_id": item_id},
        steps=[
            {"step": 1, "api": "items.create confirm=false", "result": preview},
            {"step": 2, "api": "items.list", "result": {"total": total_before}},
            {"step": 3, "api": "items.create confirm=true", "result": {"ok": created.get("ok")}},
            {"step": 4, "api": "items.list", "result": {"total": total_after}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
