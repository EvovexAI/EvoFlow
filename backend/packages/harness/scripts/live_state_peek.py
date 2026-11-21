"""运行态快照：一条命令看清「代码有没有进进程 / 右栏现在什么样 / 日志最近说了什么」。

【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】新建（零依赖，纯 stdlib）。

为什么要这个脚本（我自己的实测记账，不是"顺手加个工具"）
--------------------------------------------------------
本轮用户的原话：「下次你再运行的时候，你如何去看日志，对不对？或者是有哪些地方能
直接看清楚，而不是这样反反复复地让我去重启。」

暴露的是我的一个**固定绕路**：我每次改完代码都要靠「请用户重启 → 再调一次工具 →
看结果对不对」来判定改动生效。这条链每跑一次就是 **1 轮用户等待 + 1 轮我重跑**。
而其中有一半的失败根本不是"改错了"，是**改动根本没进进程** —— 我改的文件 mtime
晚于 evoflow.exe 的进程启动时间，Gateway 从源码 import 后就不再重读。

实测（2026-11-20 23:40）：
- evoflow.exe pid 57380 StartTime = 23:20:43
- stage_tool.py mtime = 23:35:45（晚 15 分钟 → 未进进程）
- agui_stream_normalizer.py mtime = 23:33:05（晚 12 分钟 → 未进进程）
- evopanel/dist/index.html mtime = 23:05:30（早 15 分钟 → 已经在那份 bundle 里）

所以「改动生效了吗」这个问题的**答案是能在本地算出来的**（mtime 比 StartTime），
不需要重启才知道。以前我不算，直接去要一次重启，这是纯浪费。

它提供三件事
------------
1. ``--drift``：把我改过的文件逐个跟 evoflow.exe 启动时间比，直接列出
   「已进进程 / 未进进程」。未进进程的才需要重启，已进的不用。
2. ``--right-stage``：读 ``right-stage-YYYY-MM-DD.log`` 尾部，把 ``[py] emit sent``
   与紧随其后的 ``[web-state] report`` 成对排出来 —— 这是"我说了什么 → 屏幕上
   变成了什么"唯一的对照证据。同时打一次 ``GET /api/stage/right-stage/state``。
3. ``--log <source>``：走网关的 ``/api/diagnostics/tail``（现网已确认 right-stage
   在 sources 列表里），不直接读 90MB 大文件。

用法
----
    PYTHONPATH=packages/harness:. python backend/packages/harness/scripts/live_state_peek.py
    ... --drift                     只判改动是否进进程（0.5s）
    ... --right-stage --lines 40    只看右栏配对
    ... --log gateway --lines 100   看某个日志源尾部
    ... --watch backend/app/x.py ...  指定要比对的文件

判据（本岗硬规矩）
------------------
- ``未进进程`` 的文件**不许**用"再调一次工具看行为"来验收，必须先重启；
- ``已进进程`` 的文件如果行为不对，那才是真的代码缺陷，才去改代码；
- 这个区分以前我全靠脑补，现在有数字。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

GATEWAY = "http://127.0.0.1:8382"

# 改动后需要"进进程"才有意义的路径（后端源代码直加载；dist 是打包进 exe 的静态资源）
DEFAULT_WATCH = (
    "backend/app/gateway/agui_stream_normalizer.py",
    "backend/packages/harness/evoflow/tools/builtins/stage_tool.py",
    "backend/packages/harness/evoflow/admin/platform_handlers.py",
    "backend/packages/harness/evoflow/admin/platform_actions.py",
    "backend/app/gateway/routers/stage_right_panel.py",
    "evopanel/dist/index.html",
)


def _exe_start_time(proc_name: str = "evoflow") -> tuple[int | None, datetime | None]:
    """取桌面端进程的 pid 与启动时间（Windows；一次 powershell 调用约 0.4s）。"""
    ps = (
        f"Get-Process {proc_name} -ErrorAction SilentlyContinue | "
        "Sort-Object StartTime | Select-Object -First 1 -Property Id,StartTime | "
        "ForEach-Object { \"{0} {1}\" -f $_.Id, $_.StartTime.ToString('yyyy-MM-ddTHH:mm:ss.fff') }"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=20,
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        print(f"  ! 取进程启动时间失败: {exc}")
        return None, None
    line = (out.stdout or "").strip().splitlines()
    if not line:
        return None, None
    parts = line[0].split()
    if len(parts) < 2:
        return None, None
    try:
        return int(parts[0]), datetime.fromisoformat(parts[1])
    except ValueError:
        return None, None


def _frontend_source_newer_than_dist(repo: Path) -> tuple[datetime, str] | None:
    """前端源码里是否有比 ``dist/index.html`` 更新的文件。

    返回 (最新 mtime, 相对路径)；全部都不新（或 dist 不存在）时返回 None。
    dist 不存在单独由 ``cmd_drift`` 的 paths 检查报「路径不存在」，这里不重复判。

    【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    只扫 ``src/``：``tests/`` 不影响产物，扫进来会让每次改测试都误报。
    """
    dist = repo / "evopanel" / "dist" / "index.html"
    if not dist.exists():
        return None
    dist_mtime = dist.stat().st_mtime
    src = repo / "evopanel" / "src"
    if not src.is_dir():
        return None
    newest: tuple[float, str] | None = None
    suffixes = {".ts", ".tsx", ".js", ".jsx", ".css", ".json"}
    for p in src.rglob("*"):
        if not p.is_file() or p.suffix not in suffixes:
            continue
        try:
            mt = p.stat().st_mtime
        except OSError:
            continue
        if mt <= dist_mtime:
            continue
        if newest is None or mt > newest[0]:
            newest = (mt, str(p.relative_to(repo)))
    if newest is None:
        return None
    return datetime.fromtimestamp(newest[0]), newest[1]


def cmd_drift(paths: tuple[str, ...], repo: Path) -> int:
    pid, started = _exe_start_time()
    print("=" * 78)
    print("改动 vs 运行进程（决定是否需要重启）")
    print("=" * 78)
    if started is None:
        print("  ! 没找到 evoflow 进程 —— 桌面端没在跑，下面的比对无意义")
        return 2
    print(f"  evoflow.exe  pid={pid}  启动于 {started:%Y-%m-%d %H:%M:%S}")
    # 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：drift 增一道「前端源码 vs dist」检查，并把它算进退出码。
    # 为什么（本轮真事故）：我只比了 dist 与进程启动时刻，得出「全部已进进程，不用重启」，
    #   而真实情况是我 00:36~00:46 改的前端源码**从未被打进 dist**（dist 是 00:16 的旧包）。
    #   于是我连续让用户重启、连续让他看到旧行为 —— 他问「恶化的一直都解决不掉吗」。
    # 判据：evopanel/src 下任一文件 mtime 晚于 dist/index.html → 前端源码未进包；
    #   此时无论 dist 多新都必须报「需要重新构建」，不许说「不用重启」。
    frontend_stale = _frontend_source_newer_than_dist(repo)
    if frontend_stale:
        newest, name = frontend_stale
        print()
        print("  ⚠ 前端源码比 dist 新 —— 改了没重新构建，dist 里是旧代码：")
        print(f"      最新源码  {newest:%H:%M:%S}  {name}")
        dist = repo / "evopanel" / "dist" / "index.html"
        if dist.exists():
            print(f"      dist      {datetime.fromtimestamp(dist.stat().st_mtime):%H:%M:%S}  evopanel/dist/index.html")
        print("    → 先跑 (cd evopanel && npm run build)，否则打包出来的仍是旧前端。")

    stale: list[str] = []
    fresh: list[str] = []
    missing: list[str] = []
    for rel in paths:
        p = repo / rel
        if not p.exists():
            missing.append(rel)
            continue
        mt = datetime.fromtimestamp(p.stat().st_mtime)
        if mt > started:
            stale.append(f"    未进进程  {mt:%H:%M:%S}  {rel}")
        else:
            fresh.append(f"    已进进程  {mt:%H:%M:%S}  {rel}")

    if fresh:
        print("\n  这两类不用重启就能验：")
        for line in fresh:
            print(line)
    if stale:
        print("\n  改了但进程还在跑旧代码（必须重启后才谈得上验收）：")
        for line in stale:
            print(line)
    if missing:
        print("\n  路径不存在（跳过）：")
        for rel in missing:
            print(f"    -  {rel}")

    print()
    if stale or frontend_stale:
        print(f"  结论：{len(stale)} 个后端文件未进进程 + "
              f"{'前端源码未打包' if frontend_stale else '前端已同步'} → 需要一次重启；"
              f"{len(fresh)} 个已生效，可以现在就验。")
        if frontend_stale:
            print("        ⚠ 重启前先 npm run build，否则重启也白搭（dist 里是旧源码）。")
    else:
        print("  结论：全部已进进程，不需要重启，直接调工具看行为即可。")
    return 1 if frontend_stale else 0


# 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：``/api/diagnostics/tail`` 的 ``lines`` 由网关约束在 [50, 5000]，
#   第一次真跑时我传 ``--lines 30`` 直接吃到 ``HTTP 422 Unprocessable Entity``，
#   而脚本只报「取不到」，看不出是哪个参数越界。现在在客户端夹到合法区间，
#   并把实际生效值打出来。为什么：422 不带字段名时，光看报错要再发一次探针才定位。
TAIL_LINES_MIN, TAIL_LINES_MAX = 50, 5000


def _clamp_lines(lines: int) -> int:
    return max(TAIL_LINES_MIN, min(TAIL_LINES_MAX, int(lines)))


def _http_json(url: str, timeout: float = 8.0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        print(f"  ! {url} 取不到：HTTP {exc.code} {exc.reason}")
        return None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"  ! {url} 取不到：{exc}")
        return None


def cmd_right_stage(lines: int, repo: Path) -> int:
    print("=" * 78)
    print("右栏现场：日志配对 + 状态快照")
    print("=" * 78)

    state = _http_json(f"{GATEWAY}/api/stage/right-stage/state")
    if state:
        tabs = state.get("tabs") or []
        print(f"  快照  collapsed={state.get('collapsed')}  "
              f"activeKey={state.get('activeKey')}  rev={state.get('rev')}  签数={len(tabs)}")
        for t in tabs:
            key = (t or {}).get("key")
            title = (t or {}).get("title")
            sk = (t or {}).get("sessionKey")
            print(f"    - {key}  title={title!r}  sessionKey={sk}")
    else:
        print("  快照  取不到（网关没起或没重启到新版）")

    tail = _http_json(
        f"{GATEWAY}/api/diagnostics/tail?source=right-stage&lines={_clamp_lines(lines)}"
    )
    if not tail or not tail.get("exists"):
        print("  日志  right-stage 源读不到")
        return 0
    body = (tail.get("content") or "").strip().splitlines()
    print(f"\n  日志  {tail.get('path')}  共 {len(body)} 行，末尾关键行：")
    # 只打有信息量的行：py emit / web-state，其它（心跳）跳过
    shown = 0
    for raw in body[-max(lines, 20):]:
        if "[py]" in raw or "[web-state]" in raw:
            print(f"    {raw}")
            shown += 1
    if not shown:
        print("    （这批日志里没有 [py]/[web-state] 行 —— 说明这一轮没调过右栏工具）")

    print("\n  怎么读：一条 [py] emit sent action=X 后面紧跟的 [web-state] report，")
    print("  就是「我发了 X → 用户右栏变成了什么样」的唯一实证；两者之间缺席 = 前端没接。")
    return 0


def cmd_log(source: str, lines: int) -> int:
    data = _http_json(
        f"{GATEWAY}/api/diagnostics/tail?source={source}&lines={_clamp_lines(lines)}"
    )
    if not data:
        return 1
    print(f"# {data.get('log_name')}  {data.get('path')}  size={data.get('size')}")
    print((data.get("content") or "").rstrip())
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="运行态快照（只读，零依赖）")
    ap.add_argument("--repo", default=".", help="仓库根，默认当前目录")
    ap.add_argument("--drift", action="store_true", help="只看改动是否进了运行进程")
    ap.add_argument("--right-stage", action="store_true", help="只看右栏配对与快照")
    ap.add_argument("--log", default=None, help="读某个日志源尾部（如 gateway / langgraph）")
    ap.add_argument("--lines", type=int, default=40)
    ap.add_argument("--watch", nargs="*", default=None, help="要比对的文件（相对仓库根）")
    args = ap.parse_args(argv)

    repo = Path(args.repo).resolve()
    any_flag = bool(args.drift or args.right_stage or args.log)

    rc = 0
    if not any_flag or args.drift:
        rc |= cmd_drift(tuple(args.watch or DEFAULT_WATCH), repo)
    if not any_flag or args.right_stage:
        rc |= cmd_right_stage(args.lines, repo)
    if args.log:
        rc |= cmd_log(args.log, args.lines)
    return rc


if __name__ == "__main__":
    sys.exit(main())
