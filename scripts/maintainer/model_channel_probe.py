#!/usr/bin/env python3
"""对话模型渠道探活 / 试调用工具 — 直读 EvoFlow SQLite，直连厂商 HTTP。

用途：
  - 列出本机已配置的模型连接（``evoflow_model_connections``）与对话模型（``evoflow_models``）
  - 实调各厂商 ``/chat/completions``，区分「DB 里标 available 但其实调不通」的情况
  - 试调用指定模型并打印首段回复

注意：EvoFlow 的**对话模型连接**与**生图/语音渠道**分开存放：
  - 对话连接 → ``evoflow_model_connections``
  - 生图/语音 → ``evoflow_app_settings`` 的 ``media.credentials``（如 ``openaiImageBaseUrl``）
    部分 OpenAI 兼容生图网关同时提供 ``/chat/completions``，本脚本以 ``sakutime`` 别名挂出来。

用法：
  python scripts/maintainer/model_channel_probe.py --list
  python scripts/maintainer/model_channel_probe.py --probe                 # 探活全部已知可用模型
  python scripts/maintainer/model_channel_probe.py --call openai deepseek-v4.1-flash "你好"
  python scripts/maintainer/model_channel_probe.py --call sakutime gpt-5.6 "你好"
  python scripts/maintainer/model_channel_probe.py --db "D:/path/evoflow.db" --list

Windows 控制台中文乱码时先执行 ``chcp 65001``。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - 旧解释器
    pass

DEFAULT_DB_CANDIDATES = (
    r"C:\Users\admin\.evoflow\profiles\default\data\app\evoflow.db",
    r"C:\Users\admin\.evoflow\data\app\evoflow.db",
    r"C:\Users\admin\.evoflow-dev\data\app\evoflow.db",
)

# 实测能正常对话的模型（连接键 -> 模型 ID）。DB 的 availability_status 不可信，
# 这里维护的是「探活通过」的名单。
DEFAULT_TARGETS: list[tuple[str, str]] = [
    ("sakutime", "gpt-5.6"),
    ("openai", "deepseek-v4.1-flash"),
    ("openai", "qwen3.8-max"),
    ("openai", "qwen3.8-flash"),
    ("openai", "qwen3.6-35b-a3b"),
    ("openai", "step-5-preview"),
    ("openai", "glm-5.3"),
    ("openai", "glm-5.3-flash"),
    ("volcengine", "deepseek-v4.1-flash"),
    ("volcengine", "deepseek-v4.1-flash-economy"),
    ("volcengine", "doubao-seed-2.1-pro"),
    ("volcengine", "doubao-seed-2.1-lite"),
    ("volcengine", "kimi-k3.1-pro"),
    ("volcengine", "kimi-k2.8-preview"),
    ("volcengine", "glm-5.3-flash"),
]


# --------------------------------------------------------------------------- #
# DB 定位与读取
# --------------------------------------------------------------------------- #
def _db_candidates() -> list[Path]:
    """收集本机可能的 evoflow.db 位置（含多 profile 目录）。"""
    out: list[Path] = []
    home = os.getenv("EVOFLOW_HOME")
    if home:
        out.append(Path(home) / "data" / "app" / "evoflow.db")

    user_home = Path.home()
    out.extend(Path(raw) for raw in DEFAULT_DB_CANDIDATES)
    # 多 profile：~/.evoflow/profiles/<name>/data/app/evoflow.db
    for root in (user_home / ".evoflow" / "profiles", user_home / ".evoflow-dev" / "profiles"):
        if root.is_dir():
            for profile in root.iterdir():
                if profile.is_dir():
                    out.append(profile / "data" / "app" / "evoflow.db")
    return out


def resolve_db(explicit: str | None) -> Path:
    """按显式路径 → EVOFLOW_DB_PATH → 常见安装位置（取最近修改的）依次定位 evoflow.db。

    注意：多 profile 并存时（``~/.evoflow/profiles/default`` 与 ``~/.evoflow-dev``），
    自动选择最近被写入的那个，与实际运行的 Gateway 实例一致。
    """
    if explicit:
        return Path(explicit).expanduser().resolve()

    env_path = os.getenv("EVOFLOW_DB_PATH")
    if env_path:
        return Path(env_path).expanduser().resolve()

    existing = [p for p in _db_candidates() if p.exists() and p.stat().st_size > 0]
    if not existing:
        raise SystemExit("找不到 evoflow.db，请用 --db 显式指定路径。")
    return max(existing, key=lambda p: p.stat().st_mtime)


def open_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_connections(conn: sqlite3.Connection) -> dict[str, dict[str, str]]:
    """读取全部可用渠道：对话连接 + 生图渠道里的 OpenAI 兼容网关。"""
    out: dict[str, dict[str, str]] = {}

    try:
        rows = conn.execute(
            "select key, base_url, api_key, api_type, display_name from evoflow_model_connections"
        ).fetchall()
    except sqlite3.Error:
        rows = []
    for r in rows:
        out[str(r["key"])] = {
            "base_url": str(r["base_url"] or "").strip().rstrip("/"),
            "api_key": str(r["api_key"] or "").strip(),
            "api_type": str(r["api_type"] or "openai-completions"),
            "display_name": str(r["display_name"] or ""),
        }

    # 生图渠道里的 OpenAI 兼容网关（sakutime.cc 等）也能走 /chat/completions。
    try:
        row = conn.execute(
            "select value_text, value_json from evoflow_app_settings where key='media.credentials'"
        ).fetchone()
    except sqlite3.Error:
        row = None
    if row:
        raw = row["value_json"] or row["value_text"] or "{}"
        try:
            media = json.loads(raw)
        except Exception:
            media = {}
        base = str(media.get("openaiImageBaseUrl") or "").strip().rstrip("/")
        key = str(media.get("openaiImageApiKey") or "").strip()
        if base and key:
            out.setdefault(
                "sakutime",
                {
                    "base_url": base,
                    "api_key": key,
                    "api_type": "openai-completions",
                    "display_name": "sakutime（生图渠道，兼作对话）",
                },
            )
    return out


def list_models(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    try:
        return conn.execute(
            "select name, vendor, model, base_url, availability_status, unavailable_reason "
            "from evoflow_models order by vendor, name"
        ).fetchall()
    except sqlite3.Error:
        return []


# --------------------------------------------------------------------------- #
# 调用
# --------------------------------------------------------------------------- #
def chat(
    conns: dict[str, dict[str, str]],
    conn_key: str,
    model_id: str,
    prompt: str,
    max_tokens: int = 1000,
    timeout: int = 120,
) -> tuple[str, dict[str, Any]]:
    """调用一次 /chat/completions。返回 (可读结果行, 原始响应)。"""
    if conn_key not in conns:
        return "FAIL  连接键 %s 不存在（现有: %s）" % (conn_key, ", ".join(sorted(conns))), {}

    info = conns[conn_key]
    url = info["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + info["api_key"],
        },
    )

    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:400]
        except Exception:
            pass
        return "FAIL  %5.1fs HTTP %s | %s" % (time.time() - started, exc.code, detail), {}
    except Exception as exc:
        return "FAIL  %5.1fs %s" % (time.time() - started, exc), {}

    msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
    content = msg.get("content") or ""
    reasoning = msg.get("reasoning_content") or ""
    if not content and reasoning:
        content = "[思考模式，仅 reasoning] " + reasoning
    usage = data.get("usage") or {}
    line = "OK    %5.1fs | 返回模型=%s | tokens(prompt=%s, completion=%s)\n%s" % (
        time.time() - started,
        data.get("model"),
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        content,
    )
    return line, data


def mask(secret: str) -> str:
    if not secret:
        return "(空)"
    if len(secret) <= 8:
        return "****" + secret[-4:]
    return "%s****%s" % (secret[:4], secret[-4:])


# --------------------------------------------------------------------------- #
# 子命令
# --------------------------------------------------------------------------- #
def cmd_list(conn: sqlite3.Connection, conns: dict[str, dict[str, str]]) -> None:
    print("== 模型连接（对话）==")
    for key in sorted(conns):
        info = conns[key]
        print(
            "  %-12s %-52s key=%s  %s"
            % (key, info["base_url"] or "(空)", mask(info["api_key"]), info["display_name"])
        )

    print()
    print("== evoflow_models（注意 availability_status 未必准确）==")
    for row in list_models(conn):
        print(
            "  %-32s vendor=%-12s model=%-28s %-12s %s"
            % (
                row["name"],
                row["vendor"],
                row["model"],
                row["availability_status"],
                row["base_url"] or "",
            )
        )


def cmd_probe(conns: dict[str, dict[str, str]], prompt: str) -> int:
    failures = 0
    for conn_key, model_id in DEFAULT_TARGETS:
        print("=" * 72)
        print("%s / %s" % (conn_key, model_id))
        line, _ = chat(conns, conn_key, model_id, prompt)
        print(line)
        if line.startswith("FAIL"):
            failures += 1
    print("=" * 72)
    print("失败 %d / %d" % (failures, len(DEFAULT_TARGETS)))
    return 1 if failures else 0


def cmd_call(
    conns: dict[str, dict[str, str]], conn_key: str, model_id: str, prompt: str
) -> int:
    line, _ = chat(conns, conn_key, model_id, prompt)
    print("%s / %s" % (conn_key, model_id))
    print(line)
    return 1 if line.startswith("FAIL") else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="EvoFlow 对话模型渠道探活 / 试调用")
    parser.add_argument("--db", help="evoflow.db 路径（默认自动定位）")
    parser.add_argument("--list", action="store_true", help="列出连接与模型")
    parser.add_argument("--probe", action="store_true", help="探活全部已知可用模型")
    parser.add_argument("--call", nargs=2, metavar=("CONN_KEY", "MODEL_ID"), help="试调用单个模型")
    parser.add_argument("--prompt", default="用一句话介绍你自己，并报出你的模型名。", help="提示词")
    args = parser.parse_args()

    db_path = resolve_db(args.db)
    conn = open_db(db_path)
    conns = load_connections(conn)
    print("DB: %s" % db_path)
    print("渠道: %s" % ", ".join(sorted(conns)))
    print()

    if args.call:
        conn_key, model_id = args.call
        return cmd_call(conns, conn_key, model_id, args.prompt)
    if args.probe:
        return cmd_probe(conns, args.prompt)
    if args.list:
        cmd_list(conn, conns)
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
