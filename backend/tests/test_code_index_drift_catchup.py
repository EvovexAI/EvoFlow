"""锁住「源码漂移自愈」：ready 索引 + 磁盘新增文件 → 检索时后台增量补录，且绝不触发全量重建。

【self-evolution-bot · 2026-11-18 · 第46轮 · 模型:qwen3.8-flash】为什么有这条测试：
第38轮修的是「让漂移可见」（工具首行会报 `N new file(s) not indexed`），
配方里明写「没做自愈」。本轮实测坐实缺口：
- config.yaml 里 auto_index_on_search / watcher_enabled 全为 true，但 17:05 后没有任何
  build_worker 活着（watcher 只能从面板接口显式启动，重启后无人拉起）；
- search_index 的自愈触发条件是 `not st["ready"]`，而 ready 判定（stale_reasons）
  **不含漂移** → 刚写了新文件的 agent 下一次检索照样搜不到，报出来的 stale 永远修不掉。

判据 = 三条反证必须同时成立：
① 补录后**下一次**检索真能搜到该符号（测接线，不是测函数返回 ok）；
② 全程没有调用 build_index / _spawn_build_subprocess（不许为几个文件重烧全仓）；
③ 补录不发生在检索主路上（现网实测 11 个文件同步跑要 28.1s，会把搜索卡死）。
"""

from __future__ import annotations

import pytest

from evoflow.code_index import store as S
from evoflow.code_index.hooks import drain_index_hook_pool_for_tests


@pytest.fixture
def ws(tmp_path, monkeypatch):
    """建一个「已 ready」的小库：2 个文件在库里，根路径与收尾标记都按真建库口径写。"""
    cfg = S.get_code_index_config()
    monkeypatch.setattr(cfg, "semantic_search_enabled", False)
    root = str(tmp_path).replace("\\", "/")
    (tmp_path / "src").mkdir()
    conn = S._connect(root)
    S._ensure_schema(conn)
    for i in range(2):
        p = tmp_path / "src" / f"mod_{i}.py"
        p.write_text(f"def existing_{i}():\n    return {i}\n", encoding="utf-8")
        S.index_file(root, relative_path=f"src/mod_{i}.py")
    resolved = S.resolve_index_root(workspace_root=root)
    # 必须走 _touch_index_meta 收尾（与真建库同口径）：只写 root 的话
    # meta 里没有 index_tokenizer_version / indexed_max_files，
    # search_index 开头就会把 _fts_needs_rebuild 当「老库需重建」→
    # 直接进全量重建支路，压根走不到「稳态 + 漂移」这一支，测试就测错地方了。
    S._touch_index_meta(conn, resolved, S._db_path(root))
    # 建库收尾本来就会清掉这个标记（store.py 三处）；夹具里第一次 index_file
    # 会把缺版本键的库标成待重建，不清就等于造了个「永远待重建」的假稳态。
    conn.execute("DELETE FROM meta WHERE key='fts_needs_rebuild'")
    conn.commit()
    conn.close()
    S._drift_catchup_cooldown.clear()
    S._purge_drift_cache(root)
    return root, tmp_path


def test_drift_catchup_indexes_new_file_without_full_rebuild(ws, monkeypatch):
    root, tmp_path = ws

    # 前置：库必须被判 ready（否则走的是残缺重建路径，测不到漂移这条新支路）
    st = S.index_status(workspace_root=root)
    assert st.get("ready") is True, f"夹具未达稳态: {st.get('stale_reasons')}"

    # 磁盘上新写一个文件（模拟 git 检出 / 外部改动；非 gitignore 目录）
    (tmp_path / "src" / "brand_new.py").write_text(
        "def zzq_drift_catchup_marker():\n    return 1\n", encoding="utf-8"
    )

    # 反证 ②：任何人敢在这里起全量重建，直接炸测试
    def _no_full_rebuild(*a, **k):  # pragma: no cover - 命中即失败
        raise AssertionError("drift catch-up must not trigger full build_index")

    monkeypatch.setattr(S, "build_index", _no_full_rebuild)
    monkeypatch.setattr(S, "_spawn_build_subprocess", _no_full_rebuild)

    # 第一次：发现漂移 → 投递后台增量池（**不当次阻塞**，见 28.1s 实测）
    res1 = S.search_index(workspace_root=root, query="zzq_drift_catchup_marker")
    names1 = [str(s.get("name") or "") for s in (res1.get("symbols") or [])]
    assert "zzq_drift_catchup_marker" not in names1, "自愈若同步跑在检索里，这里会直接命中"

    drain_index_hook_pool_for_tests(timeout=60.0)

    # 反证 ①：补录后下一次检索必须真能搜到这个符号
    res2 = S.search_index(workspace_root=root, query="zzq_drift_catchup_marker")
    names2 = [str(s.get("name") or "") for s in (res2.get("symbols") or [])]
    assert "zzq_drift_catchup_marker" in names2, f"漂移未自愈: symbols={names2[:8]}"

    # 反证 ③的落盘面：页脚不得继续报已经消失的漂移
    drift = (S.index_freshness(root).get("index_source_drift") or {})
    assert drift.get("added") == 0, f"补录完仍报新增漂移: {drift}"


def test_catchup_skips_when_building(ws, monkeypatch):
    """构建中让路（别和全量抢 sqlite 写锁）；无漂移零投递。"""
    root, tmp_path = ws
    (tmp_path / "src" / "later.py").write_text(
        "def zzq_later_marker():\n    pass\n", encoding="utf-8"
    )
    hits: list[str] = []
    monkeypatch.setattr(S, "index_file", lambda *a, **k: hits.append("hit"))
    out = S._schedule_drift_catchup(root, st={"building": True})
    assert out["status"] == "skipped" and out["reason"] == "building"
    assert not hits


def test_catchup_cooldown_and_no_drift_shortcircuit(ws, monkeypatch):
    """有漂移→投递；同 root 冷却期内不再动；漂移清零后直接短路。"""
    root, tmp_path = ws
    (tmp_path / "src" / "x.py").write_text("def zzq_cd_marker():\n    pass\n", encoding="utf-8")

    out1 = S._schedule_drift_catchup(root, st={"building": False})
    assert out1["status"] == "queued" and out1["queued"] >= 1
    drain_index_hook_pool_for_tests(timeout=60.0)

    out2 = S._schedule_drift_catchup(root, st={"building": False})
    assert out2["status"] == "skipped" and out2["reason"] == "cooldown"

    S._drift_catchup_cooldown.clear()
    out3 = S._schedule_drift_catchup(root, st={"building": False})
    assert out3["reason"] == "no_add_change", out3
