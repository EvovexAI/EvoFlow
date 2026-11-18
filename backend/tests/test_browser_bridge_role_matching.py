"""Browser bridge locator matching — real node kernel + jsdom-free page stubs.

【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这个文件：桥的定位引擎（__MATCH_FN / __splitNth / __pickExpr）是塞在
Python 原始字符串里的 JavaScript，``py_compile`` 与 ruff 对它的语法和语义零分辨力。
本轮就靠它抓到过一次真错：正则写成 ``/\\\\s+/``（Python 原始串里多一层反斜杠），
py_compile 全绿、页面里 evaluate 直接抛 SyntaxError 返回 null。

判据（每条都对应现网实测到的缺陷）：
1. ``internal:role=heading`` 必须命中 h1..h6 —— 修复前 cn.bing.com 结果页
   h1..h6 共 13 个却返回 0，模型只能放弃语义定位退回猜 CSS。
2. ``input[type=search]`` 必须能被 ``searchbox`` 命中（修复前 0）。
3. ``li`` 必须能被 ``listitem`` 命中（修复前 0）。
4. ``name=/GitHub/i`` 正则必须参与比对（修复前被当字面量，恒 0）。
5. ``>> nth=N`` 必须按索引取一个，``nth=-1`` 取最后一个（修复前整串当选择器，恒 0）。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NODE_REPL = REPO / "backend" / "packages" / "harness" / "evoflow" / "plugins" / "node_repl.py"


def _extract_match_fn() -> str:
    src = NODE_REPL.read_text(encoding="utf-8")
    start = src.index("const __MATCH_FN = String.raw`")
    start = src.index("`", start) + 1
    # 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
    # 终止标记不能绑在「下一个变量名」上：后续在中间插了新块（__refOf），
    # 提取器立刻失效，10 条测试全红而代码其实没坏。用「行首两个空格 + 反引号 + 分号」定界。
    end = src.index("\n  `;\n", start)
    return src[start:end]


def _extract_nth_helpers() -> str:
    src = NODE_REPL.read_text(encoding="utf-8")
    start = src.index("const __splitNth = (sel) => {")
    # 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：收尾改用「下一个块的固定注释」而不是「__countExpr 之后第一个分号」。
    # 为什么：__countExpr 本轮从单行箭头函数改成多行块，旧收尾把它从中间截断，
    # 三条测试直接 SyntaxError —— 抽取器过于依赖被抽代码的字面形状，是它自己的缺陷。
    end = src.index("    // ── playwright 命令面", start)
    return src[start:end]


HARNESS_JS = """
// 最小页面桩：只实现 __MATCH_FN 依赖的 DOM 面
const rect = () => ({ width: 10, height: 10, left: 0, top: 0 });
const mkEl = (tag, attrs = {}, text = "") => {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    isContentEditable: false,
    value: attrs.value || "",
    innerText: text,
    textContent: text,
    __attrs: attrs,
    children: [],
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    getBoundingClientRect: rect,
    querySelector: () => null,
    scrollIntoView: () => {},
    getComputedStyle: undefined,
  };
  return el;
};

const PAGE = [
  mkEl("h1", {}, "标题一"),
  mkEl("h2", {}, "结果标题"),
  mkEl("h3", {}, "小标题"),
  mkEl("input", { type: "search", placeholder: "在此处输入", "aria-label": "搜索" }),
  mkEl("input", { type: "text", value: "" }, ""),
  mkEl("li", {}, "条目一"),
  mkEl("li", {}, "条目二"),
  mkEl("a", { href: "https://github.com/a" }, "Github"),
  mkEl("a", { href: "https://github.com/b" }, "GitHub 第二个"),
  mkEl("a", { href: "https://example.com" }, "Example"),
  mkEl("label", { for: "q" }, "搜索词"),
];

