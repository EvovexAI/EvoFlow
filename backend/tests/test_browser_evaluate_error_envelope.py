"""evaluate 统一异常信封：页内异常不许逃逸成 16 秒超时。

【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这组测试：重启后实测同一个非法选择器
- example.com 780ms、bing 864ms 就报真实错误
- github.com 稳定卡 16049ms / 16183ms 才报 `embed HTTP bridge timed out waiting for guest poll`
连测三次共 48 秒全白等。该站点钳断了页内异常的回传通道，宿主只能等兜底超时。

修法：在**唯一的 engine 入口**给所有 `method:"evaluate"` 表达式套一层 try/catch，
页内异常变成正常返回值 `{__evoEvalErr}`，再由同一入口拆封成 `{ok:false,error}`。
这样 17 个 evaluate 调用点一个都不用改，且不依赖异常回传通道。

判据（本文件断言）：正常值必须原样透传（不许被信封篡改），异常必须立刻变成 ok:false。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
NODE_REPL = REPO / "packages" / "harness" / "evoflow" / "plugins" / "node_repl.py"


def _source() -> str:
    return NODE_REPL.read_text(encoding="utf-8")


def _wrap_eval_source() -> str:
    src = _source()
    start = src.index("const __wrapEval = (command) => {")
    end = src.index("const engine = (command) => __gwFetch", start)
    return src[start:end].strip()


def _run_node(script: str) -> str:
    import os
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False, encoding="utf-8") as fh:
        fh.write(script)
        path = fh.name
    try:
        proc = subprocess.run(
            ["node", path],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=60,
            shell=False,
        )
        assert proc.returncode == 0, f"node failed: {proc.stderr[:800]}"
        return proc.stdout
    finally:
        os.unlink(path)


HARNESS = r"""
const fs = require('fs');
const src = fs.readFileSync(%s, 'utf8');
const a = src.indexOf('const __wrapEval = (command) => {');
const b = src.indexOf('const engine = (command) => __gwFetch', a);
const wrapSrc = src.slice(a, b).trim();
const __wrapEval = eval('(' + wrapSrc.replace('const __wrapEval = ', '').replace(/;\s*$/, '') + ')');

const unwrap = (r) => {
  const v = r && r.value;
  if (v && typeof v === 'object' && typeof v.__evoEvalErr === 'string') {
    return { ok: false, error: { code: 'execution_error', message: '页面内执行失败：' + v.__evoEvalErr.slice(0,300) } };
  }
  if (v && typeof v === 'object' && v.__evoEvalOk === 1) {
    return Object.assign({}, r, { value: v.v === undefined ? null : v.v });
  }
  return r;
};
// 宿主语义复刻：只有 awaitPromise:true 时宿主才会 await 返回值；之后一律过 JSON 边界
// （真实链路是 Runtime.evaluate → JSON → 桥），Promise 一旦没被 await，JSON 后就是 {}。
const runEngine = async (cmd) => {
  const wrapped = __wrapEval(cmd);
  if (wrapped.method !== 'evaluate') return { ok: true, value: 'RAW' };
  try {
    const fn = new Function('return ' + wrapped.expression);
    let v = fn();
    if (cmd.awaitPromise) v = await v;
    if (v === undefined) v = null;
    return { ok: true, value: JSON.parse(JSON.stringify(v)) };
  } catch (e) {
    return { ok: false, error: { message: 'TIMEOUT_WOULD_HAVE_HAPPENED' } };
  }
};
globalThis.document = { querySelectorAll(){ throw new SyntaxError("'!!bad' is not a valid selector"); } };

