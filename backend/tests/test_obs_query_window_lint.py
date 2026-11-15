"""obs_query 窗口判据的契约 —— 它拦的是「静默算错窗口」，正反都钉。

【self-evolution-bot · 2026-11-15 · 第18轮】新建。

为什么单独钉这个函数
--------------------
第18轮我对用户报了整套「近 24h」数字，实际窗口 ≈32 小时：ISO 文本列（100% 带 +08:00）
跟 datetime('now') 的 UTC 空格格式做字典序比较，'T' > ' ' 把边界整天放进来，**不报错**。
随后想用 strftime('%s') 做对照，又因 TEXT vs INTEGER 恒真拿到「= 全表」。
两个假数同源、都出自 obs_query.py 这个被定为唯一观测入口的脚本，所以补进入口。
判据第一版在反证里就现出两处形：漏报（strftime >= strftime - 86400 没拦住）、
误报（SQL 注释里的同名文字被当命中）。正反例必须同时进测试，否则下次改判据的人
只能看见"拦住过什么"，看不见"不该拦什么"——后者坏了才没人信提示。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_MOD_PATH = Path(__file__).resolve().parents[1] / "packages" / "harness" / "scripts" / "obs_query.py"


def _load():
    spec = importlib.util.spec_from_file_location("_obs_query_under_test", _MOD_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- 该拦的：两种静默假数形态 ----

def test_flags_iso_text_vs_utc_datetime() -> None:
    m = _load()
    warns = m.window_lint(
        "SELECT count(*) FROM evoflow_obs_tool_invocations WHERE started_at > datetime('now','-1 day')"
    )
    assert len(warns) == 1 and "字典序" in warns[0]


def test_flags_requested_at_and_ended_at_too() -> None:
    m = _load()
    for col in ("requested_at", "ended_at", "occurred_at"):
        assert m.window_lint(f"SELECT 1 FROM t WHERE {col} >= datetime('now', '-7 day')"), col


def test_flags_strftime_vs_arithmetic_int() -> None:
    """第18轮我实际踩中的那条：strftime >= strftime - 86400（算术先 coercion → 恒真）。"""
    m = _load()
    warns = m.window_lint(
        "SELECT count(*) FROM t WHERE strftime('%s',started_at) >= strftime('%s','now') - 86400"
    )
    assert len(warns) == 1 and "恒真" in warns[0]


def test_flags_strftime_vs_bare_int() -> None:
    m = _load()
    assert m.window_lint("SELECT 1 FROM t WHERE strftime('%s',started_at) > 1794116469")


# ---- 不该拦的：正确写法与合法比较 ----

def test_accepts_normalized_cst_window() -> None:
    m = _load()
    assert not m.window_lint(
        "SELECT 1 FROM t WHERE replace(substr(started_at,1,19),'T',' ') >= datetime('now','-1 day','+8 hours')"
    )


def test_accepts_cast_epoch_window() -> None:
    m = _load()
    assert not m.window_lint(
        "SELECT 1 FROM t WHERE CAST(strftime('%s',started_at) AS INTEGER) "
        ">= CAST(strftime('%s','now') AS INTEGER) - 86400"
    )


def test_accepts_text_vs_text_epoch_compare() -> None:
    """两侧都是 strftime 的等长 epoch 文本时，字典序与数值同序，属合法。"""
    m = _load()
    assert not m.window_lint("SELECT 1 FROM t WHERE strftime('%s',started_at) > strftime('%s','now')")


# ---- 反证：判据不能被注释/字符串外的东西骗到 ----

def test_line_comment_mention_is_not_a_hit() -> None:
    m = _load()
    assert not m.window_lint("SELECT 1 FROM t -- started_at > datetime('now','-1 day') 这是注释")


def test_block_comment_mention_is_not_a_hit() -> None:
    m = _load()
    assert not m.window_lint("SELECT 1 FROM t /* started_at > datetime('now') */ WHERE tool_name='x'")


def test_strip_keeps_real_code() -> None:
    m = _load()
    assert m.strip_sql_comments("SELECT a FROM t -- x\nWHERE b > 1").strip().endswith("WHERE b > 1")