globalThis.document = {
  querySelectorAll: (sel) => {
    // __MATCH_FN 只用这一种：逗号分隔的标签/属性大列表
    const parts = sel.split(",").map((s) => s.trim());
    return PAGE.filter((el) => {
      const tag = el.tagName.toLowerCase();
      return parts.some((p) => {
        if (p.startsWith("[")) {
          const attr = p.slice(1, -1).split("=")[0];
          return el.hasAttribute(attr);
        }
        return p === tag;
      });
    });
  },
  querySelector: () => null,
  getElementById: () => null,
  evaluate: () => ({ snapshotLength: 0 }),
};
globalThis.getComputedStyle = () => ({ visibility: "visible", display: "block" });
globalThis.XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 0 };
globalThis.window = globalThis;
"""


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


def _count(selector: str) -> int:
    js = (
        HARNESS_JS
        + _extract_match_fn()
        + f"\nprocess.stdout.write(String(__evoMatch({json.dumps(selector)}).length));"
    )
    return int(_run_node(js))


def test_bridge_setup_js_is_syntactically_valid() -> None:
    """门禁盲区：_BRIDGE_SETUP_JS 是 Python 原始串里的 JS，py_compile/ruff 零分辨力。

    本轮两次踩到同一个坑：注释里写反引号（把模板串提前截断）、正则写成双反斜杠
    （Python 原始串里多一层）。两次 py_compile 都全绿，运行态 kernel 却直接抛
    ``Unexpected identifier``、页面 evaluate 返回 null。必须真的过 node --check。
    """
    src = NODE_REPL.read_text(encoding="utf-8")
    marker = '_BRIDGE_SETUP_JS = r"""'
    start = src.index(marker) + len(marker)
    end = src.index('"""', start)
    bridge_js = "async function __wrap(){\n" + src[start:end] + "\n}\n"
    path = REPO / "outputs" / "tmp" / "bridge_check.mjs"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(bridge_js, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["node", "--check", str(path)], capture_output=True, text=True, timeout=60
        )
        assert proc.returncode == 0, f"BRIDGE_SETUP_JS 语法错误:\n{proc.stderr}"
    finally:
        path.unlink(missing_ok=True)


def test_match_fn_is_valid_javascript() -> None:
    """第二道门：__MATCH_FN 单独也要能当 JS 解析（注入页面时它就是一段脚本）。"""
    _run_node(_extract_match_fn() + "\nprocess.stdout.write('ok');")


