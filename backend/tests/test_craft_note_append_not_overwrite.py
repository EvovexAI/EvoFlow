"""craft note 更新语义回归护栏：命中已有文件必须**追加**，不许整篇覆盖。

【fullstack-dev · 2026-11-15 · 第12轮】新建。

为什么单独建一个文件：``assets action=note kind=experience path=craft/x.md`` 的回执是 ``ok:true updated:true``，
但 ``hub.save_craft_note`` 走的是 ``save_craft_from_experience`` **整篇重建** —— 上一轮写的两段分析被吞掉。
工具说明写着「note 默认追加（mode=replace 才整份覆盖）」，实现与说明相反，属"静默丢数据还报成功"，
比同轮修的双标题更严重，所以单独钉住，防止下一个人把它"优化"回整篇重建。

注：新建时文件名取自标题 slug（``_unique_rel_name``），**不取自** update_path；所以"更新"必须先拿到
返回的 path 再回传，这也正是模型侧 ``assets note path=…`` 的用法。
"""

from __future__ import annotations

import pytest

from evoflow.assets.hub import resolve_entity_file, save_craft_note
from evoflow.assets.paths import EntityRef


@pytest.fixture()
def entity(tmp_path, monkeypatch) -> EntityRef:
    """隔离到 tmp：与本仓 test_asset_catalog_basename.py 同一套路（EVOFLOW_HOME + 清缓存）。

    【fullstack-dev · 2026-11-15 · 第12轮】写第一版时误用 ``EVOFLOW_PROFILE_DIR``（不存在的环境变量）
    且没清 paths 缓存 —— 那样跑会把探针文件写进我真实的 craft/ 目录。
    """
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    return EntityRef("employee", "probe")


def _body_of(entity: EntityRef, rel: str) -> str:
    return resolve_entity_file(entity, rel).read_text(encoding="utf-8")


def test_update_path_appends_and_keeps_old_content(entity: EntityRef) -> None:
    rel = save_craft_note(entity, title="配方甲", content="第一段：根因分析")["path"]

    res = save_craft_note(entity, title="配方甲", content="第二段：第12轮更正", update_path=rel)

    assert res.get("updated") is True, res
    assert res.get("appended") is True, res
    body = _body_of(entity, rel)
    assert "第一段：根因分析" in body, body  # 旧内容没被吞
    assert "第二段：第12轮更正" in body, body
    assert "## 补充" in body, body
    assert body.count("# 配方甲") <= 1, body  # 不因此再套一层标题


def test_update_path_keeps_frontmatter_stable(entity: EntityRef) -> None:
    rel = save_craft_note(entity, title="配方乙", content="旧")["path"]
    exp_id = [ln for ln in _body_of(entity, rel).splitlines() if ln.startswith("experience_id:")]

    save_craft_note(entity, title="配方乙", content="新", update_path=rel)

    after = _body_of(entity, rel)
    assert exp_id and exp_id[0] in after, after  # 引用键不被追加改写


def test_mode_replace_still_rebuilds(entity: EntityRef) -> None:
    rel = save_craft_note(entity, title="配方丙", content="要丢弃的旧内容")["path"]

    save_craft_note(entity, title="配方丙", content="整份覆盖", update_path=rel, mode="replace")

    body = _body_of(entity, rel)
    assert "要丢弃的旧内容" not in body, body
    assert "## 解决方案" in body, body


def test_update_path_missing_falls_back_to_new_file(entity: EntityRef) -> None:
    """update_path 指到不存在的路径：走新建分支，内容不丢，回执说清落在哪个 path。"""
    res = save_craft_note(entity, title="配方丁", content="正文", update_path="craft/does-not-exist.md")

    assert res["path"] == "craft/does-not-exist.md", res
    assert res.get("updated") is False, res
    assert "正文" in _body_of(entity, res["path"])
