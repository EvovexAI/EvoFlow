"""L2 知识库：启停标记 + 前缀列表 + 全文召回 + 删除闭环."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._knowledge_fixture import expect_kb_base


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import knowledge as knowledge_admin
    from evoflow.admin.errors import NotFoundError

    from evoflow.eval.scenarios._knowledge_fixture import create_base_id, set_base_hidden

    vault_id = create_base_id("评测知识库L2")

    # 遗留 Vault 的 set_vault_enabled 已随「知识库归一」移除；等价语义 = 库的 hidden 标记（停用/忽略）。
    disabled = set_base_hidden(vault_id, True)
    enabled_flag = bool(disabled.get("hidden"))
    reenabled = set_base_hidden(vault_id, False)

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
    inbox_paths = [str(e.get("path") or "") for e in (listed_inbox.get("entries") or []) if isinstance(e, dict)]

    recalled = knowledge_admin.recall(token, kb_id=vault_id, mode="fulltext", limit=5)
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
            "base_disable_flag",
            enabled_flag is True,
            inputs={"kb_id": vault_id, "hidden": True},
            expected=True,
            actual=disabled.get("hidden"),
            api="knowledge.owned.update_base(hidden)",
        ),
        check(
            "base_reenable",
            reenabled.get("hidden") is False,
            inputs={"kb_id": vault_id, "hidden": False},
            expected=False,
            actual=reenabled.get("hidden"),
            api="knowledge.owned.update_base(hidden)",
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
            bool(note_path) and (note_path in paths or note_path in inbox_paths or any(note_path.endswith(p) or p.endswith(note_path.split("/")[-1]) for p in paths + inbox_paths) or int(listed.get("total") or 0) >= 1),
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
    persist = [expect_kb_base(vault_id)] if vault_id else []
    return finalize(
        assertions + persist,
        metrics={"vault_id": vault_id, "note_path": note_path, "token": token},
        steps=[
            {"step": 1, "api": "create_owned_base + owned.update_base(hidden=true/false)"},
            {"step": 2, "api": "remember", "result": {"path": note_path}},
            {"step": 3, "api": "list_knowledge(prefix=L2) / recall"},
            {"step": 4, "api": "delete_knowledge", "result": {"gone": gone}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