def test_match_fn_survives_template_literal_evaluation() -> None:
    """第三道门（第58轮新增）：必须走「模板字面量求值」这一步，而不是只读磁盘文本。

    【self-evolution-bot · 2026-11-18 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新开这条，专门抓 `__MATCH_FN` 被**普通**模板字面量吞掉反斜杠的缺陷。

    为什么（现网实测，本仓真实事故）：`__MATCH_FN` 里有 14 个反斜杠，
    例如 `s.match(/^\\/([\\s\\S]*)\\/([a-z]*)$/)`。用普通模板字面量拼接时
    `\\/` 被吃成 `/`、`\\s` 被吃成 `s`，运行态变成
    `s.match(/^/([sS]*)/([a-z]*)$/)` —— 整段 IIFE 直接 `Unexpected token ')'`。
    而 `Runtime.evaluate` 对「表达式自身语法错」只回 `ok:true, value:undefined`
    （不像页面抛错那样给 exceptionDetails），桥又把 undefined 当 0，
    于是 cn.bing.com 上 `querySelectorAll('a')=77` 而 `locator('a').count()` **恒为 0**。

    为什么旧门禁抓不到：`test_match_fn_is_valid_javascript` 直接拿**磁盘文本**去喂 node，
    磁盘文本一直是合法的；被破坏的是「模板求值之后的字符串」。判据必须放在求值之后。
    """
    src = _bridge_block()
    # 从声明处取「用什么字面量拼」这个事实，再按**同样的写法**在 node 里求值。
    # 这样门禁验的是运行态真实字符串，而不是磁盘文本（磁盘文本一直是合法的）。
    decl = src.index("const __MATCH_FN = ")
    open_tick = src.index("`", decl)
    decl_prefix = src[decl:open_tick + 1]
    body = src[open_tick + 1:src.index("\n  `;\n", open_tick)]
    is_raw = "String.raw" in decl_prefix
    escaped_body = body.replace("`", "\\`")

    tagged = "String.raw`" if is_raw else "`"
    probe = (
        "const runtime = " + tagged + escaped_body + "`;\n"
        "try { new Function('return (function(){' + runtime + '; return 1; })()'); }\n"
        "catch (e) { process.stdout.write('PARSE_FAIL:' + e.message); process.exit(3); }\n"
        "const bs = (runtime.match(/\\\\/g) || []).length;\n"
        "process.stdout.write('ok:len=' + runtime.length + ':backslashes=' + bs);"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", probe],
        capture_output=True, text=True, timeout=60, cwd=str(REPO),
    )
    out = f"{proc.stdout}{proc.stderr}".strip()
    # 1) 求值结果必须仍能被 JS 解析。这一条**独立**生效：即便声明形式被改回普通模板，
    #    也必须真的走一遍求值再 parse，才能证明「被吞掉的反斜杠会破坏页内表达式」。
    assert proc.returncode == 0 and out.startswith("ok:"), (
        f"模板求值后的字符串无法解析（这就是运行态真实事故）：{out}"
    )
    # 2) 反斜杠必须全部幸存：14 个是今天的真实数量。
    backslashes = int(out.rsplit("backslashes=", 1)[1])
    assert backslashes >= 14, (
        f"模板求值后只剩 {backslashes} 个反斜杠（应 ≥14）——反斜杠被吃掉，"
        "页内正则被破坏，count() 会静默变 0。"
    )
    # 3) String.raw 不做任何转义替换，求值后长度必须等于磁盘文本长度。
    evaluated_len = int(out.split("len=", 1)[1].split(":")[0])
    assert evaluated_len == len(body), (
        f"求值后长度 {evaluated_len} != 磁盘 {len(body)}，说明发生了转义替换"
    )
    # 4) 最后才断言声明形式：它是根因所在（前面三条是它造成的后果）。
    assert is_raw, (
        "`__MATCH_FN` 必须用 String.raw 模板字面量声明；"
        "普通 ` 会把正则里的 \\/ 吃成 /、\\s 吃成 s，页内表达式直接 SyntaxError，"
        "而引擎对表达式自身语法错只回 ok:true+value:undefined → count 静默变 0。"
    )


def test_heading_role_matches_h_tags() -> None:
    assert _count("internal:role=heading") == 3


def test_searchbox_role_matches_input_search() -> None:
    assert _count("internal:role=searchbox") == 1


def test_textbox_role_still_matches_plain_input() -> None:
    # searchbox 也属于 textbox 家族，避免修复把旧的 textbox 调用打成 0
    assert _count("internal:role=textbox") == 2


def test_listitem_role_matches_li() -> None:
    assert _count("internal:role=listitem") == 2


def test_role_name_regex_is_honored() -> None:
    # 修复前：正则在桥里被当字面量，`/github/i` 匹配不到 "Github"
    assert _count("internal:role=link[name=/github/i]") == 2


def test_role_name_string_is_case_insensitive() -> None:
    assert _count('internal:role=link[name="github"i]') == 2


def test_role_name_exact_still_works() -> None:
    assert _count('internal:role=link[name="Github"s]') == 1


def test_placeholder_selector_is_implemented() -> None:
    # 修复前：internal:attr 直接抛「暂未实现」
    assert _count('internal:attr=[placeholder="在此处输入"i]') == 1


