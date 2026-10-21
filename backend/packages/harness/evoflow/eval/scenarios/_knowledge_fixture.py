"""Shared knowledge-base fixture for eval scenarios.

背景（2026-10-21）：知识库在 1.0.7「知识库归一」后整体改名为 owned base，
``evoflow.admin.knowledge`` 不再提供 ``create_managed_vault`` / ``list_vaults`` /
``set_vault_enabled``（遗留 Obsidian Vault 已移除）。多个场景仍在调用旧 API，
导致 4 个 P0/P1 场景在第一步就 AttributeError 报 error、整条 smoke 通过率被拉低。

本模块把「建库 + 取 kb_id」收敛到一处，场景只依赖当前真实 API；
未来知识库 API 再调整时只改这一个文件。
"""

from __future__ import annotations

from typing import Any, Callable

from evoflow.eval.scenarios._harness import Assertion


def create_base(name: str, description: str = "") -> dict:
    """Create a platform-owned knowledge base and return the raw service payload."""
    from evoflow.admin import knowledge as knowledge_admin

    return knowledge_admin.create_owned_base(name=name, description=description)


def create_base_id(name: str, description: str = "") -> str:
    """Create a platform-owned knowledge base and return its ``kb_id``."""
    created = create_base(name, description)
    base = created.get("base") or {}
    return str(created.get("kbId") or base.get("id") or "").strip()


def ensure_base(name: str, *, limit: int = 200) -> str:
    """Return an existing owned base id with the same name, or create one."""
    from evoflow.admin import knowledge as knowledge_admin

    try:
        listed = knowledge_admin.list_bases()
    except Exception:  # noqa: BLE001 — 列表失败不阻断建库
        listed = {}
    rows = []
    for key in ("bases", "items", "vaults", "knowledge_bases"):
        value = listed.get(key) if isinstance(listed, dict) else None
        if isinstance(value, list) and value:
            rows = value
            break
    for row in rows:
        if not isinstance(row, dict):
            continue
        if str(row.get("name") or "").strip() != name:
            continue
        kb_id = str(row.get("id") or row.get("kbId") or "").strip()
        if kb_id:
            return kb_id
    return create_base_id(name)


def set_base_hidden(kb_id: str, hidden: bool) -> dict:
    """Hide/unhide an owned knowledge base.

    ``admin.knowledge`` 没有 set_vault_enabled 的等价封装（遗留 Vault 的启停语义已
    落在 owned base 的 ``hidden`` 标记上），这里直接调 owned service。
    """
    from evoflow.knowledge.owned import service as owned_service

    owned_service.update_base(kb_id, {"hidden": bool(hidden)})
    base = owned_service.get_base(kb_id) or {}
    return {"ok": True, "kbId": kb_id, "hidden": bool(base.get("hidden", hidden)), "base": base}


def safe(call: Callable[[], object], default=None):
    """Best-effort execute a knowledge admin call (used for optional cleanup)."""
    try:
        return call()
    except Exception:  # noqa: BLE001
        return default


def expect_kb_base(vault_id: str) -> Assertion:
    """Assert the owned knowledge base is durable (file store + owned.sqlite row).

    注意：其中有
    `kb_bases` 在 ``owned.sqlite``（独立库，不归 eval 的 sqlite helper），
    必须用 owned 自己的连接查，不能走 ``db_one``。
    """
    from evoflow.eval.scenarios._harness import check as _check

    base_row: dict[str, Any] | None = None
    list_err = ""
    try:
        from evoflow.knowledge.owned.db import db as owned_db

        with owned_db() as conn:
            row = conn.execute(
                "SELECT id, name FROM kb_bases WHERE id=? AND deleted_at IS NULL", (vault_id,)
            ).fetchone()
        base_row = dict(row) if row is not None else None
    except Exception as exc:  # noqa: BLE001
        list_err = str(exc)

    storage_ok = False
    try:
        from evoflow.admin import knowledge as knowledge_admin

        listed = knowledge_admin.list_bases()
        storage_ok = any(
            str((b or {}).get("id") or "") == vault_id
            for b in (listed.get("items") or [])
            if isinstance(b, dict)
        )
    except Exception:  # noqa: BLE001
        storage_ok = False

    return _check(
        f"kb_base_persisted_{vault_id}",
        bool(base_row) and storage_ok,
        inputs={"vault_id": vault_id, "planes": ["owned.sqlite:kb_bases", "admin.list_bases"]},
        expected={"kb_bases_row": vault_id, "in_list_bases": True},
        actual={"row": base_row, "in_list_bases": storage_ok, "error": list_err},
        api="db.kb_bases + knowledge.list_bases",
        plane="json_store",
    )
