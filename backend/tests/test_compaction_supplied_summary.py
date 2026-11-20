"""调用方自带摘要（agent 自己写 summary）的压缩通路回归。

【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这批用例：手工压缩此前只能走 `_generate_summary()`，即另起一次
`invocation_kind="compress"` 的模型调用、把整段 transcript 序列化后喂给另一个模型
重读一遍。新增的 `sessions.compact(summary=...)` 允许正在跑的 agent 直接写摘要正文，
必须证明两件事：
1. 传了 summary 时**一次压缩模型都不调**（否则省调用的意义没落地）；
2. 摘要真的落盘成 `conversation_summary`，且内存视图被折叠、token 数真的降。
两条都不能只测函数自造样例——第12轮教训。
"""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from evoflow.admin.platform_handlers import sessions_compact
from evoflow.agents.context_compaction_core import (
    MAIN_SUMMARY_PREFIX,
    get_context_compaction_engine,
    is_conversation_summary_human,
)
from evoflow.config.summarization_config import get_compaction_settings


def _long_transcript(turns: int = 24) -> list[HumanMessage | AIMessage]:
    """够长到能折叠：远超 _MIN_MESSAGES_TO_COMPRESS 且中段 token 足够。"""
    msgs: list[HumanMessage | AIMessage] = []
    for i in range(turns):
        msgs.append(HumanMessage(content=f"第{i}轮用户提问：" + "细节描述。" * 60))
        msgs.append(AIMessage(content=f"第{i}轮助手回复：" + "处理结果。" * 60))
    return msgs


def _settings_kw() -> dict[str, Any]:
    s = get_compaction_settings()
    return {
        "threshold_ratio": s.threshold_ratio,
        "aggressive_ratio": s.aggressive_ratio,
        "protect_first_n": s.protect_first_n,
        "protect_tail_messages": s.protect_tail_messages,
        "protect_tail_tool_rounds": s.protect_tail_tool_rounds,
    }


def _realistic_summary(note: str = "") -> str:
    """写一份符合章节模板篇幅的摘要（≥800 tokens）。

    【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
    为什么不再用三五个字当摘要：自带摘要现在有**最小质量闸**（≥800 tokens，
    见 `fold_with_supplied_summary`）。这个闸门本身就是本轮实测出来的缺陷——
    原来传一句 "ok" 也会把 80 条对话折成 4 条、静默丢 76 条且不报错。
    测试必须用真实长度的摘要，否则测的是"闸门拒绝"而不是被测行为。
    """
    from evoflow.agents.context_compaction_core import count_text_tokens

    body = (
        "## 目标\n"
        f"{note or '完成本轮任务并留下可复算的证据。'}\n"
        "## 进展（已完成 / 进行中 / 受阻）\n"
        "- 已完成：实现与接线都已核对到具体行号。\n"
        "- 进行中：按现网数据复算改动前后的桶数与命中率。\n"
        "- 受阻：无。\n"
        "## 关键决策\n- 复用老路径全部后置步骤，不另起一套语义。\n"
    )
    filler = "## 关键上下文\n" + ("实现细节、验证判据与现网数字逐条记录，供下一轮直接沿用。" * 8) + "\n"
    while count_text_tokens(body) < 850:
        body += filler
    return body


@pytest.fixture
def no_compress_model(monkeypatch):
    """任何压缩模型调用都直接炸——用来证明新通路真的没调模型。"""

    def _boom(*args: Any, **kwargs: Any):
        raise AssertionError("compaction must not invoke a compress model when summary is supplied")

    monkeypatch.setattr(
        "evoflow.agents.context_compaction_core.ContextCompactionEngine._generate_summary",
        _boom,
    )
    monkeypatch.setattr(
        "evoflow.agents.context_compaction_core.create_chat_model",
        _boom,
        raising=False,
    )
    return _boom