def test_nth_suffix_picks_index() -> None:
    js = (
        HARNESS_JS
        + _extract_match_fn()
        + _extract_nth_helpers()
        + """
const pick = (sel) => { const all = eval(__pickExpr(sel)); return Array.isArray(all) ? all.map(e => e.innerText) : []; };
process.stdout.write(JSON.stringify({
  nth0: pick('internal:role=link[name="github"i] >> nth=0'),
  nth1: pick('internal:role=link[name="github"i] >> nth=1'),
  last: pick('internal:role=heading >> nth=-1'),
  outOfRange: pick('internal:role=heading >> nth=9'),
  total: eval(__countExpr('internal:role=link[name="github"i] >> nth=0')),
}));
"""
    )
    out = json.loads(_run_node(js))
    assert out["nth0"] == ["Github"]
    assert out["nth1"] == ["GitHub 第二个"]
    assert out["last"] == ["小标题"]
    assert out["outOfRange"] == []
    # 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
    # 更正：上一轮这里断言 total==2（即 count 忽略 nth），那是我把自己的 bug 写成了判据。
    # Playwright 契约是 ``locator('a').nth(0).count() === 1`` —— count 数的是**收窄后**的集合。
    # 现网复算证据：磁盘版修前 `... >> nth=0` 的 count 返回 5（真值应为 1），
    # 于是模型无法确认「我取的到底是第几个」，只能再 count 一次全量、再猜，形成反复。
    assert out["total"] == 1


def test_wait_for_load_state_has_no_unconditional_settle() -> None:
    """判据：已达成目标态时不得再补眠。修复前恒 500ms（现网实测 534~694ms）。"""
    src = NODE_REPL.read_text(encoding="utf-8")
    start = src.index('if (an === "waitForLoadState") {')
    end = src.index('if (an === "waitForURL") {', start)
    block = src[start:end]
    assert "settled=immediate" in block, "已达成分支必须直接返回"
    assert "document.readyState" in block, "轮询要有页内探针兜底"
    # 修复前的写法：settleMs 无条件 500
    assert "state === \"networkidle\" ? 1200 : 500" not in block


# 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
# 为什么新开这两条：上一轮 12 条测试全绿，但重启后现网 locator("a").count() 仍是 0
# （页内 querySelectorAll('a') 真值 66），heading/list/link 全 0 —— 比修复前更糟。
# 根因：__pickExpr/__countExpr 是 **Node 侧**的表达式生成器，我把它写进了「页面内执行」
# 的模板字符串，页面里必然抛 ReferenceError；count 又用 Number(r.value)||0 吞成 0，
# 于是「真坏了」与「真的没有」在模型侧长得一模一样。
# 教训：测试只覆盖了 __MATCH_FN 在页面内的行为，完全没覆盖「生成器 → 页面表达式」这条接线。
# 这两条门禁补的就是接线：静态查未插值引用 + 动态跑两段式组装。


def test_no_node_side_generator_leaks_into_page_expression() -> None:
    """接线门禁：页面侧表达式里不许出现只在 Node 侧存在的标识符。

    ``expression:`` 模板是在 Node 里拼好的字符串，``${...}`` 之外的内容会原样进页面。
    ``__pickExpr`` / ``__countExpr`` / ``__splitNth`` 都是 Node 侧函数，
    出现在模板里就是 ReferenceError —— 而它会被 ``Number(x)||0`` 吞成 0，静默通过一切语法检查。

    判据只扫 ``expression:`` 后面那段模板字面量，不扫整个 ``__pwHandle``：
    否则 ``const pickExprJs = __pickExpr(sel)`` 这种 Node 侧合法调用会被误判（本节第54轮实测误报）。
    """
    src = NODE_REPL.read_text(encoding="utf-8")
    start = src.index("const __pwHandle = async (cmd) => {")
    end = src.index("globalThis[__evoflowBridgeSymbol]", start)
    block = src[start:end]

    regions = []
    cursor = 0
    while True:
        i = block.find("expression: `", cursor)
        if i < 0:
            break
        j = i + len("expression: `")
        # 模板字面量里没有嵌套反引号（已人工确认），扫到下一个反引号即可
        k = block.index("`", j)
        regions.append(block[j:k])
        cursor = k + 1

    assert regions, "没抓到任何 expression 模板，判据失效"
    assert any("__MATCH_FN" in r for r in regions), "抓到的区域不像真表达式，判据失效"

    leaked = []
    for r in regions:
        for name in ("__pickExpr", "__countExpr", "__splitNth"):
            if name + "(" in r:
                leaked.append(f"{name} 泄漏进页面表达式: {r.strip()[:140]}")
    assert not leaked, "\n".join(leaked)


