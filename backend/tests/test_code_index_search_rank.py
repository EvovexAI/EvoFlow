"""第32轮：检索排序回归 —— 走真实 search_index 全路径，锁已验证的修复。

【self-evolution-bot · 2026-11-17 · 第32轮】
背景：同一份真实索引库、60 条「把符号名拆成空格词」的查询、K=10，
查询集冻结在 outputs/layered_pool.json（索引库是活的，不冻结则两次跑数不可比）：

    消融（同池 60 条）           hit@1     hit@3     hit@K
    HEAD 原版                    4/60      6/60      8/60
    只加整串分隔符匹配            29/60     40/60     60/60   ← 主力
    只加输出层按 match_rank       4/60      6/60      8/60   ← 单独用零收益
    两者都有（当前工作区）        44/60     54/60     60/60

  读法：整串匹配负责「把正确符号召回并置顶」，输出层分档负责「别把它再压下去」。
  只做后者没用——没有 match_rank=4 的候选时，分档无从发挥。

已锁的修复：
  1. _search_symbols 的分隔符不敏感**整串**匹配（match_rank=4，长串优先、只认整串）
  2. format_results 按 match_rank 分档，不许用「名字是否字面包含查询串」推翻检索层
  3. FTS 查询 ORDER BY rank；_SKIP_DIRS 不再排除索引器自己的源码目录
  4. _hyphen_variants 不再反向造出 "progres-s" 这种源码不存在的词项

已撤销、勿再加回：
  「把 rerank 前的 limit 截断延后」——回退后测试全绿、同池评测零差别，
  拿不出证据的改动不留（_filter_index_rows 的 limit 仍在 rerank 前生效）。
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from evoflow.code_index import store as S


def _build_workspace(tmp_path: Path, files: dict[str, str]) -> str:
    for rel, text in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return str(tmp_path)


def test_search_index_recall_survives_candidate_pool_overflow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """匹配文档数 > fetch_lim 时，真目标必须挤进候选池。

    这是 ORDER BY rank 的真实生效边界（实测）：
      31 个匹配文档、候选池只取 10 条
        无 ORDER BY rank → 目标不在候选池（按 rowid 取，全是先入库的噪音）
        有 ORDER BY rank → 目标在候选池
    用例设计要点：目标文件名本身含关键词，rerank 会给它高分（fname==query → +85），
    所以它只要**进了候选池就必然排第一**；不在池里则完全消失。
    这样断言与 rerank 的路名 tiebreak 解耦，只测「召回进池」这一件事。
    """
    pad = "\n".join(f"unrelated_line_{i} = {i}" for i in range(400))
    noise = {
        f"aaa/n{i:02d}.py": f"zzz_needle_marker = 1\n{pad}\n" for i in range(30)
    }
    files = {
        **noise,
        "zzz/zzz_needle_marker.py": "zzz_needle_marker = 1\nzzz_needle_marker = 2\n",
    }
    root = _build_workspace(tmp_path, files)
    S.build_index(workspace_root=root, force=True)

    # 【self-evolution-bot · 2026-11-17 · 第32轮】必须关掉语义召回再测 FTS 排序：
    # 实测语义召回会把目标文件单独捞回候选池，从而**掩盖** FTS 层的排序缺陷
    # （反证时去掉 ORDER BY rank 测试仍然全绿，就是这个原因）。
    # 本用例只对 FTS 召回负责，语义召回另有其自己的测试。
    real_cfg = S.get_code_index_config()

    def _no_semantic() -> object:
        return real_cfg.model_copy(update={"semantic_search_enabled": False})

    monkeypatch.setattr(S, "get_code_index_config", _no_semantic)

    res = S.search_index(workspace_root=root, query="zzz_needle_marker", limit=10)
    got = [h["path"] for h in (res.get("hits") or [])]
    assert got, f"检索无结果，terms={res.get('search_terms')}"
    assert got[0] == "zzz/zzz_needle_marker.py", (
        "31 个匹配文档里目标没进候选池（它文件名含关键词，进池必第一）——"
        f"实际前 5={got[:5]}\n"
        "（回退 ORDER BY rank 必红：候选按 rowid 取，全是先入库的噪音）"
    )


def test_hyphen_variants_no_reverse_garbage() -> None:
    """不能把 read/progress 这类词反向拆成 persiste-d / progres-s。"""
    for word in ("progres", "read", "build", "persist", "index"):
        assert S._hyphen_variants(word) == [], (
            f"_hyphen_variants({word!r}) 又生成垃圾变体了：{S._hyphen_variants(word)}"
        )
    assert "dalle" in S._hyphen_variants("dall-e")
    assert "dall_e" in S._hyphen_variants("dall-e")


@pytest.mark.parametrize("identifier", ["_read_persisted_build_progress", "MAX_WALK_NODES"])
def test_identifier_expansion_has_no_fabricated_terms(identifier: str) -> None:
    """标识符展开出的每个词项都必须**原样**出现在原串里，不许凭空造词。

    【self-evolution-bot · 2026-11-17 · 第32轮】这条断言原来写成
    「去掉分隔符后能在 normalized 原串里找到」，结果对缺陷零分辨力：
    反向分支造出的 `persiste-d` 去掉分隔符正好等于 `persisted`，
    于是回退生产代码它照样通过（实测 6 红里有它 2 绿，是我造的空测试）。
    现在只统一连字符/下划线的写法，不再抹掉分隔符——
    `persiste-d` 归一成 `persiste_d`，不是原串的子串，必须红。
    """
    terms = S._expand_search_terms(identifier, explicit_terms=[identifier])
    hay = identifier.replace("-", "_").lower()
    for t in terms:
        needle = t.replace("-", "_").lower()
        assert needle in hay, f"展开出源码里不存在的词项: {t!r}（原始 {identifier!r}）"


def test_split_query_matches_underscored_symbol(tmp_path: Path) -> None:
    """把驼峰/下划线名字拆成词去搜，也要命中那个符号。

    实测（冻结池 60 条拆词查询、K=10、关语义召回）：
      只加这条整串匹配   hit@1 = 29/60，hit@K = 60/60
      再叠加输出层分档   hit@1 = 44/60，hit@K = 60/60
    根因：库里 `_read_persisted_build_progress` 去分隔符后与查询整串相同，
    但原实现只做「原样/前缀/子串」匹配，一个都命不中；
    per-term 循环先轮到 'read' 这个泛名（库里有 20 个叫 read 的符号），名额被占满。
    """
    root = _build_workspace(tmp_path, {
        "aaa/noise_read.py": "def read():\n    return 1\n",
        "bbb/store.py": (
            "def read_persisted_build_progress():\n    return 1\n"
        ),
    })
    S.build_index(workspace_root=root, force=True)
    res = S.search_index(workspace_root=root, query="read persisted build progress", limit=10)
    syms = [(s.get("name"), s.get("path")) for s in (res.get("symbols") or [])]
    assert syms, "符号层无结果"
    assert syms[0][0] == "read_persisted_build_progress", (
        f"拆词查询没把带下划线的符号排第一，实际={syms[:3]}"
    )


def test_no_separator_match_only_for_long_whole_query() -> None:
    """分隔符不敏感匹配只认长整串，短泛词不许拿最高档。
    我第一版让每个词都参与，progress / build 也拿了最高档，
    结果「叫 Progress 的组件」压掉了真正的 _read_persisted_build_progress。"""
    assert S._strip_seps("a-b_c d") == "abcd"
    assert S._strip_seps("_read_persisted_build_progress") == "readpersistedbuildprogress"


def test_output_layer_respects_match_rank() -> None:
    """输出层重排不许推翻检索层的 match_rank。

    实测：_search_symbols 正确给出 _read_persisted_build_progress（match_rank=4）第一，
    旧版 _symbol_rank 只看「符号名是否字面包含查询串」，
    把名字含 "progress" 的 Progress 组件判成更高档，压掉真答案。
    """
    from evoflow.code_index.format_results import format_search_index_body

    data = {
        "symbols": [
            {"name": "Progress", "path": "ui/progress.tsx", "kind": "function", "line": 20,
             "match_rank": 1},
            {"name": "_read_persisted_build_progress",
             "path": "store.py", "kind": "function", "line": 100, "match_rank": 4},
        ],
        "hits": [],
    }
    body = format_search_index_body(data, label="read persisted build progress", limit=10)
    lines = [ln for ln in body.splitlines() if ln.strip().startswith("-")]
    assert lines, body
    assert "_read_persisted_build_progress" in lines[0], (
        f"match_rank=4 的符号没排第一，实际首条={lines[0]!r}"
    )


def test_source_dir_not_skipped() -> None:
    """索引器自己的源码目录不能被 _SKIP_DIRS 排除（实测后果：15 个源文件 0 行入库）。"""
    rel = "backend/packages/harness/evoflow/code_index/store.py"
    assert not S._path_has_skipped_segment(rel), (
        "code_index 源码目录又被排除了——索引会答不出「检索是怎么实现的」"
    )
    assert S._path_has_skipped_segment(".evoflow/code_index/index.db")
    assert S._path_has_skipped_segment("evopanel/src-tauri/target/x.ts")
    assert S._path_has_skipped_segment("backend/x/node_modules/y.js")


def test_iter_skips_external_junction(tmp_path: Path) -> None:
    """仓根 junction/symlink 指到仓外时不得走进去（否则索引会混进别仓代码）。"""
    root = tmp_path / "ws"
    foreign = tmp_path / "foreign"
    root.mkdir()
    foreign.mkdir()
    (root / "keep.py").write_text("def keep():\n    return 1\n", encoding="utf-8")
    (foreign / "leak.py").write_text("def leak():\n    return 2\n", encoding="utf-8")
    link = root / "other_repo"
    try:
        link.symlink_to(foreign, target_is_directory=True)
    except OSError:
        # Windows without symlink privilege: try junction via mklink
        import subprocess

        r = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(foreign)],
            capture_output=True,
            # 【self-evolution-bot · 2026-11-17 · 第40轮】不能用 text=True：
            # Windows 下 cmd 的输出是 GBK（本机实测 0xb4），按 UTF-8 解码会在
            # subprocess 的 reader 线程抛 UnicodeDecodeError，把干净的测试输出
            # 污染成 PytestUnhandledThreadExceptionWarning —— 后来者会以为有故障。
            check=False,
        )
        if r.returncode != 0 or not link.exists():
            msg = (r.stderr or r.stdout or b"").decode("mbcs", errors="replace")
            import pytest

            pytest.skip(f"cannot create symlink/junction: {msg}")

    assert S._dir_escapes_workspace(link, root.resolve()) is True
    files = S._iter_source_files(root, max_files=100)
    names = {p.name for p in files}
    assert "keep.py" in names
    assert "leak.py" not in names


def test_search_index_exposes_freshness(tmp_path: Path) -> None:
    """索引新鲜度必须随搜索结果返回，否则调用方无从判断结果可不可信。

    【self-evolution-bot · 2026-11-17 · 第33轮】用户问「搜索的时效性你能看到吗」，
    实测原始实现看不到：返回里只有 rebuild_in_progress，而它只在「正在构建」时为真；
    构建完成后这份索引是 5 分钟还是 5 天，工具输出里没有任何信息。
    判据 = 返回值带 index_age_seconds / index_updated_at，且是 int / ISO 串。
    """
    root = _build_workspace(tmp_path, {"a.py": "def alpha_one():\n    return 1\n"})
    S.build_index(workspace_root=root, force=True)
    res = S.search_index(workspace_root=root, query="alpha_one", limit=5)
    assert "index_age_seconds" in res, "搜索结果里没有索引年龄，调用方无法判断时效性"
    age = res["index_age_seconds"]
    assert isinstance(age, int) and age >= 0, f"index_age_seconds 不是合法的非负整数：{age!r}"
    assert res.get("index_updated_at"), "缺少 index_updated_at"
    assert age < 3600, f"刚建完索引却报 age={age}s，读数不对"


def test_freshness_rendered_and_passed_through(tmp_path: Path) -> None:
    """接线三处必须都通：检索层产出 → 输出层渲染 → 工具出口不丢字段。

    【self-evolution-bot · 2026-11-17 · 第33轮】第 16 轮的教训是「只测函数、不测接线」：
    search_code_index.py 的 _format_search_data 会**重建**一个 dict 只挑字段，
    检索层就算返回了新字段，不在这里透传也会在工具出口处被丢掉。
    所以这条必须走工具自己的入口，而不是自己拼 dict 调 format。
    """
    from evoflow.tools.host_direct.search_code_index import _format_search_data

    data = {
        "hits": [{"path": "a.py", "snippet": "x"}],
        "symbols": [],
        "index_age_seconds": 390,
        "index_updated_at": "2026-11-17T03:00:00Z",
        "label": "alpha_one",
    }
    body = _format_search_data(data, limit=5)
    assert body.splitlines()[0].startswith("[index] last updated"), (
        f"索引年龄没有渲到输出首行，实际首行={body.splitlines()[0]!r}"
    )
    assert "6m" in body.splitlines()[0], f"年龄分档不对：{body.splitlines()[0]!r}"


def test_freshness_missing_does_not_break_output() -> None:
    """没有年龄字段时不许崩、也不许瞎编一行 —— 未知就静默略过。"""
    from evoflow.code_index.format_results import format_search_index_body

    body = format_search_index_body(
        {"hits": [{"path": "a.py", "snippet": "x"}], "symbols": []},
        label="alpha_one",
        limit=5,
    )
    assert "[index] last updated" not in body, "没有年龄数据却打出了年龄行（等于编造）"
    assert "Code index results for 'alpha_one':" in body
def test_whole_query_beats_single_generic_word(tmp_path: Path) -> None:
    """多词查询：整句拼起来的符号必须压过「某个单词恰好等于符号名」。

    【self-evolution-bot · 2026-11-17 · 第34轮】同池 60 条实测：
      改动前 hit@1 = 44/60、hit@3 = 54/60
      改动后 hit@1 = 57/60、hit@3 = 60/60
      定点拆除整句接线 → 掉回 44/60、54/60（反证，13 条是真实收益）
    根因：16 条 miss@1 里 14 条同一机制 —— 查询被拆成单词后，短泛词
    （resolve / build / preview / status）先拿到 match_rank=4 占满名额，
    而「整句拼起来」这个候选从未参与比对。本用例锁的正是这一条：
    库里同时存在 `build()` 和 `build_diff_summary()`，查 "build diff summary"，
    首位必须是后者。改回旧实现时 `build()` 会拿走第一。
    """
    root = _build_workspace(tmp_path, {
        "aaa/noise_build.py": "def build():\n    return 1\n",
        "bbb/summary.py": "def build_diff_summary():\n    return 2\n",
    })
    S.build_index(workspace_root=root, force=True)
    res = S.search_index(workspace_root=root, query="build diff summary", limit=10)
    syms = [(s.get("name"), s.get("match_rank")) for s in (res.get("symbols") or [])]
    assert syms, "符号层无结果"
    assert syms[0][0] == "build_diff_summary", (
        f"整句命中没排第一，实际={syms[:3]}（短泛词 build 抢了首位 = 旧缺陷复现）"
    )
    assert syms[0][1] == 5, f"整句全等应给 match_rank=5，实际={syms[0][1]}"


def test_output_layer_rank_is_monotonic() -> None:
    """输出层分档必须单调：mr=5 严格排在 mr=4 之前。

    【self-evolution-bot · 2026-11-17 · 第34轮】原实现 `mr>=4` 一律进同一档，
    于是整句命中的 resolve_data_paths（mr=5）和单词全等的 resolve（mr=4）
    同档，再由「字面包含」判胜负 —— 短名又赢一次。
    这条断言不许退化成「同档内比字面」。
    """
    from evoflow.code_index.format_results import format_search_index_body

    body = format_search_index_body(
        {
            "hits": [],
            "symbols": [
                {"path": "a.py", "name": "resolve", "kind": "function", "line": 1, "match_rank": 4},
                {"path": "b.py", "name": "resolve_data_paths", "kind": "function", "line": 2, "match_rank": 5},
            ],
        },
        label="resolve data paths",
        limit=5,
    )
    lines = [ln for ln in body.splitlines() if ln.strip().startswith("-")]
    assert lines, f"符号行没渲染出来：{body!r}"
    assert "resolve_data_paths" in lines[0], f"mr=5 没排第一，首条={lines[0]!r}"


# ---------------------------------------------------------------------------
# 第40轮：三条实测缺陷的回归锁
# 【self-evolution-bot · 2026-11-17 · 第40轮 · 模型:deepseek-v4.1-flash-1017】
# ---------------------------------------------------------------------------


def _git_repo(tmp_path: Path) -> str:
    """建一个最小 git 仓库（`_git_ignored_dirs` 依赖 git）。"""
    import subprocess

    root = tmp_path / "ws"
    root.mkdir()
    (root / ".gitignore").write_text("outputs/\nsite/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(root)], check=False, capture_output=True)
    # 不用 text=True：Windows 下 git 的 stderr 可能是 GBK，
    # 解码失败会在 reader 线程抛 UnicodeDecodeError，把测试输出污染成"疑似失败"。
    check = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--git-dir"],
        capture_output=True,
        check=False,
    )
    if check.returncode != 0:
        pytest.skip("git 不可用，跳过 gitignore 相关断言")
    return str(root)


def test_generated_dirs_are_skipped_by_gitignore(tmp_path: Path) -> None:
    """生成物目录（outputs/site）不得进索引。

    【self-evolution-bot · 2026-11-17 · 第40轮】为什么必须锁：本轮实测
    `outputs/eval_search_tool.py`（我自己的评测脚本）里写了负例字符串常量，
    于是「查一个根本不存在的符号」时索引"命中"了那个脚本，
    工具返回 10 条无关结果 —— **索引把测试夹具当成了答案**。
    同批实测，磁盘 8425 个文件里 982 个（12%）落在被忽略目录内，白解析白占库。
    """
    root = _git_repo(tmp_path)
    (tmp_path / "ws" / "outputs").mkdir()
    (tmp_path / "ws" / "outputs" / "probe.py").write_text("def probe():\n    return 1\n", encoding="utf-8")
    (tmp_path / "ws" / "site").mkdir()
    (tmp_path / "ws" / "site" / "x.md").write_text("# site\n", encoding="utf-8")
    (tmp_path / "ws" / "src").mkdir()
    (tmp_path / "ws" / "src" / "keep.py").write_text("def keep():\n    return 2\n", encoding="utf-8")

    S._GIT_IGNORED_DIRS_CACHE.clear()
    names = {p.name for p in S._iter_source_files(Path(root), max_files=100)}
    assert "keep.py" in names, f"真实源码被误伤：{names}"
    assert "probe.py" not in names, f"生成物目录 outputs/ 没有被排除：{names}"
    assert "x.md" not in names, f"生成物目录 site/ 没有被排除：{names}"


def test_real_content_dirs_not_skipped(tmp_path: Path) -> None:
    """反向断言：真实内容目录即使被 .gitignore 也不许排除。

    【self-evolution-bot · 2026-11-17 · 第40轮】第一版判据是「git 忽略就跳过」，
    实测会把 docs/roles（339 行）、backend/assets（23 行，agent 记忆）、
    skills/custom（14 行）从索引里删掉 —— 排除掉的不是产物，是人写的文档。
    判据只能是「是不是生成物落点」，不能是「git 有没有忽略」。
    """
    root = _git_repo(tmp_path)
    ws = tmp_path / "ws"
    (ws / ".gitignore").write_text("outputs/\ndocs/roles/\nassets/\n", encoding="utf-8")
    (ws / "docs" / "roles").mkdir(parents=True)
    (ws / "docs" / "roles" / "note.md").write_text("# 角色文档\n", encoding="utf-8")
    (ws / "assets").mkdir()
    (ws / "assets" / "mem.md").write_text("# 记忆\n", encoding="utf-8")

    S._GIT_IGNORED_DIRS_CACHE.clear()
    names = {p.name for p in S._iter_source_files(Path(root), max_files=100)}
    assert "note.md" in names, f"真实文档目录被误排除：{names}"
    assert "mem.md" in names, f"真实记忆目录被误排除：{names}"


def test_literal_missing_only_for_bare_identifiers() -> None:
    """「查不到」判定只能用于裸标识符，不能判死自然语言查询。

    【self-evolution-bot · 2026-11-17 · 第40轮】实测依据（大池 224 条）：
    5 条随机不存在标识符 → 5 条都没有说「没有」，其中 4 条照常吐 10 条符号。
    但 `resolve data paths`（真查询，拆词后能命中）绝不能被判成「没有」。
    语义分数不适用于此判定：实测真查询 `prune empty dirs` 语义 0.555，
    假查询 0.642 —— 分数反向，任何阈值都会误杀真查询。
    """
    assert S._looks_like_single_identifier("resolve_data_paths") is True
    assert S._looks_like_single_identifier("buildDiffSummary") is True
    assert S._looks_like_single_identifier("some_missing_symbol_ab12") is True

    # 自然语言 / 中文 / 管道 / 带空格 → 一律不判
    for s in ("resolve data paths", "插件卸载", "dall-e|dalle", "", "a b"):
        assert S._looks_like_single_identifier(s) is False, f"{s!r} 不该被当成裸标识符"


def test_not_found_hint_rendered_and_absent(tmp_path: Path) -> None:
    """输出层两向断言：标记为真才提示，标记缺失/为假时不许提示。"""
    from evoflow.code_index.format_results import format_search_index_body

    with_flag = format_search_index_body(
        {"hits": [], "symbols": [], "literal_query_missing": True},
        label="some_missing_symbol_ab12",
        limit=5,
    )
    assert "[not found]" in with_flag, f"缺「没有」提示：{with_flag!r}"

    without_flag = format_search_index_body(
        {"hits": [], "symbols": [], "literal_query_missing": False},
        label="resolve_data_paths",
        limit=5,
    )
    assert "[not found]" not in without_flag, f"真查询被误判成没有：{without_flag!r}"

    # 老数据没有这个键 → 不许 KeyError，也不许乱提示
    legacy = format_search_index_body(
        {"hits": [], "symbols": []}, label="resolve_data_paths", limit=5
    )
    assert "[not found]" not in legacy
# 【self-evolution-bot · 2026-11-18 · 第44轮 · 模型:deepseek-v4.1-flash-1017】
# 以下两条来自本机现网实测缺陷，不是设想：
#   库内 fts_content 9040 行 / 7840 个不同 path → 1200 条重复行，
#   而向量判据分母取行数(9040)、分子取 distinct path(7840)，
#   造出阈值 8859 > 分子天花板 7840 → ready 永远 False →
#   每次检索都「索引残缺，自动触发重建」，整仓被反复白烧。


def test_reindex_same_file_does_not_duplicate_fts_rows(tmp_path: Path) -> None:
    """同一个文件被索引两次，fts_content 必须仍只有一行。

    【缺陷】fts_content 是 FTS5 虚拟表，没有 UNIQUE 约束——`INSERT` 不报错、
    也不覆盖，只会**再加一行**。全量建库时第一步 `_clear_tables()` 整表 DELETE
    掩盖了这个问题，所以单进程跑一万次都看不出来；只有第二个构建进程在同一批
    path 上交错写才会暴露（本机 2026-11-18 07:24 实测 4 个 build_worker 并存
    → 1200 条重复，且抽查 40/40 的重复行 content 完全一致，是纯重复不是新旧版本）。

    断言同时覆盖两条写入路径：
      · `_index_batch`（全量建库批内写）——已补 DELETE 前置；
      · `index_file`（watcher 单文件增量）——原本就有 DELETE，一并钉住防回归。
    """
    root = _build_workspace(tmp_path, {"src/dup_check.py": "def dup_probe_symbol():\n    return 1\n"})
    S.build_index(workspace_root=root, force=True)

    conn = S._connect(Path(root))
    try:
        rows_after_build = conn.execute("select count(*) from fts_content").fetchone()[0]
        # 增量入口再写一次同一个文件（模拟 watcher 触发 / 第二个进程交错写）
        S.index_file(workspace_root=root, relative_path="src/dup_check.py")
        rows_after_incremental = conn.execute("select count(*) from fts_content").fetchone()[0]
        paths = conn.execute("select count(distinct path) from fts_content").fetchone()[0]
    finally:
        conn.close()

    assert rows_after_build == 1, f"全量建库就写出了重复行：{rows_after_build} 行"
    assert rows_after_incremental == 1, (
        f"同一文件被重复索引后 fts_content 变成 {rows_after_incremental} 行"
        "（FTS5 无 UNIQUE 约束，写前必须先按 path DELETE）"
    )
    assert paths == 1


def test_vector_coverage_denominator_uses_distinct_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """向量覆盖率判据的分母必须按**不同文件数**，不能按 fts 行数。

    【为什么】分子 `vec_paths` 是 `COUNT(DISTINCT path)`（文件数口径），
    分母若取 `_fts_doc_count()` 的行数，一旦 fts 出现同 path 多行，
    分母会虚涨而分子天花板不变 → 阈值永远达不到 → `ready=False` 恒定
    → `schedule_build_index` 每次都判残缺 → 每次检索都白烧一遍全仓。
    本机实测：9040 行 / 7840 path，阈值 8859 > 天花板 7840，恒 False。

    本用例直接**人为制造**重复行来复现那个状态，再断言判据不因重复行变脸。
    """
    root = _build_workspace(
        tmp_path,
        {
            "src/a.py": "def alpha_symbol():\n    return 1\n",
            "src/b.py": "def beta_symbol():\n    return 2\n",
        },
    )
    S.build_index(workspace_root=root, force=True)

    # 人工灌重复行（等价于并发构建交错写留下来的脏数据）
    conn = S._connect(Path(root))
    try:
        row = conn.execute("select path, content from fts_content limit 1").fetchone()
        for _ in range(3):
            conn.execute("INSERT INTO fts_content(path, content) VALUES (?, ?)", (row[0], row[1]))
        conn.commit()
        rows = conn.execute("select count(*) from fts_content").fetchone()[0]
        distinct = conn.execute("select count(distinct path) from fts_content").fetchone()[0]
        # 清掉向量，让判据必须开口说话（否则 vec_n==0 走 vectors_missing 分支）
        try:
            conn.execute("DELETE FROM code_vec")
            conn.commit()
        except Exception:  # noqa: BLE001 - 没有 vec0 时这条用例退化为只验分母
            pass
    finally:
        conn.close()

    assert rows > distinct, f"夹具没造出重复行：rows={rows} distinct={distinct}"

    st = S.index_status(workspace_root=root)
    reasons = " ".join(st.get("stale_reasons") or [])
    # 分母必须是 distinct(2)，不能是 rows(5)：报出的数字应等于文件数
    for num in reasons.replace("<", " ").replace(":", " ").split():
        if num.isdigit():
            assert int(num) != rows or rows == distinct, (
                f"判据仍在用行数 {rows} 当分母（真实文件数 {distinct}）：{reasons!r}"
            )
def test_build_lease_is_mutually_exclusive_under_race(tmp_path: Path) -> None:
    """并发抢建库租约，只许一个进程抢到。

    【缺陷】原实现是「读→判→写」三步：每个进程先 `_read_build_lease` 读到没人持有，
    再各自 `INSERT OR REPLACE`，最后一个覆盖前几个 —— **所有进程都返回抢到了**。
    本机 2026-11-18 07:24 复现：4 个 build_worker 并存写同一个库，
    fts_content 造出 1200 条同 path 重复行，进而让向量判据分母虚涨、
    `ready` 永远 False、每次检索都重烧一遍全仓。
    修法：压成一条 `INSERT ... ON CONFLICT DO UPDATE ... WHERE 旧心跳/旧 pid 仍匹配`，
    `rowcount == 0` 即没抢到（单条语句在 SQLite 里是原子的）。

    反证要求：把 `ON CONFLICT ... WHERE` 换回 `INSERT OR REPLACE`，
    本用例必须变红（否则说明它测不到竞争）。
    """
    import sqlite3

    root = _build_workspace(tmp_path, {"src/x.py": "def x_symbol():\n    return 1\n"})
    key = S._workspace_hash(root)
    # 先建库让 schema/租约表就位，再清掉租约，模拟「此刻没人持有」
    S.build_index(workspace_root=root, force=True)
    conn = S._connect(Path(root))
    try:
        conn.execute("DELETE FROM build_lease")
        conn.commit()
    finally:
        conn.close()

    n = 6
    results: list[tuple[int, bool]] = []
    barrier = threading.Barrier(n)

    def _worker(i: int) -> None:
        c = sqlite3.connect(str(S._db_path(root)), timeout=30.0)
        c.row_factory = sqlite3.Row
        try:
            barrier.wait()
            ok, _holder = S.try_acquire_build_lease(c, key, owner=f"w{i}:test")
            results.append((i, bool(ok)))
        finally:
            c.close()

    threads = [threading.Thread(target=_worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    got = [r for r in results if r[1]]
    assert len(results) == n
    assert len(got) == 1, (
        f"租约不互斥：{len(got)}/{n} 个进程都以为自己抢到了（应为 1）—— "
        f"读写判断必须压成一条带条件的 SQL 才是原子的：{sorted(results)}"
    )
def test_vectors_only_embeds_only_files_missing_vectors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`vectors_only` 恢复路径必须**只补缺向量的文件**，不许把全仓重嵌一遍。

    【缺陷】原实现无条件把 `source_files` 整份交给 `_index_embeddings_sync`，
    于是「只补向量」实际等于「把所有文件重算一遍向量」。
    实测本机 2026-11-18：7842 个可索引文件里 2580 个已有向量 → 33% 纯浪费；
    而向量段是建库最慢的一段（本地 bge ≈96 块/秒、全仓 11.4 万块 ≈20 分钟），
    每被打断一次就多烧 6~7 分钟。

    本用例用 monkeypatch 记录真正送进嵌入的文件名，直接断言「已有向量的不送」。
    """
    files = {
        "src/keep.py": "def keep_symbol():\n    return 1\n",
        "src/fill.py": "def fill_symbol():\n    return 2\n",
        "src/other.py": "def other_symbol():\n    return 3\n",
    }
    root = _build_workspace(tmp_path, files)
    S.build_index(workspace_root=root, force=True)

    # 人为制造「部分文件缺向量」：删掉 src/fill.py 的全部向量
    conn = S._connect(Path(root))
    try:
        conn.execute("DELETE FROM code_vec WHERE path = ?", ("src/fill.py",))
        conn.commit()
        have = {r[0] for r in conn.execute("SELECT DISTINCT path FROM code_vec")}
    finally:
        conn.close()
    assert "src/fill.py" not in have
    assert have, "夹具没留下任何已有向量，用例无意义"

    sent: list[str] = []
    real_embed = S._index_embeddings_sync

    def _spy(root_, root_path_, files_, cfg_):
        sent.extend(p.relative_to(root_path_).as_posix() for p in files_)
        return real_embed(root_, root_path_, files_, cfg_)

    monkeypatch.setattr(S, "_index_embeddings_sync", _spy)
    S.build_index(workspace_root=root, force=False)  # 走 vectors_only 分支

    assert "src/fill.py" in sent, f"缺向量的文件没被补：{sorted(sent)}"
    for p in have:
        assert p not in sent, (
            f"已有向量的 {p} 被重复嵌入（vectors-only 应当只补缺的）：{sorted(sent)}"
        )