def test_fold_with_supplied_summary_folds_without_model(monkeypatch, no_compress_model):
    stored: dict[str, Any] = {}

    def _fake_persist(session_key, text, **kwargs):
        stored["session_key"] = session_key
        stored["text"] = text
        return 1

    monkeypatch.setattr(
        "evoflow.persistence.chat_message_repositories.persist_conversation_summary",
        _fake_persist,
    )

    engine = get_context_compaction_engine()
    messages = _long_transcript()
    folded, changed = engine.fold_with_supplied_summary(
        messages,
        summary=_realistic_summary("让压缩不再多雇一个模型。"),
        thread_id="tid-supplied",
        context_length=128_000,
        session_key="agent:main:supplied",
        **_settings_kw(),
    )

    assert changed is True, "折叠必须真的发生"
    assert len(folded) < len(messages), f"消息数应下降，实际 {len(messages)}→{len(folded)}"
    summary_rows = [m for m in folded if is_conversation_summary_human(m)]
    assert len(summary_rows) == 1, "折叠结果里应恰好有一条 conversation_summary"
    assert "让压缩不再多雇一个模型" in str(summary_rows[0].content)
    # 落盘：摘要正文写进 evoflow_chat_messages，下一轮 hydration 才认
    assert stored.get("session_key") == "agent:main:supplied"
    assert "让压缩不再多雇一个模型" in str(stored.get("text") or "")


def test_fold_with_supplied_summary_returns_unchanged_when_no_plan(monkeypatch):
    monkeypatch.setattr(
        "evoflow.persistence.chat_message_repositories.persist_conversation_summary",
        lambda *a, **k: 1,
    )
    engine = get_context_compaction_engine()
    messages = [HumanMessage(content="短"), AIMessage(content="也短")]
    folded, changed = engine.fold_with_supplied_summary(
        messages,
        summary=_realistic_summary("只有两句话。"),
        thread_id="tid-short",
        context_length=128_000,
        session_key="agent:main:short",
        **_settings_kw(),
    )
    assert changed is False
    assert folded is messages


def test_fold_with_supplied_summary_empty_summary_is_noop():
    engine = get_context_compaction_engine()
    messages = _long_transcript(2)
    folded, changed = engine.fold_with_supplied_summary(
        messages,
        summary="   ",
        thread_id="tid-empty",
        context_length=128_000,
        **_settings_kw(),
    )
    assert changed is False
    assert folded is messages


def test_fold_with_supplied_summary_prefixes_marker(monkeypatch):
    captured: dict[str, str] = {}

    def _fake_persist(session_key, text, **kwargs):
        captured["text"] = text
        return 1

    monkeypatch.setattr(
        "evoflow.persistence.chat_message_repositories.persist_conversation_summary",
        _fake_persist,
    )
    engine = get_context_compaction_engine()
    engine.fold_with_supplied_summary(
        _long_transcript(),
        summary=_realistic_summary("裸正文不能直接落盘，必须带 compaction 前缀。"),
        thread_id="tid-prefix",
        context_length=128_000,
        session_key="agent:main:prefix",
        **_settings_kw(),
    )
    assert captured["text"].startswith(MAIN_SUMMARY_PREFIX[:20])


def test_sessions_compact_passes_summary_through(monkeypatch):
    """接线：handler 必须把 args["summary"] 真的传到压缩入口（第12轮：只测函数等于没测）。"""
    seen: dict[str, Any] = {}

    async def _fake_run(session_key, *, session_row=None, supplied_summary=None):
        seen["session_key"] = session_key
        seen["supplied_summary"] = supplied_summary
        from evoflow.agents.manual_context_compaction import ManualCompactionResult

        return ManualCompactionResult(
            ok=True,
            changed=True,
            reason="manual_compact_supplied",
            before_gate_tokens=9000,
            after_gate_tokens=1200,
            before_message_count=48,
            after_message_count=9,
            context_usage={"used_tokens": 1200, "window_tokens": 128000, "pct": 0.9},
            persisted_summary=True,
        )

    monkeypatch.setattr(
        "evoflow.admin.sessions.prepare_session_compact",
        lambda **kwargs: {
            "session_key": "agent:main:handler",
            "session_row": {"sessionKey": "agent:main:handler", "threadId": "tid-h"},
            "running": False,
            "run_status": "idle",
            "title": "t",
            "message_count": 48,
        },
    )
    monkeypatch.setattr(
        "evoflow.agents.manual_context_compaction.run_manual_context_compaction",
        _fake_run,
    )

    out = sessions_compact({"session_key": "agent:main:handler", "summary": "## 目标\n我手写的摘要", "confirm": True})

    assert seen["supplied_summary"] == "## 目标\n我手写的摘要"
    assert seen["session_key"] == "agent:main:handler"
    assert out["ok"] is True
    assert out["changed"] is True
    assert out["reason"] == "manual_compact_supplied"


