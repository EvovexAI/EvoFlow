"""Tests for notify_continuation: durable dedupe, batching, anti-misread prefix."""

import time

from evoflow.tools.zcode_port import notify_continuation as nc


def _reset_module_state():
    with nc._DEDUP_LOCK:
        nc._DEDUP.clear()
    with nc._BATCH_LOCK:
        nc._PENDING.clear()
        for t in nc._COLLECTORS.values():
            t.cancel()
        nc._COLLECTORS.clear()


def _notif(mid, text=None, tid="t1", sk="agent:main:t1", source="task-notification"):
    return dict(
        thread_id=tid,
        session_key=sk,
        notification_text=text
        or (
            "<task-notification>\n"
            f"<task-id>{mid}</task-id>\n"
            "<status>completed</status>\n"
            "</task-notification>"
        ),
        message_id=mid,
        source=source,
    )


class TestDedup:
    def setup_method(self):
        _reset_module_state()
        # 屏蔽真实派发:500 条通知的收集器到期后不允许打到真调度器
        self._orig_dispatch = nc._dispatch_notification_turn
        nc._dispatch_notification_turn = lambda *a, **k: True
        self._orig_window = nc._BATCH_WINDOW_SECONDS
        nc._BATCH_WINDOW_SECONDS = 0.01

    def teardown_method(self):
        nc._dispatch_notification_turn = self._orig_dispatch
        nc._BATCH_WINDOW_SECONDS = self._orig_window
        _reset_module_state()

    def test_same_mid_deduped(self, monkeypatch):
        monkeypatch.setattr(nc, "_ledger_claim", lambda sk, mid: True)
        assert nc.schedule_task_notification_turn(**_notif("m1")) is True
        assert nc.schedule_task_notification_turn(**_notif("m1")) is False

    def test_lru_evicts_oldest_not_wholesale(self, monkeypatch):
        monkeypatch.setattr(nc, "_ledger_claim", lambda sk, mid: True)
        for i in range(nc._DEDUP_MAX + 1):
            assert nc.schedule_task_notification_turn(**_notif(f"m{i}")) is True
        # 超限后:最老的 m0 被淘汰(可重进),最新的仍在(去重)——不再是 clear() 全清
        assert nc.schedule_task_notification_turn(**_notif("m0")) is True
        assert nc.schedule_task_notification_turn(**_notif(f"m{nc._DEDUP_MAX}")) is False

    def test_ledger_duplicate_blocks(self, monkeypatch):
        monkeypatch.setattr(nc, "_ledger_claim", lambda sk, mid: mid != "m-claimed")
        assert nc.schedule_task_notification_turn(**_notif("m-fresh")) is True
        assert nc.schedule_task_notification_turn(**_notif("m-claimed")) is False

    def test_ledger_error_fails_open(self, monkeypatch):
        # 打真实底层原语:DB 故障抛异常 → _ledger_claim 必须 fail-open
        import evoflow.persistence.session_runtime_repository as srr

        def boom(*args, **kwargs):
            raise RuntimeError("db down")

        monkeypatch.setattr(srr, "try_claim_inject", boom)
        assert nc.schedule_task_notification_turn(**_notif("m1")) is True

    def test_invalid_input_returns_false(self, monkeypatch):
        monkeypatch.setattr(nc, "_ledger_claim", lambda sk, mid: True)
        assert nc.schedule_task_notification_turn(**_notif("")) is False


class TestBatching:
    def setup_method(self):
        _reset_module_state()
        self.dispatched: list[tuple[str, str, str]] = []
        self.release_calls: list[str] = []

    def _capture_dispatch(self, monkeypatch, *, fail=False):
        def _dispatch(tid, sk, text, mid, *, source):
            if fail:
                raise RuntimeError("scheduler down")
            self.dispatched.append((tid, text, mid))
            return True

        monkeypatch.setattr(nc, "_dispatch_notification_turn", _dispatch)
        monkeypatch.setattr(
            nc, "_ledger_release", lambda sk, mid: self.release_calls.append(mid)
        )
        monkeypatch.setattr(nc, "_ledger_claim", lambda sk, mid: True)
        monkeypatch.setattr(nc, "_BATCH_WINDOW_SECONDS", 0.05)

    def _wait_flush(self, tid="t1", timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with nc._BATCH_LOCK:
                if tid not in nc._PENDING and tid not in nc._COLLECTORS:
                    return True
            time.sleep(0.02)
        return False

    def test_batch_merges_same_thread(self, monkeypatch):
        self._capture_dispatch(monkeypatch)
        for i in range(3):
            assert nc.schedule_task_notification_turn(**_notif(f"m{i}")) is True
        assert self._wait_flush() is True
        assert len(self.dispatched) == 1  # 3 条通知 → 1 个 turn
        tid, text, mid = self.dispatched[0]
        assert text.count("<task-notification>") == 3
        # 转写必须保持裸块开头(无防误读前缀)——前后端"通知不进用户气泡"
        # 的过滤都按裸前缀判定;防误读前缀由 provider 层中间件注入。
        assert text.lstrip().startswith("<task-notification>")
        assert "SYSTEM NOTIFICATION" not in text
        # 顺序保持到达序
        assert text.index("m0") < text.index("m1") < text.index("m2")

    def test_different_threads_dispatch_separately(self, monkeypatch):
        self._capture_dispatch(monkeypatch)
        nc.schedule_task_notification_turn(**_notif("a", tid="t1"))
        nc.schedule_task_notification_turn(**_notif("b", tid="t2"))
        assert self._wait_flush("t1") and self._wait_flush("t2")
        assert len(self.dispatched) == 2

    def test_dispatch_failure_releases_claims(self, monkeypatch):
        self._capture_dispatch(monkeypatch, fail=True)
        nc.schedule_task_notification_turn(**_notif("m1"))
        nc.schedule_task_notification_turn(**_notif("m2"))
        assert self._wait_flush() is True
        assert self.dispatched == []
        assert sorted(self.release_calls) == ["m1", "m2"]

    def test_forced_flush_at_max_items(self, monkeypatch):
        self._capture_dispatch(monkeypatch)
        monkeypatch.setattr(nc, "_BATCH_MAX_ITEMS", 2)
        nc.schedule_task_notification_turn(**_notif("m1"))
        nc.schedule_task_notification_turn(**_notif("m2"))
        # 达到 _BATCH_MAX_ITEMS 立即 flush,不等窗口
        assert len(self.dispatched) == 1
        assert self.dispatched[0][1].count("<task-notification>") == 2

    def test_late_notification_reopens_window(self, monkeypatch):
        self._capture_dispatch(monkeypatch)
        nc.schedule_task_notification_turn(**_notif("m1"))
        assert self._wait_flush() is True
        nc.schedule_task_notification_turn(**_notif("m2"))
        assert self._wait_flush() is True
        assert len(self.dispatched) == 2  # 两个窗口,两个 turn
