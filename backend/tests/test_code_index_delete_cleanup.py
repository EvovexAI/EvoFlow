"""锁住「已删除文件的残留行会被清掉，且熔断闸在 root 口径漂移时能拦住」。

【self-evolution-bot · 2026-11-19 · 第64轮 · 模型:deepseek-v4.1-flash-1017】为什么有这条测试：
第46轮补的漂移自愈只做「新增/改动」一侧，`deleted` 分支**只报不修**，
注释理由是「删除交给 watcher 与下次全量重建」。现网实测坐实这个理由已不成立：
  · watcher 默认 `watcher_enabled=False`，且 `start_index_watch` 只由面板接口拉起，
    进程重启后没人拉起（第46轮自己的注释就写着这一点）；
  · 全量重建要 ~30 分钟且不常在；
  · 结果：本仓 fts_content 7915 个 path 里 12 个磁盘已不存在，其中 6 个留着 symbols 行；
    近 10 天 1496 条符号命中里 **20 条（1.34%）指向不存在的文件**，catalog 1491 条里 22 条。
    模型照着这些路径去 read 就是必然失败 —— 这是索引在持续制造无效回合。

判据 = 五条反证必须同时成立（每条都能单独把修复打红）：
① 幽灵文件在清理后从 symbols/fts 里消失（测接线：走 search_index，不测函数返回 ok）；
② 活文件一个都不许丢（误删比漏删严重得多）；
③ root 解析口径漂移（整库被判已删除）必须被拦住，一行都不许清；
④ 「遍历没看见」不等于「不存在」：路径仍在磁盘上的必须复核拦回；
⑤ 清理必须发生在后台池、不在检索主路上（主路开写事务会堵住正在读这条库的人）。
"""

from __future__ import annotations

import pytest

from evoflow.code_index import store as S
from evoflow.code_index.hooks import drain_index_hook_pool_for_tests


@pytest.fixture
def ws(tmp_path, monkeypatch):
    """建一个「已 ready」的小库，含 4 个活文件 + N 个随后从磁盘删掉的幽灵文件。"""
    cfg = S.get_code_index_config()
    monkeypatch.setattr(cfg, "semantic_search_enabled", False)
    root = str(tmp_path).replace("\\", "/")
    (tmp_path / "src").mkdir()
    conn = S._connect(root)
    S._ensure_schema(conn)
    for i in range(4):
        p = tmp_path / "src" / f"keep_{i}.py"
        p.write_text(f"def keep_{i}():\n    return {i}\n", encoding="utf-8")
        S.index_file(root, relative_path=f"src/keep_{i}.py")
    resolved = S.resolve_index_root(workspace_root=root)
    S._touch_index_meta(conn, resolved, S._db_path(root))
    # 建库收尾会清这个标记；不清就成了「永远待重建」的假稳态，走不到漂移支路。
    conn.execute("DELETE FROM meta WHERE key='fts_needs_rebuild'")
    conn.commit()
    conn.close()
    S._drift_catchup_cooldown.clear()
    S._purge_drift_cache(root)
    return root, tmp_path


def _add_ghosts(root, tmp_path, n: int) -> None:
    for g in range(n):
        p = tmp_path / "src" / f"ghost_{g}.py"
        p.write_text(f"def zzq_ghost_marker_{g}():\n    return 9\n", encoding="utf-8")
        S.index_file(root, relative_path=f"src/ghost_{g}.py")
    S._purge_drift_cache(root)
    S._drift_catchup_cooldown.clear()


def _remove_ghosts(tmp_path, n: int) -> None:
    import os

    for g in range(n):
        os.remove(tmp_path / "src" / f"ghost_{g}.py")


def test_ghost_rows_are_purged_and_live_files_survive(ws, monkeypatch):
    """反证 ①②⑤：幽灵清了、活的没丢、且不在检索主路上同步跑。"""
    root, tmp_path = ws
    _add_ghosts(root, tmp_path, 2)
    assert S.search_index(workspace_root=root, query="zzq_ghost_marker_0").get("symbols"), (
        "前置不成立：幽灵文件本应可搜到"
    )
    _remove_ghosts(tmp_path, 2)
    S._purge_drift_cache(root)

    # 反证 ②：清理过程绝不允许起全量重建（那是把用户当矿工的做法）
    def _no_full_rebuild(*a, **k):  # pragma: no cover - 命中即失败
        raise AssertionError("delete cleanup must not trigger full build_index")

    monkeypatch.setattr(S, "build_index", _no_full_rebuild)
    monkeypatch.setattr(S, "_spawn_build_subprocess", _no_full_rebuild)

    # 反证 ⑤：调度那一下不能已经清完 —— 清库是写事务，必须留在后台池。
    # 判据用线程名而不是「再搜一下看还在不在」：HOOK_POOL 只有 1 个 worker，
    # 提交后常在毫秒级就跑完，那种断言是有竞态的（我第一版就写成那样，红了）。
    import threading

    calls: list[str] = []
    real_cleanup = S._run_delete_cleanup

    def _spy(root_arg, queue):  # noqa: ANN001 - 只记录调用方线程
        calls.append(threading.current_thread().name)
        return real_cleanup(root_arg, queue)

    monkeypatch.setattr(S, "_run_delete_cleanup", _spy)

    out = S._schedule_drift_catchup(root, st={"building": False})
    assert out.get("deleted_clean") == 2, f"计划未包含两条幽灵: {out}"
    assert calls == [], "清理在检索主路上同步跑了 —— 会拿写锁堵住正在读这条库的人"

    drain_index_hook_pool_for_tests(timeout=60.0)
    S._purge_drift_cache(root)
    assert calls, "清理根本没有被投递（接错池子等于没改）"
    assert threading.current_thread().name not in calls, f"清理跑在主线程: {calls}"

    # 反证 ①：幽灵必须真的搜不到了（走真实检索出口，不看内部计数）
    assert S.search_index(workspace_root=root, query="zzq_ghost_marker_0").get("symbols") == []
    assert S.search_index(workspace_root=root, query="zzq_ghost_marker_1").get("symbols") == []
    # 反证 ②：活文件一个都不许丢
    names = [s.get("name") for s in (S.search_index(workspace_root=root, query="keep_2").get("symbols") or [])]
    assert "keep_2" in names, f"活文件被误删: {names}"
    # 页脚不得继续报已经清完的删除（否则下一次检索又让人以为脏数据还在）
    drift = S.index_freshness(root).get("index_source_drift") or {}
    assert int(drift.get("deleted") or 0) == 0, f"清完仍报删除漂移: {drift}"


