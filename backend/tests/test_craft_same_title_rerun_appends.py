"""craft 同标题重跑必须**追加进同一文件**，不许随机后缀另存孪生件。

【self-evolution-bot · 2026-11-17 · 第31轮】新建。

为什么：duty wrap-up 镜像每班次调 ``save_craft_note``（不带 update_path），同题第二次进来时
``_unique_rel_name`` 造出 ``X.md`` + ``X-a137.md`` 两份 H1 完全同文的配方。现网实测 craft/ 里
11 份「下游回执」主题文件互为近重复（含这对孪生），我本轮手工合并时才暴露写入端缺陷。
追加语义（第12轮）落地后，"防撞"的正当性只剩**标题不同文**这一种情况。

边界钉两条：
1) 同文命中 → updated=True、追加、不产生新文件；
2) slug 撞但标题不同文（48 字截断致撞）→ 仍另存，不吞另一篇。
"""

from __future__ import annotations

from evoflow.assets.hub import resolve_entity_file, save_craft_note
from evoflow.assets.paths import EntityRef


def _entity(tmp_path, monkeypatch) -> EntityRef:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    return EntityRef("employee", "probe")


def test_same_title_rerun_appends_instead_of_suffixed_twin(tmp_path, monkeypatch) -> None:
    e = _entity(tmp_path, monkeypatch)
    first = save_craft_note(e, title="下游回执验收闭环流程", content="第一段：复算 HEAD/Tag")
    rel = first["path"]

    # 模拟 wrap-up 下一班次：同标题、不带 update_path 重新写入
    second = save_craft_note(e, title="下游回执验收闭环流程", content="第二段：补充 ls-remote 实测")

    assert second["path"] == rel, f"同题重跑却另存了新文件: {second['path']}"
    assert second.get("updated") is True, second
    body = resolve_entity_file(e, rel).read_text(encoding="utf-8")
    assert "第一段：复算 HEAD/Tag" in body, "旧内容被吞"
    assert "第二段：补充 ls-remote 实测" in body, "新内容没进"
    assert "## 补充" in body
    # 反证目录里只有这一篇（没有 -xxxx 孪生）
    craft_dir = resolve_entity_file(e, "craft")
    twins = [p.name for p in craft_dir.glob("*.md") if p.name != f"{rel.split('/')[-1]}"]
    assert twins == [], f"同题重跑仍产生了孪生文件: {twins}"


def test_slug_collision_but_different_title_still_new_file(tmp_path, monkeypatch) -> None:
    e = _entity(tmp_path, monkeypatch)
    base = "甲" * 48  # _slug_cjk max_len=48：两标题 slug 截断后相同
    title_a = f"{base}·配方A"
    title_b = f"{base}·配方B"
    rel_a = save_craft_note(e, title=title_a, content="A 的内容")["path"]

    res_b = save_craft_note(e, title=title_b, content="B 的内容")

    assert res_b["path"] != rel_a, "slug 撞但标题不同文，不该并进 A 的文件"
    assert not res_b.get("updated"), res_b
    body_a = resolve_entity_file(e, rel_a).read_text(encoding="utf-8")
    assert "B 的内容" not in body_a, "B 被误追加进 A"
