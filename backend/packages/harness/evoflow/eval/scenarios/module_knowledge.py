"""Module scenario: 知识库 — vault + note CRUD (list/get/delete)."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_vault_setting


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import knowledge as knowledge_admin
    from evoflow.admin.errors import NotFoundError

    created = knowledge_admin.create_managed_vault(name="评测模块知识库")
    vault = created.get("vault") or created
    vault_id = str(vault.get("id") or created.get("vault_id") or created.get("id") or "").strip()

    listed = knowledge_admin.list_vaults()
    vault_ids = [
        str(v.get("id") or "")
        for v in (listed.get("items") or listed.get("vaults") or [])
        if isinstance(v, dict)
    ]

    saved = knowledge_admin.remember(
        {
            "title": "模块评测笔记",
            "knowledge": "知识库模块 CRUD 评测正文。",
            "content": "知识库模块 CRUD 评测正文。",
        },
        vault_id=vault_id or None,
    )
    note_path = ""
    if isinstance(saved, dict):
        note_path = str(
            (saved.get("result") or {}).get("path")
            or saved.get("path")
            or ""
        ).strip()

    listed_notes = knowledge_admin.list_knowledge(vault_id=vault_id or None, limit=50)
    entries = listed_notes.get("entries") or []
    entry_paths = [
        str(e.get("path") or e.get("id") or "")
        for e in entries
        if isinstance(e, dict)
    ]
    if not note_path and entry_paths:
        note_path = entry_paths[0]

    got = None
    get_err = ""
    if note_path:
        try:
            got = knowledge_admin.get_knowledge(note_path, vault_id=vault_id or None)
        except Exception as exc:  # noqa: BLE001
            get_err = str(exc)

    deleted = None
    gone = False
    if note_path:
        deleted = knowledge_admin.delete_knowledge(note_path, vault_id=vault_id or None)
        try:
            knowledge_admin.get_knowledge(note_path, vault_id=vault_id or None)
        except NotFoundError:
            gone = True
        except Exception:  # noqa: BLE001
            gone = True

    assertions = [
        check(
            "vault_created",
            bool(vault_id),
            inputs={"name": "评测模块知识库"},
            expected="非空 vault_id",
            actual=vault_id,
            api="knowledge_admin.create_managed_vault",
        ),
        check(
            "vault_listed",
            bool(vault_id) and vault_id in vault_ids,
            inputs={},
            expected=vault_id,
            actual=vault_ids[:20],
            api="knowledge_admin.list_vaults",
        ),
        check(
            "note_remembered",
            bool(note_path) and bool(saved.get("ok", True) if isinstance(saved, dict) else saved),
            inputs={"title": "模块评测笔记", "vault_id": vault_id},
            expected="非空 path",
            actual={"path": note_path, "via": saved.get("via") if isinstance(saved, dict) else None},
            api="knowledge_admin.remember",
        ),
        check(
            "note_listed",
            bool(note_path) and (note_path in entry_paths or int(listed_notes.get("total") or 0) >= 1),
            inputs={"vault_id": vault_id},
            expected=note_path or ">=1 notes",
            actual={"total": listed_notes.get("total"), "paths": entry_paths[:10]},
            api="knowledge_admin.list_knowledge",
        ),
        check(
            "note_get",
            got is not None and isinstance(got.get("item"), dict),
            inputs={"path": note_path, "vault_id": vault_id},
            expected="item present",
            actual={"has_item": bool(got and got.get("item")), "error": get_err},
            api="knowledge_admin.get_knowledge",
        ),
        check(
            "note_deleted",
            bool(deleted and deleted.get("ok")) and gone,
            inputs={"path": note_path, "vault_id": vault_id},
            expected={"ok": True, "gone": True},
            actual={"deleted": deleted, "gone": gone},
            api="knowledge_admin.delete_knowledge",
        ),
    ]
    persist = [expect_vault_setting(vault_id)] if vault_id else []
    return finalize(
        assertions + persist,
        metrics={"vault_id": vault_id, "note_path": note_path},
        steps=[
            {"step": 1, "api": "create_managed_vault", "result": {"vault_id": vault_id}},
            {"step": 2, "api": "list_vaults", "result": {"count": len(vault_ids)}},
            {"step": 3, "api": "remember", "result": {"path": note_path}},
            {"step": 4, "api": "list_knowledge / get_knowledge"},
            {"step": 5, "api": "delete_knowledge", "result": {"gone": gone}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
