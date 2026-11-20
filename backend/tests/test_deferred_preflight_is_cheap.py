"""延后 preflight 必须**又轻又不占请求路径** —— 两条缺一不可。

【self-evolution-bot · 2026-11-20 · 第70轮 · 模型:deepseek-v4.1-flash-1017】

事故（2026-11-20 07:32:17→07:37:31）：`run_deferred_full_preflight` 对 3 个库
跑全量 `PRAGMA integrity_check` + `wal_checkpoint(TRUNCATE)`（evoflow.db 3.14GB、
observability.db 2.46GB），独占默认线程池 **5 分 14 秒**。同一窗口：

    /api/tasks                  排队 10s → tasks_catalog_timeout → 503
    /api/mcp/config             正常 47ms，实际等到 26s
    /api/knowledge/owned/bases  7.7s

第36轮已记录过的教训：**「差值消失只能说明不再排队，不能说明路径变轻」**。
所以只把 preflight 挪到专用池是半个修复 —— 5 分钟的重活仍在，只是换了个池子堵。
本测试钉死后半边：延后 preflight 不得使用 full `integrity_check`，也不得 TRUNCATE。

实测对照（2026-11-20，只读打开）：
    evoflow.db       3217MB  quick_check  9441ms
    observability.db 2460MB  quick_check 13366ms
    vs full integrity_check + TRUNCATE   ≈314s（即那段日志空窗）
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

_DB_PY = (
    Path(__file__).resolve().parents[1]
    / "packages/harness/evoflow/persistence/db.py"
)


def _func_source(name: str) -> str:
    """取 db.py 里某个函数（含装饰器前）的源码文本。

    用 ast 定位而不是正则匹配 `def name`：注释里出现同名文字（本仓注释大量
    引用符号名）会让正则版假命中，正是我反复踩的「判据先剥注释」那一类。
    """
    src = _DB_PY.read_text(encoding="utf-8")
    tree = ast.parse(src)
    lines = src.splitlines(keepends=True)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            start = node.lineno - 1
            end = node.end_lineno or start + 1
            # 按 AST 行号精确跳过 docstring 节点（不能靠字符串替换：docstring 会被
            # dedent，与源码缩进不一致，替换必然落空 —— 我第一版就栽在这里，
            # 把 docstring 里的 "integrity_check" 当成代码判违规）。
            skip: set[int] = set()
            body_nodes = node.body
            if (
                body_nodes
                and isinstance(body_nodes[0], ast.Expr)
                and isinstance(body_nodes[0].value, ast.Constant)
                and isinstance(body_nodes[0].value.value, str)
            ):
                ds = body_nodes[0]
                skip = set(range(ds.lineno - 1, (ds.end_lineno or ds.lineno)))
            kept = [
                lines[i]
                for i in range(start, end)
                if i not in skip and not lines[i].lstrip().startswith("#")
            ]
            return "".join(kept)
    raise AssertionError(f"db.py 里没有函数 {name}")


def test_deferred_preflight_does_not_use_full_integrity_check() -> None:
    """延后 preflight 本体不得跑 `PRAGMA integrity_check`（O(全库) 扫描）。"""
    body = _func_source("preflight_database_deferred")
    assert "integrity_check" not in body, (
        "延后 preflight 又用回全量 integrity_check 了。\n"
        "现网代价：5.6GB 两个库 ≈314 秒独占，期间 /api/tasks 直接 503。\n"
        "改用 quick_check（实测 9~13s）；确需全量请用 "
        "EVOFLOW_STARTUP_DB_PREFLIGHT=full 显式开启。"
    )


def test_deferred_preflight_does_not_truncate_wal() -> None:
    """延后 preflight 不得用 TRUNCATE checkpoint —— 那会与写方互锁。"""
    body = _func_source("preflight_database_deferred")
    assert "_wal_checkpoint_truncate" not in body, (
        "延后 preflight 又用回 TRUNCATE checkpoint 了；"
        "它与写繁忙互锁（busy 时等满 timeout），后台路径应只用 PASSIVE。"
    )
    assert "_wal_checkpoint_passive" in body, (
        "延后 preflight 没有跑 PASSIVE checkpoint；"
        "WAL 会随运行持续膨胀（磁盘回收由 retention 的尺寸保险负责）。"
    )


def test_deferred_preflight_skips_telemetry_db_by_default() -> None:
    """遥测库默认可丢弃，不应每次启动都扫它的 2.4GB。"""
    body = _func_source("preflight_database_deferred")
    assert "_skip_observability_startup_preflight" in body, (
        "延后 preflight 没保留「遥测库可跳过」的开关读取，"
        "会退化成每次启动全扫 observability.db。"
    )


def test_deferred_preflight_has_full_escape_hatch() -> None:
    """降级必须留逃生舱：显式要求全量时仍能跑老的 integrity_check。"""
    body = _func_source("preflight_database_deferred")
    assert 'mode == "full"' in body, (
        "没有 EVOFLOW_STARTUP_DB_PREFLIGHT=full 的逃生分支 —— "
        "一旦真怀疑库损坏就没有全量检查手段了。"
    )
    assert "preflight_database(path, label=label)" in body, (
        "full 分支没有真的调用 preflight_database，逃生舱是空壳。"
    )


def test_deferred_preflight_is_actually_used() -> None:
    """函数存在 ≠ 它被接线。第16轮教训：声明处/使用处/落盘处要数三遍。"""
    body = _func_source("run_deferred_full_preflight")
    assert "preflight_database_deferred(" in body, (
        "run_deferred_full_preflight 没有调用轻量版 —— "
        "新函数写好了但没人用（典型的「测函数不测接线」）。"
    )
    assert "preflight_database(" not in body.replace(
        "preflight_database_deferred(", ""
    ), (
        "run_deferred_full_preflight 里还残留对重量级 preflight_database 的直调。"
    )


# ---------------------------------------------------------------------------
# 反向验证：判据自身必须能红
# ---------------------------------------------------------------------------


def test_reverse_check_rejects_heavy_body() -> None:
    """喂一段必然违规的实现，判据必须抓到 —— 否则本测试只是在测自己语法没写错。

    这段是**事故原样**：full integrity_check + TRUNCATE。
    """
    src = _DB_PY.read_text(encoding="utf-8")
    tree = ast.parse(src)
    heavy = None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "preflight_database":
            lines = src.splitlines(keepends=True)
            heavy = "".join(lines[node.lineno - 1 : node.end_lineno])
            break
    assert heavy is not None
    # 老的重量级实现里必须同时含这两个符号，否则说明我认错了函数
    assert "integrity_check" in heavy
    assert "_wal_checkpoint_truncate" in heavy


@pytest.mark.parametrize("needle", ["integrity_check", "_wal_checkpoint_truncate"])
def test_assertion_helper_can_detect(needle: str) -> None:
    """确认断言用的子串真的会在违规实现里出现（防止判据恒真）。"""
    src = _DB_PY.read_text(encoding="utf-8")
    assert re.search(needle, src), f"{needle} 在 db.py 中完全不存在，判据形同虚设"
