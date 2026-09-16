"""Department catalog for smart employees."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.proactive.departments import DepartmentRepository
from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.repositories import ProactiveRepository
from evoflow.timeutil import utc_now_iso_z


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_department_crud_and_member_sync(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    now = utc_now_iso_z()
    for code, dept in (("alice", "增长"), ("bob", ""), ("carol", "增长")):
        ProactiveRepository.save_role(
            ProactiveRole(
                agent_code=code,
                role_name=code,
                department=dept,
                config=ProactiveRoleConfig(),
                status="active",
                created_at=now,
                updated_at=now,
            )
        )

    listed = DepartmentRepository.list_departments()
    names = {d["name"] for d in listed}
    assert "增长" in names
    growth = next(d for d in listed if d["name"] == "增长")
    assert growth["member_count"] == 2

    media = DepartmentRepository.create(name="媒体")
    assert media["name"] == "媒体"

    DepartmentRepository.set_members(media["id"], ["bob", "carol"])
    listed2 = DepartmentRepository.list_departments()
    media2 = next(d for d in listed2 if d["id"] == media["id"])
    assert {m["agent_code"] for m in media2["members"]} == {"bob", "carol"}
    growth2 = next(d for d in listed2 if d["name"] == "增长")
    assert growth2["member_count"] == 1
    assert growth2["members"][0]["agent_code"] == "alice"

    DepartmentRepository.rename(media["id"], name="内容中心")
    assert ProactiveRepository.get_role("bob").department == "内容中心"

    DepartmentRepository.delete(media["id"])
    assert ProactiveRepository.get_role("bob").department == ""
    assert all(d["name"] != "内容中心" for d in DepartmentRepository.list_departments())


def test_department_head_and_align_unmanaged(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    now = utc_now_iso_z()
    for code in ("lead", "a", "b"):
        ProactiveRepository.save_role(
            ProactiveRole(
                agent_code=code,
                role_name=code,
                department="研发",
                config=ProactiveRoleConfig(reports_to="outsider" if code == "b" else ""),
                status="active",
                created_at=now,
                updated_at=now,
            )
        )
    # outsider outside dept — b already reports to them
    ProactiveRepository.save_role(
        ProactiveRole(
            agent_code="outsider",
            role_name="outsider",
            department="",
            config=ProactiveRoleConfig(),
            status="active",
            created_at=now,
            updated_at=now,
        )
    )

    depts = DepartmentRepository.list_departments()
    rd = next(d for d in depts if d["name"] == "研发")
    assert rd["head_agent_code"] == ""

    updated = DepartmentRepository.set_head(
        rd["id"], head_agent_code="lead", align_unmanaged=True
    )
    assert updated["head_agent_code"] == "lead"
    assert updated["head_role_name"] == "lead"
    assert ProactiveRepository.get_role("a").config.reports_to == "lead"
    # already had a manager — leave alone
    assert ProactiveRepository.get_role("b").config.reports_to == "outsider"
    assert ProactiveRepository.get_role("lead").config.reports_to == ""

    # Removing head from members clears head
    DepartmentRepository.set_members(rd["id"], ["a", "b"])
    listed = DepartmentRepository.list_departments()
    rd2 = next(d for d in listed if d["id"] == rd["id"])
    assert rd2["head_agent_code"] == ""
    assert {m["agent_code"] for m in rd2["members"]} == {"a", "b"}

    # Head must be a member
    try:
        DepartmentRepository.set_head(rd["id"], head_agent_code="lead")
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "本部门成员" in str(e)