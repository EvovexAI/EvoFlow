"""浏览器端到端一键验收（模拟智能体真实调用链）。

用法：
    python tools/browser-e2e-check.py

完全走智能体的真实路径：node_repl 内核 → 桥（ZCode browser-client.mjs）→
网关 /api/browser/execute → 引擎 → WebView2 嵌入窗口。验收项：

1. 内核桥就绪（Symbol 存在）
2. 浏览器列表可达
3. 导航到百度首页（校验 url/title 回传）
4. 二次导航到搜索页（校验嵌套 params 命令形状）
5. 引擎截屏（base64 解码非空、非纯白，证明页面真实渲染）
6. 窗口纪律：枚举 EvoFlow 窗口，统计可见的浏览器窗口数量
7. ANOMALY 检查：统一日志自上次标记后不得出现窗口违规

全部通过打印 PASS，任何一步失败打印 FAIL 并指出证据行。
"""

from __future__ import annotations

import base64
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend" / "packages" / "harness"))

os.environ.setdefault("EVOFLOW_CONFIG_DIR", r"C:\Users\admin\.evoflow-dev")

from evoflow.plugins.node_repl import call_node_repl_js  # noqa: E402

LOG = Path(os.environ["EVOFLOW_CONFIG_DIR"]) / "logs" / "plugin-control.log"
BOOTSTRAP = """const browserPluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const browserClientUrl = pathToFileURL(join(browserPluginRoot, "scripts", "browser-client.mjs")).href;
const { setupBrowserRuntime } = await import(browserClientUrl);
await setupBrowserRuntime({ globals: globalThis });
"""

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, evidence: str = "") -> None:
    results.append((name, ok, evidence))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {evidence}" if evidence else ""))


def marker() -> None:
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(f"=== e2e 验收开始 {datetime.now():%H:%M:%S} ===\n")


def anomalies_since(since_bytes: int) -> list[str]:
    text = LOG.read_text(encoding="utf-8", errors="replace").encode("utf-8")[
        since_bytes:
    ].decode("utf-8", errors="replace")
    return [ln.strip() for ln in text.splitlines() if "ANOMALY" in ln]


def visible_browser_windows() -> list[str]:
    """复用取证脚本的窗口枚举，数可见的 EvoFlow Browser。"""
    ps = subprocess.run(
        ["python", str(REPO / "tools" / "browser-window-diag.py"), "--tail", "0"],
        capture_output=True, text=True, timeout=120, encoding="utf-8", errors="replace",
    )
    return [
        ln.strip()
        for ln in ps.stdout.splitlines()
        if "EvoFlow Browser" in ln and "vis=True" in ln
    ]


def main() -> int:
    marker()
    since = LOG.stat().st_size
    print("== 浏览器端到端验收（智能体真实调用链）==\n")

    # 1. 内核桥就绪
    r = call_node_repl_js('typeof Symbol.for("zcode.node-repl.browser-control-bridge")', 30_000)
    check("1. 内核桥 Symbol 就绪", "symbol" in r, r[:60])

    # 2. 浏览器列表
    r = call_node_repl_js(
        'globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")].list()'
        '.then((x) => JSON.stringify(x))',
        30_000,
    )
    check("2. 浏览器列表可达", "evoflow-webview" in r, r[:80])

    # 3. 首页导航（平铺形状）
    r = call_node_repl_js(
        BOOTSTRAP
        + 'const b = await agent.browsers.getForUrl("https://www.baidu.com/");\n'
        + 'const n = await b.execute({ method: "navigate", url: "https://www.baidu.com/" });\n'
        + 'nodeRepl.write(JSON.stringify(n).slice(0, 200));\n"ok"',
        90_000,
    )
    check("3. 首页导航（平铺命令形状）", "百度一下" in r, r.split("nav=")[-1][:90])

    # 4. 搜索页导航（嵌套 params 形状 — 真实技能形状）
    r = call_node_repl_js(
        BOOTSTRAP
        + 'const b = await agent.browsers.getForUrl("https://www.baidu.com/");\n'
        + 'const n = await b.execute({ method: "navigate", params: { url: "https://www.baidu.com/s?wd=shanghai" } });\n'
        + 'nodeRepl.write(JSON.stringify(n).slice(0, 200));\n"ok"',
        90_000,
    )
    check("4. 搜索页导航（嵌套 params 形状）", "百度搜索" in r, r.split("nav=")[-1][:90])

    # 5. 引擎截屏：页面真实渲染（内核侧校验 PNG 头与体量，不回传大 base64）
    r = call_node_repl_js(
        BOOTSTRAP
        + 'const b = await agent.browsers.getForUrl("https://www.baidu.com/");\n'
        + 'const s = await b.execute({ method: "screenshot", params: {} });\n'
        + 'const b64 = s && s.image && s.image.base64 ? s.image.base64 : "";\n'
        + 'const png = b64.startsWith("iVBORw0KGgo");\n'
        + 'nodeRepl.write("b64len=" + b64.length + " png=" + png);\n"ok"',
        90_000,
    )
    shot_ok = "png=true" in r
    try:
        b64len = int(r.split("b64len=")[1].split(" ")[0])
    except Exception:
        b64len = 0
    # 空白页截图极小（<15K base64）；真实页面 >50K
    shot_ok = shot_ok and b64len > 50_000
    check("5. 引擎截屏真实渲染", shot_ok, f"b64len={b64len}")

    # 6. 窗口纪律
    visible = visible_browser_windows()
    # 面板未开时应为 0；面板开着时恰好 1 且被看门狗钳在槽位。
    check("6. 可见浏览器窗口 ≤ 1", len(visible) <= 1, "; ".join(visible) or "none visible")

    # 7. ANOMALY
    anoms = anomalies_since(since)
    check("7. 零窗口违规（ANOMALY）", not anoms, "; ".join(anoms[-2:]) or "clean")

    failed = [r for r in results if not r[1]]
    print(f"\n== 结果：{'PASS 全部通过' if not failed else f'FAIL {len(failed)} 项未过'} ==")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
