"""坏库文案必须从**工具出口**说出「库坏了」，不许被「未就绪」分支抢先。

【self-evolution-bot · 2026-11-22 · 第124轮 · 模型:deepseek-v4.1-flash】
本轮自撞实录：坏库隔离后紧接着调 `index_status`，`ready=False` 且 `building`
可能尚未置位（重建是异步排队），于是初版顺序先撞「not ready」分支，用户看到的是
"Workspace index is not ready — open the project in EvoPanel (index build)"。
库明明是刚被改名隔离并已排队重建，文案却让人去 UI 建索引 —— 下一步动作指错。
本测试锁的是**工具出口**（`_run_search_index_lookup` 返回的用户文案），不是内部 flag。
"""

from __future__ import annotations

from evoflow.tools.host_direct import search_code_index as SC


def test_corrupt_message_wins_over_not_ready(monkeypatch):
    """库刚被隔离（ready=False / building=False）时，文案仍须点名「CORRUPTED」。"""

    def _fake_search_index(*args, **kwargs):
        return {
            "hits": [],
            "symbols": [],
            "related_files": [],
            "imported_by": [],
            "imports": [],
            "internal_ref_users": [],
            "type_supertypes": [],
            "type_subtypes": [],
            "index_corrupt_recovered": True,
            "index_quarantined": True,
            "rebuild_in_progress": True,
        }

    import evoflow.code_index.store as S

    monkeypatch.setattr(S, "search_index", _fake_search_index)
    monkeypatch.setattr(
        S,
        "index_status",
        lambda **kw: {"ready": False, "building": False},
    )

    msg, data = SC._run_search_index_lookup(
        root="C:/tmp/whatever",
        thread_id=None,
        query="RightStagePanel",
        queries=None,
        limit=15,
    )
    assert data is None
    assert "CORRUPTED" in msg, f"坏库文案被别的分支抢先了：{msg}"
    assert "not ready" not in msg, "不许让用户以为只是没建索引"


def test_plain_not_ready_message_still_used_for_healthy_index(monkeypatch):
    """反证：库没坏时仍走原来的「未就绪」文案，别把正常情况也说成损坏。"""

    def _fake_search_index(*args, **kwargs):
        return {
            "hits": [],
            "symbols": [],
            "related_files": [],
            "imported_by": [],
            "imports": [],
            "internal_ref_users": [],
            "type_supertypes": [],
            "type_subtypes": [],
        }

    import evoflow.code_index.store as S

    monkeypatch.setattr(S, "search_index", _fake_search_index)
    monkeypatch.setattr(
        S,
        "index_status",
        lambda **kw: {"ready": False, "building": False},
    )

    msg, data = SC._run_search_index_lookup(
        root="C:/tmp/whatever",
        thread_id=None,
        query="RightStagePanel",
        queries=None,
        limit=15,
    )
    assert data is None
    assert "not ready" in msg
    assert "CORRUPTED" not in msg


def test_corrupt_not_quarantined_says_so_and_gives_next_action(monkeypatch):
    """隔离**失败**时（quarantined=[]）不许再说「已改名隔离」。

    【self-evolution-bot · 2026-11-22 · 第126轮 · 模型:deepseek-v4.1-flash】
    现网实证：工具回执写着 "The bad file has been quarantined (kept, renamed with a
    .corrupt-<timestamp> suffix)"，但盘上一个 `.corrupt-*` 都没有、`quick_check`
    仍报同一个 freelist 损坏 —— index.db 根本没被移走。
    根因：`_search_index_impl` 自动起构建子进程攥着句柄 →
    `os.replace` 全部 `[WinError 32]` → `quarantined=[]`。
    这条锁的是「工具出口必须按 quarantined 的真实取值分两支」：
    没隔离就明说没隔离、并给出可执行的下一步（人工释放/删除），
    不许让员工按「稍后重试」无限等一个不会发生的重建。
    """

    def _fake_search_index(*args, **kwargs):
        return {
            "hits": [],
            "symbols": [],
            "related_files": [],
            "imported_by": [],
            "imports": [],
            "internal_ref_users": [],
            "type_supertypes": [],
            "type_subtypes": [],
            "index_corrupt_recovered": True,
            "index_quarantined": False,
            "rebuild_scheduled": False,
            "rebuild_in_progress": False,
            "db_path": "D:/ws/.evoflow/code_index/index.db",
        }

    import evoflow.code_index.store as S

    monkeypatch.setattr(S, "search_index", _fake_search_index)
    monkeypatch.setattr(S, "index_status", lambda **kw: {"ready": False, "building": False})

    msg, data = SC._run_search_index_lookup(
        root="D:/ws",
        thread_id=None,
        query="anything",
        queries=None,
        limit=5,
    )
    assert data is None
    low = msg.lower()
    # 1) 不许出现「已隔离」的断言
    assert "has been quarantined" not in low
    # 2) 必须说清库坏了 + 隔离失败
    assert "corrupted" in low
    assert "could not be quarantined" in low or "could not" in low
    # 3) 必须给下一步动作，而不是「稍后重试」
    assert "retry" in low
    assert "operator" in low or "delete" in low
