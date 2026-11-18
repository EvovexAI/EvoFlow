"""Auto-bootstrap 必须真的提供 ``globalThis.tab``（文档承诺 = 代码实现）。

【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这个文件（现网实测数据）：
308 次 ``mcp__node_repl__js`` 调用里 **107 次**手写了整段 bootstrap 前言
（``pathToFileURL`` / ``setupBrowserRuntime`` / ``getForUrl`` / ``tabs.list`` / ``tabs.get``），
每次 494 字符 —— 累计 49,220 字符 ≈ 12.3k tokens 纯重复输入。

实测这三步的固定开销：``getForUrl`` 12.5ms + ``tabs.list`` 13.7ms + ``tabs.get`` 25.0ms。
端到端对比（p50，6 次）：
  手写 bootstrap + evaluate  = **93.3ms**
  直接用宿主注入的 tab + evaluate = **25.8ms**
⇒ 每调用省 67.5ms / 460 字符。

判据（三条，都是「承诺必须真」）：
1. bootstrap 源码里必须给 ``globalThis.tab`` 赋值 —— 否则指南里写「直接用 tab」就是空话；
2. ``__evoflowBrowserBootstrapped`` 已置位的**短路分支**也要补解析 —— 这条最容易漏：
   短路 ``return`` 在赋值之前，不补就永远是 undefined（我第一版就漏了它）；
3. 指南文本必须禁止手写 bootstrap —— 否则模型继续照旧写法烧 token。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NODE_REPL = REPO / "backend" / "packages" / "harness" / "evoflow" / "plugins" / "node_repl.py"
NODE_REPL_TOOL = REPO / "backend" / "packages" / "harness" / "evoflow" / "plugins" / "node_repl_tool.py"


def _bootstrap_src() -> str:
    src = NODE_REPL.read_text(encoding="utf-8")
    marker = '_BROWSER_AUTO_BOOTSTRAP_JS = r"""'
    start = src.index(marker) + len(marker)
    return src[start:src.index('"""', start)]


def _run_node(js: str, timeout: int = 60) -> str:
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", js],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(REPO),
    )
    if proc.returncode != 0:
        raise AssertionError(f"node failed:\nSTDOUT\n{proc.stdout}\nSTDERR\n{proc.stderr}")
    return proc.stdout.strip()


def test_bootstrap_assigns_global_tab() -> None:
    """主流程必须给 globalThis.tab 赋值。"""
    js = _bootstrap_src()
    assert "globalThis.tab = t" in js, (
        "auto-bootstrap 没有给 globalThis.tab 赋值；指南里「直接用 tab」就成了空承诺，"
        "模型只能继续每次手写 494 字符的 bootstrap 前言。"
    )


def test_bootstrap_short_circuit_also_resolves_tab() -> None:
    """已 bootstrap 过的短路分支必须补一次 tab 解析。

    为什么单列一条：短路 ``return`` 出现在主流程赋值之前。只改主流程的话，
    只要内核曾经 bootstrap 过（几乎总是），``globalThis.tab`` 永远是 undefined。
    """
    js = _bootstrap_src()
    short_circuit = js.index("__evoflowBrowserBootstrapped && typeof globalThis.browser")
    early_return = js.index("return;", short_circuit)
    segment = js[short_circuit:early_return]
    assert "globalThis.tab" in segment, (
        "短路分支（已 bootstrap 时）没有补 globalThis.tab 解析 —— "
        "该分支会先 return，新加的 tab 赋值永远走不到。"
    )


def test_bootstrap_is_syntactically_valid() -> None:
    """bootstrap 是 Python 原始串里的 JS，py_compile 零分辨力，必须过 node --check。"""
    _run_node("async function __w(){\n" + _bootstrap_src() + "\n}\nprocess.stdout.write('ok');")


def test_short_circuit_still_resolves_tab_at_runtime() -> None:
    """真跑一遍：模拟「已 bootstrap 但无 tab」，要求执行后 tab 变成 object。

    这是本文件的**行为**门禁（不是文本门禁）——本轮教训：
    文本上写了 ``globalThis.tab = t`` 不代表在短路路径上真的会执行。
    """
    js = _bootstrap_src()
    probe = (
        "globalThis.__evoflowBrowserBootstrapped = true;\n"
        "let got = null;\n"
        "globalThis.browser = {\n"
        "  bootstrap: () => {},\n"
        "  tabs: {\n"
        "    list: async () => [{ id: 'tab-0' }],\n"
        "    get: async (id) => ({ id, playwright: {} }),\n"
        "  },\n"
        "};\n"
        "await (async () => {\n" + js + "\n})();\n"
        "process.stdout.write(typeof globalThis.tab + ':' + (globalThis.tab && globalThis.tab.id));"
    )
    out = _run_node(probe)
    assert out == "object:tab-0", f"短路分支执行后 globalThis.tab = {out!r}（期望 object:tab-0）"


def test_guide_forbids_manual_bootstrap() -> None:
    """指南必须明确禁止手写 bootstrap —— 这是 12.3k tokens 浪费的唯一来源。"""
    guide = NODE_REPL_TOOL.read_text(encoding="utf-8")
    assert "Do NOT write bootstrap boilerplate" in guide, (
        "指南没有禁止手写 bootstrap 前言；107/308 次调用重复烧掉约 12.3k tokens 的直接原因就是它。"
    )
    # 旧的鼓励性措辞必须消失：它明确教模型「不确定时就手写一遍」。
    assert "Prefer still writing the bootstrap" not in guide, (
        "旧的「Prefer still writing the bootstrap for clarity when unsure」还在，"
        "与「禁止手写」自相矛盾。"
    )


def test_plugin_injection_hint_forbids_manual_bootstrap() -> None:
    """每轮注入的 ``<evoflow_browser_runtime>`` 提示也必须禁止手写 bootstrap。

    为什么单列：这段文本在 ``runtime.py`` 里、**每轮必然注入**，影响力比 compact guide 更大。
    第59轮我只改了 compact guide，注入提示仍在教「bootstrap + getForUrl + tabs.get」，
    两处自相矛盾 —— 模型当然会照旧的写。
    """
    src = (REPO / "backend" / "packages" / "harness" / "evoflow" / "plugins" / "runtime.py").read_text(
        encoding="utf-8"
    )
    assert "globalThis.tab" in src, "注入提示没有告诉模型 globalThis.tab 已就绪"
    assert "bootstrap + getForUrl" not in src, (
        "注入提示仍在教模型写 `bootstrap + getForUrl/... + tabs.get(\"tab-0\")` 前言；"
        "这与「宿主已注入 browser/tab」相矛盾，且每轮都注入，浪费按轮计。"
    )
    assert "Do NOT write bootstrap boilerplate" in src or "不要写 bootstrap 前言" in src, (
        "注入提示必须显式禁止写 bootstrap 前言（英文或中文其一）。"
    )
