"""`get_session_map_entry` 必须与 `load_session_map()[k]` 逐字段等价，且只查一行。

【self-evolution-bot · 2026-11-18 · 第49轮 · 模型:deepseek-v4.1-flash-1017】
为什么要锁两条：
1. **等价性**——有 7 个调用点把它当「按 key 取侧栏一行」用，写的是
   `existing.get("threadId")` / `existing.get("createdAt")` 这类驼峰键。
   任何字段漏拼都会静默变成空值（不报错），所以必须逐字段比对，不能只断言非空。
2. **只查一行**——这才是修的东西。原实现为取一个字段 SELECT 全部会话行
   （本机 548 行，冷 6976ms / 热 124ms），单行只要 0.017ms。
   断言「SELECT 语句数」比断言耗时稳定：耗时受机器负载影响，语句数不会。
"""

from __future__ import annotations

from evoflow.persistence import session_repositories as R


class _FakeRow:
    """sqlite3.Row 的最小替身：`_row_dict` 走 `row.keys()`，用 tuple 会 AttributeError。"""

    def __init__(self, data: dict):
        self._data = data
        self._keys = list(data.keys())

    def keys(self):
        return self._keys

    def __getitem__(self, i):
        if isinstance(i, int):
            return self._data[self._keys[i]]
        return self._data[i]


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _RecordingDb:
    """记录执行过的每条 SQL，让「查了几行」可断言。"""

    def __init__(self, rows):
        self.sql: list[str] = []
        self._rows = rows

    def execute(self, sql, params=()):
        self.sql.append(sql)
        return _FakeCursor(self._rows)


def _patch_db(monkeypatch, rows) -> _RecordingDb:
    db = _RecordingDb(rows)
    monkeypatch.setattr(R, "get_db", lambda: db)
    return db


_ROW = {
    "session_key": "proactive:self-evolution-bot:chat:abc",
    "thread_id": "lc-1234",
    "title": "第49轮",
    "created_at": 1700000000000,
    "updated_at": 1700000005000,
    "message_count": 7,
    "context_json": '{"proactive_round_id": "round:2026-11-18T13:00:00+08:00"}',
    "is_deleted": 0,
    "local_workspace_root": None,
    "use_virtual_paths": 0,
    "model_name": None,
    "model_pinned": 0,
    "primary_model_name": None,
    "session_mode": None,
    "thinking_enabled": None,
    "reasoning_effort": None,
    "is_plan_mode": None,
    "subagent_enabled": None,
    "include_search": None,
    "memory_enabled": None,
    "use_claude_code_chat": 0,
    "collab_phase": None,
    "collab_task_id": None,
    "agent_id": "self-evolution-bot",
    "permission_preset": None,
    "tool_approval_policy": None,
    "session_status": None,
}


def test_entry_shape_matches_load_session_map(monkeypatch):
    """两侧逐字段相等——这是 7 个调用点敢直接替换的唯一依据。"""
    _patch_db(monkeypatch, [_FakeRow(_ROW)])
    entry = R.get_session_map_entry("proactive:self-evolution-bot:chat:abc")
    expected = R._session_row_to_map_entry(
        {k: v for k, v in _ROW.items()}
    )
    assert entry == expected
    # 调用点用到的驼峰键一个都不能少
    for k in ("threadId", "title", "createdAt", "updatedAt", "messageCount", "context"):
        assert k in entry, f"缺键 {k}：调用点会静默取到空值"
    assert entry["threadId"] == "lc-1234"
    assert entry["context"]["proactive_round_id"] == "round:2026-11-18T13:00:00+08:00"


def test_single_row_query_only(monkeypatch):
    """只发一条 SQL，且带 LIMIT 1 —— 防有人改回全表扫。"""
    db = _patch_db(monkeypatch, [_FakeRow(_ROW)])
    R.get_session_map_entry("proactive:self-evolution-bot:chat:abc")
    assert len(db.sql) == 1, f"应当只查一行，实际发了 {len(db.sql)} 条 SQL"
    assert "LIMIT 1" in db.sql[0]


def test_filter_conditions_match_load_session_map(monkeypatch):
    """过滤条件必须与 load_session_map 一致，否则「取不到」和「取到"已删除"」两种情况会分叉。"""
    db = _patch_db(monkeypatch, [_FakeRow(_ROW)])
    R.get_session_map_entry("proactive:self-evolution-bot:chat:abc")
    sql = " ".join(db.sql[0].split())
    assert "is_deleted = 0" in sql
    assert "prewarmed" in sql, "必须排除 prewarmed 会话（否则侧栏出现幽灵行）"
    assert "agent:executor:%" in sql


def test_missing_and_deleted_return_none(monkeypatch):
    """查不到返回 None，调用方 `or {}` 即等价于旧行为；空 key 不发 SQL。"""
    db = _patch_db(monkeypatch, [])
    assert R.get_session_map_entry("no-such-key") is None
    assert R.get_session_map_entry("") is None
    assert R.get_session_map_entry(None) is None
    assert len(db.sql) == 1, "空 key 不应该查库"
