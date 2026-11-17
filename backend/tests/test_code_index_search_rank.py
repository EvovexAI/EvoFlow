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
            text=True,
            check=False,
        )
        if r.returncode != 0 or not link.exists():
            import pytest

            pytest.skip(f"cannot create symlink/junction: {r.stderr or r.stdout}")

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
