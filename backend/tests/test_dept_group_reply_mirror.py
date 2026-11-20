"""部门群聊回复镜像测试。

【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】

覆盖：
1. 开关默认关闭（EVOFLOW_DEPT_GROUP_REPLY_MIRROR 未设置 → 不镜像）
2. 开关打开 + 会话带 dept_group_timeline_session → 镜像成功
3. 幂等键确定性：同 (session_key, run_id, turn_key) 多次 → 同 id
4. 幂等键区分性：不同 run_id / turn_key → 不同 id
5. 群会话自身不镜像（防自循环）
6. 非群会话（无 dept_group_timeline_session）不镜像
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class DeptGroupReplyMirrorTest(unittest.TestCase):
    def setUp(self) -> None:
        self._old_flag = os.environ.get("EVOFLOW_DEPT_GROUP_REPLY_MIRROR")
        self._tmpdir = tempfile.TemporaryDirectory()
        self._old_db = os.environ.get("EVOFLOW_DB_PATH")
        os.environ["EVOFLOW_DB_PATH"] = str(Path(self._tmpdir.name) / "mirror_test.db")
        # 重置单例，确保用新库。注意必须用仓库提供的 reset_db_for_tests()：
        # 写连接是 _shared_conn/_shared_wrapper，并不存在 _db_conn，
        # 直接置一个不存在的属性等于没断连接，临时目录 cleanup 会 PermissionError。
        # 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
        from evoflow.persistence.db import reset_db_for_tests

        reset_db_for_tests()

    def tearDown(self) -> None:
        if self._old_flag is None:
            os.environ.pop("EVOFLOW_DEPT_GROUP_REPLY_MIRROR", None)
        else:
            os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = self._old_flag
        if self._old_db is None:
            os.environ.pop("EVOFLOW_DB_PATH", None)
        else:
            os.environ["EVOFLOW_DB_PATH"] = self._old_db
        from evoflow.persistence.db import reset_db_for_tests

        reset_db_for_tests()
        self._tmpdir.cleanup()

    # ── 1. 开关 ────────────────────────────────────────────────────────
    def test_flag_on_by_default(self) -> None:
        """默认开：功能要真生效，否则等于交付了一个不干活的补丁。"""
        os.environ.pop("EVOFLOW_DEPT_GROUP_REPLY_MIRROR", None)
        from evoflow.proactive.dept_group_reply_mirror import mirror_enabled

        self.assertTrue(mirror_enabled())

    def test_flag_can_be_disabled(self) -> None:
        for raw in ("0", "false", "OFF", "no"):
            os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = raw
            from evoflow.proactive.dept_group_reply_mirror import mirror_enabled

            self.assertFalse(mirror_enabled(), f"{raw!r} 必须能关掉，否则没法回滚")

    def test_flag_explicit_on(self) -> None:
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.proactive.dept_group_reply_mirror import mirror_enabled

        self.assertTrue(mirror_enabled())

    def test_non_group_session_fast_path(self) -> None:
        """普通 1:1 会话不该为此多读一次会话上下文。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        self.assertFalse(
            mirror_reply_to_dept_group(session_key="proactive:bot:chat", content="私聊")
        )

    # ── 2. 幂等键确定性（反证锚点）──────────────────────────────────────
    def test_message_id_is_deterministic(self) -> None:
        from evoflow.proactive.dept_group_reply_mirror import build_mirror_message_id

        a = build_mirror_message_id(
            session_key="proactive:x:chat:dept-d1", run_id="run-1", turn_key="msg-1"
        )
        b = build_mirror_message_id(
            session_key="proactive:x:chat:dept-d1", run_id="run-1", turn_key="msg-1"
        )
        self.assertEqual(a, b, "同输入必须产生同 id，否则重试会重复落库")
        self.assertTrue(a.startswith("dept-reply-"), f"前缀应为 dept-reply-，实际 {a}")

    def test_message_id_differs_by_run(self) -> None:
        from evoflow.proactive.dept_group_reply_mirror import build_mirror_message_id

        a = build_mirror_message_id(session_key="s", run_id="run-1", turn_key="m")
        b = build_mirror_message_id(session_key="s", run_id="run-2", turn_key="m")
        self.assertNotEqual(a, b, "不同 run 不能塌成同一条")

    def test_message_id_differs_by_turn(self) -> None:
        from evoflow.proactive.dept_group_reply_mirror import build_mirror_message_id

        a = build_mirror_message_id(session_key="s", run_id="r", turn_key="m-1")
        b = build_mirror_message_id(session_key="s", run_id="r", turn_key="m-2")
        self.assertNotEqual(a, b, "同一 run 内不同轮次不能合并")

    # ── 3. 镜像行为 ────────────────────────────────────────────────────
    def _mk_session(self, sk: str, ctx: dict) -> None:
        import json

        from evoflow.persistence.db import get_db

        conn = get_db()
        conn.execute(
            """
            INSERT OR REPLACE INTO evoflow_chat_sessions
                (session_key, thread_id, title, created_at, updated_at,
                 message_count, context_json, is_deleted)
            VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, ?, 0)
            """,
            (sk, "t-" + sk[:8], "test", json.dumps(ctx, ensure_ascii=False)),
        )
        conn.commit()

    def test_speaker_name_uses_role_name_not_ctx_agent_name(self) -> None:
        """群里显示名必须是**岗位花名**，不是会话上下文里的 ``agent_name``。

        现网实测缺陷：会话上下文里 ``agent_name`` 是 ``"main"``（主智能体名），
        镜像照抄后同一个人在群里出现两个名字——前端气泡写「新粉引导Bot」，
        后端镜像行写「main」（现网 dept:fb5e4c3468ce:chat seq 252 即此）。
        真源是 ``evoflow_proactive_roles.role_name``。

        【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
        """
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        import json

        from evoflow.persistence.db import get_db
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:dname:chat"
        work_sk = "proactive:bot:chat:dept-dname"
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO evoflow_proactive_roles "
            "(agent_code, role_name, config_json, created_at, updated_at) "
            "VALUES (?, ?, '{}', datetime('now'), datetime('now'))",
            ("bot", "新粉引导Bot"),
        )
        conn.commit()
        self._mk_session(group_sk, {"dept_group_id": "dname"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "dname",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                # 现网就是这个值：主智能体的名字，不是岗位花名
                "agent_name": "main",
            },
        )

        ok = mirror_reply_to_dept_group(
            session_key=work_sk, content="回一句话", run_id="rn", turn_key="mn"
        )
        self.assertTrue(ok)
        row = get_db().execute(
            "SELECT content_json FROM evoflow_chat_messages WHERE session_key = ?",
            (group_sk,),
        ).fetchone()
        self.assertIsNotNone(row)
        dg = json.loads(str(row[0])).get("dept_group") or {}
        self.assertEqual(
            dg.get("speaker_name"),
            "新粉引导Bot",
            f"群里显示名必须是岗位花名，实际 {dg.get('speaker_name')!r}",
        )

    def _count_group_msgs(self, group_sk: str) -> int:
        from evoflow.persistence.db import get_db

        row = get_db().execute(
            "SELECT count(*) FROM evoflow_chat_messages WHERE session_key = ?", (group_sk,)
        ).fetchone()
        return int(row[0] or 0) if row else 0

    def test_mirror_writes_into_group_timeline(self) -> None:
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d1:chat"
        work_sk = "proactive:bot:chat:dept-d1"
        self._mk_session(group_sk, {"dept_group_id": "d1"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d1",
                "dept_group_name": "测试部",
                "dept_group_im": True,
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )

        ok = mirror_reply_to_dept_group(
            session_key=work_sk, content="我在群里说一句", run_id="r1", turn_key="m1"
        )
        self.assertTrue(ok, "带 dept_group_timeline_session 的会话必须镜像成功")
        self.assertEqual(self._count_group_msgs(group_sk), 1)

    def test_mirror_is_idempotent(self) -> None:
        """同一轮重复写 3 次 → 群里只留 1 条。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d2:chat"
        work_sk = "proactive:bot:chat:dept-d2"
        self._mk_session(group_sk, {"dept_group_id": "d2"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d2",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )

        for _ in range(3):
            mirror_reply_to_dept_group(
                session_key=work_sk, content="重复回复", run_id="r9", turn_key="m9"
            )
        self.assertEqual(
            self._count_group_msgs(group_sk), 1, "同一轮重试 3 次必须只落 1 条"
        )

    def test_no_mirror_without_group_context(self) -> None:
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        work_sk = "proactive:bot:chat:private"
        self._mk_session(work_sk, {"source": "proactive"})
        ok = mirror_reply_to_dept_group(session_key=work_sk, content="私聊回复")
        self.assertFalse(ok, "非群会话不得镜像")

    def test_no_mirror_from_group_session_itself(self) -> None:
        """群时间线会话自己不得镜像，否则自循环。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        ok = mirror_reply_to_dept_group(session_key="dept:d3:chat", content="x")
        self.assertFalse(ok)

    def test_mirror_off_does_nothing(self) -> None:
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "0"
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d4:chat"
        work_sk = "proactive:bot:chat:dept-d4"
        self._mk_session(group_sk, {"dept_group_id": "d4"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d4",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
            },
        )
        ok = mirror_reply_to_dept_group(session_key=work_sk, content="不应出现")
        self.assertFalse(ok, "开关关闭时不得写库")
        self.assertEqual(self._count_group_msgs(group_sk), 0)

    # ── 4. 正文归一：AIMessage.content 可能是 list[block] ───────────────
    def test_list_content_is_normalized_to_text(self) -> None:
        """直接把 list 交给 str() 会把列表字面量写进群，必须只取文本块。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.persistence.db import get_db
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d5:chat"
        work_sk = "proactive:bot:chat:dept-d5"
        self._mk_session(group_sk, {"dept_group_id": "d5"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d5",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )
        ok = mirror_reply_to_dept_group(
            session_key=work_sk,
            content=[{"type": "text", "text": "第一段"}, {"type": "text", "text": "第二段"}],
            run_id="r1",
            turn_key="m1",
        )
        self.assertTrue(ok)
        row = get_db().execute(
            "SELECT content_json FROM evoflow_chat_messages WHERE session_key = ?",
            (group_sk,),
        ).fetchone()
        import json

        payload = json.loads(str(row[0]))
        self.assertEqual(payload.get("content"), "第一段第二段", "列表块必须拼成纯文本")
        self.assertNotIn("{'type'", payload.get("content"), "不得把列表字面量写进群")

    # ── 5. 前端在场：接管占位行，不产生第二条气泡 ──────────────────────
    def test_adopts_frontend_placeholder_message_id(self) -> None:
        """前端已写 streaming 占位行时，镜像必须写同一个 id（覆盖），
        否则同一句回复在群里会变成两条气泡。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        import json

        from evoflow.persistence.db import get_db
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d6:chat"
        work_sk = "proactive:bot:chat:dept-d6"
        self._mk_session(group_sk, {"dept_group_id": "d6"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d6",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )
        # 模拟前端流式占位行（不带正文、turn_state=streaming）
        conn = get_db()
        conn.execute(
            """
            INSERT INTO evoflow_chat_messages
                (session_key, seq, role, message_id, content_json, created_at, updated_at, turn_state)
            VALUES (?, 1, 'assistant', 'agent-bot-1710000000000', ?, datetime('now'), datetime('now'), 'streaming')
            """,
            (
                group_sk,
                json.dumps(
                    {
                        "content": "",
                        "dept_group": {
                            "dept_id": "d6",
                            "msg_kind": "agent",
                            "speaker_code": "bot",
                            "speaker_name": "测试岗",
                            "work_session_key": work_sk,
                            "stream_state": "streaming",
                        },
                    },
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()

        ok = mirror_reply_to_dept_group(
            session_key=work_sk, content="定稿正文", run_id="r1", turn_key="m1"
        )
        self.assertTrue(ok)
        rows = get_db().execute(
            "SELECT message_id, turn_state FROM evoflow_chat_messages WHERE session_key = ?",
            (group_sk,),
        ).fetchall()
        self.assertEqual(len(rows), 1, f"群里必须只有 1 条气泡，实际 {len(rows)} 条")
        self.assertEqual(
            str(rows[0][0]), "agent-bot-1710000000000", "镜像必须写前端占位行的 id"
        )
        self.assertEqual(str(rows[0][1]), "final", "占位行必须被定稿")

    def test_stale_placeholder_not_adopted(self) -> None:
        """陈旧占位行不接管（现网实测缺陷）。

        前端跑到一半被关掉时，那条 ``agent-*`` streaming 行会永远停在 streaming。
        若镜像不看到达时间就去接管它，新回复会被写进**几天前的旧气泡**——群里既看不到
        新消息，旧消息又被篡改。判据：超过 15 分钟（与前端 STREAMING_STALE_MS 同口径）
        的 streaming 行一律不接管，改用确定性镜像键自己 append。

        【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
        """
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        import json

        from evoflow.persistence.db import get_db
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d8:chat"
        work_sk = "proactive:bot:chat:dept-d8"
        self._mk_session(group_sk, {"dept_group_id": "d8"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d8",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )
        conn = get_db()
        conn.execute(
            """
            INSERT INTO evoflow_chat_messages
                (session_key, seq, role, message_id, content_json, created_at, updated_at, turn_state)
            VALUES (?, 1, 'assistant', 'agent-bot-OLD', ?,
                    '2026-11-14T02:00:00+08:00', '2026-11-14T02:00:00+08:00', 'streaming')
            """,
            (
                group_sk,
                json.dumps(
                    {
                        "content": "",
                        "dept_group": {
                            "dept_id": "d8",
                            "msg_kind": "agent",
                            "speaker_code": "bot",
                            "work_session_key": work_sk,
                            "stream_state": "streaming",
                        },
                    },
                    ensure_ascii=False,
                ),
            ),
        )
        conn.commit()

        ok = mirror_reply_to_dept_group(
            session_key=work_sk, content="这轮的新回复", run_id="r9", turn_key="m9"
        )
        self.assertTrue(ok)
        rows = get_db().execute(
            "SELECT message_id, turn_state FROM evoflow_chat_messages "
            "WHERE session_key = ? ORDER BY seq",
            (group_sk,),
        ).fetchall()
        mids = [str(r[0]) for r in rows]
        self.assertIn("agent-bot-OLD", mids, "陈旧占位行必须原样保留，不能被改写")
        new_rows = [r for r in rows if str(r[0]).startswith("dept-reply-")]
        self.assertEqual(len(new_rows), 1, "新回复必须用镜像键单独成一条")

    def test_fresh_naive_utc_placeholder_adopted(self) -> None:
        """刚写下、但时间串是裸 UTC 的占位行仍要接管（现网实测第二种写法）。

        现网既有 ``...+08:00`` 的 ISO 行，也出现过 ``2026-11-20 00:12:00`` 这种
        裸 UTC 串（实为本地 08:12）。只按本地时区解释会把它当成 8 小时前 → 拒绝接管
        → 群里多一条空壳。判据取两种解释中较年轻者。

        【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
        """
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        import datetime as dt
        import json

        from evoflow.persistence.db import get_db
        from evoflow.proactive.dept_group_reply_mirror import mirror_reply_to_dept_group

        group_sk = "dept:d9:chat"
        work_sk = "proactive:bot:chat:dept-d9"
        self._mk_session(group_sk, {"dept_group_id": "d9"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d9",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )
        utc_naive = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M:%S")
        conn = get_db()
        conn.execute(
            """
            INSERT INTO evoflow_chat_messages
                (session_key, seq, role, message_id, content_json, created_at, updated_at, turn_state)
            VALUES (?, 1, 'assistant', 'agent-bot-UTCNOW', ?, ?, ?, 'streaming')
            """,
            (
                group_sk,
                json.dumps(
                    {
                        "content": "",
                        "dept_group": {
                            "dept_id": "d9",
                            "msg_kind": "agent",
                            "speaker_code": "bot",
                            "work_session_key": work_sk,
                            "stream_state": "streaming",
                        },
                    },
                    ensure_ascii=False,
                ),
                utc_naive,
                utc_naive,
            ),
        )
        conn.commit()

        ok = mirror_reply_to_dept_group(
            session_key=work_sk, content="定稿正文", run_id="r10", turn_key="m10"
        )
        self.assertTrue(ok)
        rows = get_db().execute(
            "SELECT message_id, turn_state FROM evoflow_chat_messages WHERE session_key = ?",
            (group_sk,),
        ).fetchall()
        self.assertEqual(len(rows), 1, f"群里必须只有 1 条气泡，实际 {len(rows)} 条")
        self.assertEqual(str(rows[0][0]), "agent-bot-UTCNOW", "裸 UTC 时间串不能挡住接管")

    def test_no_placeholder_means_own_id(self) -> None:
        """前端不在场（无占位行）→ 用确定性镜像 id 自己 append，回复照样上墙。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.persistence.db import get_db
        from evoflow.proactive.dept_group_reply_mirror import (
            build_mirror_message_id,
            mirror_reply_to_dept_group,
        )

        group_sk = "dept:d7:chat"
        work_sk = "proactive:bot:chat:dept-d7"
        self._mk_session(group_sk, {"dept_group_id": "d7"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d7",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
            },
        )
        ok = mirror_reply_to_dept_group(
            session_key=work_sk, content="断线时的回复", run_id="r7", turn_key="m7"
        )
        self.assertTrue(ok)
        rows = get_db().execute(
            "SELECT message_id FROM evoflow_chat_messages WHERE session_key = ?",
            (group_sk,),
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            str(rows[0][0]),
            build_mirror_message_id(session_key=work_sk, run_id="r7", turn_key="m7"),
        )

    # ── 6. 接线：走中间件真实收口函数（不是只测函数本身）──────────────
    def test_middleware_hook_writes_group(self) -> None:
        """直接调 TranscriptMiddleware._mirror_to_dept_group —— 线上真正的调用点。
        用 _message_to_dict 的真实形状（content 为 list 块、键名 "id"）。"""
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.agents.middlewares.transcript_middleware import TranscriptMiddleware
        from evoflow.persistence.db import get_db

        group_sk = "dept:d8:chat"
        work_sk = "proactive:bot:chat:dept-d8"
        self._mk_session(group_sk, {"dept_group_id": "d8"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d8",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
                "agent_name": "测试岗",
            },
        )
        new_msgs = [
            {
                "id": "lc-msg-1",
                "role": "assistant",
                "type": "AIMessage",
                "content": [{"type": "text", "text": "接线测试正文"}],
            }
        ]
        TranscriptMiddleware._mirror_to_dept_group(work_sk, new_msgs, thread_id="t-1")

        rows = get_db().execute(
            "SELECT message_id, content_json FROM evoflow_chat_messages WHERE session_key = ?",
            (group_sk,),
        ).fetchall()
        self.assertEqual(len(rows), 1, "中间件收口点必须真的把回复写进群")
        import json

        payload = json.loads(str(rows[0][1]))
        self.assertEqual(payload.get("content"), "接线测试正文")

    def test_middleware_hook_ignores_empty_and_tool(self) -> None:
        os.environ["EVOFLOW_DEPT_GROUP_REPLY_MIRROR"] = "1"
        from evoflow.agents.middlewares.transcript_middleware import TranscriptMiddleware

        group_sk = "dept:d9:chat"
        work_sk = "proactive:bot:chat:dept-d9"
        self._mk_session(group_sk, {"dept_group_id": "d9"})
        self._mk_session(
            work_sk,
            {
                "dept_group_id": "d9",
                "dept_group_timeline_session": group_sk,
                "proactive_agent_code": "bot",
            },
        )
        TranscriptMiddleware._mirror_to_dept_group(
            work_sk,
            [
                {"id": "lc-2", "role": "tool", "type": "ToolMessage", "content": "工具输出"},
                {"id": "lc-3", "role": "assistant", "type": "AIMessage", "content": []},
            ],
            thread_id="t-2",
        )
        self.assertEqual(self._count_group_msgs(group_sk), 0, "工具消息/空正文不得进群")


if __name__ == "__main__":
    unittest.main()
