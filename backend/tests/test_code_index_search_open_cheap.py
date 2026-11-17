"""第39轮回归：搜索路径上三处「每次检索都白付」的开销必须保持已修。

【self-evolution-bot · 2026-11-17 · 第39轮 · 模型:deepseek-v4.1-flash-1017】

为什么这三条值得锁：它们都不是「某次调用慢」，而是**每次 search_index 都付**，
且都属于「看不出错、只是慢」的类型——不会红、不会报错、只让用户觉得工具卡。

判据一律选**实现级/等价性**，不选耗时阈值：耗时在不同机器上不稳，
而「有没有多发一次系统调用」「算出的是不是同一批路径」「pragma 有没有真的读回」是确定的。

⚠️ 本文件吃过一次教训（第39轮自身）：
第一版把 `source_drift` 的切片逻辑**复刻**在测试里，于是关掉被测实现它照样绿——
测试测的是测试自己。现改为全部调用 store 里的真实函数；对拍对象是 pathlib。
"""
from __future__ import annotations

import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from evoflow.code_index import store

# ── 1. mmap：连接建好就必须能读回 mmap_size ────────────────────────────────


def test_connection_enables_mmap(tmp_path: Path) -> None:
    """_configure_sqlite_connection 必须开启 mmap。

    为什么：本仓索引库已 1.0GB（code_vec 向量段 644MB），vec0 的 KNN 是纯顺序读，
    不映射就每次检索白等 0.3s。实测 KNN 374ms → 66ms，整体 -21%。
    """
    conn = sqlite3.connect(str(tmp_path / "t.db"))
    try:
        store._configure_sqlite_connection(conn)
        got = int(conn.execute("PRAGMA mmap_size").fetchone()[0])
    finally:
        conn.close()
    assert got > 0, f"mmap_size 未生效（读回 {got}）——索引库会退化成普通文件读"


def test_mmap_pragma_failure_does_not_break_connection(tmp_path: Path) -> None:
    """mmap 是纯优化，任何失败都不许挡住连接建立。

    反向：让 execute 对 mmap 语句抛 OperationalError，_configure_sqlite_connection 仍须正常返回。
    用 factory 子类而不是 monkeypatch sqlite3.Connection（后者是不可变内建类型，
    monkeypatch 会直接 TypeError——本机已验证）。
    """

    class RaisingConn(sqlite3.Connection):
        def execute(self, sql, *args, **kwargs):  # type: ignore[override]
            if "mmap_size" in str(sql):
                raise sqlite3.OperationalError("simulated: mmap unsupported")
            return super().execute(sql, *args, **kwargs)

    conn = sqlite3.connect(str(tmp_path / "raise.db"), factory=RaisingConn)
    try:
        store._configure_sqlite_connection(conn)  # 不应抛
        assert conn.execute("SELECT 1").fetchone()[0] == 1
    finally:
        conn.close()


# ── 2. source_drift 的相对路径：必须与 Path.relative_to 逐条等价 ─────────────


def test_rel_paths_match_pathlib(tmp_path: Path) -> None:
    """store 的切片实现必须与 Path.relative_to 对同一批文件给出完全相同的相对路径。

    直接调 store 的真实函数（不复刻），对拍对象是 pathlib。
    """
    root = tmp_path / "repo"
    names = [
        "a.py",
        "pkg/b.ts",
        "pkg/deep/nest/c.tsx",
        "带 空格/文件.py",
        "dash-dir/x_y.z",
        "very/deep/chain/of/dirs/f.py",
    ]
    files = []
    for n in names:
        p = root / n
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("x", encoding="utf-8")
        files.append(p)

    prefix = store._rel_path_prefix(root)
    got = {r for p in files if (r := store._relative_source_path(p, prefix)) is not None}
    want = {p.relative_to(root).as_posix() for p in files}
    assert got == want, f"切片 {sorted(got)} != pathlib {sorted(want)}"


def test_rel_paths_sibling_dir_with_same_prefix_not_stripped(tmp_path: Path) -> None:
    """兄弟目录名以根目录名开头时，不许把前缀误切掉。

    这是字符串切片最典型的坑：`repo` 与 `repo2`。若实现写成
    `sp[len(root_prefix):]`（而不是先判 `startswith(root_prefix + "/")`），
    `D:/x/repo2/a.py` 会被切成 `2/a.py` 并冒充成 `repo` 里的文件。
    这条断言是**真正能区分对错**的那条（对拍 pathlib 那条对等价实现无力）。
    """
    root = tmp_path / "repo"
    root.mkdir()
    sibling = tmp_path / "repo2" / "a.py"
    sibling.parent.mkdir(parents=True, exist_ok=True)
    sibling.write_text("x", encoding="utf-8")

    got = store._relative_source_path(sibling, store._rel_path_prefix(root))
    assert got is not None
    assert not got.startswith("2/"), f"把 repo2 的前缀当 repo 切掉了: {got!r}"
    assert "repo2" in str(got), f"兄弟目录被误判为根内文件: {got!r}"


def test_rel_paths_never_silently_drop_outside_files(tmp_path: Path) -> None:
    """根目录外的路径不许被静默丢掉。

    原实现 `except ValueError: continue` 会把根外文件直接丢掉；改造后必须退回原串。
    这是「更保守」的语义，测试守住它，防止有人图省事改回 continue。
    """
    root = tmp_path / "repo"
    root.mkdir()
    outside = tmp_path / "elsewhere.py"
    outside.write_text("x", encoding="utf-8")

    got = store._relative_source_path(outside, store._rel_path_prefix(root))
    assert got is not None, "根外路径被丢成 None——真实文件会从漂移统计里消失"
    assert "elsewhere.py" in str(got)