(async () => {
  const cases = %s;
  const out = {};
  for (const [name, cmd] of cases) { out[name] = unwrap(await runEngine(cmd)); }
  console.log(JSON.stringify(out));
})();
"""


def _run_cases(cases: list[tuple[str, dict]]) -> dict:
    literal = json.dumps(cases, ensure_ascii=False)
    script = HARNESS % (json.dumps(str(NODE_REPL).replace("\\", "/")), literal)
    return json.loads(_run_node(script).strip().splitlines()[-1])


def test_normal_values_pass_through_unchanged():
    """正常值必须原样透传——信封不许篡改任何合法结果。"""
    out = _run_cases([
        ["num", {"method": "evaluate", "expression": "1+1"}],
        ["nil", {"method": "evaluate", "expression": "null"}],
        ["str", {"method": "evaluate", "expression": '"hello"'}],
        ["arr", {"method": "evaluate", "expression": "[1,2,3]"}],
        ["bool", {"method": "evaluate", "expression": "false"}],
        ["zero", {"method": "evaluate", "expression": "0"}],
    ])
    assert out["num"] == {"ok": True, "value": 2}
    assert out["nil"] == {"ok": True, "value": None}
    assert out["str"] == {"ok": True, "value": "hello"}
    assert out["arr"] == {"ok": True, "value": [1, 2, 3]}
    assert out["bool"] == {"ok": True, "value": False}
    assert out["zero"] == {"ok": True, "value": 0}, "0 是最要紧的边界：不许被当成假值丢掉"


def test_page_exception_becomes_ok_false_not_timeout():
    """页内异常必须立刻变成 ok:false，且原因可见——不许退化成超时。"""
    out = _run_cases([
        ["syntax", {"method": "evaluate", "expression": 'document.querySelectorAll("!!bad").length'}],
        ["ref", {"method": "evaluate", "expression": "notDefinedAnywhere.foo"}],
    ])
    for key in ("syntax", "ref"):
        assert out[key]["ok"] is False, f"{key} 必须 ok:false"
        msg = out[key]["error"]["message"]
        assert "TIMEOUT_WOULD_HAVE_HAPPENED" not in msg, "异常逃逸了，会退化成 16 秒超时"
        assert "页面内执行失败" in msg
    assert "not a valid selector" in out["syntax"]["error"]["message"]
    assert "not defined" in out["ref"]["error"]["message"]


def test_non_evaluate_commands_are_untouched():
    """snapshot / click 等命令不许被包装，否则会改变线格式。"""
    out = _run_cases([["snap", {"method": "snapshot"}]])
    assert out["snap"]["value"] == "RAW"


def test_already_wrapped_expression_not_double_wrapped():
    """已含 __evoEvalErr 的表达式不再套第二层（避免嵌套信封）。"""
    src = _wrap_eval_source()
    assert 'indexOf("__evoEvalErr")' in src


def test_trailing_line_comment_does_not_swallow_wrapper():
    """表达式以行尾 `//` 注释结束时，包装不许被注释吞掉。

    【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
    为什么：`v: (" + expr + ")` 这种单行拼接，遇到 `expr` 尾部是 `// 说明` 就会把
    收尾的 `) }; }` 整段注释掉，包装体变成语法错误——而语法错误在 Runtime.evaluate
    里是「ok:true + value:undefined」的老坑。拼接处前后各留一个换行即整类消除。
    """
    out = _run_cases([
        ["trailing_comment", {"method": "evaluate", "expression": "1+1 // 注释在行尾"}],
        ["multi_line_comment", {"method": "evaluate", "expression": "6 * 7\n// 尾注"}],
    ])
    assert out["trailing_comment"] == {"ok": True, "value": 2}, out["trailing_comment"]
    assert out["multi_line_comment"] == {"ok": True, "value": 42}, out["multi_line_comment"]


def test_engine_is_the_single_unwrap_point():
    """解封必须在 engine 唯一入口完成，17 个调用点才不用逐个改。"""
    src = _source()
    assert "command: __wrapEval(command)" in src
    idx = src.index("const engine = (command) => __gwFetch")
    tail = src[idx : idx + 2200]
    assert "__evoEvalErr" in tail, "engine 入口必须拆信封"
    assert "__evoEvalOk" in tail


def test_await_promise_expression_keeps_its_value():
    """`awaitPromise:true` 的表达式必须仍然拿到真值，不能被信封吞成 {}。

    【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
    为什么单列一条：第一版 __wrapEval 一律用**同步** IIFE 包装。
    宿主在 awaitPromise:true 下只会 await 到「外层普通对象」，里面那个 Promise
    不会被 await，JSON 后成 `{}`。playwright.evaluate 那条路径恒为 awaitPromise:true，
    于是 async 页面函数从「拿到结果」退化成「拿到 {}」—— 我改信封时亲手引入的回归。
    判据：同一个表达式，awaitPromise:true 必须返回 42；不带该标志时返回 Promise 本身（本轮不测）。
    """
    out = _run_cases([
        ["async_fn", {"method": "evaluate", "awaitPromise": True,
                      "expression": "(async () => 42)()"}],
        ["async_await_page", {"method": "evaluate", "awaitPromise": True,
                              "expression": "(async () => { await null; return 'ok-1'; })()"}],
        ["async_throws", {"method": "evaluate", "awaitPromise": True,
                          "expression": "(async () => { throw new Error('boom-async'); })()"}],
    ])
    assert out["async_fn"] == {"ok": True, "value": 42}, f"awaitPromise 路径丢了值：{out['async_fn']}"
    assert out["async_await_page"]["value"] == "ok-1"
    assert out["async_throws"]["ok"] is False, "async 页内异常也必须变成 ok:false"
    assert "页面内执行失败" in out["async_throws"]["error"]["message"]
    assert "boom-async" in out["async_throws"]["error"]["message"]