def test_sessions_compact_without_summary_keeps_legacy_path(monkeypatch):
    seen: dict[str, Any] = {}

    async def _fake_run(session_key, *, session_row=None, supplied_summary=None):
        seen["supplied_summary"] = supplied_summary
        from evoflow.agents.manual_context_compaction import ManualCompactionResult

        return ManualCompactionResult(
            ok=True,
            changed=True,
            reason="manual_compact",
            before_gate_tokens=9000,
            after_gate_tokens=4000,
            before_message_count=48,
            after_message_count=12,
            context_usage={"used_tokens": 4000, "window_tokens": 128000, "pct": 3.1},
            persisted_summary=True,
        )

    monkeypatch.setattr(
        "evoflow.admin.sessions.prepare_session_compact",
        lambda **kwargs: {
            "session_key": "agent:main:legacy",
            "session_row": {"sessionKey": "agent:main:legacy", "threadId": "tid-l"},
            "running": False,
            "run_status": "idle",
            "title": "t",
            "message_count": 48,
        },
    )
    monkeypatch.setattr(
        "evoflow.agents.manual_context_compaction.run_manual_context_compaction",
        _fake_run,
    )

    out = sessions_compact({"session_key": "agent:main:legacy", "confirm": True})
    assert seen["supplied_summary"] is None
    assert out["reason"] == "manual_compact"


def test_run_manual_context_compaction_uses_supplied_summary(monkeypatch):
    """端到端（无压缩模型）：run_manual_context_compaction 走自带摘要分支。"""
    import asyncio

    from evoflow.agents import manual_context_compaction as mcc

    stored: dict[str, Any] = {}
    monkeypatch.setattr(
        "evoflow.persistence.chat_message_repositories.persist_conversation_summary",
        lambda sk, text, **kw: stored.update({"sk": sk, "text": text}) or 1,
    )
    monkeypatch.setattr(
        mcc,
        "list_lead_chat_rows_for_model_hydration",
        lambda sk: [{"role": "u", "content": "x"}],  # 只用于占位，下面直接打桩 hydrate
    )
    monkeypatch.setattr(
        mcc,
        "lead_transcript_rows_to_lc_messages",
        lambda rows: _long_transcript(),
    )
    monkeypatch.setattr(
        mcc,
        "build_ephemeral_model_messages",
        _boom_async,
    )

    def _boom(*a, **k):
        raise AssertionError("must not call compress model path")

    monkeypatch.setattr(
        "evoflow.persistence.session_context_usage.persist_session_context_usage",
        lambda sk, usage: None,
    )

    result = asyncio.run(
        mcc.run_manual_context_compaction(
            "agent:main:e2e",
            session_row={
                "sessionKey": "agent:main:e2e",
                "threadId": "tid-e2e",
                "modelName": "test-model",
            },
            supplied_summary=_realistic_summary("agent 自己总结的上下文检查点。"),
        )
    )

    assert result.ok is True
    assert result.reason == "manual_compact_supplied"
    assert result.changed is True
    assert result.after_gate_tokens < result.before_gate_tokens
    assert result.persisted_summary is True
    assert "agent 自己总结的上下文检查点" in str(stored.get("text") or "")


async def _boom_async(*args: Any, **kwargs: Any):
    raise AssertionError("supplied-summary path must not call build_ephemeral_model_messages / compress LLM")


# ── 闭环：本轮 fold 必须与下一轮 hydration 同形 ───────────────────────────────
# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 用户点破的缺陷：只写摘要行 + 内存 fold，不 rehydrate，本轮返回 55 条 / 30654 tokens，
# 下一轮从库重拼却只有 4 条 / 5817 tokens —— 本轮"以为保留了尾部"，下一轮全被砍掉。
# 这几条用例把它钉死：fold_with_supplied_summary 返回的列表，必须与
# list_lead_chat_rows_for_model_hydration 拼出来的一致。


@pytest.fixture()
def probe_db(tmp_path, monkeypatch):
    """隔离 sqlite，供压缩→hydration 闭环验证。"""
    db_path = tmp_path / "r94_probe.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    ensure_app_schema(get_db())
    yield
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def _seed_transcript(sk: str, tid: str, rounds: int = 40) -> None:
    from evoflow.persistence.chat_message_repositories import append_message

    for i in range(rounds):
        append_message(sk, role="user", content=f"第{i}轮提问：" + "细节描述。" * 40, thread_id=tid)
        append_message(sk, role="assistant", content=f"第{i}轮回答：" + "处理结果。" * 40, thread_id=tid)


def _summary_rows(sk: str) -> list:
    """磁盘上（不过 hydration 过滤）的 conversation_summary 行。"""
    from evoflow.persistence.db import get_db

    return get_db().execute(
        "SELECT seq FROM evoflow_chat_messages WHERE session_key=? AND tool_name='conversation_summary'",
        (sk,),
    ).fetchall()