def test_count_expression_is_two_stage_composed() -> None:
    """动态接线：按桥里的真实两段式组装，页面侧只该看到最终表达式。"""
    js = (
        HARNESS_JS
        + _extract_match_fn()
        + _extract_nth_helpers()
        + """
const cases = ['internal:role=link[name="github"i]', 'internal:role=heading'];
const out = {};
for (const sel of cases) {
  const countExprJs = __countExpr(sel);
  // 这一步等价于桥里 `(function(){${__MATCH_FN}; return ${countExprJs}; })()` 拼出来的串
  const pageExpr = `(function(){ ${__MATCH_FN_BODY_PLACEHOLDER} return ${countExprJs}; })()`;
  out[sel] = pageExpr.includes('__countExpr(') ? 'LEAKED' : eval(pageExpr);
}
process.stdout.write(JSON.stringify(out));
"""
    )
    # 页面表达式不需要再注入 __MATCH_FN 源码（桩里已 eval 过同一份），用空串代替
    js = js.replace("${__MATCH_FN_BODY_PLACEHOLDER}", "")
    out = json.loads(_run_node(js))
    assert out['internal:role=link[name="github"i]'] == 2
    assert out["internal:role=heading"] == 3
    for v in out.values():
        assert v != "LEAKED", "生成器裸调用泄漏进页面表达式"


# 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
# 本轮第二批判据：这几条守的是「假成功」——桥对模型说「做到了」，其实没做。
# 假成功比报错恶劣得多：报错模型会改一次写法；假成功会让模型以为页面就绪、动作生效，
# 于是在同一个动作上反复重试。每条都对应我在源码里逐行读到的确凿写法。


def _bridge_block() -> str:
    src = NODE_REPL.read_text(encoding="utf-8")
    return src


def test_getattribute_reads_attribute_not_action_name() -> None:
    """``locator(a).getAttribute("href")`` 必须取 href。

    上游把动作名放在 ``act.name``（值恒为 ``"getAttribute"``），属性名在 ``act.attribute``。
    原写法 ``act.attribute || act.name`` 顺序反了，于是实际取的是名为 "getAttribute" 的属性
    → 恒返回 null，模型只能改用 evaluate 重查一遍。
    """
    src = _bridge_block()
    start = src.index('if (an === "getAttribute") {')
    end = src.index('if (an === "isVisible"', start)
    block = src[start:end]
    assert 'act.attribute' in block, "必须读 act.attribute"
    assert "act.name || act.attribute" not in block, "顺序反了：act.name 恒真，会把属性名挤掉"


def test_waitfor_is_not_a_noop() -> None:
    """``locator.waitFor({state})`` 不能直接 return true。

    原实现 ``return { ok: true, value: true }`` —— 一毫秒都不等，就告诉模型「等到了」。
    模型据此立刻去点，点不到再重试。
    """
    src = _bridge_block()
    start = src.index('if (an === "waitFor") {')
    end = src.index("return { ok: false, error: { code: \"unsupported\"", start)
    block = src[start:end]
    assert "while (Date.now() < deadline)" in block, "必须有真实轮询"
    assert 'want === "attached"' in block and 'want === "hidden"' in block, "state 语义要实现"
    assert "ok: true, value: true }" != block.strip().splitlines()[-2].strip()


def test_waitforurl_does_not_alway_report_success() -> None:
    """``waitForURL`` 等不到目标 URL 必须报错。

    原实现固定循环 10×300ms 后**无条件** ``return ok:true``：即使 URL 根本没变也报成功。
    """
    src = _bridge_block()
    start = src.index('if (an === "waitForURL") {')
    end = src.index('if (an === "evaluate") {', start)
    block = src[start:end]
    assert "location.href" in block, "用页面内真实 href 判定"
    assert 'code: "timeout"' in block, "超时必须报错，不能装成功"
    assert block.count("return { ok: true, value: true };") <= 1


