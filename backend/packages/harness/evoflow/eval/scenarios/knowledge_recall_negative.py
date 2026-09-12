"""Knowledge negative: empty query + unknown vault must fail loudly & safely."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_vault_setting


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import knowledge as knowledge_admin
    from evoflow.admin.errors import NotFoundError, ValidationError

    created = knowledge_admin.create_managed_vault(name="评测负例知识库")
    vault = created.get("vault") or created
    vault_id = str(
        vault.get("id") or created.get("vault_id") or created.get("id") or ""
    ).strip()

    empty_err = ""
    empty_ok = False
    try:
        knowledge_admin.recall("", vault_id=vault_id or None, mode="fulltext", limit=5)
        empty_err = "returned without ValidationError"
    except ValidationError as exc:
        empty_ok = True
        empty_err = str(exc)[:200]
    except Exception as exc:  # noqa: BLE001
        empty_err = f"{type(exc).__name__}: {exc}"[:200]

    fake_vault = "vault_does_not_exist_eval_xx"
    fake_err = ""
    fake_ok = False
    try:
        knowledge_admin.recall("anything", vault_id=fake_vault, mode="fulltext", limit=5)
        fake_err = "returned without NotFoundError"
    except NotFoundError as exc:
        fake_ok = True
        fake_err = str(exc)[:200]
    except Exception as exc:  # noqa: BLE001
        fake_err = f"{type(exc).__name__}: {exc}"[:200]

    assertions = [
        check(
            "vault_ready",
            bool(vault_id),
            inputs={"name": "评测负例知识库"},
            expected="非空 vault_id",
            actual=vault_id,
            api="knowledge_admin.create_managed_vault",
        ),
        check(
            "empty_query_rejected",
            empty_ok,
            inputs={"query": "", "vault_id": vault_id},
            expected="ValidationError(query is required)",
            actual=empty_err,
            api="knowledge_admin.recall",
        ),
        check(
            "unknown_vault_not_found",
            fake_ok,
            inputs={"query": "anything", "vault_id": fake_vault},
            expected="NotFoundError(Vault … not found)",
            actual=fake_err,
            api="knowledge_admin.recall",
        ),
    ]
    persist = [expect_vault_setting(vault_id)] if vault_id else []
    return finalize(
        assertions + persist,
        metrics={"vault_id": vault_id},
        steps=[
            {"step": 1, "module": "knowledge", "api": "create_managed_vault", "vault_id": vault_id},
            {"step": 2, "module": "knowledge", "api": "recall(empty) → ValidationError"},
            {"step": 3, "module": "knowledge", "api": "recall(unknown vault) → NotFoundError"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