def _hydrate(sk: str):
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        lead_transcript_rows_to_lc_messages,
    )
    from evoflow.persistence.chat_message_repositories import list_lead_chat_rows_for_model_hydration

    return lead_transcript_rows_to_lc_messages(list_lead_chat_rows_for_model_hydration(sk))


def test_fold_result_matches_next_round_hydration(probe_db):
    """本轮 fold 的返回，必须等于下一轮从库重新拼出来的东西。"""
    from evoflow.agents.context_compaction_core import compaction_token_snapshot

    sk, tid = "agent:main:loop", "tid-loop"
    _seed_transcript(sk, tid)
    before = _hydrate(sk)
    assert len(before) == 80

    folded, changed = get_context_compaction_engine().fold_with_supplied_summary(
        before,
        summary=_realistic_summary("闭环验证，历史已折叠。"),
        thread_id=tid,
        context_length=128_000,
        session_key=sk,
        **_settings_kw(),
    )
    assert changed is True

    after = _hydrate(sk)
    assert len(folded) == len(after), (
        f"本轮 fold {len(folded)} 条 vs 下一轮 hydration {len(after)} 条 —— 不一致就是隐性丢上下文"
    )
    assert [type(m).__name__ for m in folded] == [type(m).__name__ for m in after]
    assert (
        compaction_token_snapshot(folded, context_length=128_000)["gate_tokens"]
        == compaction_token_snapshot(after, context_length=128_000)["gate_tokens"]
    )


def test_fold_actually_shrinks_next_round_context(probe_db):
    """压缩必须让**下一轮**真的变短，而不是只让本轮内存视图变短。"""
    from evoflow.agents.context_compaction_core import compaction_token_snapshot

    sk, tid = "agent:main:shrink", "tid-shrink"
    _seed_transcript(sk, tid)
    before = _hydrate(sk)
    snap_before = compaction_token_snapshot(before, context_length=128_000)["gate_tokens"]

    get_context_compaction_engine().fold_with_supplied_summary(
        before,
        summary=_realistic_summary("压完要真变短。"),
        thread_id=tid,
        context_length=128_000,
        session_key=sk,
        **_settings_kw(),
    )

    after = _hydrate(sk)
    snap_after = compaction_token_snapshot(after, context_length=128_000)["gate_tokens"]
    assert snap_after < snap_before, f"下一轮没变短：{snap_before} → {snap_after}"
    names = [str(getattr(m, "name", "") or "") for m in after]
    assert "conversation_summary" in names, "下一轮 hydration 必须拼进摘要行"


def test_supplied_summary_shape_matches_compress_model_path(probe_db, monkeypatch):
    """对照老路径：同一份摘要，两条路径下一轮 hydration 必须同形同 token。

    防的是「新通路自己发明一套 hydration 语义」——第 68 轮「接线对了但语义错了」。
    """
    import asyncio

    from evoflow.agents.context_compaction_core import compaction_token_snapshot

    engine = get_context_compaction_engine()
    shared = _realistic_summary("对照实验固定摘要，两边必须拿到同一份。")

    sk_old, tid_old = "agent:main:shape-old", "tid-shape-old"
    _seed_transcript(sk_old, tid_old)
    msgs_old = _hydrate(sk_old)

    async def _fake_summary(turns, **kwargs):
        return shared

    original = engine._generate_summary
    engine._generate_summary = _fake_summary  # type: ignore[method-assign]
    try:
        asyncio.run(
            engine.compress_messages(
                msgs_old,
                thread_id=tid_old,
                session_key=sk_old,
                context_length=128_000,
                force=True,
                skip_trigger_check=True,
                aggressive=False,
                model_name=None,
                **_settings_kw(),
            )
        )
    finally:
        engine._generate_summary = original  # type: ignore[method-assign]
    after_old = _hydrate(sk_old)

    sk_new, tid_new = "agent:main:shape-new", "tid-shape-new"
    _seed_transcript(sk_new, tid_new)
    msgs_new = _hydrate(sk_new)
    engine.fold_with_supplied_summary(
        msgs_new,
        summary=shared,
        thread_id=tid_new,
        context_length=128_000,
        session_key=sk_new,
        **_settings_kw(),
    )
    after_new = _hydrate(sk_new)

    assert len(after_old) == len(after_new)
    assert [type(m).__name__ for m in after_old] == [type(m).__name__ for m in after_new]
    assert (
        compaction_token_snapshot(after_old, context_length=128_000)["gate_tokens"]
        == compaction_token_snapshot(after_new, context_length=128_000)["gate_tokens"]
    )


