"""检索召回基线门禁：一条命令出数字，低于基线就红。

【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】

为什么必须有这条
----------------
在此之前，「检索准不准」的答案只存在于 gitignore 掉的 `outputs/`：
冻结池 `layered_pool.json` + 评测脚本 `eval_frozen_pool.py`。后果我全吃过：

  1. 换人换机器没有基线，判不出改动是变好还是变坏；
  2. 我差点把 55/59 当真退化，撤掉一个**正确**修复——那 55 是恢复脚本
     `echo restored` 出来、根本没真跑池子的假数字；
  3. 语法/类型门禁对「排序退化」零分辨力：25 条 search_rank 单测全绿的同时，
     冻结池可以从 59/59 掉到 44/59（第32轮实测）。

所以基线要进仓库、要能被 `pytest` 直接跑到、要低于基线就红。

判据
----
- hit@1 必须 **59/59**（= 池内全部可评条目首条即中）；
- 池子冻结在 `tests/fixtures/code_index_recall_pool.json`（60 条 `{name, path}`，
  取自真实索引符号，含 1 条目标已被排除目录的不可评条目，自动剔除）；
- 走**工具出口**（`_run_search_index_lookup` + `_format_search_data`），
  而不是 `store.search_index` 函数层——最后一米的格式化/透传才是真陷阱。

适用范围（重要，别把它当 CI 门禁）
--------------------------------
本用例读的是工作区真实索引库 `.evoflow/code_index/index.db`。干净检出/CI 上
没有该库，用例自动 `skip`（不是通过）。它守的是**开发和发布前**：改了检索
排序逻辑，在你自己有索引的机器上跑一遍就知道有没有退化。

反证（必须真做过，不许只写注释）
------------------------------
把 `_rerank_index_rows` 里 symbols 排序的 `str(r.get("name") or "").casefold()`
改回 `str(r.get("name") or "")`，本用例必须变红（实测 hit@1 掉到 58/59，
唯一失手的就是 `build overlay` → `_buildOverlays`）。不红说明断言没接上。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
POOL_PATH = Path(__file__).parent / "fixtures" / "code_index_recall_pool.json"
BASELINE_HIT_AT_1 = 59


@pytest.fixture(autouse=True)
def _no_real_embedding(monkeypatch):
    """新测试不许启动真实嵌入暖机。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    实测踩到：本文件单独跑全绿，和 test_code_index_embed_cold_gate 一起跑就红。
    原因是这里真去建索引 → 触发后台暖机线程 → 模型被加载进 sys.modules，
    而 cold_gate 的前提正是「门未开、模型还没 import」。线程是 daemon 且异步，
    事后 pop sys.modules 挡不住它。
    锁死「不起暖机、门永远关着」= 本文件只测词法层，确定且互不污染。
    """
    from evoflow.code_index import store as _S

    monkeypatch.setattr(_S, "_start_embed_warmup", lambda: None)
    monkeypatch.setattr(_S, "_embed_ready_without_import", lambda: False)
    monkeypatch.setattr(_S, "_embed_gate_open", False)


def _split_query(name: str) -> str:
    """符号名 → 用户实际会敲的问法（驼峰/下划线拆成空格词）。"""
    s = name.lstrip("_")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)
    return re.sub(r"\s+", " ", s.replace("_", " ")).strip()


def _index_db() -> Path:
    return REPO_ROOT / ".evoflow" / "code_index" / "index.db"


def _indexed_paths() -> set[str] | None:
    """返回真实索引里已入库的路径集合；索引库不可用时返回 None（→skip）。"""
    if not _index_db().exists():
        return None
    try:
        from evoflow.code_index import store as S

        conn = S._connect(str(REPO_ROOT))
        try:
            return {r[0] for r in conn.execute("select path from fts_content")}
        finally:
            conn.close()
    except Exception:  # 库损坏 / 缺 sqlite_vec 扩展 —— 环境问题，不该判红
        return None


def _first_positions(rows: list[dict]) -> list[dict]:
    """对每条池子条目跑工具出口，记录目标符号在 Symbols 段里出现的位置。"""
    from evoflow.tools.host_direct.search_code_index import (
        _format_search_data,
        _run_search_index_lookup,
    )

    out: list[dict] = []
    for item in rows:
        name = item["name"]
        q = _split_query(name)
        err, data = _run_search_index_lookup(
            root=str(REPO_ROOT), thread_id=None, query=q, queries=None, limit=10
        )
        text = err if err else _format_search_data(data, limit=10)
        names: list[str] = []
        in_symbols = False
        for line in (text or "").splitlines():
            if line.startswith("Symbols:"):
                in_symbols = True
                continue
            if in_symbols:
                if not line.startswith("  "):
                    break
                m = re.match(r"\s+-\s+\S+\s+(\S+)\s+@", line)
                if m:
                    names.append(m.group(1))
        pos = None
        for i, got in enumerate(names):
            if got.casefold() == name.casefold():
                pos = i
                break
        out.append({"name": name, "q": q, "pos": pos})
    return out


def test_frozen_pool_hit_at_1_meets_baseline() -> None:
    indexed = _indexed_paths()
    if indexed is None:
        pytest.skip(
            "本机没有可用的工作区索引库（.evoflow/code_index/index.db）；"
            "本用例只守开发/发布前，CI 上跳过。"
        )

    pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))
    assert len(pool) == 60, f"冻结池应恒为 60 条，实际 {len(pool)}（池子被改动=基线失效）"

    # 目标已不在索引里的条目剔除（文件被删/被排除），不计分也不再报退化。
    scorable = [it for it in pool if it["path"] in indexed]
    excluded = [it["name"] for it in pool if it["path"] not in indexed]
    assert scorable, "可评条目为 0：索引库和冻结池不是同一个工作区？"

    rows = _first_positions(scorable)
    hit1 = [r for r in rows if r["pos"] == 0]
    misses = [r for r in rows if r["pos"] != 0]

    print(
        f"\n[recall] hit@1 = {len(hit1)}/{len(rows)}"
        f"（基线 {BASELINE_HIT_AT_1}，剔除 {len(excluded)} 条）"
    )
    if misses:
        print("[recall] miss@1:")
        for r in misses:
            print(f"  q={r['q']!r} want={r['name']!r} pos={r['pos']}")

    assert len(hit1) >= BASELINE_HIT_AT_1, (
        f"检索召回低于基线：hit@1 = {len(hit1)}/{len(rows)}，基线 {BASELINE_HIT_AT_1}。"
        f" miss@1 = {[(r['name'], r['pos']) for r in misses]}"
    )


def test_frozen_pool_covers_both_naming_styles() -> None:
    """池子成分守卫：全是 snake_case 会让 CamelCase 退化（前端符号）检不出来。

    实测过的教训：只测 Python 符号时，`buildGoalResultPayload` /
    `buildDiffSummary` 这类前端标识符的排序问题（大小写 tie-break）完全漏网。
    """
    pool = json.loads(POOL_PATH.read_text(encoding="utf-8"))
    names = [it["name"] for it in pool]
    camel = [n for n in names if re.search(r"[a-z][A-Z]", n)]
    snake = [n for n in names if "_" in n]
    assert len(camel) >= 5, f"池子里 CamelCase 符号太少（{len(camel)}），前端检索退化会漏检"
    assert len(snake) >= 20, f"池子里 snake_case 符号太少（{len(snake)}）"
