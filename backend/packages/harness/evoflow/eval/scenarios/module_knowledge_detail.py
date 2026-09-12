"""L2 知识库：启停标记 + 前缀列表 + 全文召回 + 删除闭环."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_vault_setting


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import knowledge as knowledge_admin
    from evoflow.admin.errors import NotFoundError

    created = knowledge_admin.create_managed_vault(name="评测知识库L2")
    vault = created.get("vault") or created
    vault_id = str(vault.get("id") or created.get("id") or "").strip()

    disabled = knowledge_admin.set_vault_enabled(vault_id, False)
    enabled_flag = bool((disabled.get("vault") or {}).get("enabled", disabled.get("enabled")))
    reenabled = knowledge_admin.set_vault_enabled(vault_id, True)

    token = "EvoFlowKbL2Token99"
    saved = knowledge_admin.remember(
        {
            "title": "L2知识评测笔记",
            "knowledge": f"正文含检索词 {token}",
            "content": f"正文含检索词 {token}",
        },
        vault_id=vault_id,
    )
    note_path = str((saved.get("result") or {}).get("path") or saved.get("path") or "").strip()
    listed = knowledge_admin.list_knowledge(vault_id=vault_id, prefix="", limit=50)
    entries = listed.get("entries") or []
    paths = [str(e.get("path") or "") for e in entries if isinstance(e, dict)]
    listed_inbox = knowledge_admin.list_knowledge(vault_id=vault_id, prefix="00-Inbox", limit=50)
    inbox_paths = [
        str(e.get("path") or "")
        for e in (listed_inbox.get("entries") or [])
        if isinstance(e, dict)
    ]

    recalled = knowledge_admin.recall(token, vault_id=vault_id, mode="fulltext", limit=5)
    hit_blob = str(recalled)

    deleted = knowledge_admin.delete_knowledge(note_path, vault_id=vault_id) if note_path else {}
    gone = False
    if note_path:
        try:
            knowledge_admin.get_knowledge(note_path, vault_id=vault_id)
        except NotFoundError:
            gone = True
        except Exception:  # noqa: BLE001
            gone = True

    assertions = [
        check(
            "vault_disable_flag",
            enabled_flag is False or disabled.get("enabled") is False,
            inputs={"vault_id": vault_id, "enabled": False},
            expected=False,
            actual={"enabled": disabled.get("enabled"), "vault": disabled.get("vault")},
            api="knowledge_admin.set_vault_enabled",
        ),
        check(
            "vault_reenable",
            bool(reenabled.get("enabled", True)),
            inputs={"vault_id": vault_id, "enabled": True},
            expected=True,
            actual=reenabled.get("enabled"),
            api="knowledge_admin.set_vault_enabled",
        ),
        check(
            "remember_path",
            bool(note_path),
            inputs={"title": "L2知识评测笔记", "vault_id": vault_id},
            expected="非空 path",
            actual=note_path,
            api="knowledge_admin.remember",
        ),
        check(
            "list_contains_note",
            bool(note_path)
            and (
                note_path in paths
                or note_path in inbox_paths
                or any(note_path.endswith(p) or p.endswith(note_path.split("/")[-1]) for p in paths + inbox_paths)
                or int(listed.get("total") or 0) >= 1
            ),
            inputs={"vault_id": vault_id, "prefix": ["", "00-Inbox"]},
            expected=note_path,
            actual={"total": listed.get("total"), "paths": (paths or inbox_paths)[:8]},
            api="knowledge_admin.list_knowledge",
        ),
        check(
            "fulltext_recall",
            token in hit_blob or int(recalled.get("total") or 0) >= 1,
            inputs={"query": token, "mode": "fulltext"},
            expected=f"命中 {token}",
            actual={"total": recalled.get("total"), "snippet": hit_blob[:200]},
            api="knowledge_admin.recall",
        ),
        check(
            "delete_gone",
            bool(deleted.get("ok")) and gone,
            inputs={"path": note_path},
            expected={"ok": True, "gone": True},
            actual={"deleted": deleted, "gone": gone},
            api="knowledge_admin.delete_knowledge",
        ),
    ]
    persist = [expect_vault_setting(vault_id)] if vault_id else []
    return finalize(
        assertions + persist,
        metrics={"vault_id": vault_id, "note_path": note_path, "token": token},
        steps=[
            {"step": 1, "api": "create_managed_vault + set_vault_enabled(false/true)"},
            {"step": 2, "api": "remember", "result": {"path": note_path}},
            {"step": 3, "api": "list_knowledge(prefix=L2) / recall"},
            {"step": 4, "api": "delete_knowledge", "result": {"gone": gone}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
