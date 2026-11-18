"""运行态自证：现在跑的是哪一版、源码改过没重启没。

【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】

为什么需要这个模块
----------------
在这之前，回答「新代码生效了吗」只能靠人工三件套：
查网关进程 CreationDate、对比目标文件 mtime、再猜是哪一个晚于哪一个。
我这轮和上一轮各踩过一次：
  · 上一轮据「文件已改」宣布修复生效，实际进程还是旧的；
  · 第29轮查了 7 层接线，最后发现只是没重启。

这不是粗心，是系统没给判据。判据应该由代码给出，不是由人记。

三个判据（缺一不可，只给 commit 没用）
----------------------------------
1. `commit`       —— 当前工作区 HEAD（短哈希 + 分支）
2. `started_at`   —— 本进程启动时刻（epoch 秒 + 人话）
3. `source_newer_than_process` —— 进程启动后有没有源文件被改过

第 3 条是真正的判据：`commit` 一样、但源码比进程新 = **跑的是旧代码**。

为什么不用 psutil
----------------
本仓没装 psutil，也不该为一个时间戳引入依赖。用标准库：
  · Windows: `kernel32.GetCurrentProcessTimes`（ctypes）
  · Linux/macOS: `/proc/self/stat` 字段 22，或 `psutil` 缺席时退回本模块加载时刻
拿不到时返回 None 并明说，不编一个假时间。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# 进程启动时刻缓存：同一个进程内这值不会变，只算一次。
_PROCESS_START_TS: float | None = None
_PROCESS_START_SOURCE = ""


def _process_start_ts_win32() -> tuple[float | None, str]:
    """Windows: GetCurrentProcessTimes → 创建时间（FILETIME 100ns since 1601）。"""
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetProcessTimes.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.FILETIME),  # creation
            ctypes.POINTER(wintypes.FILETIME),  # exit
            ctypes.POINTER(wintypes.FILETIME),  # kernel
            ctypes.POINTER(wintypes.FILETIME),  # user
        ]
        creation = wintypes.FILETIME()
        exit_t = wintypes.FILETIME()
        kernel = wintypes.FILETIME()
        user = wintypes.FILETIME()
        ok = kernel32.GetProcessTimes(
            kernel32.GetCurrentProcess(),
            ctypes.byref(creation),
            ctypes.byref(exit_t),
            ctypes.byref(kernel),
            ctypes.byref(user),
        )
        if not ok:
            return None, f"GetProcessTimes failed (errno={ctypes.get_last_error()})"
        ticks = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        # 1601-01-01 → 1970-01-01 相差 11644473600 秒；单位 100ns
        return ticks / 10_000_000.0 - 11644473600.0, "win32:GetProcessTimes"
    except Exception as exc:  # noqa: BLE001 - 纯诊断，绝不抛
        return None, f"win32 probe error: {type(exc).__name__}: {exc}"


def _process_start_ts_posix() -> tuple[float | None, str]:
    """Linux: /proc/self/stat 字段 22（开机后 clock ticks）。"""
    try:
        stat = Path("/proc/self/stat")
        if stat.exists():
            raw = stat.read_text(encoding="utf-8", errors="replace")
            # comm 里可能有空格/括号，字段 22 要从最后一个 ')' 之后数
            tail = raw[raw.rfind(")") + 2 :].split()
            starttime_ticks = float(tail[19])  # 第 22 字段 = 这个列表的第 20 项
            with open("/proc/uptime", encoding="utf-8") as fh:
                uptime = float(fh.read().split()[0])
            clock_ticks = os.sysconf("SC_CLK_TCK")
            return (
                time.time() - uptime + starttime_ticks / clock_ticks,
                "posix:/proc/self/stat",
            )
    except Exception as exc:  # noqa: BLE001
        return None, f"posix probe error: {type(exc).__name__}: {exc}"
    return None, "posix:no /proc/self/stat"


def process_start_ts() -> dict[str, Any]:
    """本进程启动时刻。返回 {ts, iso, age_seconds, source}；拿不到 ts=None 且说明原因。"""
    global _PROCESS_START_TS, _PROCESS_START_SOURCE
    if _PROCESS_START_TS is None:
        if sys.platform == "win32":
            ts, source = _process_start_ts_win32()
        else:
            ts, source = _process_start_ts_posix()
        _PROCESS_START_TS = ts
        _PROCESS_START_SOURCE = source
    ts = _PROCESS_START_TS
    return {
        "ts": ts,
        "iso": (
            time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else None
        ),
        "age_seconds": round(time.time() - ts, 1) if ts else None,
        "source": _PROCESS_START_SOURCE,
    }


def _git(root: Path, *args: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except Exception:  # noqa: BLE001
        return ""
    return (out.stdout or "").strip()


def _find_repo_root(hint: Path | None = None) -> Path | None:
    """从给定路径向上找含 `.git` 的目录。"""
    cur = (hint or Path.cwd()).resolve()
    for parent in [cur, *cur.parents]:
        if (parent / ".git").exists():
            return parent
    return None


def build_runtime_version_info(
    *,
    repo_root: str | Path | None = None,
    source_dirs: list[str] | None = None,
) -> dict[str, Any]:
    """回答「在跑的是哪一版」与「源码是否比进程新」。

    参数
    ----
    repo_root:    仓库根；不给则从 cwd 向上找 `.git`
    source_dirs:  要检查漂移的目录（相对 repo_root）；默认 backend + evopanel/src

    返回
    ----
    {
      "commit": "c8efa87a",
      "branch": "main",
      "dirty": true/false,          # 工作区有未提交改动
      "process": {...},             # 见 process_start_ts()
      "source_newer_than_process": true/false/null,
      "newest_newer_file": "...",   # 哪个文件比进程新（相对路径）
      "checked_dirs": [...],
      "checked_files": 1234,
      "probe_errors": [...]         # 探针失败原因，不静默
    }

    `source_newer_than_process` 为 null 表示**无法判定**（拿不到进程启动时刻），
    调用方必须把它当「不知道」，不许当 false。
    """
    errors: list[str] = []
    proc = process_start_ts()
    if proc["ts"] is None:
        errors.append(f"process start time unavailable: {proc['source']}")

    root = Path(repo_root) if repo_root else _find_repo_root()
    info: dict[str, Any] = {
        "commit": None,
        "branch": None,
        "dirty": None,
        "process": proc,
        "source_newer_than_process": None,
        "newest_newer_file": None,
        "checked_dirs": [],
        "checked_files": 0,
        "probe_errors": errors,
    }
    if root is None:
        errors.append("repo root not found (no .git upward from cwd)")
        return info
    info["repo_root"] = str(root)

    # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    # 调用方**明确给了** repo_root 时，就以它为准，不许悄悄向上改用父目录的 .git。
    # 反证3 撞出来的：传一个非仓库子目录，输出照样报出父仓库的 commit 和工作区状态，
    # 看上去像「这个目录是干净仓库」，实际问的是另一个仓库 —— 比报错更误导。
    if repo_root is not None and not (root / ".git").exists():
        errors.append(f"repo_root has no .git: {root} (not treated as a repository)")
        return info

    info["commit"] = _git(root, "rev-parse", "--short", "HEAD") or None
    info["branch"] = _git(root, "rev-parse", "--abbrev-ref", "HEAD") or None
    status_out = _git(root, "status", "--porcelain")
    # 空输出 = 干净；有输出 = 脏。git 不可用时保持 None（别谎报干净）
    info["dirty"] = bool(status_out) if info["commit"] else None

    dirs = source_dirs if source_dirs is not None else ["backend", "evopanel/src"]
    info["checked_dirs"] = [d for d in dirs if (root / d).exists()]

    start_ts = proc["ts"]
    if start_ts is None:
        return info

    newest: tuple[float, str] | None = None
    checked = 0
    suffixes = {".py", ".ts", ".tsx", ".js", ".jsx"}
    for rel_dir in info["checked_dirs"]:
        base = root / rel_dir
        for p in base.rglob("*"):
            try:
                if not p.is_file() or p.suffix not in suffixes:
                    continue
                # 跳过依赖/构建产物：它们由安装动作写，不代表源码变更
                parts = {x.lower() for x in p.parts}
                if parts & {"node_modules", "dist", "build", "__pycache__", ".venv"}:
                    continue
                checked += 1
                mtime = p.stat().st_mtime
            except OSError:
                continue
            if mtime > start_ts and (newest is None or mtime > newest[0]):
                newest = (mtime, str(p.relative_to(root)).replace("\\", "/"))

    info["checked_files"] = checked
    # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    # 扫到 0 个文件时不许报「干净」—— 我的反证3 就是这么撞出来的：
    # repo_root 指到子目录时 checked_dirs 全是空的，输出照样打勾「检查 0 个文件」。
    # 0 的第一含义是「我的过滤器没命中」，不是「没有改动」。
    if checked == 0:
        errors.append(
            "no source files scanned (checked_dirs empty or missing under "
            f"{root}) — cannot judge whether running code is current"
        )
        info["source_newer_than_process"] = None
        return info
    info["source_newer_than_process"] = newest is not None
    if newest is not None:
        info["newest_newer_file"] = newest[1]
        info["newest_newer_age_seconds"] = round(time.time() - newest[0], 1)
    return info


def format_runtime_version_markdown(info: dict[str, Any]) -> str:
    """一行话版（给人看，别让人去读 json）。"""
    proc = info.get("process") or {}
    lines = [
        "## Runtime version",
        f"- commit: `{info.get('commit') or '未知'}`"
        f" (branch `{info.get('branch') or '?'}`)"
        f"{' — 工作区有未提交改动' if info.get('dirty') else ''}",
    ]
    if proc.get("ts"):
        lines.append(
            f"- process started: {proc['iso']} (age {proc['age_seconds']}s)"
        )
    else:
        lines.append(f"- process started: 未知（{proc.get('source')}）")

    newer = info.get("source_newer_than_process")
    errors = list(info.get("probe_errors") or [])
    # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
    # 判不出原因时把它写进「无法判定」那一行，后面就不再重复列一遍（实测会打两遍）。
    explained = False
    if newer is True:
        lines.append(
            f"- ⚠ 源码比进程新：`{info.get('newest_newer_file')}`"
            f"（{info.get('newest_newer_age_seconds')}s 前修改）"
            " — 运行中的是旧代码，需重启才生效"
        )
    elif newer is False:
        lines.append(
            f"- ✓ 进程启动后无源码改动（检查 {info.get('checked_files')} 个文件）"
        )
    else:
        # 【self-evolution-bot · 2026-11-18 · 第51轮 · 模型:deepseek-v4.1-flash-1017】
        # 判不出新旧的**原因不止一种**（拿不到启动时刻 / 一个文件都没扫到 /
        # 不是仓库），这里必须按 probe_errors 说真话。原来一律写「拿不到进程启动时刻」，
        # 反证4 当场照出这句是错的：启动时刻拿到了，是没扫到文件。
        reason = "; ".join(errors) or "原因未记录"
        lines.append(f"- ? 无法判定源码与进程的新旧（{reason}）")
        explained = True
    if errors and not explained:
        for err in errors:
            lines.append(f"- probe error: {err}")
    return "\n".join(lines)
