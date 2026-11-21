"""Ad-hoc notes: slug helpers + direct-write by tag (no inbox hop)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from evoflow.assets.ad_hoc_note import (
    build_ad_hoc_filename,
    ensure_body_recorded_at,
    title_from_body,
    validate_ad_hoc_filename,
    write_ad_hoc_note,
)
from evoflow.assets.paths import EntityRef, entity_root
from evoflow.config.paths import reset_paths_cache


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    yield tmp_path
    reset_paths_cache()


def test_filename_is_slug_only() -> None:
    name = build_ad_hoc_filename(slug_hint="Douyin Pipeline Fallback!")
    assert name == "douyin-pipeline-fallback.md"
    assert validate_ad_hoc_filename(name) is None
    assert validate_ad_hoc_filename("2026-10-19T15-40-00-legacy.md") is None
    assert validate_ad_hoc_filename("Bad Name.md") is not None


def test_ensure_body_recorded_at_fills_when_missing() -> None:
    when = datetime(2026, 3, 23, 16, 38)
    out = ensure_body_recorded_at(
        "[experience] 登录失败·token 过期\n\n先刷新 token 再重试。",
        when=when,
    )
    assert out.startswith("[experience] 登录失败·token 过期\n记录时间：2026-03-23 16:38\n")
    assert "先刷新 token" in out
    again = ensure_body_recorded_at(out, when=when)
    assert again.count("记录时间：") == 1


def test_ensure_body_recorded_at_skips_when_model_wrote_date() -> None:
    src = "[process] 周报\n\n日期：2026-03-20\n\n写完了。"
    assert ensure_body_recorded_at(src) == src


def test_experience_writes_craft_directly(asset_home: Path) -> None:
    entity = EntityRef("employee", "douyin-analyst")
    data = write_ad_hoc_note(
        entity,
        "image post fallback when API timed out",
        kind="experience",
        slug_hint="douyin-pipeline-image-post-fallback",
    )
    assert data.get("kind") == "craft"
    rel = str(data.get("path") or "").replace("\\", "/")
    assert rel.startswith("craft/")
    path = entity_root(entity) / rel
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    assert "image post fallback" in text or "记录时间" in text
    inbox = entity_root(entity) / "memory" / "_inbox" / "notes"
    assert not inbox.exists() or not any(inbox.glob("*.md"))


def test_process_writes_episodic_directly(asset_home: Path) -> None:
    entity = EntityRef("user", "u_trunc")
    data = write_ad_hoc_note(
        entity,
        "AIGC 反推师并入复刻师。\n\n依据细节。",
        kind="process",
        slug_hint="aigc-merge",
    )
    assert data.get("kind") == "episodic"
    rel = str(data.get("path") or "").replace("\\", "/")
    assert "memory/episodic/" in rel
    assert (entity_root(entity) / rel).is_file()


def test_process_same_title_creates_new_without_update_path(asset_home: Path) -> None:
    """Runtime must not auto-merge by title; only explicit update_path overwrites."""
    entity = EntityRef("user", "u_upd")
    first = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n旧方案：手动刷新。",
        kind="process",
        slug_hint="登录失败-token-过期",
    )
    rel1 = str(first.get("path") or "").replace("\\", "/")
    second = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n新方案：自动刷新后再重试。",
        kind="process",
        slug_hint="登录失败-token-过期",
    )
    rel2 = str(second.get("path") or "").replace("\\", "/")
    assert rel1 != rel2
    assert second.get("updated") is not True
    episodic = entity_root(entity) / "memory" / "episodic"
    assert len(list(episodic.glob("*.md"))) == 2


def test_process_update_path_overwrites(asset_home: Path) -> None:
    entity = EntityRef("user", "u_path")
    first = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n旧方案：手动刷新。",
        kind="process",
        slug_hint="登录失败-token-过期",
    )
    rel = str(first.get("path") or "").replace("\\", "/")
    second = write_ad_hoc_note(
        entity,
        "登录失败 token 过期\n\n新方案：自动刷新后再重试。",
        kind="process",
        update_path=rel,
    )
    assert str(second.get("path") or "").replace("\\", "/") == rel
    assert second.get("updated") is True
    text = (entity_root(entity) / rel).read_text(encoding="utf-8")
    assert "自动刷新" in text
    assert "手动刷新" not in text
    assert len(list((entity_root(entity) / "memory" / "episodic").glob("*.md"))) == 1


def test_craft_update_path_appends_not_overwrites(asset_home: Path) -> None:
    """【fullstack-dev · 2026-11-15 · 第12轮】改（原名 test_craft_update_path_overwrites）。

    为什么改名并加断言：note 更新 craft 此前是**整篇重建** —— 我按提示词里「往已有文件上追加一段」
    的规矩用它更新配方，上一轮写的两段分析被静默吞掉，回执还是 ok:true。
    现改为追加一节（``mode=replace`` 才整篇覆盖，见 test_craft_note_append_not_overwrite.py）。
    同型的「update_path 覆盖」在 episodic / journal 两处仍存在，本岗有意**未一并改**：
    那条「Runtime must not auto-merge by title」是他人钉住的意图，要动得先由总监确认。
    """
    entity = EntityRef("employee", "ops")
    first = write_ad_hoc_note(
        entity,
        "图片发帖 API 超时 fallback\n\n旧：直接失败。",
        kind="experience",
        slug_hint="图片发帖-api-超时-fallback",
    )
    rel = str(first.get("path") or "").replace("\\", "/")
    second = write_ad_hoc_note(
        entity,
        "图片发帖 API 超时 fallback\n\n新：改走本地缓存重试。",
        kind="experience",
        update_path=rel,
    )
    assert second.get("updated") is True
    assert str(second.get("path") or "").replace("\\", "/") == rel
    text = (entity_root(entity) / rel).read_text(encoding="utf-8")
    assert "本地缓存" in text
    assert "旧：直接失败。" in text, text  # 追加语义：旧内容必须在


def test_preference_appends_without_replace(asset_home: Path) -> None:
    entity = EntityRef("user", "u_pref")
    write_ad_hoc_note(entity, "默认用中文回复，简短结论先行。", kind="preference")
    second = write_ad_hoc_note(entity, "默认用中文回复，先给结论再展开细节。", kind="preference")
    assert second.get("updated") is not True
    standing = (entity_root(entity) / "memory" / "standing.md").read_text(encoding="utf-8")
    assert "简短结论先行" in standing
    assert "先给结论再展开" in standing


def test_preference_mode_replace_overwrites_standing(asset_home: Path) -> None:
    entity = EntityRef("user", "u_pref2")
    write_ad_hoc_note(entity, "旧偏好一条。", kind="preference")
    second = write_ad_hoc_note(
        entity,
        "v1\n\n## User preferences\n\n- 只要这一条新偏好。\n",
        kind="preference",
        mode="replace",
    )
    assert second.get("updated") is True
    standing = (entity_root(entity) / "memory" / "standing.md").read_text(encoding="utf-8")
    assert "只要这一条新偏好" in standing
    assert "旧偏好一条" not in standing


def test_title_from_body_keeps_date_prefixed_heading() -> None:
    """``# 2026-11-21 第106轮 —— …`` 是可读标题，不能被当成时间戳整行丢掉。

    【self-evolution-bot · 2026-11-21 · 第106轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：钉住 ``title_from_body`` 对「带日期前缀的 Markdown 标题」的处理。

    为什么（本轮自撞，工具与文件都不报错的那种缺陷）：我写了一条标题为
    ``# 2026-11-21 第106轮 —— 同一个「expand 跨会话」缺陷…`` 的复盘，
    本函数先 ``lstrip("# ")`` 得到 ``2026-11-21 第106轮 …``，随后被
    ``_BODY_HAS_TIME_RE.match``（含 ``\\b\\d{4}-\\d{2}-\\d{2}``）判成
    「这一行就是时间戳」整条跳过 —— 标题被丢，文件名退化成正文第一个通用小标题
    「根因（一句话）」，正是本函数文档里禁止的「看不出里面是什么」的命名。
    而 ``assets note`` 的返回只说 ``ok:true``，不会提示名字取错了。

    判据（四档，缺一档就会修出新问题）：
    1. 带日期的标题 → 剥掉日期前缀，保留剩余可读部分；
    2. 标题里只有日期（``# 2026-11-21``）→ 剩下为空，跳过它继续往下找；
    3. ``记录时间：…`` 打点行 + 真标题 → 取真标题（不能退化成时间戳名）；
    4. 正文里孤零零一行时间戳（无 ``#``）→ 仍然跳过（原行为必须守住）。
    """
    assert (
        title_from_body("# 2026-11-21 第106轮 —— 同一个 expand 跨会话 缺陷")
        == "第106轮 —— 同一个 expand 跨会话 缺陷"
    )
    # 只剩日期 → 该行无可用标题信息，回落到后面的行
    assert title_from_body("# 2026-11-21\n\n正文第一行") == "正文第一行"
    # 打点行在前、真标题在后
    assert title_from_body("记录时间：2026-11-21 14:06\n\n# 真标题") == "真标题"
    # 普通标题不受影响
    assert title_from_body("# 白写了第八轮") == "白写了第八轮"
    # 原行为：正文里单独一行时间戳要被跳过
    assert title_from_body("2026-11-21 14:06:41\n\n正文") == "正文"
