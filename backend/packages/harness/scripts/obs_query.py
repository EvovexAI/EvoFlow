"""观测库 / 任务库的只读即席查询入口 —— 治我每轮重写探针、猜列名、查错库这三件事。

【fullstack-dev · 2026-11-15 · 第13轮】新建（零依赖，纯 stdlib）。

为什么要这个脚本（不是"顺手加个工具"，是实测出来的成本）
--------------------------------------------------------
第13轮我为拿四个数字发了 **8 个 `python -c` 探针**，当场失败 2 次：
- 猜工具表有 `error_detail` 列 → ``OperationalError: no such column``（真名 ``error_detail_json``）；
- 猜任务表有 ``raised_by`` 列 → ``IndexError: No item with that key``（它是计算字段，不在表里）；
- 还先查了 ``evoflow_a2a_tasks``（空表），绕到第二个库才找到 ``evoflow_collab_tasks``。
近 3 天观测里 **bash 一个工具占 2505s 总耗时的 87%、P95 9711ms**，现写探针就是主力。
同类查询**每轮重写一遍** = 每轮重付一次猜列名的风险 + 几秒到十几秒的常驻开销。

它提供三件我一直缺的东西
------------------------
1. ``--list-tables`` / ``--schema``：**先看列名再写 SQL**（本岗硬规矩，别再猜）；
2. ``--db obs|app``：两个库一个入口，不会再把 A2A 空表当成协作任务表；
3. 结果外层强制 ``LIMIT``：一个手滑的 ``SELECT *`` 会把几十万行灌进上下文（观测库 2GB），
   那不是慢，是把我下一轮直接打死。

边界
----
- **只读**：以 ``mode=ro`` 打开，且只接受 ``SELECT`` / ``WITH`` 开头的语句；要写数据请走正经接口，别用这个。
- 不做聚合封装（P50/P95 之类留在 SQL 里写窗口函数）—— 聚合口径会变，
  把它写死进脚本就等于把一次性的结论伪装成通用能力。趋势/环比请用 ``agent_self_metrics.py``。
- DB 路径解析**复用** ``agent_self_metrics.resolve_db_path``（同目录 import），
  避免出现第二份 profiles 猜测逻辑（读写两侧只修一侧 = 没修，本岗栽过两次）。

用法
----
    python backend/packages/harness/scripts/obs_query.py --list-tables
    python backend/packages/harness/scripts/obs_query.py --schema evoflow_obs_tool_invocations
    python backend/packages/harness/scripts/obs_query.py --db app --list-tables
    python backend/packages/harness/scripts/obs_query.py \\
        --sql "SELECT tool_name,status,error_message FROM evoflow_obs_tool_invocations
               WHERE agent_code IN ('self-evolution-bot','fullstack-dev')
                 AND status!='success' ORDER BY started_at DESC"
    # 【self-evolution-bot · 2026-11-15 · 第18轮】本岗 2026-11-15 16:01 起由 fullstack-dev
    # 改名为 self-evolution-bot，观测库历史行仍记旧码 —— 查本岗一律两码并集，漏一条就是半段盲区。
    EVOFLOW_HOME=~/.evoflow/profiles/default python … # 与度量脚本同一套环境口径
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# 【fullstack-dev · 2026-11-15 · 第13轮】改：普通 import 依赖同目录恰好出现在 sys.path 上 ——
# 本脚本从仓库任意 cwd 直接 ``python …/obs_query.py`` 调用（与 agent_self_metrics 同用法），
# 对端模块名不在路径里时会取不到。改为按 __file__ 显式加载，路径不靠运气。
def _load_metrics():
    import importlib.util

    target = Path(__file__).resolve().parent / "agent_self_metrics.py"
    spec = importlib.util.spec_from_file_location("_evoflow_agent_self_metrics", target)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"缺少同目录依赖：{target}")
    mod = importlib.util.module_from_spec(spec)
    mod.__name__ = "_evoflow_agent_self_metrics"
    spec.loader.exec_module(mod)
    return mod


resolve_db_path = _load_metrics().resolve_db_path  # 同目录复用，勿另写一份路径解析

# 观测库走 agent_self_metrics.resolve_db_path；任务库是另一套（data/app/evoflow.db）。
APP_DB_REL = Path("data") / "app" / "evoflow.db"
_WRITE_RE = re.compile(r"^\s*(insert|update|delete|drop|alter|create|attach|pragma|vacuum|reindex)\b", re.I)
_HEAD_RE = re.compile(r"^\s*(select|with|explain)\b", re.I)


def resolve_app_db(explicit: str = "") -> Path | None:
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.exists() else None
    home = (os.environ.get("EVOFLOW_HOME") or "").strip()
    if home:
        p = Path(home).expanduser() / APP_DB_REL
        return p if p.exists() else None
    base = Path.home() / ".evoflow" / "profiles"
    if base.is_dir():
        preferred = base / "default" / APP_DB_REL
        if preferred.exists():
            return preferred
        cands = [q / APP_DB_REL for q in sorted(base.iterdir()) if (q / APP_DB_REL).exists()]
        if cands:
            return max(cands, key=lambda x: x.stat().st_mtime)
    return None


def resolve_db(kind: str, explicit: str = "") -> Path | None:
    return resolve_app_db(explicit) if kind == "app" else resolve_db_path(explicit)


_TIME_COLS = r"(?:started_at|ended_at|requested_at|occurred_at|finished_at|created_at|updated_at)"
# 坑 1：ISO 文本列（实测 100% 形如 2026-11-15T21:49:33.343000+08:00）直接跟
# datetime('now',…) 出的 "2026-11-14 13:49:55"（UTC、空格分隔）做字典序比较。
# 'T'(0x54) > ' '(0x20) ⇒ 边界那一整天全被放进来，且**不报错**。
# 现网实测：错写法 5843 行 / 正确窗口 3943 行（虚高 1.48 倍）。
_STR_VS_UTC_RE = re.compile(rf"{_TIME_COLS}\s*(?:>=|<=|>|<)\s*datetime\(\s*'now'", re.I)
# 坑 2：strftime('%s',…) 返回 **TEXT**，跟裸整数比时 SQLite 恒判「文本 > 整数」
# ⇒ 条件永真，返回全表。现网实测：17963 行 = 全表行数（该 agent 同期窗口只有 3943）。
_TEXT_VS_INT_RE = re.compile(r"strftime\(\s*'%s'\s*,\s*[\w.]+\s*\)\s*(?:>=|<=|>|<)\s*(?!cast)(\d+)", re.I)


def window_lint(sql: str) -> list[str]:
    """检出两种「静默把窗口算错」的 SQL 写法，返回给 stderr 的提示（不改结果、不拦停）。

    【self-evolution-bot · 2026-11-15 · 第18轮】新建。
    为什么要拦在这里：这两种写法**都不报错**，只是数悄悄变多。我本轮先拿
    ``started_at > datetime('now','-1 day')`` 对银泰报了「近 24h」的一整套数
    （5843 行口径），实际窗口约 32 小时；随后想用 ``strftime('%s')`` 做"正确"对照，
    又因为 TEXT vs INTEGER 恒真而得到"真 24h = 17963 行"= 全表。
    两个假数同源、都指向我自己定的唯一观测入口，所以补在入口而不是只写进配方——
    配方要靠人记得查，提示是每次跑都躲不掉。
    """
    warns: list[str] = []
    if _STR_VS_UTC_RE.search(sql):
        warns.append(
            "时间列是带 +08:00 的 ISO 文本（如 2026-11-15T21:49:33.343000+08:00），"
            "而 datetime('now',…) 出的是 UTC 空格格式（2026-11-14 13:49:55）。"
            "字典序里 'T' > ' ' ⇒ 边界那一整天会被全部纳入，窗口悄悄变宽且不报错。\n"
            "  ↳ 改用：replace(substr(<col>,1,19),'T',' ') >= datetime('now','-1 day','+8 hours')"
            "  （现网对照：错写法 5843 行 / 该写法 3943 行）"
        )
    if _TEXT_VS_INT_RE.search(sql):
        warns.append(
            "strftime('%s',…) 返回 TEXT，跟裸整数比较时 SQLite 判「文本 > 整数」⇒ 条件恒真、返回全表。\n"
            "  ↳ 改用：CAST(strftime('%s',<col>) AS INTEGER) >= CAST(strftime('%s','now') AS INTEGER) - 86400"
            "  （现网对照：漏 CAST 17963 行=全表 / 补 CAST 3943 行，与上一种正确写法同值）"
        )
    return warns


def _connect(db: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def list_tables(db: Path) -> int:
    con = _connect(db)
    try:
        rows = list(
            con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        )
        print(f"# {db}\n# 共 {len(rows)} 张表（表名可直接喂 --schema 看列）")
        for r in rows:
            n = str(r["name"])
            try:
                cnt = con.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0]  # noqa: S608  只读、名来自 sqlite_master
            except sqlite3.Error:
                cnt = -1
            print(f"  {n}  rows={cnt}")
        return 0
    finally:
        con.close()


def show_schema(db: Path, table: str) -> int:
    con = _connect(db)
    try:
        cols = list(con.execute(f'PRAGMA table_info("{table}")'))  # noqa: S608  只读；列名是本工具要产出的东西
        if not cols:
            print(f"[obs_query] 表 {table} 不存在。先跑 --list-tables 看真名（别再猜）", file=sys.stderr)
            return 2
        print(f"# {table} 的列（写 SQL 前照这份取名）")
        for c in cols:
            print(f"  {c['name']:28} {c['type']}")
        return 0
    finally:
        con.close()


def run_sql(db: Path, sql: str, limit: int, as_json: bool) -> int:
    stmt = sql.strip().rstrip(";")
    if _WRITE_RE.match(stmt) or not _HEAD_RE.match(stmt):
        # 只读工具就只管只读：报错文案给替代路径，别让人以为"再加个开关就能写"。
        print("[obs_query] 只接受 SELECT / WITH / EXPLAIN 开头的语句（本工具以 mode=ro 打开，写数据请走正经接口）", file=sys.stderr)
        return 2
    for _w in window_lint(stmt):
        print(f"[obs_query] ⚠ 窗口可能算错（结果照出，不拦停）：{_w}", file=sys.stderr)
    # 外层套 LIMIT：防止一次 SELECT * 把几十万行灌进上下文（观测库实测 2GB）。
    wrapped = f"SELECT * FROM ({stmt}) LIMIT {int(limit)}" if _HEAD_RE.match(stmt) and not stmt.lower().startswith("explain") else stmt
    con = _connect(db)
    try:
        cur = con.execute(wrapped)
        names = [d[0] for d in (cur.description or [])]
        rows = [dict(zip(names, r, strict=True)) for r in cur.fetchall()]
    except sqlite3.Error as e:
        # 列名/表名猜错是最常见错法：直接把可用列名吐回去，省掉"再发一发探针"。
        print(f"[obs_query] SQL 出错：{type(e).__name__}: {e}", file=sys.stderr)
        m = re.search(r"no such (?:column|table):\s*([\w.]+)", str(e))
        if m:
            bare = m.group(1).split(".")[-1]
            try:
                cols = [c["name"] for c in con.execute(f'PRAGMA table_info("{bare}")')]  # noqa: S608
                if cols:
                    print(f"  ↳ {bare} 的实际列：{', '.join(cols)}", file=sys.stderr)
                else:
                    print(f"  ↳ {bare} 不是表名；用 --list-tables 查真名", file=sys.stderr)
            except sqlite3.Error:
                pass
        return 2
    finally:
        con.close()
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
        return 0
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(names)
    for r in rows:
        w.writerow([str(v).replace("\n", " ")[:300] if v is not None else "" for v in r.values()])
    sys.stdout.write(buf.getvalue())
    print(f"# {len(rows)} 行（外层已套 LIMIT {limit}；要更多用 --limit）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="观测库/任务库只读即席查询（先看列名再写 SQL）")
    ap.add_argument("--db", choices=("obs", "app", "explicit"), default="obs", help="obs=观测库（默认）；app=任务/会话库")
    ap.add_argument("--path", default="", help="直接指定 .db 路径（--db explicit 时必填）")
    ap.add_argument("--list-tables", action="store_true", help="列表名与行数")
    ap.add_argument("--schema", default="", help="打印某表的列名与类型")
    ap.add_argument("--sql", default="", help="SELECT/WITH 语句（只读）")
    ap.add_argument("--limit", type=int, default=80, help="结果行上限（默认 80，防灌爆上下文）")
    ap.add_argument("--json", action="store_true", help="输出 JSON 而非 CSV")
    args = ap.parse_args()

    kind = "explicit" if args.path and args.db == "explicit" else args.db
    db = resolve_db("app" if kind == "app" else "obs", args.path or "")
    if db is None:
        print(f"[obs_query] 找不到 {'任务库' if kind == 'app' else '观测库'}：用 EVOFLOW_HOME 或 --path 指定", file=sys.stderr)
        return 2
    if args.list_tables:
        return list_tables(db)
    if args.schema:
        return show_schema(db, args.schema)
    if args.sql:
        return run_sql(db, args.sql, max(1, args.limit), args.json)
    ap.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