# ── 工具出口：platform_tool 必须把 summary 送到 handler ───────────────────────
# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增一条从 **工具出口**（`platform_tool.invoke`）走的用例。
# 为什么：上面所有用例都打在 handler / engine 层。第89轮实证——函数层全绿而
#   工具出口错是最常见的「最后一米」：工具层还有参数归一化（`_coerce_args_json`
#   会把 dict 转成 JSON 串）、`_TOOL_OWN_KEYS` 排除、ToolRuntime 注入等环节。
#   模型实际最容易把 args_json 传成 **dict 而非字符串**，这条用例钉死该形态。
# 反向验证：把 `_coerce_args_json` 改成直接 `return str(args_json)`（dict 变
#   `"{'summary': ...}"` 单引号伪 JSON），本用例即红 —— 证明它测的是归一化本身。
async def test_platform_tool_outlet_delivers_summary_as_dict(probe_db, no_compress_model):
    """模型把 args_json 传成 dict 时，summary 仍必须完整到达 handler。"""
    from evoflow.tools.builtins.platform_tool import platform_tool

    sk, tid = "agent:main:tool-outlet", "tid-tool-outlet"
    _seed_transcript(sk, tid)
    from evoflow.persistence.session_repositories import upsert_session_row

    upsert_session_row(sk, thread_id=tid, title="tool outlet")

    summary = _realistic_summary("工具出口探针：dict 形态也必须送达。")
    msg = await platform_tool.ainvoke(
        {
            "name": "platform",
            "type": "tool_call",
            "id": "probe-tool-outlet",
            "args": {
                "action": "sessions.compact",
                "args_json": {"summary": summary, "session_key": sk},  # ← dict
                "confirm": True,
            },
        }
    )
    import json as _json

    body = getattr(msg, "content", msg)
    data = _json.loads(body) if isinstance(body, str) else body
    assert data.get("ok") is True, f"工具出口失败：{data.get('error')} | {data.get('hint')}"
    assert data.get("reason") == "manual_compact_supplied", "必须走自写摘要通路，不是老路"
    assert data.get("persisted_summary") is True

    rows = _hydrate(sk)
    blob = _json.dumps([str(getattr(r, "content", r)) for r in rows], ensure_ascii=False)
    assert "工具出口探针" in blob, "摘要正文没进下一轮 hydration"


# ── CLI 入口：人最常用的入口也必须能传摘要 ───────────────────────────────────
# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增两条 CLI 用例。
# 为什么：后端 `sessions.compact` 支持自带摘要后，CLI `_compact()` 仍只透传
#   session_key/thread_id —— 带 `--summary` 会被 argparse 直接拒（"unrecognized
#   arguments"），等于能力做了但命令行入口没接。这是第 94 轮用户重启前点出的缺口。
def test_cli_compact_accepts_summary_flag():
    """`evoflow sessions compact --summary` 必须被 argparse 接受。"""
    import argparse

    from evoflow.cli.commands import sessions as cli_mod

    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest="cmd", required=True)
    cli_mod.register(subs)
    ns = parser.parse_args(
        ["sessions", "compact", "--session-key", "agent:main:x", "--summary", "## 目标\ncli 摘要"]
    )
    assert ns.summary == "## 目标\ncli 摘要"
    assert ns.summary_file == ""


def test_cli_compact_passes_summary_to_handler(monkeypatch, tmp_path):
    """`--summary` / `--summary-file` 都必须落到 handler 的 `summary` 键。"""
    import argparse

    from evoflow.admin import platform_handlers as ph
    from evoflow.cli.commands import sessions as cli_mod

    seen: dict = {}

    def _fake_sessions_compact(args):
        seen.update(args)
        return {"ok": True}

    monkeypatch.setattr(ph, "sessions_compact", _fake_sessions_compact)

    parser = argparse.ArgumentParser()
    subs = parser.add_subparsers(dest="cmd", required=True)
    cli_mod.register(subs)

    # ① 直接传正文
    ns = parser.parse_args(["sessions", "compact", "--session-key", "sk1", "--summary", "正文A"])
    cli_mod._compact(ns)
    assert seen["summary"] == "正文A"

    # ② 从文件读（长摘要更实用）
    f = tmp_path / "s.md"
    f.write_text("## 目标\n文件里的摘要", encoding="utf-8")
    seen.clear()
    ns2 = parser.parse_args(
        ["sessions", "compact", "--session-key", "sk2", "--summary-file", str(f)]
    )
    cli_mod._compact(ns2)
    assert "文件里的摘要" in (seen.get("summary") or "")

    # ③ 都不给 → None，走老路
    seen.clear()
    ns3 = parser.parse_args(["sessions", "compact", "--session-key", "sk3"])
    cli_mod._compact(ns3)
    assert seen.get("summary") is None