def test_networkidle_is_not_an_alias_of_load() -> None:
    """``networkidle`` 不能等于 ``load``。

    原 ``satisfied()`` 里 ``state === "networkidle"`` 分支直接返回 ``ready === "complete"``，
    与 load 完全同义。调用方要 networkidle 恰恰是想等动态内容静下来，语义必须不同。
    """
    src = _bridge_block()
    start = src.index('if (an === "waitForLoadState") {')
    end = src.index('if (an === "waitForURL") {', start)
    block = src[start:end]
    assert "performance.getEntriesByType" in block, "networkidle 必须看资源活动"
    assert "stableSince" in block, "要有稳定窗口判定"
    # 关键：satisfied() 内部不许再给 networkidle 开 complete 的直通分支
    sat = block[block.index("const satisfied ="):block.index("let lastReady")]
    assert "networkidle" not in sat, "satisfied() 内不应再有 networkidle 的等价分支"


def test_press_focuses_target_before_dispatching() -> None:
    """``locator(x).press(k)`` 必须先聚焦 x。

    Playwright 语义是「聚焦该元素再按键」。原实现直接转发 key，落在**残留焦点**上：
    刚 fill 过 A，再对 B 按 Enter，回车其实发给了 A —— 页面没反应，模型以为定位错、换写法重试。
    """
    src = _bridge_block()
    start = src.index('if (an === "press") {')
    end = src.index('if (an === "selectOption") {', start)
    block = src[start:end]
    assert ".focus()" in block, "press 前必须聚焦命中元素"
    assert "activeElement" in block, "聚焦要可验证（否则又是假成功）"


def test_wait_for_load_state_timeout_is_honest_and_bounded() -> None:
    """``waitForLoadState`` 的默认预算与超时语义必须如实。

    【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
    为什么新开这条：第54轮我只把「已达成态」改成立即返回，却漏了另一头 ——
    现网实测 github.com 在 IAB 里 goto 1474ms 返回后，12 秒仍停在 ``readyState=interactive``
    （146 个锚点，页面早已可用）；一次**不带 timeout** 的 ``waitForLoadState()``
    实测 **20163ms 打满预算**，然后照样回 ``ok:true``。等于每次白白烧 20 秒，
    还拿到一个谎报的成功口径。

    判据两条（缺一条都修不完整）：
    1. 默认预算要跟插件自带口径一致（``routine URL/load-state waits remain capped at 3000ms``），
       不许再是 15000；
    2. 等不到目标态必须报 ``timeout`` 并带当前 readyState，且明确告诉模型「SPA 可能永远到不了 load，
       别再等」—— 只报错不给下一步，模型只会原样重试。
    """
    src = _bridge_block()
    start = src.index('if (an === "waitForLoadState") {')
    end = src.index('if (an === "waitForURL") {', start)
    block = src[start:end]

    assert "|| 15000" not in block, "默认预算不许再是 15000ms（实测打满 20s）"
    assert "|| 3000" in block, "默认预算应与插件口径 3000ms 一致"

    tail = block[block.index("settleMs ="):]
    assert 'code: "timeout"' in tail, "等不到目标态必须报 timeout，不许装成功"
    assert "readyState=" in tail, "报错要带当前 readyState 供模型判断"
    assert "不要再重复等" in tail, "SPA 到不了 load 时要说清下一步，否则模型只会原样重试"
    # 旧写法：超时分支同样 return ok:true —— 与真实失败不可区分。
    # 判据落在「settle 之后的收尾段」，别再拿整块里的 immediate 分支当参照
    # （本节第57轮实测：写成 `in block` 会永远为真，等于没断言）。
    assert "{ ok: true" not in tail, "超时收尾段不许再出现无条件 ok:true"