def test_drift_of_whole_repo_is_blocked(ws):
    """反证 ③：root 口径漂移会让整库被判已删除 —— 一行都不许清。"""
    root, _tmp_path = ws
    plan = S._plan_delete_cleanup(
        {"total": 4}, ["src/keep_0.py", "src/keep_1.py", "src/keep_2.py", "src/keep_3.py"], 4, root=root
    )
    # 比例闸 + 绝对量地板：4 个全删 = 比例 1.0，但绝对量 4 <= 32 → 闸门放行，
    # 所以真正的防线是「逐条复核」：这些文件还在盘上，一条都不该进队列。
    assert plan["queue"] == [], f"活文件被列进清理队列: {plan}"

    # 大仓库形态：比例与绝对量同时超阈值 → ratio_guard 直接拦住，连复核都不需要
    big = S._plan_delete_cleanup(
        {"total": 100}, [f"x{i}.py" for i in range(3000)], 3000, root=root
    )
    assert big["reason"] == "ratio_guard" and big["queue"] == [], big


def test_ratio_guard_thresholds():
    """熔断阈值本身的边界（纯函数，不碰磁盘）。"""
    # 大仓真实删除量：0.15% < 阈值 15% → 该清
    assert S._plan_delete_cleanup({"total": 7915}, ["a.py"], 1)["reason"] == "ok"
    # 半库消失：37.9% 且绝对量 3000 > 32 → 必须拦
    half = S._plan_delete_cleanup({"total": 7915}, ["a.py"], 3000)
    assert half["reason"] == "ratio_guard" and half["skipped_ratio"] is True
    # 无删除信号 → 不动
    assert S._plan_delete_cleanup({"total": 100}, [], 0)["reason"] == "no_deleted_paths"


def test_root_unavailable_blocks_cleanup():
    """root 不在了 → 任何"已删除"结论都不可信，必须直接放弃。"""
    out = S._plan_delete_cleanup(
        {"total": 100}, ["a.py"], 1, root="Z:/definitely/not/a/real/root"
    )
    assert out["reason"] == "root_unavailable" and out["queue"] == []


def test_unconfirmed_paths_are_dropped(ws):
    """反证 ④：「遍历没看见」不等于「不存在」—— 还在盘上的路径必须复核拦回。"""
    root, _tmp_path = ws
    # 传一个真实存在的目录路径冒充"已删除"
    plan = S._plan_delete_cleanup({"total": 7915}, ["src"], 1, root=root)
    assert plan["queue"] == [] and plan["unconfirmed"] == 1, plan


def test_search_index_wires_the_cleanup(ws, monkeypatch):
    """接线：走**真实检索入口** search_index 也必须把清理投出去。

    【self-evolution-bot · 2026-11-19 · 第64轮】为什么单开一条：
    上面那条是直接调 `_schedule_drift_catchup` 的，属**函数层**。
    本岗栽过 4 次「函数层全绿、接线没通」—— 现在这条专门锁
    `search_index → _schedule_drift_catchup → _HOOK_POOL` 这三跳中的后一跳。
    """
    root, tmp_path = ws
    _add_ghosts(root, tmp_path, 1)
    _remove_ghosts(tmp_path, 1)
    S._purge_drift_cache(root)
    S._drift_catchup_cooldown.clear()

    submitted: list[str] = []
    real = S._run_delete_cleanup

    def _spy(root_arg, queue):  # noqa: ANN001
        submitted.extend(queue)
        return real(root_arg, queue)

    monkeypatch.setattr(S, "_run_delete_cleanup", _spy)

    # 真实入口：不直接调调度函数
    S.search_index(workspace_root=root, query="zzq_ghost_marker_0")
    drain_index_hook_pool_for_tests(timeout=60.0)
    S._purge_drift_cache(root)
    assert submitted, "search_index 没有把清理投递出去（接线断了）"
    assert S.search_index(workspace_root=root, query="zzq_ghost_marker_0").get("symbols") == []