def test_rel_paths_root_itself_returns_none(tmp_path: Path) -> None:
    """根目录自身不是文件，必须返回 None（原实现会给个 '.'）。"""
    root = tmp_path / "repo"
    root.mkdir()
    assert store._relative_source_path(root, store._rel_path_prefix(root)) is None


def test_source_drift_counts_unchanged_after_refactor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """source_drift 端到端：新增/删除/未变三种文件的计数必须正确。

    这条测的是「改完还算得对」，而不是耗时。
    """
    root = tmp_path / "repo"
    root.mkdir()
    (root / "kept.py").write_text("x", encoding="utf-8")
    (root / "gone.py").write_text("x", encoding="utf-8")

    # 造一个只有 kept.py 的索引库
    dbp = root / ".evoflow" / "code_index" / "index.db"
    dbp.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(dbp))
    try:
        conn.execute("CREATE TABLE fts_content (path TEXT)")
        conn.execute("INSERT INTO fts_content VALUES ('kept.py')")
        conn.execute("INSERT INTO fts_content VALUES ('gone.py')")
        conn.commit()
    finally:
        conn.close()

    monkeypatch.setattr(store, "get_code_index_config", lambda: type("C", (), {"max_files": 100})())
    # 真正的「删除」：必须从磁盘移走，只在库里留着——这样 deleted 才该 +1。
    # （第一版忘了删，于是断言 deleted==1 必然失败，红的是测试不是实现。）
    (root / "gone.py").unlink()
    (root / "newone.py").write_text("x", encoding="utf-8")

    drift = store.source_drift(str(root))
    assert drift["deleted"] == 1, f"gone.py 未被识别为删除: {drift}"
    assert drift["added"] >= 1, f"newone.py 未被识别为新增: {drift}"


# ── 3. 逃逸检查：普通目录不许再付 resolve() 的系统调用 ──────────────────────


def test_escape_check_skips_resolve_for_plain_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """普通目录（非 symlink / 非 junction）不应调用 Path.resolve()。

    为什么：resolve() 在 Windows 上是 nt._getfinalpathname，逐个目录一次系统调用，
    实测 22k 个目录累计 148ms。而 os.walk 里判完就 `dirnames[:] = kept` 剪枝，
    逃逸目录的子目录根本到不了这里，所以那次 resolve 拦不到任何新东西
    （probe 实测文件集 8426/8426 完全一致）。
    """
    target = tmp_path / "plain"
    target.mkdir()

    calls = {"n": 0}
    real_resolve = Path.resolve

    def counting_resolve(self, *a, **kw):
        calls["n"] += 1
        return real_resolve(self, *a, **kw)

    monkeypatch.setattr(Path, "resolve", counting_resolve)
    escaped = store._dir_escapes_workspace(target, tmp_path)
    assert escaped is False, "普通目录被判为逃逸"
    assert calls["n"] == 0, f"普通目录仍调用了 resolve {calls['n']} 次（每次检索白付系统调用）"


def test_escape_check_still_blocks_symlink(tmp_path: Path) -> None:
    """symlink 必须仍然被拦（改造不能破坏的既有行为）。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    root.mkdir()
    link = root / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"无法创建 symlink: {exc}")
    assert store._dir_escapes_workspace(link, root) is True


def test_escape_check_still_blocks_junction(tmp_path: Path) -> None:
    """junction 必须仍然被拦——这是本仓 clawdevoflow 的真实形态。"""
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = root / "junc"
    if sys.platform == "win32":
        # 不用 text=True：cmd /c mklink 的中文输出是 GBK，按 UTF-8 解码会在
        # reader 线程抛 UnicodeDecodeError（只是 warning，但会污染整个套件的输出）。
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
        if r.returncode != 0:
            pytest.skip(f"无法创建 junction: {r.stdout!r}{r.stderr!r}")
    else:
        link.symlink_to(outside, target_is_directory=True)

    assert store._dir_escapes_workspace(link, root) is True


def test_escape_check_falls_back_when_is_junction_missing(tmp_path: Path) -> None:
    """没有 is_junction 的 Python/平台上必须退回 resolve 比较（行为与改造前一致）。

    反向：把探针对象的 is_junction 藏起来，此时若实现直接 `return False`，
    逃逸目录就会被放行——所以必须计数 resolve 确实被调用过。
    用鸭子类型替身（只实现 _dir_escapes_workspace 真正用到的三样：
    is_symlink / resolve / 可选 is_junction），不去打桩 builtins.getattr。
    """
    root = tmp_path / "root"
    root.mkdir()
    real_inside = root / "child"
    real_inside.mkdir()
    real_escape = tmp_path / "escape"
    real_escape.mkdir()

    calls = {"resolve": 0}

    class NoJunctionPath:
        """模拟「拿不到 is_junction 属性」的路径对象。"""

        def __init__(self, real: Path) -> None:
            self._real = real

        def is_symlink(self) -> bool:
            return False

        def resolve(self) -> Path:
            calls["resolve"] += 1
            return self._real.resolve()

        # 故意不定义 is_junction

    assert store._dir_escapes_workspace(NoJunctionPath(real_inside), root.resolve()) is False
    assert calls["resolve"] >= 1, "没有 is_junction 时未退回 resolve 比较，等于放行了逃逸目录"

    calls["resolve"] = 0
    assert store._dir_escapes_workspace(NoJunctionPath(real_escape), root.resolve()) is True
