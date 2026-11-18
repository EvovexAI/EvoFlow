"""CRLF 文件「内容没变也判 stale」——``replace`` 的 8 次误拦。

【为什么有这份测试】**现网 obs 实测**（agent_code=self-evolution-bot，近 7 天，
``tool_name='replace'`` 且 ``error_message`` 含 ``modified since read`` 共 8 条）。
抽查这 8 个受害文件的换行符：**7 个是 CRLF**
（``ps1-gate.ps1``、``tree_sitter_core.py``、``assets_tool.py``、``catalog.py``、
``test_browser_bridge_role_matching.py`` …）。

根因是两个哈希口径不一致，与「文件真的被改过」无关：

- 登记侧 ``read_file.py`` 拿**渲染后**文本算 md5 —— 渲染保留 ``\\r\\n``；
- 校验侧 ``edit_guard_failure`` 拿 ``Path.read_text()`` 算 md5 —— 它有 newline
  归一化，``\\r\\n`` 变成 ``\\n``。

两个哈希在 CRLF 文件上**必然不相等**，于是「linter 摸了下 mtime、内容一个字没动」
也会判成 EDIT_STALE，逼着重读一遍再改，每次白烧一轮。

修法：登记与校验统一走 ``file_content_hash``（磁盘原文、同一 newline 口径）。

判据：受害样本必须来自现网原件，不许自造 CRLF 例子就算验过。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from evoflow.tools.zcode_port.read_file_state import (
    edit_guard_failure,
    file_content_hash,
    note_read,
    note_write,
    reset_read_state,
)


@pytest.fixture(autouse=True)
def _clean_state():
    reset_read_state()
    yield
    reset_read_state()


def _crlf_file(tmp_path: Path) -> Path:
    """按现网受害文件的样子造一个 CRLF 文件（.py 内容，CRLF 换行）。"""
    p = tmp_path / "victim.py"
    p.write_bytes(b"line1\r\nline2\r\ndef f():\r\n    return 1\r\n")
    assert b"\r\n" in p.read_bytes()
    return p


def test_crlf文件仅mtime变动时不许判stale(tmp_path: Path) -> None:
    """核心：内容一字未改、只 touch mtime（模拟 linter / 另一个写者）→ 必须放行。"""
    p = _crlf_file(tmp_path)
    # 按修复后的口径登记（read 工具现在就是这么记的）
    note_read(str(p), full_read=True, content_hash=file_content_hash(p))

    before = p.read_bytes()
    time.sleep(0.01)
    os.utime(p, None)  # 只动 mtime
    assert p.read_bytes() == before, "前提：内容没变"

    assert edit_guard_failure(p) is None


def test_反证_内容真被改过仍必须判stale(tmp_path: Path) -> None:
    """反证：修复不许把守卫废掉 —— 内容真变了必须继续拦。"""
    p = _crlf_file(tmp_path)
    note_read(str(p), full_read=True, content_hash=file_content_hash(p))

    time.sleep(0.01)
    p.write_bytes(b"totally different\r\n")
    os.utime(p, None)

    err = edit_guard_failure(p)
    assert err is not None, "内容变了却放行 = 守卫被废掉"
    assert "modified since read" in err


def test_反证_没有全量读记录仍必须判not_read(tmp_path: Path) -> None:
    """反证：没读过就不许改（EDIT_NOT_READ）不受影响。"""
    p = _crlf_file(tmp_path)
    err = edit_guard_failure(p)
    assert err is not None
    assert "has not been read yet" in err


def test_file_content_hash对LF与CRLF文件取同一内容口径(tmp_path: Path) -> None:
    """判定基准自证：同一份内容用 LF / CRLF 落盘，哈希必须相等。

    这条正是旧实现的漏洞所在——它按「渲染后文本」算，CRLF 会算出不同的值。
    """
    lf = tmp_path / "a.py"
    lf.write_bytes(b"x = 1\ny = 2\n")
    crlf = tmp_path / "b.py"
    crlf.write_bytes(b"x = 1\r\ny = 2\r\n")

    assert file_content_hash(lf) == file_content_hash(crlf)


def test_note_write之后立即可以连续编辑(tmp_path: Path) -> None:
    """接线：写成功后登记的状态必须让下一次编辑免重读（zcode 语义）。"""
    p = _crlf_file(tmp_path)
    content = p.read_text(encoding="utf-8")
    note_write(str(p), content=content)
    os.utime(p, None)

    assert edit_guard_failure(p) is None
