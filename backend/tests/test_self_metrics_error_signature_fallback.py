"""``_error_signature_text``：error_message 为空时必须回落到工具返回原文头部。

【self-evolution-bot · 2026-11-19 · 第83轮 · 模型:deepseek-v4.1-flash-1017】新建。

为什么钉这一处
--------------
``error_message`` 这一列是 **11-16 才开始填充**的：现网实测 11-12~11-15 的非成功行里
空 message 分别是 92/24/61/3 条，11-16 起才是 0 条。只认 ``error_message`` 时，
11-16 之前的全部老错误都被压成 ``(无类型)``，于是任何「前半期 vs 后半期」对比
都会把老错误整片算成**新增**。本轮我正是被它骗了一次：

    表上写着 ``↑ assets · write_path_not_allowed  后半 14 次 / 前半 2 次``

换成 ``output_text`` 复核才发现前半期同样有 30 次，只是当时没写进 error_message。
**度量工具报假故障，比没有度量更坏**（同第19轮 guard 拦截被报成新故障那次）。

这三条测试同时钉住两个方向：
① 空 message 且头部是错误信封 → 必须能提出签名（否则又回到假新增）；
② 空 message 但头部是**正常内容**（比如文件正文里恰好有 "Error:" 字样）→ 必须提不出
   签名（宁可空签名，也不许造出假故障 —— 这是「探针自带过滤器判不存在」的反面）。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = (
    Path(__file__).resolve().parents[1] / "packages" / "harness" / "scripts" / "agent_self_metrics.py"
)


@pytest.fixture(scope="module")
def m():
    spec = importlib.util.spec_from_file_location("agent_self_metrics_sig", _SCRIPT)
    assert spec and spec.loader, f"度量脚本不在预期路径：{_SCRIPT}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_error_message_优先(m):
    r = {"error_message": "write_path_not_allowed", "output_head": '{"ok": false, "error": "x"}'}
    assert m._error_signature_text(r) == "write_path_not_allowed"


def test_message为空时回落到错误信封头部(m):
    """11-16 之前的行没有 error_message —— 不回落就等于「没发生」。"""
    r = {
        "error_message": "",
        "output_head": '{"ok": false, "error": "write_path_not_allowed", "hint": "wr',
    }
    assert "write_path_not_allowed" in m._error_signature_text(r)


def test_Error前缀的信封同样回落(m):
    r = {
        "error_message": None,
        "output_head": "Error: 工具「assets」不在本值班工具表中。值班无 deferred 激活；请只使用当前 t",
    }
    assert m._error_signature_text(r).startswith("Error:")


def test_正常内容不造签名(m):
    """返回正文里恰好出现 "Error:" 字样，不许被当成报错。"""
    r = {"error_message": "", "output_head": "# 某某配方\n这里讲 Error: 前缀怎么用\n"}
    assert m._error_signature_text(r) == ""


def test_空头部不造签名(m):
    assert m._error_signature_text({"error_message": "", "output_head": ""}) == ""


def test_签名函数吃得到回落文本(m):
    """端到端：_failure_signature 必须真的用上回落，而不是只让 helper 单测绿。"""
    rows = [
        {
            "tool_name": "assets",
            "status": "error",
            "error_type": "ToolReturnedError",
            "error_message": "",
            "output_head": '{"ok": false, "error": "write_path_not_allowed", "hint": "x"}',
        }
    ]
    sig = m._failure_signature(rows)
    joined = " | ".join(f"{k[0]}::{k[1]}" for k in sig)
    assert "write_path_not_allowed" in joined, f"回落没接到签名上：{joined}"


def test_成功行不进签名(m):
    rows = [
        {
            "tool_name": "assets",
            "status": "success",
            "error_type": None,
            "error_message": "",
            "output_head": '{"ok": false, "error": "write_path_not_allowed"}',
        }
    ]
    assert m._failure_signature(rows) == {}
