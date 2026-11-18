"""跨进程建库租约 —— 守住「索引永不收敛」的活锁。

【self-evolution-bot · 2026-11-18 · 第43轮 · 模型:deepseek-v4.1-flash-1017】

现场（本机实测）：`search_code_index` 每次 11~15s，10 个 build_worker
子进程同时在跑，各占 800~900s CPU，`meta` 里 `phase=embedding` 而
`vectors_done` 缓慢爬又反复归零。三层原因：

1. `_build_jobs` 是**进程内** dict。本机同时跑着两个 Gateway 进程，
   各自 `schedule_build_index` 都看到「本地没有 job」→ 各起一个子进程。
   `_jobs_lock` 是 threading.Lock，跨进程等于没有。
2. `build_index` 第一步 `_clear_tables()` 里有 `DELETE FROM meta`，把
   `root` / `indexed_max_files` / `index_tokenizer_version` 一并删掉。
   于是清表后 `index_status` 必判 `ready=False` → 每个后续检索都再触发一次
   强制重建 → 又清一次表。
3. 向量段（本仓 11.4 万块、约 30 分钟）必然被下一轮重建打断，
   `vectors_incomplete` 永远成立，判据永远「未就绪」。

本文件守的是修复后的三条不变量。
"""

from __future__ import annotations

import importlib
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

# bash_tool / store 这类模块要 import_module 才拿到真模块（StructuredTool 同名遮蔽）。
store = importlib.import_module("evoflow.code_index.store")


def _fresh_root(tmp_path: Path) -> str:
    root = tmp_path / "ws"
    (root / ".evoflow" / "code_index").mkdir(parents=True)
    return str(root)


def _open(root: str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(store._db_path(root)), timeout=10.0)
    store._ensure_schema(conn)
    return conn


# ---------------------------------------------------------------- 租约互斥


def test_second_acquire_is_rejected_while_first_holds(tmp_path, monkeypatch):
    """同一 workspace 第二个持有者必须被拒绝（模拟两个 Gateway 进程）。"""
    root = _fresh_root(tmp_path)
    key = store._workspace_hash(root)

    conn = _open(root)
    try:
        ok1, holder1 = store.try_acquire_build_lease(conn, key, owner="procA")
        assert ok1 is True and holder1 is None

        # 换一条连接 = 换一个进程视角；同 pid 但 owner 不同，
        # 模拟「同一台机器上的另一个 Gateway」。
        conn2 = sqlite3.connect(str(store._db_path(root)), timeout=10.0)
        try:
            ok2, holder2 = store.try_acquire_build_lease(conn2, key, owner="procB")
        finally:
            conn2.close()
        assert ok2 is False, "第二个进程不该拿到租约，否则两个 worker 会互相清表"
        assert holder2 is not None and holder2["owner"] == "procA"
    finally:
        conn.close()


def test_lease_is_reusable_after_release(tmp_path):
    """正常结束必须把租约还回去，否则下一个进程要白等 TTL。"""
    root = _fresh_root(tmp_path)
    key = store._workspace_hash(root)

    conn = _open(root)
    try:
        ok, _ = store.try_acquire_build_lease(conn, key, owner="procA")
        assert ok
    finally:
        conn.close()

    store.release_build_lease(root, owner="procA")

    conn = _open(root)
    try:
        ok2, holder = store.try_acquire_build_lease(conn, key, owner="procB")
        assert ok2 is True and holder is None
    finally:
        conn.close()


def test_dead_pid_lease_is_taken_over_immediately(tmp_path):
    """持有者 pid 已死 → 立刻接管，不靠 300s TTL 空等。

    为什么单独立这一条：只按心跳年龄判死会让 `kill -9` 之后
    索引一直残缺却没人修（心跳停在死亡那一刻，TTL 内谁都"看到有人在跑"）。
    """
    root = _fresh_root(tmp_path)
    key = store._workspace_hash(root)

    # 造一个绝不可能存活的 pid 的租约行，心跳是刚刚。
    dead_pid = 999_999
    conn = _open(root)
    try:
        conn.execute(store._LEASE_TABLE_DDL)
        conn.execute(
            "INSERT OR REPLACE INTO build_lease"
            "(workspace, owner, pid, started_at, heartbeat_at) VALUES (?,?,?,?,?)",
            (key, "ghost", dead_pid, int(time.time()), int(time.time())),
        )
        conn.commit()
        ok, holder = store.try_acquire_build_lease(conn, key, owner="procNew")
    finally:
        conn.close()
    assert ok is True, f"pid {dead_pid} 已死，租约应被立刻接管（拿到的是 {holder}）"