def test_css_engine_prefix_is_stripped() -> None:
    """``css=`` 前缀必须被剥掉再交给 querySelectorAll。

    【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
    为什么新开这条：browser-client 会把普通字符串选择器编码成 `css=a` 传进桥
    （桥日志实测 `mode=css sel=a`）。`__evoMatch` 有 xpath=/internal:*/text=/has-text= 等分支，
    **唯独没有 css= 分支**，于是直接落到 `querySelectorAll("css=a")` —— 非法 CSS 抛错，
    被末尾 `catch (e) { return [] }` 吞成空数组。现网后果（实测）：
    页内 `__evoMatch("a")` = 66、同一条表达式走引擎直调 = 66，
    但 `pg.locator("a").count()` = **0**；连 `a:::bogus(((` 这种非法选择器也静默返 0，
    「真坏了」与「真的没有」模型分不出来，只能反复换写法 —— 这就是反复的直接来源。
    """
    src = _bridge_block()
    key = "const __MATCH_FN = String.raw`"
    s0 = src.index(key) + len(key)
    body = src[s0:src.index("`", s0)]
    # 判据：剥离分支存在，且在 >> 串联分支之后（避免绕过 nth 串联处理）
    assert 'sel.startsWith("css=")' in body, "必须剥 css= 前缀，否则 querySelectorAll 直接抛错"
    assert body.index('sel.startsWith("css=")') > body.index('sel.includes(">>")'), \
        "剥离必须放在 >> 串联分支之后"
    # 反向判据：不许把 css= 直接喂给 querySelectorAll
    assert "querySelectorAll(sel)" in body
    assert "sel.slice(4).trim()" in body, "要真剥前缀，不是只加注释"


def test_match_fn_has_no_template_interpolation_and_single_backtick() -> None:
    """``__MATCH_FN`` 里不许出现 ``${`` 或多余反引号。

    【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
    本节第57轮现场撞到：我在注释里写了带反引号的 `css=` 字样，模板字面量被**提前闭合**，
    提取长度从 13652 掉到 12631，语法门禁立刻 red。这类缺陷 py_compile 完全看不见。
    """
    src = _bridge_block()
    key = "const __MATCH_FN = String.raw`"
    s0 = src.index(key) + len(key)
    end = src.index("`", s0)
    body = src[s0:end]
    assert "${" not in body, "__MATCH_FN 是模板字面量，内含 ${ 会被当插值解析"
    assert len(body) > 12000, f"提取过早截断（{len(body)}），多半是注释里混进了反引号"


def test_invalid_css_raises_instead_of_silently_returning_zero() -> None:
    """非法 CSS 必须抛错，不许被吞成空数组（=count 0）。

    【self-evolution-bot · 2026-11-18 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
    为什么新开这条：``__evoMatch`` 末尾原本两处 ``catch (e) { return []; }``，
    页内 ``document.querySelectorAll("a:::bogus(((")`` 实测抛 SyntaxError，
    但被这两行吞成 ``[]``，于是 ``locator("a:::bogus(((").count()`` 返回 **0**。
    模型看到 0 只会以为「选择器对、页面没这东西」，于是换写法再试 —— 这正是"反复"的来源。
    判据：**语法非法 ≠ 命中为零**，前者要改选择器，后者要换策略。

    反向验证：把 ``catch (e) { return []; }`` 加回末尾兜底 → 本条必红。
    """
    src = _bridge_block()
    key = "const __MATCH_FN = String.raw`"
    s0 = src.index(key) + len(key)
    body = src[s0:src.index("`", s0)]
    # 兜底段（css= 分支 + 最终 return）里不许再出现吞错
    tail = body[body.index('if (sel.startsWith("css="))'):]
    assert "catch (e) { return []; }" not in tail, \
        "CSS 兜底不许 catch 成空数组：非法选择器会被伪装成「命中 0 个」"
    assert 'querySelectorAll(sel.slice(4).trim())' in tail, "css= 分支要直接抛，不包 try"
    assert "return Array.from(document.querySelectorAll(sel));" in tail, "最终兜底要直接抛，不包 try"
