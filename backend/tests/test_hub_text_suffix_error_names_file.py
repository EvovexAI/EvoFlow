"""``hub`` 的「只允许文本资产」拒绝文案必须点名文件与后缀。

【为什么有这份测试】2026-11-17 观测库里躺着 14 条 ``assets`` 写入失败，
其中 2026-11-17 09:56 那条（``kind='reflection'`` + 裸名）**挂了整整两天没人归因**。
原因不是没人看，而是报错原文只有一句：

    only text assets can be written via API

不带文件路径、不带它实际的后缀、也不说允许哪些后缀。看这条错误的人无法判断：
是路径越界？是后缀不对？是权限？——于是这 14 条全部沉底，直到第55轮我拿真实入参
复跑才撞出根因（write 分支补了 kind 目录却漏补 ``.md``）。

判据：同一个拒绝分支，报错正文必须同时含
  ① 被拒的相对路径  ② 它当前的后缀（或 ``(none)``）  ③ 允许的后缀清单。
反证：**正常后缀仍然必须写成功**——加信息不能变成加拦截。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.assets.hub import _TEXT_SUFFIXES, write_text_file
from evoflow.assets.paths import EntityRef, entity_root
from evoflow.config.paths import reset_paths_cache


@pytest.fixture()
def asset_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_paths_cache()
    yield tmp_path
    reset_paths_cache()


def _entity() -> EntityRef:
    return EntityRef("employee", "self-evolution-bot").normalized()


# 现网原件：第55轮实测时被真实工具入口拒掉的那个相对路径形态
REAL_REJECTED = "memory/journal/第31轮-接口报0件真因是函数没定义-我却先读了两轮判据"


def test_write_reject_error_names_the_file_and_its_suffix(asset_home: Path) -> None:
    """无后缀路径被拒时，报错必须点名该路径且说明后缀为 (none)。"""
    with pytest.raises(ValueError) as exc:
        write_text_file(_entity(), REAL_REJECTED, "正文")

    msg = str(exc.value)
    assert REAL_REJECTED in msg, msg
    assert "(none)" in msg, msg


def test_write_reject_error_lists_allowed_suffixes(asset_home: Path) -> None:
    """报错必须给出允许的后缀，否则调用方只能靠猜或读源码。"""
    with pytest.raises(ValueError) as exc:
        write_text_file(_entity(), REAL_REJECTED, "正文")

    msg = str(exc.value)
    for suffix in _TEXT_SUFFIXES:
        assert suffix in msg, f"{suffix} missing from: {msg}"


def test_write_reject_error_names_the_offending_suffix(asset_home: Path) -> None:
    """后缀存在但不允许时，报错要说出**那个**后缀，而不是只说 (none)。"""
    with pytest.raises(ValueError) as exc:
        write_text_file(_entity(), "memory/journal/导图.png", "正文")

    msg = str(exc.value)
    assert ".png" in msg, msg
    assert "导图.png" in msg, msg


@pytest.mark.parametrize("rel", [REAL_REJECTED, "memory/journal/x.txt", "craft/y.markdown"])
def test_upstream_suffix_retry_still_writes_after_error_text_change(
    asset_home: Path, rel: str
) -> None:
    """反证：改文案不能变成加拦截——补上 .md 后原路径必须写得进去。"""
    ok_rel = rel if Path(rel).suffix.lower() in _TEXT_SUFFIXES else rel + ".md"

    out = write_text_file(_entity(), ok_rel, "正文")

    assert out["content"] == "正文", out
    assert (entity_root(_entity()) / ok_rel).is_file()


def test_delete_reject_error_names_the_file(asset_home: Path) -> None:
    """同一根因的 delete 分支：拒绝时也要点名文件与后缀。

    注意顺序：delete 先查 ``is_file()`` 才查后缀，所以必须真的造一个
    「存在但后缀不在白名单」的文件，否则永远走不到这条拒绝分支
    （第33轮教训：测试走不到目标行等于没测）。
    """
    from evoflow.assets.hub import delete_text_file

    rel = "memory/journal/导图.png"
    target = entity_root(_entity()) / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"\x89PNG\r\n")
    assert target.is_file(), "夹具没造出来，后面的断言就没有意义"

    with pytest.raises(ValueError) as exc:
        delete_text_file(_entity(), rel)

    msg = str(exc.value)
    assert rel in msg, msg
    assert ".png" in msg, msg


def test_rename_reject_error_names_the_file(asset_home: Path) -> None:
    """rename 分支同源：拒绝时点名文件与后缀。"""
    from evoflow.assets.hub import rename_text_file

    rel = "memory/journal/导图.png"
    target = entity_root(_entity()) / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"\x89PNG\r\n")

    with pytest.raises(ValueError) as exc:
        rename_text_file(_entity(), rel, "新名.md")

    msg = str(exc.value)
    assert rel in msg, msg
    assert ".png" in msg, msg
