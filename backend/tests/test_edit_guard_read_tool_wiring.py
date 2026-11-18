"""接线测试：``read`` 工具真实入口 → 登记 → ``replace`` 守卫，端到端不许假绿。

【为什么单列一份】``test_edit_guard_crlf_stale.py`` 直接调 ``note_read``，
它只证明「我写的函数对」，不证明**真实的 read 工具会这么登记**。
第33/38 轮的教训：只测函数层，接线断了照样全绿。

这条测试必须走 ``read_file_hd`` 本体（@tool 包装后的 .func），
用现网受害者同型的 CRLF 文件，然后按 ``replace`` 的判据去问守卫。
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.tools.zcode_port.read_file_state import (
    edit_guard_failure,
    file_content_hash,
    note_read,
    reset_read_state,
)

read_mod = pytest.importorskip("evoflow.tools.host_direct.read_file")


@pytest.fixture(autouse=True)
def _clean_state():
    reset_read_state()
    yield
    reset_read_state()


def _runtime(tool_call_id: str = "t1"):
    return SimpleNamespace(tool_call_id=tool_call_id, context={"agent_name": "self-evolution-bot"}, config={})


def _crlf_py(tmp_path: Path) -> Path:
    p = tmp_path / "tree_sitter_core.py"  # 现网受害同型文件名
    p.write_bytes(b'"""doc"""\r\n\r\ndef f():\r\n    return 1\r\n')
    assert b"\r\n" in p.read_bytes()
    return p


def test_read工具登记的是磁盘原文哈希(tmp_path: Path) -> None:
    """核心接线：read 走完之后，登记的哈希必须等于磁盘原文哈希。

    修复前 read 记的是**渲染后**文本（CRLF 未归一化）的哈希，
    与守卫比对时用的磁盘原文哈希永远不等。
    """
    p = _crlf_py(tmp_path)

    out = read_mod.read_file_hd.func(path=str(p), runtime=_runtime())
    assert not str(out).startswith("Error:"), out

    # 登记口径必须与守卫一致
    from evoflow.tools.zcode_port import read_file_state as st

    with st._LOCK:
        entry = st._SEEN.get(str(p.resolve()))
    assert entry is not None, "read 之后必须有登记"
    assert entry.content_hash == file_content_hash(p), (
        "read 登记的哈希与磁盘原文哈希不一致 —— 守卫永远比不平"
    )


def test_read之后仅mtime变动_守卫必须放行(tmp_path: Path) -> None:
    """端到端：read → touch mtime（内容不变）→ replace 守卫必须放行。"""
    p = _crlf_py(tmp_path)
    out = read_mod.read_file_hd.func(path=str(p), runtime=_runtime())
    assert not str(out).startswith("Error:"), out

    before = p.read_bytes()
    time.sleep(0.01)
    os.utime(p, None)
    assert p.read_bytes() == before

    assert edit_guard_failure(p) is None


def test_read之后内容真变_守卫仍拦住(tmp_path: Path) -> None:
    """反证：接线通了不代表守卫废了，内容真改必须继续拦。"""
    p = _crlf_py(tmp_path)
    out = read_mod.read_file_hd.func(path=str(p), runtime=_runtime())
    assert not str(out).startswith("Error:"), out

    time.sleep(0.01)
    p.write_bytes(b"changed\r\n")
    os.utime(p, None)

    err = edit_guard_failure(p)
    assert err is not None and "modified since read" in err, err


def test_未经read直接编辑_仍判not_read(tmp_path: Path) -> None:
    """反证：修复没有绕过「必须先读」这条。"""
    p = _crlf_py(tmp_path)
    err = edit_guard_failure(p)
    assert err is not None and "has not been read yet" in err, err
