"""资产中心后台修复的回归测试：

- 用量 ledger：touch 只写 sidecar，不改写内容文件；计数累计并与 frontmatter 合并
- journal 并发追加不丢内容（路径锁）
- 对话工具层隔离：跨员工读/写拒绝、workspace 归属校验
- 多用户桶清洗不再碰撞
- apply 的 profile 按目标实体类型过滤
"""

from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.assets.apply import apply_assets_to_entity
from evoflow.assets.hub import record_fact, write_journal
from evoflow.assets.paths import EntityRef, entity_root, sanitize_user_asset_id
from evoflow.assets.usage import read_usage_meta, touch_asset_usage
from evoflow.config.paths import reset_paths_cache
from evoflow.tools.builtins.assets_tool import _resolve_entity


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    yield tmp_path
    reset_paths_cache()


def _runtime(agent: str = "", workspace: str = ""):
    ctx: dict = {}
    if agent:
        ctx["proactive_agent_code"] = agent
    if workspace:
        ctx["workspace_path"] = workspace
    return SimpleNamespace(context=ctx)


# ── 用量 ledger ─────────────────────────────────────────────────────


def test_usage_touch_keeps_content_file_untouched(asset_home: Path) -> None:
    ent = EntityRef("user", "user")
    data = record_fact(ent, "用 uv 管理依赖", title="开发环境偏好")
    rel = str(data.get("path") or "")
    target = entity_root(ent) / rel
    before_content = target.read_text(encoding="utf-8")
    before_mtime = target.stat().st_mtime_ns

    assert touch_asset_usage(ent, rel) is True
    assert touch_asset_usage(ent, rel) is True

    # 内容文件一个字节都没动（旧实现会整文件重写 frontmatter）
    assert target.read_text(encoding="utf-8") == before_content
    assert target.stat().st_mtime_ns == before_mtime
    # ledger 落在 sidecar（点前缀），计数累计
    ledger = entity_root(ent) / "memory" / ".usage-ledger.json"
    assert ledger.is_file()
    meta = read_usage_meta(ent, rel)
    assert meta["use_count"] == "2"
    assert meta["last_used_at"]


def test_journal_concurrent_append_keeps_all_entries(asset_home: Path) -> None:
    ent = EntityRef("user", "user")
    n = 6
    threads = [
        threading.Thread(target=lambda i=i: write_journal(ent, f"第{i}条内容", date="2026-01-01"))
        for i in range(n)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    text = (entity_root(ent) / "memory" / "journal" / "20260101.md").read_text(encoding="utf-8")
    for i in range(n):
        assert f"第{i}条内容" in text


# ── 对话工具层隔离 ──────────────────────────────────────────────────


def test_cross_employee_read_rejected(asset_home: Path) -> None:
    rt = _runtime(agent="emp-a")
    # 自己的树放行
    own = _resolve_entity(rt, entity_type="employee", entity_id="emp-a", action="read", path="memory/x.md")
    assert own.entity_id == "emp-a"
    # 他人：读/列表/检索拒绝
    with pytest.raises(PermissionError):
        _resolve_entity(rt, entity_type="employee", entity_id="emp-b", action="read", path="memory/x.md")
    with pytest.raises(PermissionError):
        _resolve_entity(rt, entity_type="employee", entity_id="emp-b", action="search")
    # 写入重定向到当前员工自己的树（保持既有行为）
    note = _resolve_entity(rt, entity_type="employee", entity_id="emp-b", action="note")
    assert note.entity_id == "emp-a"
    # 无员工身份的会话不允许显式指定他人员工
    with pytest.raises(PermissionError):
        _resolve_entity(_runtime(), entity_type="employee", entity_id="emp-b", action="read")
    with pytest.raises(PermissionError):
        _resolve_entity(_runtime(), entity_type="employee", entity_id="emp-b", action="note")


def test_workspace_entity_requires_session_binding(asset_home: Path, tmp_path: Path) -> None:
    proj_a = tmp_path / "proj-a"
    proj_b = tmp_path / "proj-b"
    proj_a.mkdir()
    proj_b.mkdir()
    # 会话绑定 proj-a：自己的项目放行
    own = _resolve_entity(_runtime(workspace=str(proj_a)), scope="workspace", entity_id=str(proj_a))
    assert own.entity_type == "workspace"
    # 其他项目拒绝
    with pytest.raises(PermissionError):
        _resolve_entity(_runtime(workspace=str(proj_a)), scope="workspace", entity_id=str(proj_b))
    # 会话没有绑定工作区时不允许指定
    with pytest.raises(PermissionError):
        _resolve_entity(_runtime(), scope="workspace", entity_id=str(proj_b))


# ── 多用户桶清洗 ────────────────────────────────────────────────────


def test_sanitized_user_buckets_do_not_collide() -> None:
    assert sanitize_user_asset_id("a.b") != sanitize_user_asset_id("a_b")
    assert sanitize_user_asset_id("a.b") != sanitize_user_asset_id("a-b")
    # 已是合法段的历史 id 保持稳定（不迁移既有桶）
    assert sanitize_user_asset_id("simple-user") == "simple-user"
    assert sanitize_user_asset_id("user") == "user"


# ── apply profile 过滤 ──────────────────────────────────────────────


def test_apply_profile_filters_by_target_entity(asset_home: Path) -> None:
    src = EntityRef("employee", "emp-src")
    dst = EntityRef("employee", "emp-dst")
    src_profile = entity_root(src) / "profile"
    src_profile.mkdir(parents=True, exist_ok=True)
    (src_profile / "SOUL.md").write_text("# SOUL\n\n源员工人格\n", encoding="utf-8")
    (src_profile / "basic-info.md").write_text("# 不属于员工画像集的死文件\n", encoding="utf-8")

    res = apply_assets_to_entity(src, dst, scopes=["profile"], conflict="overwrite")
    dst_profile = entity_root(dst) / "profile"
    assert (dst_profile / "SOUL.md").is_file()
    assert not (dst_profile / "basic-info.md").exists()
    detail = next(d for d in res["details"] if d["scope"] == "profile")
    assert detail["action"] in {"merged", "copied", "overwritten"}
    # frontmatter 的 entity 归属重写为目标员工（若源文件带 frontmatter）
    soul = (dst_profile / "SOUL.md").read_text(encoding="utf-8")
    assert "emp-dst" in soul or "entity_id" not in soul