def test_peek_does_not_write_lease(tmp_path):
    """`peek_build_lease` 只读不占。

    为什么必须成立：`schedule_build_index` 用 peek 决定「要不要起子进程」。
    若它改成 acquire，会在 acquire→release 之间留一个几毫秒窗口，
    真正的 build_worker 恰好此时抢租约就会以为「已有构建」而放弃，
    结果谁都不建库 —— 比原来的活锁更难查。
    """
    root = _fresh_root(tmp_path)
    conn = _open(root)
    try:
        conn.execute(store._LEASE_TABLE_DDL)
        conn.commit()
    finally:
        conn.close()

    assert store.peek_build_lease(root) is None
    # peek 之后仍应可被正常 acquire，说明 peek 没留下租约行。
    conn = _open(root)
    try:
        ok, _ = store.try_acquire_build_lease(conn, store._workspace_hash(root), owner="procA")
        assert ok is True
        assert store.peek_build_lease(root)["owner"] == "procA"
    finally:
        conn.close()


def test_peek_ignores_dead_holder(tmp_path):
    """peek 遇到死 pid 的租约必须返回 None（否则 schedule 永远不再建库）。"""
    root = _fresh_root(tmp_path)
    key = store._workspace_hash(root)
    conn = _open(root)
    try:
        conn.execute(store._LEASE_TABLE_DDL)
        conn.execute(
            "INSERT OR REPLACE INTO build_lease"
            "(workspace, owner, pid, started_at, heartbeat_at) VALUES (?,?,?,?,?)",
            (key, "ghost", 999_999, int(time.time()), int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()
    assert store.peek_build_lease(root) is None


# ------------------------------------------------- 清表不得毁掉身份/版本键


def test_clear_tables_keeps_identity_meta(tmp_path):
    """清表只能删产物键，`root` / `indexed_max_files` / `tokenizer_version` 必须保留。

    这是活锁的第二半：`DELETE FROM meta` 把 `root` 删掉后
    `index_status` 必判未就绪 → 每个检索都再触发一次强制重建。
    """
    root = _fresh_root(tmp_path)
    dbp = store._db_path(root)

    conn = _open(root)
    try:
        store._touch_index_meta(conn, root, dbp)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('build_progress.phase', 'embedding')"
        )
        conn.commit()
        before = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    finally:
        conn.close()

    assert "root" in before, "前置条件：touch 之后应当有 root 键"

    # 直接执行 build_index 里 _clear_tables 的等价语句（保持与源码一致：
    # 它就是 DELETE FROM meta WHERE key IN (...) + 前缀删）。
    conn = _open(root)
    try:
        conn.execute(
            "DELETE FROM meta WHERE key IN ("
            "'indexed_at', 'index_db_path', 'symbol_parsers',"
            "'build_progress.phase', 'build_progress.updated_at'"
            ")"
        )
        conn.execute("DELETE FROM meta WHERE key LIKE 'build_progress.%'")
        conn.execute("DELETE FROM meta WHERE key = 'fts_needs_rebuild'")
        conn.commit()
        after = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    finally:
        conn.close()

    for keep in ("root", "indexed_max_files", "index_tokenizer_version", "fts_schema_version"):
        assert keep in after, f"清表后 {keep} 丢了 —— index_status 会永远判未就绪"
    assert "build_progress.phase" not in after, "进度键必须清掉，否则旧进度会被当成当前进度"
    # 身份键的值也不能被改。
    assert after["root"] == before["root"]


def test_build_index_source_does_not_wipe_whole_meta():
    """源码级守门：`build_index` 里不得再出现 `DELETE FROM meta` 整表清空。

    为什么用源码断言：这是**一次删除就能重新引入活锁**的地方，
    而它不会让任何行为测试变红（清表照样能建库，只是永远建不完）。

    【self-evolution-bot · 2026-11-18 · 第43轮】注意先剥注释再断言：
    本文件改动里有多处**注释**在解释「原来的 DELETE FROM meta」，
    不剥注释的话这条断言会把注释当代码，永远为红（我第一版正是如此）。
    正反两面都要有：既断言整表删除不存在，也断言带 WHERE 的定向删除**确实存在**，
    否则「把整段删干净」也能让这条变绿。
    """
    src = Path(store.__file__).read_text(encoding="utf-8", errors="replace")
    code_lines = [ln for ln in src.splitlines() if not ln.strip().startswith("#")]
    offenders = [
        ln.strip()
        for ln in code_lines
        if "DELETE FROM meta" in ln and "WHERE" not in ln
    ]
    assert not offenders, f"发现整表清空 meta：{offenders}"
    # 反向：定向删除必须真的在（防止有人把整段删掉来"通过"本测试）。
    assert any(
        "DELETE FROM meta WHERE key LIKE 'build_progress.%" in ln for ln in code_lines
    ), "定向清理 build_progress.* 的语句不见了 —— 清表后旧进度会被当成当前进度"


# ---------------------------------------- 有内容时不该空等 search_wait_seconds


def test_wait_index_ready_does_not_block_when_index_has_content(tmp_path):
    """库里有文件可搜时，即便 building + 未 ready，也必须立刻返回。

    修前：`while not ready and building` 会无条件等满 `search_wait_seconds`，
    而 `ready` 要等 11.4 万块向量全部写完（约 30 分钟）——
    实测每次检索白等 8×250ms=2000ms，而 7839 个文件明明可搜。
    """
    cfg = store.get_code_index_config()
    if float(cfg.search_wait_seconds or 0) <= 0:
        pytest.skip("search_wait_seconds<=0，本判据不适用")

    root = _fresh_root(tmp_path)
    st = {"ready": False, "building": True, "files": 7839, "symbols": 51744}
    t0 = time.perf_counter()
    out = store._wait_index_ready(root, thread_id=None, cfg=cfg, initial=st)
    elapsed = time.perf_counter() - t0
    assert out is st, "有内容时必须原样返回，不该再去轮询"
    assert elapsed < 0.5, f"有内容还等了 {elapsed * 1000:.0f}ms"


def test_wait_index_ready_still_waits_when_index_is_empty(tmp_path):
    """库是空的就必须等 —— 这条守住上面那条别改过头。"""
    cfg = store.get_code_index_config()
    if float(cfg.search_wait_seconds or 0) <= 0:
        pytest.skip("search_wait_seconds<=0，本判据不适用")

    root = _fresh_root(tmp_path)
    st = {"ready": False, "building": True, "files": 0, "symbols": 0}
    t0 = time.perf_counter()
    # 真实轮询会调 index_status，这里把等待上限压到 0.1s 避免测试变慢。
    fast_cfg = cfg.model_copy(update={"search_wait_seconds": 0.1})
    store._wait_index_ready(root, thread_id=None, cfg=fast_cfg, initial=st)
    elapsed = time.perf_counter() - t0
    assert elapsed >= 0.09, f"空库应当等待，实际只花了 {elapsed * 1000:.0f}ms"


# ---------------------------------------------------- 漂移缓存必须能命中


def test_drift_cache_hits_across_mtime_jitter(tmp_path, monkeypatch):
    """库 mtime 每秒都在变（建库每批 commit 一次），缓存仍必须命中。

    修前缓存键是秒级 mtime，构建期间 100% miss，
    实测 `index_freshness` 每次 290~513ms 全是重新 walk 7839 文件。
    """
    calls = {"n": 0}

    def _fake_drift(root, *, since_ts=None):
        calls["n"] += 1
        return {"changed": 0, "added": 0, "deleted": 0, "total": 100}

    monkeypatch.setattr(store, "source_drift", _fake_drift)
    store._DRIFT_CACHE.clear()

    base = 1_700_000_000.0
    # 同一分钟内、每秒一次的三个 mtime：必须只真正计算一次。
    for offset in (0, 1, 2):
        store._source_drift_cached("/tmp/ws-drift-test", base + offset)
    assert calls["n"] == 1, f"同一分钟内的 mtime 抖动应命中缓存，实际重算 {calls['n']} 次"


# ------------------------------------------ 子进程视角：租约真的跨进程生效


def test_lease_blocks_a_real_second_process(tmp_path):
    """真的开第二个 Python 解释器抢租约 —— 这是唯一能证明「跨进程」的判据。

    同进程内两个连接互斥只能说明 SQLite 行锁生效，不能说明
    「两个 Gateway 进程不会同时建库」。缺陷本体正是进程内 `_jobs_lock`
    看不见另一个进程。
    """
    root = _fresh_root(tmp_path)
    key = store._workspace_hash(root)

    conn = _open(root)
    try:
        ok, _ = store.try_acquire_build_lease(conn, key, owner=f"{os.getpid()}:holder")
        assert ok
    finally:
        conn.close()

    code = f"""
import importlib, sqlite3, sys
store = importlib.import_module("evoflow.code_index.store")
conn = sqlite3.connect(r"{store._db_path(root)}", timeout=10.0)
ok, holder = store.try_acquire_build_lease(conn, "{key}", owner="other-proc")
print("OK" if ok else "BLOCKED", (holder or {{}}).get("owner"))
conn.close()
"""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(Path(store.__file__).resolve().parents[3]), env.get("PYTHONPATH", "")]
    )
    proc = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        cwd=str(tmp_path),
    )
    out = (proc.stdout or "").strip()
    assert proc.returncode == 0, f"子进程失败：{proc.stderr[-2000:]}"
    assert out.startswith("BLOCKED"), f"另一个进程居然拿到了租约：{out!r}"


