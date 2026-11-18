"""本地嵌入模型加载：缓存半写要重试一次，真故障要立即上抛。

【self-evolution-bot · 2026-11-18 · 第47轮 · 模型:deepseek-v4.1-flash-1017】

现场：网关 1.3.35 上每次检索都打一行
``code_index: sync query embedding failed: ... Pooling.__init__() missing 1
required positional argument: 'embedding_dimension'``，
而同一条命令单独跑 / 多线程 / 三进程并发跑全部成功。

根因：sentence_transformers 5.6 的 ``Pooling.config_keys`` 已改成
['embedding_dimension','pooling_mode','include_prompt']，而 bge 缓存的
``1_Pooling/config.json`` 还是旧格式；首次加载时新版 ``Pooling.load_config``
会迁移并**回写**该文件。两个进程同时首次加载，一方读到另一方写到一半的 json
→ ``cls(**config)`` 缺字段。实测该文件 mtime 恰好落在两个任务并发首次加载的同一秒。

后果比一次失败严重：``store._start_embed_warmup`` 失败后进 300 秒冷却，
期间每次检索都静默退回纯词法（结果看着仍然对，但语义召回整整 5 分钟不在线）。

这里的断言只锁**判据**，不加载真模型（CI 上无权重）：
半写类错误重试一次、真故障不重试、重试次数上限为 2。
"""
from __future__ import annotations

import pytest

from evoflow.knowledge.embedding import local_provider as lp

HALF_WRITTEN = TypeError(
    "Pooling.__init__() missing 1 required positional argument: 'embedding_dimension'"
)


def _fast_retry(monkeypatch):
    """把重试等待压到 0，避免测试真等 0.6s。"""
    monkeypatch.setattr(lp, "_LOAD_RETRY_DELAY_S", 0.0, raising=False)


def test_transient_cache_error_is_retried_once(monkeypatch):
    _fast_retry(monkeypatch)
    calls = {"n": 0}

    def build():
        calls["n"] += 1
        if calls["n"] == 1:
            raise HALF_WRITTEN
        return "MODEL"

    assert lp._load_with_retry(build, "m") == "MODEL"
    assert calls["n"] == 2, "半写类错误必须重试一次"


def test_real_failure_is_not_retried(monkeypatch):
    _fast_retry(monkeypatch)
    calls = {"n": 0}

    def build():
        calls["n"] += 1
        raise OSError("No space left on device")

    with pytest.raises(OSError):
        lp._load_with_retry(build, "m")
    assert calls["n"] == 1, "真故障必须立即上抛，不能被重试掩盖"


def test_retry_is_bounded(monkeypatch):
    _fast_retry(monkeypatch)
    calls = {"n": 0}

    def build():
        calls["n"] += 1
        raise HALF_WRITTEN

    with pytest.raises(TypeError):
        lp._load_with_retry(build, "m")
    assert calls["n"] == lp._LOAD_RETRY_ATTEMPTS == 2, "重试次数必须封顶，不能无限重试"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Pooling.__init__() missing 1 required positional argument: 'x'", True),
        ("Pooling.__init__() got an unexpected keyword argument 'y'", True),
        ("Expecting value: line 1 column 1 (char 0)", True),
        ("No space left on device", False),
        ("CUDA out of memory", False),
        ("Connection refused", False),
    ],
)
def test_transient_judgement(text, expected):
    assert lp._is_transient_load_error(Exception(text)) is expected
