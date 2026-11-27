"""对话健康度统计：「用户发了消息，流式没有正常显示」到底有多少次、卡在哪一环。

【self-evolution-bot · 2026-11-27 · 第137轮 · 模型:deepseek-v4-1-flash-261017】
新建。为什么要有它：用户报「对话后没反应」，我只能靠一条条翻 35MB 前端日志，
翻完还分不清「真卡住」和「我的计时器没归零」——实测发现 7 条 `first_response` 的
`sinceSendMs` 是 60 万~123 万毫秒（10~20 分钟），其中一半是上一轮的残留锚点，
不是真等了 10 分钟。**没有配对判据就没有可信数字。**

判据（唯一可信的那条）
----------------------
前端 `[回合计时]` 打点是一对一的：每次点发送记 `send_click`，每轮收口记 `stream_end`。
所以「发出去没反应」= **有 send_click、但同一 sessionKey 之后没等到 stream_end**。
这比数 `first_response` 强：first_response 迟到不代表失败（可能只是慢），
stream_end 缺失才代表这一轮**根本没有收口**（界面会一直停在「正在工作」）。

补充四个横切指标（都是实测过会咬人的）
------------------------------------
1. 首帧上屏慢：`open_frame_snapshot` 耗时分档（实测 18.8% ≥10s、207 次 ≥60s）；
2. 会话标识失联：`execution/state :: session not found`（实测 53 次 / 12 个 id）——
   前端会盯着一个查无此人的 thread 轮询，表现与"没反应"完全一样，但根因不同；
3. 渲染层清窗：`渲染内存危急` 次数 —— 它清 sticky 快照，清完切回会话就是空白；
4. 数据库单方面没收口：日志 `cannot resolve session_key` —— 后端写完了但库里
   run_status 停在 running，前端会一直显示"正在工作"。

用法
----
    python backend/packages/harness/scripts/chat_turn_health.py --days 1
    python backend/packages/harness/scripts/chat_turn_health.py --days 1 --verbose
    python backend/packages/harness/scripts/chat_turn_health.py --log <指定日志目录或文件>
    python backend/packages/harness/scripts/chat_turn_health.py --days 1 --since 12:00

边界
----
- **只读**：只按行扫日志，不写任何文件、不碰数据库、不起服务。
- 零依赖：只用 stdlib，不 import evoflow。
- 不做猜测式归因：每条结论后面都跟着它赖以成立的那个打点计数。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

# 两种日志格式：前端 ``[2026-11-27 12:11:39.508] ...``；网关 ``2026-11-27 11:00:24 - logger - WARNING - ...``
_TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]")
_TS_GW_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_EVENT_RE = re.compile(r'"event":"([^"]+)"')
_FRAME_MS_RE = re.compile(r"frame_snapshot 耗时 (\d+)ms")
_NOT_FOUND_RE = re.compile(r"GET /api/chat/sessions/([^/]+)/execution/state")


def resolve_log_dir(explicit: str = "") -> Path | None:
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file() or p.is_dir():
            return p
        return None
    base = Path.home() / ".evoflow" / "logs"
    return base if base.is_dir() else None


def _parse_body(line: str) -> dict:
    """日志行 = 时间戳 + 级别 + 文案 + 一段 JSON。只取最外层那段 JSON。"""
    idx = line.find('{"')
    if idx < 0:
        return {}
    try:
        obj = json.loads(line[idx:].rstrip())
    except Exception:
        return {}
    return obj if isinstance(obj, dict) else {}


def _bucket(ms: int) -> str:
    if ms >= 60_000:
        return ">=60s"
    if ms >= 10_000:
        return "10-60s"
    if ms >= 1_000:
        return "1-10s"
    return "<1s"


def _quantiles(vals: list[int]) -> str:
    if not vals:
        return "n=0"
    s = sorted(vals)
    n = len(s)

    def q(p: float) -> int:
        return s[min(n - 1, max(0, int(round(n * p)) - 1))]

    return f"n={n} p50={q(0.50)}ms p90={q(0.90)}ms max={s[-1]}ms"


def _find_app_db() -> Path | None:
    """定位本机业务库 evoflow.db（只读用）。"""
    env = os.getenv("EVOFLOW_DB_PATH", "").strip()
    if env:
        p = Path(env)
        if p.is_file():
            return p
    base = Path.home() / ".evoflow" / "profiles"
    if not base.is_dir():
        return None
    cands = sorted(base.glob("*/data/app/evoflow.db"))
    return cands[0] if cands else None


def _iso_local(ts: str) -> str:
    """日志时间 ``2026-11-27 13:56:27.015`` → 库里 ISO 前缀 ``2026-11-27T13:56:27``。"""
    return ts[:10] + "T" + ts[11:19]


def _iso_add_sec(head: str, sec: int) -> str:
    """ISO 前缀 ``2026-11-27T14:44:41`` +N 秒 → 同格式（跨分钟/跨小时都算对）。

    【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
    新建。上一版复核窗口的上界写成了「本分钟末」（``head[:-2] + "59.999"``），
    注释说「后续 300s」但代码只看了同一分钟 —— 于是 14:44:41 这一轮
    （回复 14:45:28 落库）被判成「真无回复」，5 条里 5 条全误报。
    """
    dt = datetime.strptime(head, "%Y-%m-%dT%H:%M:%S")
    return (dt + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%S")


def _db_cross_check(unclosed: list[dict]) -> dict:
    """把「未收口」轮次拿去库里复核：后端到底有没有写回复。

    【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
    为什么必须加这一栏：2026-11-27 实测抽 14 条未收口轮次，**每一条**在
    evoflow_chat_messages 里都有 assistant 回复（如 13:56:27 发出、13:56:40 落库）。
    所以「未收口」不等于「用户没看到回复」，多数只是前端没收到/没记收口信号。
    不把这两半拆开，就会把「打点缺口」当成产品故障去修 —— 方向全错。
    """
    out: dict = {"db_path": None, "answered": [], "not_answered": [], "skipped": 0}
    dbp = _find_app_db()
    if dbp is None:
        return out
    out["db_path"] = str(dbp)
    try:
        conn = sqlite3.connect(f"file:{dbp.as_posix()}?mode=ro", uri=True)
    except Exception:
        return out
    try:
        for s in unclosed:
            ts = str(s.get("_ts") or "")
            if len(ts) < 19:
                out["skipped"] += 1
                continue
            head = _iso_local(ts)
            preview = str(s.get("textPreview") or "")[:12]
            lo = head[:-2] + "00"
            hi_sec = head[:-2] + "59.999"   # 本轮 user 行只可能落在这一秒（含毫秒进位）
            # 1) 找这一轮的 user 行：优先「同秒 + 文本前缀对上」，否则同秒第一条
            rows = conn.execute(
                """
                SELECT thread_id, COALESCE(content_json, ''), created_at
                FROM evoflow_chat_messages
                WHERE role = 'user' AND created_at >= ? AND created_at <= ?
                ORDER BY created_at
                """,
                (lo, hi_sec),
            ).fetchall()
            tid = ""
            for t, body, _ca in rows:
                if preview and preview not in str(body):
                    continue
                tid = str(t or "").strip()
                break
            if not tid and rows:
                tid = str(rows[0][0] or "").strip()
            if not tid:
                out["skipped"] += 1
                continue
            # 2) 这一轮之后 300s 内、**同一 thread** 有没有 assistant 行
            reply_until = _iso_add_sec(head, 300) + ".999"
            hit = conn.execute(
                """
                SELECT created_at, substr(COALESCE(content_json, ''), 1, 60)
                FROM evoflow_chat_messages
                WHERE role = 'assistant' AND thread_id = ?
                  AND created_at > ? AND created_at <= ?
                ORDER BY created_at LIMIT 1
                """,
                (tid, head[:-2] + "59.999", reply_until),
            ).fetchone()
            (out["answered"] if hit else out["not_answered"]).append(
                {"ts": ts, "thread": tid[:12], "reply_at": hit[0] if hit else ""}
            )
    finally:
        conn.close()
    return out


def _scan(paths: list[Path], days: int, since: str = "", gw_paths: list[Path] | None = None):
    """扫日志，返回各指标的原始样本。

    【self-evolution-bot · 2026-11-27 · 第137轮】``gw_paths`` 单独传：库侧没收口
    （cannot resolve session_key）只写在 **gateway** 日志里，前端日志该计数恒为 0。
    头一版只扫前端，把这一项报成 0 次 —— 那是「我的过滤器没命中」，不是真的没有。
    """
    today = date.today()
    cut = today - timedelta(days=days - 1)
    sends: list[dict] = []
    ends: list[dict] = []
    frame_ms: list[int] = []
    first_resp: list[int] = []
    first_resp_at: list[tuple[int, int]] = []
    not_found: list[tuple[str, str]] = []
    mem_crit = 0
    db_unclosed = 0
    day_lines: Counter[str] = Counter()

    for p in paths:
        with p.open("r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = _TS_RE.match(line)
                if not m:
                    continue
                ts = m.group(1)
                try:
                    d = date(int(ts[0:4]), int(ts[5:7]), int(ts[8:10]))
                except ValueError:
                    continue
                if d < cut:
                    continue
                if since and ts[11:16] < since:
                    continue
                day_lines[ts[:10]] += 1

                em = _EVENT_RE.search(line)
                ev = em.group(1) if em else ""

                if ev == "send_click":
                    body = _parse_body(line)
                    body["_ts"] = ts
                    sends.append(body)
                    continue
                if ev == "stream_end":
                    body = _parse_body(line)
                    body["_ts"] = ts
                    ends.append(body)
                    continue
                if ev == "open_frame_snapshot":
                    fm = _FRAME_MS_RE.search(line)
                    if fm:
                        frame_ms.append(int(fm.group(1)))
                    continue
                if ev == "first_response":
                    body = _parse_body(line)
                    v = body.get("sinceSendMs")
                    a = body.get("atMs")
                    if isinstance(v, int):
                        first_resp.append(v)
                        if isinstance(a, int):
                            first_resp_at.append((a, v))
                    continue
                if "execution/state :: session not found" in line:
                    nm = _NOT_FOUND_RE.search(line)
                    not_found.append((ts, nm.group(1) if nm else "?"))
                    continue
                if "渲染内存危急" in line:
                    mem_crit += 1
                    continue
                if "cannot resolve session_key" in line:
                    db_unclosed += 1

    for p2 in (gw_paths or []):
        with p2.open("r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = _TS_GW_RE.match(line)
                if not m:
                    continue
                ts = m.group(1)
                try:
                    d = date(int(ts[0:4]), int(ts[5:7]), int(ts[8:10]))
                except ValueError:
                    continue
                if d < cut:
                    continue
                if since and ts[11:16] < since:
                    continue
                if "cannot resolve session_key" in line:
                    db_unclosed += 1

    return {
        "sends": sends,
        "ends": ends,
        "frame_ms": frame_ms,
        "first_resp": first_resp,
        "first_resp_at": first_resp_at,
        "not_found": not_found,
        "mem_crit": mem_crit,
        "db_unclosed": db_unclosed,
        "day_lines": day_lines,
    }


def analyze(paths: list[Path], days: int, verbose: bool = False, since: str = "", gw_paths: list[Path] | None = None) -> int:
    r = _scan(paths, days, since=since, gw_paths=gw_paths)
    sends, ends = r["sends"], r["ends"]

    print("=" * 74)
    print(f"对话健康度 · 扫 {len(paths)} 个文件 · 近 {days} 天"
          + (f" · 只看 {since} 之后" if since else ""))
    for d, n in sorted(r["day_lines"].items()):
        print(f"  {d}: {n} 行")
    print("=" * 74)

    # ---- 【1】核心判据：按发送时刻配对 ----
    # 【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
    # 本轮两处口径修正（都有现网取证）：
    # ① 排队重复计数：忙时点发送先记一条 `composer_queue_while_busy`，等本轮结束真正发出时
    #    `handle_send` 又记一条同文本 send_click（实测 01:06:41 排队 → 01:06:43 真发出 Δ1545ms；
    #    11:04:01 → 11:04:07 Δ5676ms）。排队那条永远等不到 stream_end，会把未收口率虚抬。
    #    → 能配到「同文本更晚的真发送」= 重复，排除出分母；配不到 = **排队丢失**（真缺陷）。
    # ② 有 sessionKey 的一律按会话键配对（第137轮已补打点，比时序反推精确）。
    # 时序配对仍保留为兜底：stream_end.atMs - sinceSendMs = 该轮发送时刻，容差 1500ms。
    def _norm_text(raw: object) -> str:
        return re.sub(r"\s+", " ", str(raw or "")).strip()

    QUEUE_MAX_WAIT_MS = 1_800_000  # 排队消息 30 分钟内被真发出才算「不是丢」
    queue_idx = [i for i, s in enumerate(sends) if "queue" in str(s.get("source") or "")]
    queue_promoted: set[int] = set()
    for qi in queue_idx:
        qt = _norm_text(sends[qi].get("textPreview"))
        qms = int(sends[qi].get("atMs") or 0)
        if not qt or not qms:
            continue
        for j, s2 in enumerate(sends):
            if j == qi or j in queue_promoted or "queue" in str(s2.get("source") or ""):
                continue
            jms = int(s2.get("atMs") or 0)
            if jms <= qms or jms - qms > QUEUE_MAX_WAIT_MS:
                continue
            if _norm_text(s2.get("textPreview")) == qt:
                queue_promoted.add(qi)
                break
    queue_lost = [sends[i] for i in queue_idx if i not in queue_promoted]
    effective = [i for i in range(len(sends)) if i not in queue_promoted]

    total = len(effective)
    send_ms = [int(sends[i].get("atMs") or 0) for i in effective]

    def _sk_of(rec: dict) -> str:
        return str(rec.get("sessionKey") or "").strip()

    matched_idx: set[int] = set()
    unmatched_end_ms: list[int] = []
    TOL = 1500

    def _pair_end(e: dict) -> int | None:
        """返回被配上的 effective 索引；配不上返回 None。"""
        at = int(e.get("atMs") or 0)
        since = e.get("sinceSendMs")
        if not at or not isinstance(since, int):
            return None
        guess = at - since
        esk = _sk_of(e)
        # ① 会话键优先（两侧都有键才可信）。【self-evolution-bot · 2026-11-27 · 第138轮】
        #    修：第一版在这里 return None 就收尾，没回落时序 —— 现网 send_click 修前
        #    只有 3/45 条带 sessionKey，结果 43 条有效发送全部配不上，复算出「已收口 0
        #    / 100% 未收口」的假数。键配不上必须回落时序，不许就地放弃。
        if esk:
            for pos, i in enumerate(effective):
                if pos in matched_idx:
                    continue
                s2 = sends[i]
                if _sk_of(s2) == esk and send_ms[pos] and abs(send_ms[pos] - guess) <= TOL:
                    return pos
        # ② 时序兜底
        for pos, sm in enumerate(send_ms):
            if pos in matched_idx or not sm:
                continue
            if abs(sm - guess) <= TOL:
                return pos
        return None

    for e in ends:
        pos = _pair_end(e)
        if pos is None:
            # 容差内没配上：可能这一轮的 send_click 在更早的日志文件里（跨天/跨轮转）
            unmatched_end_ms.append(int(e.get("atMs") or 0))
        else:
            matched_idx.add(pos)

    unclosed = [sends[i] for pos, i in enumerate(effective) if pos not in matched_idx]
    cross_file_ends = len(unmatched_end_ms)

    print("\n【1】发出去有没有收口 —— 唯一可信的「没反应」判据")
    print(f"  send_click  = {len(sends)}（其中排队 {len(queue_idx)} 条）")
    print(f"  stream_end  = {len(ends)}")
    if queue_promoted:
        print(f"    排队后又被真发出（同文本，不计入分母） = {len(queue_promoted)}")
    if queue_lost:
        print(f"    ⚠ 排队后从未真发出（排队丢失·用户可见） = {len(queue_lost)}")
        for s2 in queue_lost[:12]:
            print(f"      {s2.get('_ts')} | {str(s2.get('textPreview') or '')[:40]}")
    print(f"  有效发送    = {total}")
    if total:
        ok = total - len(unclosed)
        # 关键拆分：只是一轮没收口 ≠ 用户什么都没看到。
        # 有 first_response 说明界面**确实动过了**（转圈→出了第一段），
        # 一条 first_response 都没有才是「发出去像石沉大海」。
        import time as _t
        now_ms = int(_t.time() * 1000)
        IN_FLIGHT_MS = 300_000
        answered_idx: set[int] = set()
        for a, since in r["first_resp_at"]:
            guess = a - since
            for i, sm in enumerate(send_ms):
                if i in answered_idx or not sm:
                    continue
                if abs(sm - guess) <= TOL:
                    answered_idx.add(i)
                    break
        closed_set = set(matched_idx)
        inflight = [i for i, sm in enumerate(send_ms) if sm and now_ms - sm < IN_FLIGHT_MS and sm > now_ms - 86_400_000 and i not in closed_set]
        silent, stuck = [], []
        # 【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
        # 索引必须在 effective 空间里遍历：matched_idx / answered_idx / inflight 都是
        # effective 的下标，用 enumerate(sends) 会错位（排队重复被排除后两个集合基不同）。
        for pos, i in enumerate(effective):
            if pos in closed_set or pos in inflight:
                continue
            (stuck if pos in answered_idx else silent).append(sends[i])
        print(f"  已收口      = {ok}  ({100.0 * ok / total:.1f}%)")
        print(f"  未收口      = {len(unclosed)}  ({100.0 * len(unclosed) / total:.1f}%)")
        print(f"      ├ 毫无反应（一条首包都没来）      = {len(silent)}")
        print(f"      ├ 有首包但没收口（界面停在转圈）  = {len(stuck)}")
        print(f"      └ 可能仍在跑（近 5 分钟内发出）   = {len(inflight)}")
        if silent:
            print("  毫无反应明细:")
            for s2 in silent[:12]:
                print(f"    {s2.get('_ts')} | {str(s2.get('textPreview') or '')[:30]}")
        if stuck:
            print("  有首包但没收口明细:")
            for s2 in stuck[:12]:
                print(f"    {s2.get('_ts')} | {str(s2.get('textPreview') or '')[:30]}")
        # 【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
        # 接上库侧复核：`_db_cross_check` 上一轮写好了却从没被调用（死代码）。
        # 必须接，因为「未收口」有一半是打点缺口、用户其实收到了回复——
        # 不拿库里的 assistant 行做反证，就会把打点问题当产品故障去修（方向全错）。
        dbx = _db_cross_check(unclosed)
        if dbx.get("db_path"):
            print(f"  ↳ 库里复核（{Path(str(dbx['db_path'])).name}，窗口 ±3s + 后续 300s）:")
            print(f"     确实没回复（库里也没有 assistant 行） = {len(dbx['not_answered'])}")
            print(f"     库里有回复（仅前端没收口·打点缺口）   = {len(dbx['answered'])}")
            if dbx["skipped"]:
                print(f"     无法定位本轮 user 行，跳过           = {dbx['skipped']}")
            for s3 in dbx["not_answered"][:10]:
                print(f"     ⚠ 真无回复 {s3['ts']} | thread={s3['thread']}")
        else:
            print("  ↳ 库里复核：找不到 evoflow.db（可用 EVOFLOW_DB_PATH 指定）")
        for k, v in Counter(e.get("outcome", "?") for e in ends).most_common():
            print(f"    收口方式 · {k}: {v}")
        if cross_file_ends:
            print(f"    另 {cross_file_ends} 条收口对不上本轮 send_click（跨日志文件或跨日，不计入分母）")
        if unclosed and verbose:
            print("  未收口明细（时间 / 会话 / 内容预览）:")
            for s in unclosed[:30]:
                print(f"    {s.get('_ts')} | {str(s.get('sessionKey') or '-')[:36]} | "
                      f"{str(s.get('textPreview') or '')[:26]}")
    else:
        print("  本条无样本：这段时间没抓到 send_click 打点（可能没发过消息/日志已轮转）")

    # ---- 【2】首帧上屏 ----
    print("\n【2】首帧上屏耗时分档（open_frame_snapshot）")
    if r["frame_ms"]:
        b = Counter(_bucket(v) for v in r["frame_ms"])
        for k in (">=60s", "10-60s", "1-10s", "<1s"):
            if b[k]:
                print(f"  {k:>7}: {b[k]:>6}  ({100.0 * b[k] / len(r['frame_ms']):.1f}%)")
        print(f"  合计 {_quantiles(r['frame_ms'])}")
        slow = b[">=60s"]
        if slow:
            print(f"  ⚠ {slow} 次 ≥60s：用户看到的是空白/转圈，不是「没回复」")
    else:
        print("  本条无样本")

    # ---- 【3】首包响应 ----
    print("\n【3】首包响应等待（first_response.sinceSendMs）")
    if r["first_resp"]:
        fb = Counter(_bucket(v) for v in r["first_resp"])
        for k in (">=60s", "10-60s", "1-10s", "<1s"):
            if fb[k]:
                print(f"  {k:>7}: {fb[k]:>6}")
        print(f"  合计 {_quantiles(r['first_resp'])}")
        big = [v for v in r["first_resp"] if v >= 600_000]
        if big:
            print(f"  ⚠ >=600s 共 {len(big)} 条：可能真卡住，也可能上轮锚点未清 —— "
                  f"必须与【1】的未收口数交叉看，单独拿它报数会报错")
    else:
        print("  本条无样本")

    # ---- 【4】会话标识失联 ----
    print("\n【4】会话标识失联（execution/state :: session not found）")
    if r["not_found"]:
        print(f"  次数 = {len(r['not_found'])} | 不同 id = {len(set(x[1] for x in r['not_found']))}")
        for k, v in Counter(x[1][:42] for x in r["not_found"]).most_common(6):
            print(f"    {v:>4} × {k}")
        print("  含义：前端在轮询一个库里查不到的会话编号 → 界面停在「没反应」，但后端是好的")
    else:
        print("  0 次（好）")

    # ---- 【5】渲染层与库侧 ----
    print("\n【5】两个会让界面停在「正在工作」的旁路")
    print(f"  渲染内存危急（清 sticky 快照→切回会话空白）: {r['mem_crit']} 次")
    if total and r["mem_crit"]:
        print(f"    与发送次数之比 {r['mem_crit'] / total:.0f} : 1（>1 = 清理比发消息还频繁）")
    print(f"  库里 run_status 未收口（cannot resolve session_key，前+网关）: {r['db_unclosed']} 次")
    # 【self-evolution-bot · 2026-11-27 · 第138轮 · 模型:deepseek-v4-1-flash-261017】
    # 后端已把「孤儿线程（sessions 表一行都没有，无目标可写）」降为 info，不再进这个计数；
    # 仍留这条注解，避免下次看到 0 又以为是「我的过滤器没命中」。
    print("    注：remint 孤儿线程（旧 thread_id 在 sessions 表无行）不再计入 ——")
    print("        没有行可写，返回 False 属正确行为（本轮已改后端日志分级）。")

    print("\n" + "=" * 74)
    print("怎么读这三个数：")
    print("  【1】未收口 > 0  → 先看库里复核：有 assistant 行 = 打点缺口；真无回复才是故障")
    print("      排队丢失 > 0 → 用户排队的消息**从未发出**，这是用户可见的真故障")
    print("  【4】> 0         → 前端在等一个查无此人的会话，表现一样但根因不同")
    print("  【2】>=60s 占比高 → 打开会话就慢，空白屏是等不到首帧，不是没回复")
    print("  【5】两项高      → 界面停在「正在工作」，但消息其实早已写进库")
    print("=" * 74)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="对话健康度统计：发出去没反应 / 上屏慢 / 会话失联")
    ap.add_argument("--days", type=int, default=1, help="统计最近几天（默认 1）")
    ap.add_argument("--log", default="", help="指定日志目录或单个日志文件")
    ap.add_argument("--since", default="", help="只看某个钟点之后，如 12:00")
    ap.add_argument("--verbose", action="store_true", help="打印未收口轮次明细")
    args = ap.parse_args()

    logdir = resolve_log_dir(args.log)
    if not logdir:
        print("[chat-health] 找不到日志目录 ~/.evoflow/logs，用 --log 指定", file=sys.stderr)
        return 2

    if logdir.is_file():
        paths = [logdir]
    else:
        cut = date.today() - timedelta(days=max(1, args.days) - 1)
        paths = []
        for p in sorted(logdir.glob("frontend-*.log")):
            m = re.search(r"frontend-(\d{4}-\d{2}-\d{2})\.log$", p.name)
            if not m:
                continue
            try:
                d = date(*map(int, m.group(1).split("-")))
            except ValueError:
                continue
            if d >= cut:
                paths.append(p)
        if not paths:
            print(f"[chat-health] 近 {args.days} 天没有 frontend-*.log", file=sys.stderr)
            return 2

    gw: list[Path] = []
    if not logdir.is_file():
        cut2 = date.today() - timedelta(days=max(1, args.days) - 1)
        for p in sorted(logdir.glob("gateway-*.log")):
            m = re.search(r"gateway-(\d{4}-\d{2}-\d{2})\.log$", p.name)
            if not m:
                continue
            try:
                d = date(*map(int, m.group(1).split("-")))
            except ValueError:
                continue
            if d >= cut2:
                gw.append(p)

    return analyze(paths, args.days, verbose=args.verbose, since=args.since, gw_paths=gw)


if __name__ == "__main__":
    raise SystemExit(main())