# ── 本轮（第94轮收尾）新挖出的三处缺陷，逐条锁死 ─────────────────────────────
# 【self-evolution-bot · 2026-11-20 · 第94轮 · 模型:deepseek-v4.1-flash-1017】
# 这三条都不是设计问题，是探针一跑就露的实现缺陷：
#   ① 无条件先落盘 → 每次调用都往 transcript 尾部插一条 conversation_summary，
#      hydration 只认最新一条，其余是纯垃圾（实测连续两次调用后磁盘 3 行）；
#   ② 摘要没有质量闸 → 传 "ok" 也把 80 条折成 4 条，静默丢 76 条；
#   ③ `_cap_summary_text` 用英文 4 chars/token 换算，中文实测 0.87 字/token，
#      于是"上限 5%×context_length"的闸门被放大 4.6 倍、一个都没截住
#      （实测输入 24153 tokens，落盘 24164，只多了截断标记）。


def test_short_summary_is_rejected_loudly(probe_db):
    """摘要太短必须**报错**，不许静默把历史折成一句话。"""
    sk, tid = "agent:main:junk", "tid-junk"
    _seed_transcript(sk, tid)
    before = _hydrate(sk)

    with pytest.raises(ValueError) as exc:
        get_context_compaction_engine().fold_with_supplied_summary(
            before,
            summary="ok",
            thread_id=tid,
            context_length=128_000,
            session_key=sk,
            **_settings_kw(),
        )
    assert "摘要太短" in str(exc.value)
    # 且不许留下任何痕迹：既不折内存视图，也不往库里插行
    assert len(_hydrate(sk)) == len(before)
    assert not _summary_rows(sk), "被拒绝的调用不许写 conversation_summary"


def test_short_conversation_does_not_persist_summary(probe_db):
    """对话太短没有可折叠中间段时，不许落盘摘要（否则"压缩"反而给上下文加一段）。"""
    sk, tid = "agent:main:tiny", "tid-tiny"
    _seed_transcript(sk, tid, rounds=2)
    before = _hydrate(sk)
    assert len(before) == 4

    _folded, changed = get_context_compaction_engine().fold_with_supplied_summary(
        before,
        summary=_realistic_summary(),
        thread_id=tid,
        context_length=128_000,
        session_key=sk,
        **_settings_kw(),
    )
    assert changed is False
    assert not _summary_rows(sk), "无 plan 时落盘摘要会让下一轮多出一段摘要行"


def test_repeated_fold_does_not_grow_summary_rows(probe_db):
    """连续两次同摘要压缩，磁盘上只许留 1 条 conversation_summary。"""
    sk, tid = "agent:main:dup", "tid-dup"
    _seed_transcript(sk, tid)
    eng = get_context_compaction_engine()
    kw = dict(context_length=128_000, session_key=sk, **_settings_kw())
    text = _realistic_summary()

    eng.fold_with_supplied_summary(_hydrate(sk), summary=text, thread_id=tid, **kw)
    assert len(_summary_rows(sk)) == 1, "第一次压缩应只落 1 行"
    _folded, changed = eng.fold_with_supplied_summary(_hydrate(sk), summary=text, thread_id=tid, **kw)
    assert len(_summary_rows(sk)) == 1, f"第二次（no-op）不该再插行，实际 {len(_summary_rows(sk))} 行"


def test_cjk_summary_is_actually_capped():
    """中文摘要必须真被 `_cap_summary_text` 压到上限内（4 chars/token 假设对中文失效）。"""
    from evoflow.agents.context_compaction_core import _cap_summary_text, count_text_tokens

    big = "## 进展\n" + ("这是摘要正文。" * 3000)  # ~24150 tokens
    for ctx, ceiling in ((128_000, 6_400), (256_000, 12_800)):
        capped = _cap_summary_text(big, context_length=ctx)
        got = count_text_tokens(capped)
        assert got <= ceiling, f"ctx={ctx} 上限 {ceiling} tokens，实际落盘 {got}"
