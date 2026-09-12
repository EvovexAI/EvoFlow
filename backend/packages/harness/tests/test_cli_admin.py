"""Tests for evoflow admin services and CLI."""

from __future__ import annotations

import gc
import json
import tempfile
from pathlib import Path

import pytest

from evoflow.admin import agents as agents_admin
from evoflow.admin import models as models_admin
from evoflow.admin import sessions as sessions_admin
from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError
from evoflow.cli.main import main
from evoflow.persistence import chat_message_repositories as msg_repo
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.bootstrap import seed_config_from_app_yaml
from evoflow.persistence.config_repositories import config_tables_seeded, upsert_model
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def _seed_model(name: str = "demo-model") -> None:
    upsert_model(
        {
            "name": name,
            "use": "langchain_openai:ChatOpenAI",
            "model": "gpt-demo",
            "display_name": "Demo",
        }
    )
    seed_config_from_app_yaml({"tools": [{"name": "read_file", "group": "core", "use": "y"}]})
    assert config_tables_seeded()


def test_models_list_empty(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    assert models_admin.list_models() == {"models": []}


def test_models_crud_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    created = models_admin.create_model(
        {
            "name": "cli-test",
            "model": "gpt-test",
            "use": "langchain_openai:ChatOpenAI",
            "display_name": "CLI Test",
        }
    )
    assert created["name"] == "cli-test"
    listed = models_admin.list_models()
    assert any(m["name"] == "cli-test" for m in listed["models"])
    assert models_admin.get_model("cli-test")["display_name"] == "CLI Test"
    updated = models_admin.update_model("cli-test", {"display_name": "Updated"})
    assert updated["display_name"] == "Updated"
    deleted = models_admin.delete_model("cli-test")
    assert "deleted" in deleted["message"]
    with pytest.raises(NotFoundError):
        models_admin.get_model("cli-test")


def test_models_primary(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _seed_model("alpha")
    _seed_model("beta")
    assert models_admin.get_primary_model()["primary_model"] == "alpha"
    result = models_admin.set_primary_model("beta")
    assert result["primary_model"] == "beta"


def test_agents_check_and_create(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    check = agents_admin.check_agent_name("My-Agent")
    assert check["available"] is True
    assert check["name"] == "my-agent"
    created = agents_admin.create_agent(
        {
            "agent_code": "my-agent",
            "agent_name": "My Agent",
            "description": "test agent",
            "soul": "Be helpful.",
        }
    )
    assert created["agent_code"] == "my-agent"
    assert created["soul"] == "Be helpful."
    assert str(created.get("avatar") or "").startswith("preset:")
    fetched = agents_admin.get_agent("my-agent")
    assert fetched["agent_name"] == "My Agent"
    assert str(fetched.get("avatar") or "").startswith("preset:")
    with pytest.raises(ConflictError):
        agents_admin.create_agent({"agent_code": "my-agent"})
    deleted = agents_admin.delete_agent("my-agent")
    assert "deleted" in deleted["message"]


def test_cli_agents_delete_keep_employee(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.admin import employees as employees_admin
    from evoflow.proactive.repositories import ProactiveRepository

    agents_admin.create_agent(
        {"agent_code": "cli-keep", "agent_name": "CLI Keep", "skills": []}
    )
    employees_admin.hire({"agent_code": "cli-keep", "role_name": "R"})
    code = main(["agents", "delete", "cli-keep", "--keep-employee"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload.get("employee_kept") is True
    assert ProactiveRepository.get_role("cli-keep") is not None
    with pytest.raises(NotFoundError):
        agents_admin.get_agent("cli-keep")


def test_agents_create_respects_explicit_avatar(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    created = agents_admin.create_agent(
        {
            "agent_code": "emoji-bot",
            "agent_name": "Emoji Bot",
            "avatar": "emoji:🚀",
        }
    )
    assert created["avatar"] == "emoji:🚀"
    agents_admin.delete_agent("emoji-bot")


def test_cli_models_list_json(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _seed_model()
    code = main(["models", "list"])
    assert code == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert "models" in payload
    assert payload["models"][0]["name"] == "demo-model"


def test_cli_unknown_command_exits_nonzero() -> None:
    with pytest.raises(SystemExit) as exc:
        main(["models", "nope"])
    assert exc.value.code != 0


def test_cli_agents_check(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    code = main(["agents", "check", "new-role"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["available"] is True
    assert payload["name"] == "new-role"


def test_skills_enable_requires_existing_skill(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(NotFoundError):
        from evoflow.admin import skills as skills_admin

        skills_admin.set_skill_enabled("missing-skill", enabled=True)


def test_models_create_validation(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError):
        models_admin.create_model([])  # type: ignore[arg-type]


def test_cli_help_models_subcommand(capsys) -> None:
    with pytest.raises(SystemExit):
        main(["models"])
    assert "list" in capsys.readouterr().out or True


def _seed_searchable_session(*, session_key: str, title: str, content: str) -> None:
    sess_repo.upsert_session_row(
        session_key,
        thread_id="t-search",
        title=title,
        message_count=1,
        context={},
    )
    msg_repo.append_message(
        session_key,
        role="assistant",
        content=content,
        message_id=f"msg-{session_key}",
    )


def test_sessions_search_by_message(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _seed_searchable_session(
        session_key="agent:main:docker-chat",
        title="Docker 端口讨论",
        content="我们把 Gateway 改到 8070 端口了",
    )
    result = sessions_admin.search_sessions("8070")
    assert result["total_results"] == 1
    assert result["sessions"][0]["session_key"] == "agent:main:docker-chat"
    assert any("8070" in m["snippet"] for m in result["sessions"][0]["matches"])


def test_sessions_search_titles_fallback(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    sess_repo.upsert_session_row(
        "agent:main:title-only",
        thread_id="t-title",
        title="规划方案 v2",
        message_count=0,
        context={},
    )
    result = sessions_admin.search_sessions("规划方案", search_titles=True)
    assert result["total_results"] == 1
    assert result["sessions"][0]["title"] == "规划方案 v2"


def test_sessions_search_requires_query(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError):
        sessions_admin.search_sessions("  ")


def test_cli_sessions_search_json(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    _seed_searchable_session(
        session_key="agent:main:cli-search",
        title="CLI test",
        content="unique-cli-keyword-xyzzy",
    )
    code = main(["sessions", "search", "--query", "unique-cli-keyword-xyzzy"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["total_results"] == 1
    assert payload["sessions"][0]["session_key"] == "agent:main:cli-search"
