"""L2 待办：priority/status 过滤 + park + done 隐藏."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_user_item


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import items as items_admin

    high = items_admin.create_item(
        title="L2待办-高优",
        notes="items detail high",
        priority="high",
        tags=["eval-l2"],
        status="todo",
    )
    low = items_admin.create_item(
        title="L2待办-低优",
        notes="items detail low",
        priority="low",
        tags=["eval-l2"],
        status="todo",
    )
    hid = str((high.get("item") or high).get("id") or "")
    lid = str((low.get("item") or low).get("id") or "")

    listed_high = items_admin.list_items(priority="high", q="L2待办", include_done=True)
    high_ids = [str(r.get("id") or "") for r in (listed_high.get("items") or []) if isinstance(r, dict)]

    parked = items_admin.update_item(hid, {"status": "parked"})
    park_status = str((parked.get("item") or parked).get("status") or "")
    listed_parked = items_admin.list_items(status="parked", q="L2待办", include_done=True)
    park_ids = [str(r.get("id") or "") for r in (listed_parked.get("items") or []) if isinstance(r, dict)]

    items_admin.update_item(lid, {"status": "done"})
    open_listed = items_admin.list_items(q="L2待办-低优", include_done=False)
    open_ids = [str(r.get("id") or "") for r in (open_listed.get("items") or []) if isinstance(r, dict)]
    done_get = items_admin.get_item(lid)
    done_status = str((done_get.get("item") or done_get).get("status") or "")

    assertions = [
        check(
            "priority_filter",
            hid in high_ids and lid not in high_ids,
            inputs={"priority": "high", "q": "L2待办"},
            expected={"include": hid, "exclude": lid},
            actual=high_ids[:20],
            api="items_admin.list_items",
        ),
        check(
            "park_status",
            park_status == "parked" and hid in park_ids,
            inputs={"item_id": hid, "status": "parked"},
            expected="parked + listed",
            actual={"status": park_status, "park_ids": park_ids[:10]},
            api="items_admin.update_item",
        ),
        check(
            "done_hidden_from_open_list",
            done_status == "done" and lid not in open_ids,
            inputs={"item_id": lid, "include_done": False},
            expected="done and excluded",
            actual={"status": done_status, "open_ids": open_ids[:10]},
            api="items_admin.list_items(include_done=False)",
        ),
    ]
    persist = [
        expect_user_item(hid, status="parked", title="L2待办-高优"),
        expect_user_item(lid, status="done", title="L2待办-低优"),
    ]
    return finalize(
        assertions + persist,
        metrics={"high_id": hid, "low_id": lid},
        steps=[
            {"step": 1, "api": "create_item high/low"},
            {"step": 2, "api": "list_items(priority=high)", "result": high_ids[:10]},
            {"step": 3, "api": "update parked / done", "result": {"park": park_status, "done": done_status}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
