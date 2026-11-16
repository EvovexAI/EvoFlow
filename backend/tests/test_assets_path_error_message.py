"""资产路径非法的报错必须点名「哪个字符」——第19轮实测踩坑后补的契约。

背景：``resolve_entity_file`` 原来对不合规路径只抛
``ValueError("invalid characters in path")``，不说哪个字符非法、也不说允许哪些。
2026-11-16 第19轮，我写 journal 文件名时带了 ``+``（``...-写了个20+-实测是13.md``），
连试 3 次路径才摸到规则，每次都是一句「invalid characters in path」，纯猜。

【self-evolution-bot · 2026-11-16 · 第19轮】
断言：① 非法路径的报错里要点名非法字符与允许集合；② 合法路径不受影响（反证，防误伤）。

fixture 沿用 ``tests/test_craft_note_append_not_overwrite.py`` 的隔离套路：
``monkeypatch.setenv("EVOFLOW_HOME", tmp)`` + ``reset_paths_cache()``，
否则会把探针写进我真实的 craft/ 目录。
"""

from __future__ import annotations

import pytest

from evoflow.assets.paths import EntityRef, resolve_entity_file


@pytest.fixture()
def entity(tmp_path, monkeypatch) -> EntityRef:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    return EntityRef("employee", "probe")


def test_illegal_char_is_named_in_error(entity: EntityRef) -> None:
    with pytest.raises(ValueError) as exc:
        resolve_entity_file(entity, "journal/写了个20+-实测是13.md")
    msg = str(exc.value)
    assert "+" in msg, f"报错未点名非法字符 '+': {msg}"
    assert "invalid characters in path" in msg


def test_illegal_colon_is_named(entity: EntityRef) -> None:
    with pytest.raises(ValueError) as exc:
        resolve_entity_file(entity, "journal/a:b.md")
    assert ":" in str(exc.value)


def test_error_lists_allowed_set(entity: EntityRef) -> None:
    with pytest.raises(ValueError) as exc:
        resolve_entity_file(entity, "journal/bad name.md")
    msg = str(exc.value)
    assert " " in msg
    assert "allowed" in msg.lower(), f"报错未给出允许字符集合: {msg}"


@pytest.mark.parametrize(
    "rel",
    [
        "journal/第19轮我写了个20-实测是13.md",
        "craft/本地自验证闭环-重装后自唤醒用法.md",
        "memory/journal/plain_name-1.md",
    ],
)
def test_legal_paths_unaffected(entity: EntityRef, rel: str) -> None:
    """反证：中文、数字、连字符、下划线、点、斜杠都必须照常通过。"""
    out = resolve_entity_file(entity, rel)
    assert out.name == rel.split("/")[-1]
