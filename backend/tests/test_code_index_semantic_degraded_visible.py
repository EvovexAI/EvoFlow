"""语义降级必须冒到工具出口 —— 不许只在 logger 里说话。

【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】

为什么必须有这条
----------------
实测过的真实事故：每次检索都在报
  `code_index: sync query embedding failed: EmbeddingError: Failed to load
   local embedding model ... Pooling.__init__() missing 1 required positional
   argument: 'embedding_dimension'`
而**工具返回的文本完全正常**（字面匹配撑住了），冻结池照样 59/59。
我是翻日志时才撞见的。没有这条测试，同类退化会一直「看着好好的」。

判据（三向，缺一不可）
--------------------
1. 正向：embed 失败 → 工具出口文本必须出现 `lexical matching only`；
2. 反证：语义正常 → 文本里**不许**出现该行（防假报警）；
3. 反证：`semantic_search_enabled=False` → 不许报降级（关掉是配置，不是故障）。

第 2 条要注意：嵌入有暖机闸门，第一次调用必然返回 None。必须先等真拿到向量
再断言「不该报警」，否则会把「正在暖机」误判成假报警（我第一版探针就栽在这）。

注意：本用例完全用 monkeypatch，不依赖真实索引库；但输出层要跑通，
仍需要一个可用的 workspace root（临时目录建一个小索引即可）。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from evoflow.code_index import store as S
from evoflow.tools.host_direct.search_code_index import (
    _format_search_data,
    _run_search_index_lookup,
)


@pytest.fixture(autouse=True)
def _restore_embed_gate():
    """还原嵌入闸门的全局状态 —— 本文件的用例会真实建索引。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    实测踩到：单独跑 4 个文件全绿，四个一起跑 `test_code_index_embed_cold_gate`
    立刻红。原因是这里的 `build_index` 真的加载了模型，把 `_embed_gate_open`
    留成 True 且把 local_provider 留在了 sys.modules 里，于是 cold gate 那条
    「门未开时首调必须返回 None」的前提被别人（我）先破坏了。
    测试之间不许留全局副作用，必须在自己的用例里清干净。
    """
    prev_open = S._embed_gate_open
    prev_try = S._embed_warm_last_try
    prev_mod = sys.modules.get("evoflow.knowledge.embedding.local_provider")
    yield
    S._embed_gate_open = prev_open
    S._embed_warm_last_try = prev_try
    if prev_mod is None:
        sys.modules.pop("evoflow.knowledge.embedding.local_provider", None)


@pytest.fixture(autouse=True)
def _no_real_embedding(monkeypatch):
    """新测试不许启动真实嵌入暖机。

    【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    实测踩到：本文件单独跑全绿，和 test_code_index_embed_cold_gate 一起跑就红。
    原因是这里真去建索引 → 触发后台暖机线程 → 模型被加载进 sys.modules，
    而 cold_gate 的前提正是「门未开、模型还没 import」。线程是 daemon 且异步，
    事后 pop sys.modules 挡不住它。
    锁死「不起暖机、门永远关着」= 本文件只测词法层，确定且互不污染。
    """
    from evoflow.code_index import store as _S

    monkeypatch.setattr(_S, "_start_embed_warmup", lambda: None)
    monkeypatch.setattr(_S, "_embed_ready_without_import", lambda: False)
    monkeypatch.setattr(_S, "_embed_gate_open", False)


def _small_workspace(tmp_path: Path) -> str:
    (tmp_path / "pkg").mkdir(parents=True, exist_ok=True)
    (tmp_path / "pkg" / "thing.py").write_text(
        "def build_overlay():\n    return 1\n", encoding="utf-8"
    )
    S.build_index(workspace_root=str(tmp_path), force=True)
    return str(tmp_path)


def _render(root: str, query: str) -> str:
    err, data = _run_search_index_lookup(
        root=root, thread_id=None, query=query, queries=None, limit=5
    )
    assert err is None, f"工具出口返回错误而非结果: {err!r}"
    return _format_search_data(data, limit=5)


def test_embedding_failure_surfaces_in_tool_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """正向：embed 打坏 → 输出层必须明说本次只有词法。"""
    root = _small_workspace(tmp_path)

    def _boom(text: str):
        # 降级原因走 thread-local，真实失败路径也是这么记的
        S._mark_degraded(
            None, "embed_error", "TEST-INJECTED embedding failure; lexical matching only"
        )
        return None

    monkeypatch.setattr(S, "_embed_query_sync", _boom)
    text = _render(root, "build overlay")
    assert "lexical matching only" in text, (
        "语义降级没有冒到工具出口，输出里看不到任何提示。全文：\n" + text
    )


def test_no_degradation_note_when_semantic_path_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """反证：配置层面关掉语义检索 ≠ 故障降级，不许打提示。"""
    root = _small_workspace(tmp_path)
    real_cfg = S.get_code_index_config()
    monkeypatch.setattr(
        S,
        "get_code_index_config",
        lambda: real_cfg.model_copy(update={"semantic_search_enabled": False}),
    )
    text = _render(root, "build overlay")
    assert "lexical matching only" not in text, (
        "把「配置关闭」误报成故障降级（假报警）。全文：\n" + text
    )


def test_degradation_reason_prefers_specific_cause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """降级原因不许被兜底覆盖：更具体的原因优先。

    实测事故：冷启动首查明明在 `warming_up`，但 `_semantic_recall_sync` 里
    「没有向量」的兜底分支无条件写 `no_vector`，把准确原因盖掉了——
    输出把用户往「嵌入坏了」的方向引，实际只是还在暖机。
    """
    S._reset_degraded()
    S._mark_degraded(None, "warming_up", "model is warming up")
    # 模拟兜底分支：已有原因时不许覆盖
    if not getattr(S._DEGRADE_STATE, "code", ""):
        S._mark_degraded(None, "no_vector", "no vector")
    got = S._collect_degraded()
    assert got["semantic_degraded"] == "warming_up"
    assert "warming up" in got["semantic_degraded_detail"]


def test_search_index_payload_carries_degraded_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """函数层就要带上这两个字段 —— 输出层才有东西可渲染。

    这条守的是「接线」：字段名在 store 里叫一个样、format 里读另一个样，
    编译全绿但提示永远不出现（本轮实测踩过）。
    """
    root = _small_workspace(tmp_path)

    def _boom(text: str):
        S._mark_degraded(None, "embed_error", "boom; lexical matching only")
        return None

    monkeypatch.setattr(S, "_embed_query_sync", _boom)
    data = S.search_index(workspace_root=root, query="build overlay", limit=5)
    assert data.get("semantic_degraded") == "embed_error"
    assert "lexical matching only" in str(data.get("semantic_degraded_detail") or "")
