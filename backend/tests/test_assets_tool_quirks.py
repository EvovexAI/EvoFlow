"""Asset Hub tool regressions found by the 2026-11-07 self-checks.

Defects that made the tool lie to its caller:
- ``write`` / ``delete`` / ``rename`` resolved to the **user** bucket while
  ``note`` / ``read`` resolved to the **employee** bucket — a write then looked
  like a successful no-op (the 发版记录 "退出码没有" case).
- ``profile`` silently edited the user's 用户画像 when told it was an employee.
- ``search`` treated a multi-word query as one literal substring → 0 hits,
  which reads as "I have no memory of this".
- ``note`` silently dropped an explicit ``path`` (kind owns the destination).
- ``rename`` left frontmatter ``name:`` pointing at the old filename.
- ``affect``/``write`` ``mode=replace`` wiped the ``source/mood/updated``
  frontmatter that the mood mirror writes.
- A multi-line note spliced its own ``## 小节`` into standing.md / USER.md.
Plus the naming rule: no ``记录时间-*.md``, no ``...-md.md`` double suffix.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.assets.paths import EntityRef, entity_root
from evoflow.assets.search import _norm_queries
from evoflow.config.paths import reset_paths_cache
from evoflow.tools.builtins import assets_tool as assets_mod


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    monkeypatch.setattr(assets_mod, "_principal_from_runtime", lambda _rt: "yin-tai")
    yield tmp_path
    reset_paths_cache()


def _runtime(*, agent: str = "main"):
    return SimpleNamespace(context={"agent_name": agent, "principal_id": "yin-tai"}, config={})


def _call(runtime, **kwargs):
    return json.loads(assets_mod.assets_tool.func(runtime=runtime, tool_call_id="t1", **kwargs))


# ---------------------------------------------------------------- search


def test_query_tokenizes_on_whitespace_and_commas() -> None:
    assert _norm_queries("工作流 运行 参数") == ["工作流", "运行", "参数"]
    assert _norm_queries("a, b，c") == ["a", "b", "c"]
    assert _norm_queries('"exact phrase" 别的词') == ["exact phrase", "别的词"]
    assert _norm_queries("") == []


def test_multiword_query_finds_assets(asset_home: Path) -> None:
    """Before: any query with a space returned zero matches."""
    rt = _runtime()
    created = _call(
        rt,
        action="note",
        kind="experience",
        content="# 海报改字与尺寸\n\n先看清原图，再图生图。",
        path="海报改字与尺寸",
    )
    assert created.get("ok") is True, created
    out = _call(rt, action="search", query="海报 尺寸", kinds="all")
    assert out.get("ok") is True, out
    assert [m["path"] for m in out["matches"]][:1] == [created["path"]], out["matches"]


def test_search_ranks_relevant_file_above_long_file(asset_home: Path) -> None:
    """A single big file used to eat the whole max_results budget by path order."""
    rt = _runtime()
    entity = EntityRef("user", "yin-tai")
    root = entity_root(entity.normalized())
    (root / "craft").mkdir(parents=True, exist_ok=True)
    noise = "\n".join(["工作流 noise line"] * 60)
    (root / "craft" / "a-噪声文件.md").write_text(f"# 噪声\n\n{noise}\n", encoding="utf-8")
    (root / "craft" / "z-运行参数.md").write_text("# 运行参数\n\n参数传值走 parameters。\n", encoding="utf-8")

    out = _call(rt, action="search", query="运行 参数", kinds="all", max_results=2)
    paths = [m["path"] for m in out.get("matches") or []]
    assert any("z-运行参数" in p for p in paths), paths


# ---------------------------------------------------------------- note


def test_note_reports_ignored_path(asset_home: Path) -> None:
    """kind decides the landing directory; a cross-kind path must not be dropped silently."""
    rt = _runtime()
    out = _call(
        rt,
        action="note",
        kind="preference",
        content="回复要简短。",
        path="craft/我想要-写在craft里.md",
    )
    assert out.get("ok") is True, out
    assert str(out.get("path")).startswith("memory/standing.md"), out
    assert out.get("ignoredPath") == "craft/我想要-写在craft里.md", out
    assert "已忽略" in out["hint"], out


def test_note_update_path_still_honored(asset_home: Path) -> None:
    """Same-directory updates keep working (only cross-kind paths are ignored)."""
    rt = _runtime()
    first = _call(rt, action="note", kind="reflection", content="# 复盘标题\n\n第一段。")
    rel = str(first.get("path") or "").replace("\\", "/")
    assert rel.startswith("memory/journal/"), rel
    second = _call(rt, action="note", kind="reflection", content="第二段。", path=rel)
    assert second.get("updated") is True, second
    assert second.get("ignoredPath") is None, second


def test_untagged_note_is_not_named_after_timestamp(asset_home: Path) -> None:
    """``记录时间-2026-11-07-22-02.md`` violates the naming rule (title must say what it is)."""
    rt = _runtime()
    out = _call(
        rt,
        action="note",
        kind="reflection",
        content="验证 journal 落点。测完删。",
    )
    rel = str(out.get("path") or "").replace("\\", "/")
    assert "记录时间" not in rel, rel
    assert "验证-journal-落点" in rel, rel


def test_note_with_heading_uses_heading(asset_home: Path) -> None:
    rt = _runtime()
    out = _call(rt, action="note", kind="process", content="# 工作流端到端跑通\n\n细节。")
    rel = str(out.get("path") or "").replace("\\", "/")
    assert "工作流端到端跑通" in rel, rel


# ---------------------------------------------------------------- rename


def test_rename_syncs_frontmatter_name(asset_home: Path) -> None:
    rt = _runtime()
    created = _call(
        rt,
        action="note",
        kind="experience",
        content="# 旧标题\n\n内容。",
        path="旧文件名",
    )
    rel = str(created.get("path") or "").replace("\\", "/")
    out = _call(rt, action="rename", path=rel, content="新文件名")
    assert out.get("ok") is True, out
    assert out.get("frontmatterSynced") is True, out
    new_rel = str(out.get("newPath") or "")
    text = (entity_root(EntityRef("user", "yin-tai").normalized()) / new_rel).read_text(encoding="utf-8")
    assert "name: 新文件名" in text, text
    assert "name: 旧文件名" not in text, text


# ---------------------------------------------------------------- affect


def test_affect_replace_keeps_frontmatter(asset_home: Path) -> None:
    rt = _runtime()
    first = _call(rt, action="affect", content="- 平静。", mode="replace")
    assert first.get("ok") is True, first
    path = entity_root(EntityRef("user", "yin-tai").normalized()) / "profile" / "affect.md"
    before = path.read_text(encoding="utf-8")
    assert before.startswith("---"), before

    out = _call(rt, action="affect", content="# 情感\n\n新的正文。", mode="replace")
    assert out.get("ok") is True, out
    after = path.read_text(encoding="utf-8")
    assert after.startswith("---"), after
    assert "source: person_affect" in after, after
    assert "mood:" in after, after
    assert "新的正文" in after, after
    assert "- 平静。" not in after, after


def test_affect_replace_respects_caller_frontmatter(asset_home: Path) -> None:
    rt = _runtime()
    _call(rt, action="affect", content="- 旧。", mode="replace")
    _call(
        rt,
        action="affect",
        content="---\nsource: custom\nmood: 期待\n---\n\n# 情感\n\n覆盖版。",
        mode="replace",
    )
    path = entity_root(EntityRef("user", "yin-tai").normalized()) / "profile" / "affect.md"
    text = path.read_text(encoding="utf-8")
    assert "source: custom" in text, text
    assert "mood: 期待" in text, text


def test_write_replace_on_affect_keeps_frontmatter(asset_home: Path) -> None:
    """Same trap via action=write (allowed path profile/affect.md)."""
    rt = _runtime()
    _call(rt, action="affect", content="- 旧心境。", mode="replace")
    out = _call(rt, action="write", path="profile/affect.md", content="# 情感\n\n重写。", mode="replace")
    assert out.get("ok") is True, out
    path = entity_root(EntityRef("user", "yin-tai").normalized()) / "profile" / "affect.md"
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---"), text
    assert "source: person_affect" in text, text
    assert "重写" in text, text


# ------------------------------------------------- entity routing (cross-bucket)


@pytest.fixture()
def employee_rt(monkeypatch: pytest.MonkeyPatch):
    """An employee session that is authenticated (principal set).

    ``is_employee_agent_name`` is DB-backed; pin it so routing is deterministic
    and the patch is reverted by monkeypatch (a module-level swap would leak into
    every later test file in the same pytest process).
    """
    from evoflow.assets import guidance

    code = "release-engineer"
    monkeypatch.setattr(guidance, "is_employee_agent_name", lambda n: str(n or "").lower() == code)
    monkeypatch.setattr(assets_mod, "_principal_from_runtime", lambda _rt: "admin")
    return SimpleNamespace(context={"agent_name": code, "principal_id": "admin"}, config={})


def test_write_delete_rename_use_the_same_bucket_as_note(asset_home: Path, employee_rt) -> None:
    """note landed in employees/<id>/ while write/delete/rename hit users/<pid>/.

    The tool therefore reported "written"/"deleted" against a different entity
    than the one it later read, which looked like a successful no-op.
    """
    rt = employee_rt
    seen = {}
    for act in ("note", "read", "search", "list", "write", "delete", "rename"):
        seen[act] = assets_mod._resolve_entity(rt, action=act, path="craft/x.md")
    buckets = {(e.entity_type, e.entity_id) for e in seen.values()}
    assert buckets == {("employee", "release-engineer")}, seen


def test_employee_write_then_read_same_file(asset_home: Path, employee_rt) -> None:
    rt = employee_rt
    written = _call(rt, action="write", path="craft/路由自检.md", content="# 路由自检\n\n应落在员工桶。")
    assert written.get("ok") is True, written
    read_back = _call(rt, action="read", path=str(written.get("path") or ""))
    assert read_back.get("ok") is True, read_back
    emp = entity_root(EntityRef("employee", "release-engineer").normalized())
    user = entity_root(EntityRef("user", "admin").normalized())
    assert (emp / "craft" / "路由自检.md").is_file()
    assert not (user / "craft" / "路由自检.md").exists()


def test_profile_rejects_employee_entity(asset_home: Path, employee_rt) -> None:
    """``profile`` always wrote the **user's** USER.md, even when told it was an
    employee profile update."""
    rt = employee_rt
    out = _call(
        rt,
        action="profile",
        content="员工档案",
        entity_type="employee",
        entity_id="release-engineer",
    )
    assert out.get("ok") is False, out
    assert "profile" in str(out.get("error")), out


def test_standing_note_does_not_create_new_sections(asset_home: Path, employee_rt) -> None:
    """A multi-line preference note must stay one bullet, not shred standing.md."""
    rt = employee_rt
    _call(
        rt,
        action="note",
        kind="preference",
        content="# 发版偏好\n\n## 版本号\n按仓库节奏走。\n",
    )
    standing = (entity_root(EntityRef("employee", "release-engineer").normalized()) / "memory" / "standing.md").read_text(encoding="utf-8")
    # The note's own heading must be demoted into the bullet (indented), never a
    # column-0 section of the long-term memory document.
    headings = [ln for ln in standing.splitlines() if re.match(r"^#{1,3}\s", ln)]
    assert all("版本号" not in h for h in headings), standing


def test_rename_syncs_machine_generated_title(asset_home: Path) -> None:
    """Journal/episodic notes carry ``title:`` (not ``name:``) and the catalog
    prefers it over the body H1 — renaming left the OLD label under the new file."""
    rt = _runtime()
    created = _call(rt, action="note", kind="reflection", content="# 旧标题机器生成\n\n正文。")
    rel = str(created.get("path") or "").replace("\\", "/")
    out = _call(rt, action="rename", path=rel, content="新标题机器生成")
    assert out.get("ok") is True, out
    assert out.get("frontmatterSynced") is True, out
    text = _call(rt, action="read", path=str(out.get("newPath") or ""))["content"]
    fm = text.split("---")[1]
    assert "title: 新标题机器生成" in fm, fm
    assert "旧标题机器生成" not in fm, fm
    # Body H1 is prose the author wrote — rename deliberately leaves it alone.


def test_rename_keeps_author_written_title(asset_home: Path) -> None:
    """A title that was never the filename is the author's — rename must not touch it."""
    rt = _runtime()
    root = entity_root(EntityRef("user", "yin-tai").normalized())
    (root / "memory" / "journal").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "journal" / "短文件名.md").write_text(
        "---\ntitle: 这是作者手写的长标题\n---\n\n正文。\n", encoding="utf-8"
    )
    out = _call(rt, action="rename", path="memory/journal/短文件名.md", content="改过的文件名")
    assert out.get("ok") is True, out
    assert out.get("frontmatterSynced") is False, out
    text = _call(rt, action="read", path=str(out.get("newPath") or ""))["content"]
    assert "title: 这是作者手写的长标题" in text, text


def test_titles_with_md_ext_do_not_double_suffix(asset_home: Path, employee_rt) -> None:
    rt = employee_rt
    out = _call(rt, action="note", kind="experience", content="# 发版一页纸 runbook.md\n\n步骤。")
    rel = str(out.get("path") or "").replace("\\", "/")
    assert rel.endswith("runbook.md"), rel
    assert "-md.md" not in rel, rel


# ---------------------------------------------------------------- list


def test_list_default_explains_scope(asset_home: Path) -> None:
    rt = _runtime()
    out = _call(rt, action="list")
    assert out.get("ok") is True, out
    assert "craft" in str(out.get("hint")), out
