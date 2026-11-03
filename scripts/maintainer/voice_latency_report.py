#!/usr/bin/env python3
"""小V 语音时延报表 — 解析 voice 日志三锚点，输出 p50/p95/max。

度量锚点（M4/M5 状态机重构的前置基线，见 docs/design/voice-state-machine-convergence.md）：
  fe_turn_to_play   用户说完→本地播报开始（voice-frontend：`用户说完→本地播报开始 X ms`）
  be_vad_to_bot     用户落静音→机器人开口（voice-backend：Pipecat observer `X ms`）
  be_turn_to_synth  turn 判定→首句合成请求（voice-backend：`turn 判定→首句合成请求 X ms`）
  be_wire_gap       句间音频下发间隔（`wire_gap=Xms`）

用法：
  python scripts/maintainer/voice_latency_report.py                # 默认 ~/.evoflow-dev/logs/voice
  python scripts/maintainer/voice_latency_report.py --dir <logs>   # 指定目录
  python scripts/maintainer/voice_latency_report.py --days 7       # 只看最近 N 天文件
"""

from __future__ import annotations

import argparse
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ANCHORS: dict[str, re.Pattern[str]] = {
    "fe_turn_to_play": re.compile(r"用户说完→本地播报开始 (\d+) ms"),
    "be_turn_to_synth": re.compile(r"turn 判定→首句合成请求 (\d+) ms"),
    "be_wire_gap": re.compile(r"wire_gap=(\d+)ms"),
    "be_vad_to_bot": re.compile(r"(?:用户落静音→机器人开口约|用户落静音→机器人开口) (\d+) ms"),
    # agent 往返（agent 内化收益评估的依据；仅语音发问路径打点）
    "fe_send_prep_ms": re.compile(r"chatSend 准备 .*prep=\+(\d+)ms"),
    "fe_send_total_ms": re.compile(r"chatSend 已提交 .*total=\+(\d+)ms"),
}


def parse_files(log_dir: Path, days: int | None) -> dict[str, list[int]]:
    samples: dict[str, list[int]] = {name: [] for name in ANCHORS}
    samples["be_wire_gap_cross_turn"] = []
    files = sorted(log_dir.glob("voice-*.log"))
    if days:
        # 文件名 voice-frontend-YYYY-MM-DD.log；粗过滤最近 N 天
        import datetime as _dt

        cutoff = _dt.date.today() - _dt.timedelta(days=days - 1)
        keep = []
        for f in files:
            m = re.search(r"(\d{4}-\d{2}-\d{2})\.log$", f.name)
            if m and _dt.date.fromisoformat(m.group(1)) >= cutoff:
                keep.append(f)
        files = keep
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            for name, pat in ANCHORS.items():
                m = pat.search(line)
                if m:
                    v = int(m.group(1))
                    # wire_gap >5s 是跨轮空闲（handoff 锚点跨回合），单独计不进句间分布
                    if name == "be_wire_gap" and v > 5000:
                        samples["be_wire_gap_cross_turn"].append(v)
                    else:
                        samples[name].append(v)
    return samples


def describe(name: str, values: list[int]) -> str:
    if not values:
        return f"  {name:<16} 无样本"
    vals = sorted(values)
    p50 = vals[len(vals) // 2]
    p95 = vals[min(len(vals) - 1, int(len(vals) * 0.95))]
    mean = statistics.fmean(vals)
    return (
        f"  {name:<16} n={len(vals):>4}  "
        f"p50={p50:>5}ms  p95={p95:>5}ms  max={max(vals):>5}ms  avg={mean:>6.0f}ms"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", default=str(Path.home() / ".evoflow-dev" / "logs" / "voice"))
    ap.add_argument("--days", type=int, default=None, help="只统计最近 N 天的日志文件")
    args = ap.parse_args()
    log_dir = Path(args.dir)
    if not log_dir.is_dir():
        print(f"日志目录不存在：{log_dir}", file=sys.stderr)
        return 1
    samples = parse_files(log_dir, args.days)
    scope = f"最近 {args.days} 天" if args.days else "全部"
    print(f"小V 语音时延报表（{scope}） 目录：{log_dir}\n")
    for name in ANCHORS:
        print(describe(name, samples[name]))
    print(
        "\n目标基线：fe_turn_to_play p95 ≤ 2000ms（P1 详设 0.8-1.2s 问→听答首音，"
        "含 agent 往返）；wire_gap p95 越小播报越连贯。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
