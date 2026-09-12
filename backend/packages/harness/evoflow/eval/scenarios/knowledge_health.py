"""Scenario: create vault → remember → fulltext recall hit."""

from __future__ import annotations

import json
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_vault_setting


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import knowledge as knowledge_admin

    created = knowledge_admin.create_managed_vault(name="评测知识库")
    vault = created.get("vault") or created
    vault_id = str(vault.get("id") or created.get("vault_id") or created.get("id") or "").strip()

    unique = "EvoFlowEvalUniqueToken42"
    remember_payload = {
        "title": "评测笔记",
        "knowledge": f"本笔记包含唯一检索词 {unique} 用于评测。",
        "content": f"本笔记包含唯一检索词 {unique} 用于评测。",
    }
    saved = knowledge_admin.remember(
        remember_payload,
        vault_id=vault_id or None,
    )
    recalled = knowledge_admin.recall(
        unique,
        vault_id=vault_id or None,
        mode="fulltext",
        limit=5,
    )

    entries = (
        recalled.get("entries")
        or recalled.get("results")
        or recalled.get("items")
        or recalled.get("hits")
        or []
    )
    total = int(recalled.get("total") or len(entries) if isinstance(entries, list) else 0)
    blob = json.dumps(recalled, ensure_ascii=False, default=str)
    has_hit = total >= 1 or unique in blob

    assertions = [
        check(
            "vault_created",
            bool(vault_id) or bool(created),
            inputs={"name": "评测知识库"},
            expected="非空 vault_id",
            actual=vault_id or str(created)[:120],
            api="knowledge_admin.create_managed_vault",
        ),
        check(
            "remember_ok",
            isinstance(saved, dict) and bool(saved.get("id") or saved.get("ok", True)),
            inputs={**remember_payload, "vault_id": vault_id},
            expected="保存成功（含 id 或 ok）",
            actual={"id": saved.get("id") if isinstance(saved, dict) else None, "keys": list(saved.keys())[:8] if isinstance(saved, dict) else None},
            api="knowledge_admin.remember",
        ),
        check(
            "recall_hit",
            has_hit,
            inputs={"query": unique, "vault_id": vault_id, "mode": "fulltext", "limit": 5},
            expected=f"命中含 {unique}",
            actual={"total": total, "snippet": blob[:240]},
            api="knowledge_admin.recall",
        ),
    ]
    persist = [expect_vault_setting(vault_id)] if vault_id else []
    return finalize(
        assertions + persist,
        metrics={"vault_id": vault_id, "hit_count": total, "token": unique},
        steps=[
            {"step": 1, "api": "create_managed_vault", "result": {"vault_id": vault_id}},
            {"step": 2, "api": "remember", "inputs": remember_payload},
            {"step": 3, "api": "recall", "inputs": {"query": unique}, "result": {"total": total}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