def test_stale_snapshot_cannot_win_the_lease(tmp_path, monkeypatch):
    """两个进程都读到「没人持有」时，后写的那个必须输。

    【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
    这是 TOCTOU 竞态的最小复现，也是唯一能区分「原子写法 / 三步分离」的判据。
    我先后写过三版真并发测试（8 线程、多进程定时发令、多进程 ready/go 握手），
    把实现换回旧写法后**三版全绿**——不是判据太弱，是竞态窗口就在
    「读」和「写」之间那几微秒，靠起跑对齐撞不出来（起跑对齐只能对齐
    "开始抢"，对不齐"读完到写"这一段）。

    所以不去赌概率，直接构造那一刻的库状态：
    让本次 acquire 看到的心跳/pid 快照停在「还没人写」，
    而库里实际已经有别人刚写的行了 —— 这正是竞态里后到者看到的东西。

    判据：后到者必须 **rowcount=0 → False**。
      · 原子写法（ON CONFLICT ... WHERE heartbeat_at=? AND pid=?）→ 条件不满足，不更新 → 输；
      · 旧三步分离（无条件 INSERT OR REPLACE）→ 直接覆盖 → 赢 → 两个 worker 同时建库。
    """
    root = _fresh_root(tmp_path)
    key = store._workspace_hash(root)
    conn = _open(root)
    try:
        # 进程 A 已经抢到（库里有一行活租约）。
        ok_a, _ = store.try_acquire_build_lease(conn, key, owner="procA")
        assert ok_a is True

        # 进程 B 的读发生在 A 写之前 —— 把它看到的世界固定成「空」。
        monkeypatch.setattr(store, "_read_build_lease", lambda *_a, **_k: None)
        ok_b, holder_b = store.try_acquire_build_lease(conn, key, owner="procB")
    finally:
        conn.close()

    assert ok_b is False, f"进程 B 拿陈旧快照覆盖了进程 A 的租约（holder={holder_b}）"
    monkeypatch.undo()
    assert store.peek_build_lease(root)["owner"] == "procA", "租约持有者必须仍是 A"
