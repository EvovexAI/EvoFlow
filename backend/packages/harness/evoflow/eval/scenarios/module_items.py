"""Module scenario: 待办事项 — create/list/update(done) without dispatch."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_user_item


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import items as items_admin

    created = items_admin.create_item(
        title="模块评测待办",
        notes="items module scenario",
        priority="high",
        tags=["eval-module"],
    )
    item = created.get("item") or created
    item_id = str(item.get("id") or "")

    listed = items_admin.list_items(q="模块评测待办", priority="high", include_done=True)
    rows = listed.get("items") or listed.get("rows") or []
    if not isinstance(rows, list):
        rows = []
    ids = [str(r.get("id") or "") for r in rows if isinstance(r, dict)]

    updated = items_admin.update_item(item_id, {"status": "done"})
    after = items_admin.get_item(item_id)
    after_item = after.get("item") or after
    status = str(after_item.get("status") or (updated.get("item") or {}).get("status") or "")

    open_listed = items_admin.list_items(q="模块评测待办", include_done=False)
    open_rows = open_listed.get("items") or []
    open_ids = [str(r.get("id") or "") for r in open_rows if isinstance(r, dict)]

    assertions = [
        check(
            "item_created",
            bool(item_id),
            inputs={"title": "模块评测待办", "priority": "high", "tags": ["eval-module"]},
            expected="非空 item_id",
            actual=item_id,
            api="items_admin.create_item",
        ),
        check(
            "listed",
            item_id in ids,
            inputs={"q": "模块评测待办", "priority": "high"},
            expected=item_id,
            actual=ids[:20],
            api="items_admin.list_items",
        ),
        check(
            "marked_done",
            status == "done",
            inputs={"item_id": item_id, "patch": {"status": "done"}},
            expected="done",
            actual=status,
            api="items_admin.update_item",
        ),
        check(
            "hidden_when_include_done_false",
            item_id not in open_ids,
            inputs={"q": "模块评测待办", "include_done": False},
            expected=f"{item_id} excluded",
            actual=open_ids[:20],
            api="items_admin.list_items(include_done=False)",
        ),
    ]
    persist = [expect_user_item(item_id, status="done", title="模块评测待办")] if item_id else []
    return finalize(
        assertions + persist,
        metrics={"item_id": item_id, "status": status},
        steps=[
            {"step": 1, "api": "create_item", "result": {"item_id": item_id}},
            {"step": 2, "api": "list_items", "result": {"ids": ids[:10]}},
            {"step": 3, "api": "update_item(status=done)", "result": status},
            {"step": 4, "api": "list_items(include_done=False)", "result": open_ids[:10]},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
