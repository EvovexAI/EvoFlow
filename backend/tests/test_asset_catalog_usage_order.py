"""L2 catalog must order by **usage evidence**, not by mere mtime.

【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】

现网取证（改前）：118 个资产文件里 **0 个** frontmatter 带 use_count/last_used，
计数全在侧车 ``memory/.usage-ledger.json``（118 条真实记录，最高 useCount=54）。
而 ``_usage_sort_key`` 只把 frontmatter ``meta`` 喂给 ``usage_recency_score``，
所以 craft/journal/fact/episodic 四类**全部**退到 ``path.stat().st_mtime`` 兜底 ——
「按使用证据排序」实际一直是 mtime 排序。本用例把这个退化钉死。

判据：造两个文件，**老的那个在 ledger 里被用过、新的那个没有**，
按使用证据排序应把「老的常用的」排在前面；按 mtime 则相反。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from evoflow.assets.catalog import list_craft_catalog, list_journal_catalog
from evoflow.assets.paths import EntityRef


def _seed(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    root = tmp_path / "assets" / "employees" / "demo"
    (root / "craft").mkdir(parents=True)
    (root / "memory" / "journal").mkdir(parents=True)
    return root


def _write(path: Path, text: str, *, mtime: float) -> None:
    path.write_text(text, encoding="utf-8")
    os.utime(path, (mtime, mtime))


def test_craft_catalog_orders_by_ledger_not_mtime(tmp_path: Path, monkeypatch) -> None:
    root = _seed(tmp_path, monkeypatch)
    craft = root / "craft"
    # 旧文件：很久没改，但被反复读过（ledger 里有记录）
    _write(craft / "used-old.md", "---\nname: used-old\n---\n\nbody\n", mtime=1_600_000_000)
    # 新文件：刚写完，从未被读过
    _write(craft / "fresh-unused.md", "---\nname: fresh-unused\n---\n\nbody\n", mtime=1_800_000_000)
    (root / "memory" / ".usage-ledger.json").write_text(
        json.dumps(
            {
                "craft/used-old.md": {
                    "useCount": 54,
                    "lastUsedAt": "2026-11-17T14:54:23Z",
                }
            }
        ),
        encoding="utf-8",
    )

    paths = [r["path"] for r in list_craft_catalog(EntityRef("employee", "demo"))]
    assert paths.index("craft/used-old.md") < paths.index("craft/fresh-unused.md"), (
        f"catalog ordered by mtime, not usage — got {paths}"
    )


def test_journal_catalog_orders_by_ledger_not_mtime(tmp_path: Path, monkeypatch) -> None:
    root = _seed(tmp_path, monkeypatch)
    journal = root / "memory" / "journal"
    _write(journal / "used-old.md", "# 被读过的旧条目\n", mtime=1_600_000_000)
    _write(journal / "fresh-unused.md", "# 刚写的未验证条目\n", mtime=1_800_000_000)
    (root / "memory" / ".usage-ledger.json").write_text(
        json.dumps(
            {
                "memory/journal/used-old.md": {
                    "useCount": 9,
                    "lastUsedAt": "2026-11-17T14:54:23Z",
                }
            }
        ),
        encoding="utf-8",
    )

    paths = [r["path"] for r in list_journal_catalog(EntityRef("employee", "demo"))]
    assert paths.index("memory/journal/used-old.md") < paths.index(
        "memory/journal/fresh-unused.md"
    ), f"catalog ordered by mtime, not usage — got {paths}"


def test_catalog_ledger_read_once_per_build(tmp_path: Path, monkeypatch) -> None:
    """100+ 行不能让 ledger 被重读 100+ 次（实测 72 次合计 7.72ms 全是重复解析）。"""
    root = _seed(tmp_path, monkeypatch)
    craft = root / "craft"
    for i in range(12):
        _write(craft / f"c{i:02d}.md", f"---\nname: c{i}\n---\n\nbody\n", mtime=1_700_000_000 + i)

    from evoflow.assets import usage as usage_mod

    calls = {"n": 0}
    real = usage_mod._read_ledger

    def _counting(entity):  # noqa: ANN001
        calls["n"] += 1
        return real(entity)

    monkeypatch.setattr(usage_mod, "_read_ledger", _counting)
    list_craft_catalog(EntityRef("employee", "demo"))
    assert calls["n"] == 1, f"ledger read {calls['n']} times for 12 rows (expected 1)"
