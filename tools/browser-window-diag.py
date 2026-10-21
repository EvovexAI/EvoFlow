"""浏览器窗口一键取证：再遇到悬浮/漂移时，跑这一个脚本，证据一次出齐。

用法：
    python tools/browser-window-diag.py [--tail 120]

输出三段：
1. 窗口枚举 —— EvoFlow 进程所有可见窗口的实时矩形（悬浮窗无所遁形）
2. 异常记录 —— logs/plugin-control.log 里全部 ANOMALY 行（含 last_writer 凶手）
3. 最近时间线 —— 统一日志最后 N 行（三端时间线对齐）
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PS_ENUM = r"""
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BDEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  public struct RECT { public int L, T, R, B; }
}
'@
$out = @()
function Describe-Win($h, $tag) {
  $r = New-Object BDEnum+RECT
  [BDEnum]::GetWindowRect($h, [ref]$r) | Out-Null
  if ((($r.R - $r.L) -lt 120) -or (($r.B - $r.T) -lt 80)) { return }
  $sb = New-Object System.Text.StringBuilder 256
  [BDEnum]::GetWindowText($h, $sb, 256) | Out-Null
  $t = $sb.ToString()
  if ($t.Length -gt 24) { $t = $t.Substring(0, 24) }
  $style = [BDEnum]::GetWindowLong($h, -16)
  $child = (($style -band 0x40000000) -ne 0)
  $parent = [BDEnum]::GetParent($h)
  $script:out += "$tag hwnd=$h vis=$([BDEnum]::IsWindowVisible($h)) child=$child parent=$parent title='$t' rect=($($r.L),$($r.T),$($r.R),$($r.B)) size=$($r.R-$r.L)x$($r.B-$r.T)"
}
$tops = @()
$cb = {
  param($h, $l)
  $p = 0
  [BDEnum]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq __PID__) {
    Describe-Win $h 'top'
    $script:tops += $h
  }
  return $true
}
[BDEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
foreach ($top in $tops) {
  $childCb = {
    param($h, $l)
    Describe-Win $h 'child'
    return $true
  }
  [BDEnum]::EnumChildWindows($top, $childCb, [IntPtr]::Zero) | Out-Null
}
$out
"""


def evoflow_dir() -> Path:
    env = os.environ.get("EVOFLOW_CONFIG_DIR")
    if env:
        return Path(env)
    home = Path(os.path.expanduser("~"))
    debug = home / ".evoflow-dev"
    return debug if debug.is_dir() else home / ".evoflow"


def evoflow_pids() -> list[int]:
    ps = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "(Get-Process evoflow -ErrorAction SilentlyContinue).Id"],
        capture_output=True, text=True, timeout=30, encoding="utf-8", errors="replace",
    )
    return [int(x) for x in ps.stdout.split() if x.strip().isdigit()]


def enumerate_windows(pid: int) -> list[str]:
    ps_src = PS_ENUM.replace("__PID__", str(pid))
    ps = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_src],
        capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace",
    )
    return [ln for ln in ps.stdout.splitlines() if ln.startswith("hwnd=")]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tail", type=int, default=120)
    args = ap.parse_args()

    log = evoflow_dir() / "logs" / "plugin-control.log"
    # Legacy root-level Chinese / prior English names (pre logs/ migration).
    if not log.is_file():
        for legacy_name in ("插件控制日志.log", "browser-debug.log"):
            legacy = evoflow_dir() / legacy_name
            if legacy.is_file():
                log = legacy
                break
    print(f"=== 浏览器窗口取证 {datetime.now():%Y-%m-%d %H:%M:%S} ===")
    print(f"统一日志: {log}\n")

    print("── 1. 窗口枚举 ──")
    pids = evoflow_pids()
    if not pids:
        print("  EvoFlow 客户端未运行")
    for pid in pids:
        print(f"  进程 {pid}:")
        for line in enumerate_windows(pid):
            print(f"    {line}")

    print("\n── 2. 异常记录（ANOMALY = 窗口违反不变量，已自动吸回）──")
    anomalies = []
    if log.exists():
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if "ANOMALY" in line:
                anomalies.append(line)
    if anomalies:
        for line in anomalies[-20:]:
            print(f"  {line}")
    else:
        print("  无")

    print(f"\n── 3. 最近 {args.tail} 行时间线 ──")
    if log.exists():
        lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        for line in lines[-args.tail:]:
            print(f"  {line}")
    else:
        print("  （日志不存在）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
