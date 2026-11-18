"""EvoFlow host for the ZCode ``node_repl`` kernel (Browser Use / Computer Use).

The official plugins' skills (``control-browser`` / ``computer-use``) hard-require
a ``mcp__node_repl__js`` tool that executes JavaScript inside the node-repl-host
kernel, where the Browser Use and Computer Use bridges live. The host speaks the
MCP "modern era" protocol (2026-07-28) which the Python MCP SDK cannot yet
negotiate, so this module drives it with raw JSON-RPC over stdio, carrying the
required ``_meta`` envelope on every message.

The tool is registered only when one of the dependent plugins is installed and
enabled, and the host runtime exists in the plugin cache.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _ulog(message: str) -> None:
    """统一浏览器/插件调试日志（logs/plugin-control.log，三端汇聚）。"""
    try:
        from evoflow.tools.builtins.browser_debug_log import browser_debug_log

        browser_debug_log("py", f"[node-repl] {message}")
    except Exception:
        pass

_NODE_REPL_HOST_PLUGIN = "node-repl-host"
_BROWSER_USE_PLUGIN = "browser-use"
_COMPUTER_USE_PLUGIN = "computer-use"
_NODE_REPL_SERVER_REL = "dist/mcp/server.js"
_PROTOCOL_VERSION = "2026-07-28"
_META_KEY = "io.modelcontextprotocol/protocolVersion"
_CALL_TIMEOUT_SEC = 130

# ---------------------------------------------------------------------------
# 浏览器桥（browser-use 插件 control-browser 技能的执行底座）
# 契约：node-repl-host/src/runtime-bridge.ts —
#   globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")] =
#     { list(): BrowserInfo[]; execute(browserId, generation, command): CommandResult;
#       documentationRoot: string; assertAvailable(): void }
# 命令词表 = ZCode browser command contract（EvoFlow browser_engine 原生支持）。
# ---------------------------------------------------------------------------

_BRIDGE_SETUP_JS = r"""
const __evoflowBridgeSymbol = Symbol.for("zcode.node-repl.browser-control-bridge");
{
  // 无条件覆盖：宿主自带的桥依赖 ZCode 桌面 broker（无桌面即不可用），
  // EvoFlow 平台桥是本环境权威 provider，必须接管该全局。
  // Prefer full Gateway URL (packaged desktop uses dynamic ports, not :8070).
  const __gwBaseExplicit = (process.env.EVOFLOW_GATEWAY_URL || "").replace(/\/+$/, "");
  const __gwPort = process.env.EVOFLOW_GATEWAY_PORT || "8070";
  const __gwBase = __gwBaseExplicit || `http://127.0.0.1:${__gwPort}`;
  // 浏览器/CUA 命令面共享令牌：网关 _bridge_token_guard 强制校验（缺头/不匹配 → 403）。
  const __bridgeToken = process.env.EVOFLOW_BROWSER_BRIDGE_TOKEN || "";
  // 内核 worker 是受限环境：无全局 fetch，只能用 node:* 内置模块。
  const __gwFetch = async (path, init) => {
    const http = await import("node:http");
    const body = init?.body ?? null;
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        `${__gwBase}${path}`,
        {
          method: init?.method || (body ? "POST" : "GET"),
          headers: {
            "Content-Type": "application/json",
            "X-EvoFlow-Bridge-Token": __bridgeToken,
            ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
            ...(init?.headers || {}),
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, text: data }));
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`EvoFlow browser bridge HTTP ${result.status}: ${result.text.slice(0, 300)}`);
    }
    return JSON.parse(result.text);
  };
  const __docsRoot = process.env.EVOFLOW_BROWSER_DOCS_ROOT || "";
  const __unavailable = (detail) => {
    throw new Error(
      "Browser runtime bridge is unavailable: EvoFlow Gateway browser service unreachable" +
      (detail ? ` (${detail})` : ""),
    );
  };
  // 探测带重试：网关重启窗口/端口双绑定切换时会偶发 403/404/ECONNREFUSED，
  // 单次探测就把整个 MCP 首调打死。3 次 × 250ms 退避，并把最后一次的
  // 真实状态带回给调用方（统一日志也能看到原因）。
  const __probe = async (path) => {
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await __gwFetch(path);
      } catch (err) {
        lastErr = String((err && err.message) || err).slice(0, 200);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }
    __unavailable(`${lastErr} (gw=${__gwBase}, 3 attempts)`);
  };
  const __assert = async () => {
    const info = await __probe("/api/browser/transport");
    const transport = (info && info.transport) || "unknown";
    // 用户要求：只驱动客户端内置浏览器面板（webview2）；系统 Edge 回退不可接受。
    if (transport !== "webview2") {
      throw new Error(
        `EvoFlow 内置浏览器面板（WebView2）当前不可用，桌面端已回退到系统 Edge（transport=${transport}）。` +
        "按平台要求不驱动 Edge——请在 EvoFlow 桌面端重启应用以恢复内置浏览器面板，然后重试。",
      );
    }
  };
  // facade 命令 → EvoFlow engine 命令映射（显式白名单，未列出即结构化报错）
  const __direct = new Set([
    "navigate", "back", "forward", "reload", "snapshot", "click", "fill", "type",
    "press", "scroll", "hover", "select", "check", "drag", "screenshot",
    "getState", "elementInfo", "evaluate", "waitFor", "close", "list",
  ]);
  const __map = {
    browserViewportSet: (command) => ({ method: "viewportSet", width: command.width, height: command.height }),
    // Skill / open() 先 tabs.new() 再 goto(url)。无 url 的 newTab 不能映射成 navigate，
    // 否则引擎报 "navigate requires url"，open()/new()+goto 全挂。单 WebView：无 url → getState。
    newTab: (command) => {
      const u = command && (command.url || command.href);
      if (typeof u === "string" && u.trim()) return { method: "navigate", url: u.trim() };
      if (u && typeof u === "object") {
        const nested = u.url || u.href || u.uri;
        if (nested) return { method: "navigate", url: String(nested) };
      }
      return { method: "getState" };
    },
    activateTab: () => ({ method: "getState" }),
    claimTab: (command, browserId) => ({
      method: "getState",
      tabId: "primary",
      __tab: { id: "primary", tabId: "primary", url: "", title: "EvoFlow WebView", viewport: { width: 1280, height: 720 }, active: true, lifecycle: "active" },
    }),
    getDialog: () => ({ method: "getState", __dialog: null }),
    handleDialog: (command) => ({ method: "getState", __dialog: null }),
  };
  const __unsupported = (name, cmd) => ({
    ok: false,
    error: { code: "unsupported", message: `EvoFlow browser bridge v1 不支持命令: ${name}（收到: ${JSON.stringify(cmd || {}).slice(0, 200)}；录屏/桌面控制属后续平台集成）`, sideEffect: "none" },
  });
  // ZCode 运行时契约：每个浏览器命令结果都必须带 tab 摘要（BrowsersFacade 的
  // expectPayload(result.tab)），缺了直接抛 "Browser result missing tab"。
  // 单 webview 模型：永远附加 primary tab，字段优先取引擎回传的 state。
  const __attachTab = (result) => {
    try {
      if (!result || typeof result !== "object" || result.tab) return result;
      const st = result.state || {};
      result.tab = {
        id: "primary",
        tabId: "primary",
        active: true,
        lifecycle: "active",
        url: st.url || "",
        title: st.title || "",
        viewport: st.viewport || { width: 1280, height: 720 },
      };
    } catch {}
    return result;
  };
  // 插件运行时的本地命令（无需引擎）：结果直接在桥内合成。
  const __local = {
    listUserTabs: () => ({ ok: true, userTabs: [] }),
    finalizeTabs: () => ({ ok: true }),
  };
  // 命令日志：每次浏览器命令的 method/url/结果状态，供工具结果回传给模型与排查
  globalThis.__evoflowBrowserLog = [];
  const __logCmd = (entry) => {
    try {
      globalThis.__evoflowBrowserLog.push({ ts: Date.now(), ...entry });
      if (globalThis.__evoflowBrowserLog.length > 50) globalThis.__evoflowBrowserLog.shift();
    } catch {}
  };
  // Kernel diagnostics → logs/plugin-control.log (source=kernel).
  const __bridgeLog = async (msg) => {
    try {
      await __gwFetch("/api/browser/log", {
        method: "POST",
        body: JSON.stringify({ source: "kernel", entries: [{ msg: String(msg).slice(0, 1800) }] }),
      });
    } catch {}
  };
  // 页内定位：CSS / xpath / Playwright internal:role|text。返回 Element[] 的函数源码。
  // 【self-evolution-bot · 2026-11-18 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：普通模板字面量 → String.raw 模板。
  // 为什么：这段源码里有 14 个反斜杠（正则 `/^\\/([\\s\\S]*)\\/([a-z]*)$/` 等）。普通模板字面量
  // 会把 `\/` 吃成 `/`、`\s` 吃成 `s`，拼出来的页内表达式变成 `s.match(/^/([sS]*)/([a-z]*)$/)`
  // —— 整段 IIFE 直接 Unexpected token ')'。而 Runtime.evaluate 在「表达式本身语法错」时报
  // ok:true + value=undefined（不像页面抛错那样给 exceptionDetails），于是桥把 undefined 当 0：
  // 现网实测页面 querySelectorAll('a')=77 而 locator('a').count() 恒为 0，模型据此反复重试。
  // 用 String.raw 后反斜杠原样保留（13518 字符整段可 parse），实测 count('a')=77。
  const __MATCH_FN = String.raw`
    function __evoMatch(sel) {
      sel = String(sel || "");
      const visible = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none";
      };
      const nameOf = (el) => String(
        el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title")
        || (el.innerText || el.value || "")
      ).trim();
      // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 parseMatcher/matchValue，统一解析 Playwright 传给桥的 matcher 串。
      // 为什么：桥原先把 name 的 "Github"i 后缀当字面量比对，于是 getByRole("link",{name:/GitHub/i})
      // 这种正则形式实测 count=0（真值 5）——正则被当普通文本，静默匹配不到任何元素。
      // 约定：JSON 字符串 + 后缀 s=精确 / i=不区分大小写；斜杠包裹的 /re/flags 形式按正则。
      const parseMatcher = (raw) => {
        let s = String(raw == null ? "" : raw);
        const m = s.match(/^\/([\s\S]*)\/([a-z]*)$/);
        if (m) {
          try { return { re: new RegExp(m[1], m[2].replace(/[^gimsuy]/g, "")), exact: false, text: s }; }
          catch (e) { /* 落到字面量 */ }
        }
        let exact = false;
        const flag = s.slice(-1);
        let literal = s;
        if (flag === "s" || flag === "i") { exact = flag === "s"; literal = s.slice(0, -1); }
        let value = literal;
        try { value = JSON.parse(literal); } catch (e) { value = literal; }
        return { exact, text: String(value) };
      };
      const matchValue = (matcher, candidate) => {
        const c = String(candidate == null ? "" : candidate);
        if (!matcher) return true;
        if (matcher.re) { matcher.re.lastIndex = 0; return matcher.re.test(c); }
        const t = String(matcher.text || "");
        if (!t) return true;
        if (matcher.exact) return c === t;
        return c.toLowerCase().includes(t.toLowerCase());
      };
      // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：把 roleOf 从「只看 tag/type」升级为 ARIA 隐式角色映射，并补 roleAlias。
      // 为什么：原实现让 h1..h6→"h1"、input[search]→"textbox"、li→"li"、ul/ol/table 无 role，
      // 而 Playwright getByRole 的契约是 heading/searchbox/listitem/list/table…
      // 现网实测：cn.bing.com 结果页 h1*13 却 getByRole("heading").count()=0、
      // getByRole("searchbox")=0、getByRole("listitem")=0 —— 定位直接失效，模型只能退回 CSS。
      const roleOf = (el) => {
        const r = (el.getAttribute("role") || "").toLowerCase().trim();
        if (r) return r.split(/\s+/)[0];
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (tag === "textarea") return "textbox";
        if (el.isContentEditable) return "textbox";
        if (tag === "input") {
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
          if (type === "search") return "searchbox";
          if (type === "hidden" || type === "file") return type;
          return "textbox";
        }
        if (tag === "button") return "button";
        if (tag === "a" && el.hasAttribute("href")) return "link";
        if (tag === "select") return el.multiple ? "listbox" : "combobox";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "img") return el.getAttribute("alt") === null ? "presentation" : "img";
        if (tag === "hr") return "separator";
        if (tag === "ul" || tag === "ol" || tag === "menu") return "list";
        if (tag === "li") return "listitem";
        if (tag === "table") return "table";
        if (tag === "tr") return "row";
        if (tag === "td") return "cell";
        if (tag === "th") return "columnheader";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "header") return "banner";
        if (tag === "footer") return "contentinfo";
        if (tag === "aside") return "complementary";
        if (tag === "section") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : "generic";
        if (tag === "form") return "form";
        if (tag === "summary") return "button";
        if (tag === "dialog") return "dialog";
        if (tag === "progress") return "progressbar";
        if (tag === "output") return "status";
        if (tag === "option") return "option";
        if (tag === "label") return "generic";
        return tag;
      };
      // Playwright 家族别名：getByRole("heading") 应同时匹配 role=heading 与显式 role="heading" 的 h 元素；
      // 反向也允许用 tag 名当 role 查（历史行为，别让老调用突然全 0）。
      // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
      // 更正：本方法第一版让 searchbox 也接受普通 textbox，导致 internal:role=searchbox
      // 在只有 text 输入框的页面上也命中——回归测试 test_searchbox_role_matches_input_search
      // 立刻把它抓成 2 vs 1。方向只能是单向继承：textbox ⊃ searchbox（ARIA 里 searchbox 是
      // textbox 的子类），反向不成立。
      const roleAlias = (want, have, tag) => {
        if (have === want) return true;
        if (want === "img") return have === "img" || tag === "img";
        if (want === "heading") return have === "heading" || /^h[1-6]$/.test(tag);
        if (want === "list") return have === "list" || have === "ul" || have === "ol" || tag === "ul" || tag === "ol";
        if (want === "listitem") return have === "listitem" || tag === "li";
        if (want === "textbox") return have === "textbox" || have === "searchbox";
        return have === want || tag === want;
      };
      if (sel.startsWith("xpath=") || sel.startsWith("//") || sel.startsWith("(//")) {
        const xp = sel.startsWith("xpath=") ? sel.slice(6) : sel;
        const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < snap.snapshotLength; i++) {
          const n = snap.snapshotItem(i);
          if (n && n.nodeType === 1) out.push(n);
        }
        return out;
      }
      if (sel.startsWith("internal:role=")) {
        const raw = sel.slice("internal:role=".length);
        const bracket = raw.indexOf("[name=");
        const role = (bracket >= 0 ? raw.slice(0, bracket) : raw).toLowerCase().trim();
        const matcher = bracket >= 0 ? parseMatcher(raw.slice(bracket + 6, raw.endsWith("]") ? -1 : undefined)) : null;
        // 候选集要覆盖所有能承载隐式角色的标签（h1..h6/li/td/th/ul/table/img/summary…），
        // 只查 a,button,input 会让 heading/listitem/table 这些角色永远为 0。
        const all = Array.from(document.querySelectorAll(
          "a,button,input,textarea,select,summary,option,img,hr,ul,ol,menu,li,table,tbody,thead,tr,td,th,form,nav,main,header,footer,aside,section,dialog,progress,output,h1,h2,h3,h4,h5,h6,[role],[contenteditable='true'],label"
        ));
        return all.filter((el) => {
          if (!roleAlias(role, roleOf(el), el.tagName.toLowerCase())) return false;
          if (!visible(el)) return false;
          if (!matcher) return true;
          const n = nameOf(el);
          return matchValue(matcher, n) || matchValue(matcher, String(el.innerText || "").trim());
        });
      }
      if (sel.startsWith("internal:text=")) {
        const matcher = parseMatcher(sel.slice("internal:text=".length));
        const nodes = Array.from(document.querySelectorAll("a,button,h1,h2,h3,h4,h5,p,span,li,td,label,div"));
        const hits = [];
        for (const el of nodes) {
          const t = String(el.innerText || "").trim();
          if (!t || !visible(el)) continue;
          if (!matchValue(matcher, t)) continue;
          // 精确匹配时排除「父节点文本等于子节点文本」的重复命中，否则 exact 会一次报 2 个。
          if (matcher.exact && el.querySelector && Array.from(el.children).some((c) => String(c.innerText || "").trim() === t)) continue;
          hits.push(el);
          if (hits.length >= 8) break;
        }
        return hits;
      }
      // internal:label= / internal:attr=[placeholder=..] / internal:testid=[..] 三个家族
      // 以前直接报「暂未实现」，模型只能退回猜 CSS。这里按语义补齐。
      if (sel.startsWith("internal:label=")) {
        const matcher = parseMatcher(sel.slice("internal:label=".length));
        const out = [];
        for (const label of Array.from(document.querySelectorAll("label"))) {
          if (!visible(label)) continue;
          if (!matchValue(matcher, String(label.innerText || label.textContent || "").replace(/\s+/g, " ").trim())) continue;
          const forId = label.getAttribute("for");
          let target = forId ? document.getElementById(forId) : null;
          if (!target) target = label.querySelector("input,textarea,select,button");
          if (target && !out.includes(target)) out.push(target);
        }
        return out;
      }
      if (sel.startsWith("internal:attr=")) {
        // 形状：internal:attr=[placeholder="x"i] 或 [aria-label="y"s]
        const body = sel.slice("internal:attr=".length).trim();
        const m = body.match(/^\[([^=\]]+)=([\s\S]*)\]$/);
        if (!m) return [];
        const attr = m[1].toLowerCase();
        const matcher = parseMatcher(m[2]);
        return Array.from(document.querySelectorAll("[" + attr + "]")).filter((el) => visible(el) && matchValue(matcher, String(el.getAttribute(attr) || "")));
      }
      if (sel.startsWith("internal:testid=")) {
        const matcher = parseMatcher(sel.slice("internal:testid=".length).replace(/^\[/, "").replace(/\]$/, "").replace(/^data-testid=/, ""));
        return Array.from(document.querySelectorAll("[data-testid]")).filter((el) => visible(el) && matchValue(matcher, String(el.getAttribute("data-testid") || "")));
      }
      // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：补 "internal:has-text=" / "internal:has-not-text=" 与裸 "text=" 前缀，
      // 以及 ">>" 串联选择器（locator().getByText() 编译出来的形状）。
      // 为什么：这三种都是插件把一个合法 Playwright 调用编译成的串，桥之前全落进
      // querySelectorAll 兜底 → 抛错被吞 → **静默 0 命中**。现网实测 count 恒 0
      // （text=EvoFlow、h2:has-text('EvoFlow')、getByRole('link').filter({hasText}) 三条全 0），
      // 模型只能怀疑自己写错了，然后换写法重试 —— 这就是"反复"。
      if (sel.startsWith("internal:has-text=") || sel.startsWith("internal:has-not-text=")) {
        const neg = sel.startsWith("internal:has-not-text=");
        const prefix = neg ? "internal:has-not-text=" : "internal:has-text=";
        const matcher = parseMatcher(sel.slice(prefix.length));
        // Playwright 的 has-text 是「元素自身包含该文本」，若它只在子节点里出现，
        // 命中应落在那个子节点上。全量祖先链命中会让 filter() 返回整棵树（实测 139 个），
        // 于是「收窄」动作反而扩大范围。这里只保留最内层命中。
        const all = Array.from(document.querySelectorAll("*"));
        const hit = all.filter((el) => {
          if (el.nodeType !== 1 || !visible(el)) return false;
          const t = String(el.innerText || el.textContent || "").trim();
          return neg ? !matchValue(matcher, t) : matchValue(matcher, t);
        });
        if (neg) return hit;
        return hit.filter((el) => !hit.some((other) => other !== el && el.contains(other)));
      }
      if (sel.startsWith("text=")) {
        // Playwright 的 text= 引擎：默认子串、引号内为精确、前缀正则 /.../。
        const raw = sel.slice(5).trim();
        const matcher = parseMatcher(raw.startsWith("/") || /^["']/.test(raw) ? raw : JSON.stringify(raw) + "i");
        const all = Array.from(document.querySelectorAll("a,button,h1,h2,h3,h4,h5,h6,p,span,li,td,label,div,em,strong"));
        return all.filter((el) => visible(el) && matchValue(matcher, String(el.innerText || "").trim()));
      }
      if (sel.includes(">>")) {
        // 串联：A >> B 语义是「在 A 的命中里再做 B」。取第一个可解析的 A 递归收窄。
        const parts = sel.split(">>").map((x) => x.trim()).filter(Boolean);
        let pool = Array.from(document.querySelectorAll("*")).filter((el) => el.nodeType === 1);
        for (const part of parts) {
          if (/^nth=-?\d+$/.test(part)) {
            const n = Number(part.slice(4));
            const i = n < 0 ? pool.length + n : n;
            pool = i >= 0 && i < pool.length ? [pool[i]] : [];
            continue;
          }
          // 只做交集：A >> B 表示「A 的命中里同时满足 B」。
          // 之前额外允许 el.contains(命中) 会让 B 的祖先也算命中，
          // 于是 h2 >> has-text 返回 28（真值应在 11 以内），收窄变成放大。
          const inner = __evoMatch(part);
          const set = new Set(inner);
          pool = pool.filter((el) => set.has(el));
        }
        return pool;
      }
      // 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：CSS 兜底前先剥掉 Playwright 的 css= 引擎前缀。
      // 为什么：这里原先**没有 css= 分支**，css=a 会直达 querySelectorAll("css=a")。
      // 注意：必须放在 >> 串联分支之后，否则 css=a >> nth=0 会被整串剥成 a >> nth=0 再走串联，
      // 语义虽等价但会绕过串联分支对 nth 的既有处理，属于不必要的风险。
      //
      // 【self-evolution-bot · 2026-11-18 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：删掉这里两处 catch (e) { return []; }，让非法选择器**抛出去**。
      // 为什么：a:::bogus((( 在页内裸 querySelectorAll 下抛 SyntaxError（实测），
      // 但被这两行 catch 吞成空数组，于是 locator.count() 返回 0 —— 模型看到「0 个元素」，
      // 以为选择器写对了只是页面没这东西，于是换个写法再试一遍（=反复）。
      // 判据：语法非法 ≠ 命中为零。前者要模型改选择器，后者要模型换策略，混在一起就没法区分。
      // 抛出去之后，引擎 _wv2_evaluate 会经 exceptionDetails 转成 ok:false，
      // count 分支的 r.ok === false 判定再把它变成带原因的 execution_error。
      if (sel.startsWith("css=")) {
        return Array.from(document.querySelectorAll(sel.slice(4).trim()));
      }
      return Array.from(document.querySelectorAll(sel));
    }
  `;
  // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：新增 ref 选择器识别（"ref=e5" / "aria-ref=e5" / 裸 "e5"），把快照里的
  // [eNN] 接进 Playwright 定位链，转发给引擎的 ref 命令面（click/fill support ref）。
  // 为什么：domSnapshot 一直打印 "[e21] link "...""，看上去就是"点它"，但 playwright 侧
  // 没有任何入口——"locator("aria-ref=e21").count()" 实测 0，模型只能放弃 ref 改用
  // 猜 CSS/角色，猜错再换写法 = 反复试。引擎侧 "{method:"click", ref:"e5"}" 实测 ok:true，
  // 通道本来就通，只是没接线。
  const __refOf = (sel) => {
    const m = String(sel || "").trim().match(/^(?:aria-ref=|ref=|@)?(e\d+)$/);
    return m ? m[1] : "";
  };
  const __locatorMode = (sel) => {
    const s = String(sel || "");
    if (__refOf(s)) return "ref";
    if (s.startsWith("internal:role=")) return "role";
    if (s.startsWith("internal:text=")) return "text";
    if (s.startsWith("internal:label=")) return "label";
    if (s.startsWith("internal:attr=")) return "attr";
    if (s.startsWith("internal:testid=")) return "testid";
    if (s.startsWith("xpath=") || s.startsWith("//") || s.startsWith("(//")) return "xpath";
    if (s.startsWith("internal:")) return "internal-other";
    return "css";
  };
  // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：新增 __splitNth/__pickExpr，把 Playwright 的 `>> nth=N` 链接尾翻译成页内索引；
  // 并新增 __strictPick 判定，多重命中且未指定 nth 时报错而不是静默取第 0 个。
  // 为什么：locator.first()/nth(i) 编译成 `<sel> >> nth=0`，桥原来把它整串当 CSS 或
  // internal:role 名去匹配 → 永远 0 命中；而多重命中的 click 会静默点到 DOM 顺序第一个
  // （现网实测 name=Github 命中 5 个，点击直接跳到 github.com，Playwright 本应报 strict 冲突）。
  const __splitNth = (sel) => {
    const m = String(sel || "").match(/^(.*?)\s*>>\s*nth=(-?\d+)\s*$/);
    if (!m) return { base: String(sel || ""), nth: null };
    return { base: m[1].trim(), nth: Number(m[2]) };
  };
  // 页内取元素表达式：命中数组 →（可选）按 nth 取一个。
  const __pickExpr = (sel) => {
    const { base, nth } = __splitNth(sel);
    const baseJson = JSON.stringify(base);
    if (nth === null) return `__evoMatch(${baseJson})`;
    const i = nth < 0 ? `(__a.length+${nth})` : String(nth);
    return `(function(){const __a=__evoMatch(${baseJson});const __i=${i};return (__i>=0&&__i<__a.length)?[__a[__i]]:[];})()`;
  };
  // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：__countExpr 尊重 `>> nth=N`；只有无 nth 时才返回基准选择器的全量长度。
  // 为什么：原实现一律用 base，于是 locator.first().count() / .nth(i).count()
  // 永远返回全量命中数（复算实测 nth=0 仍为 5，真值应为 1），
  // 模型无法确认自己“取第几个”到底有没有生效。
  const __countExpr = (sel) => {
    const { nth } = __splitNth(sel);
    if (nth === null) return `__evoMatch(${JSON.stringify(__splitNth(sel).base)}).length`;
    return `(${__pickExpr(sel)}).length`;
  };
    // ── playwright 命令面（browser-use 插件 Tab API 的核心操作面）──
    // 插件运行时把所有 Tab 操作发成 { method:"playwright", action:{name,...} }，
    // 读取类结果放在 .value（runValue），动作类只看 ok（runAction）。
    const __pwHandle = async (cmd) => {
      const act0 = cmd.action || {};
      // 定位器操作形状：{ name:"locator", selector, operation, ...fields } —— 
      // 运行时把 locator 链的每个动作都发成 name:"locator"+operation。
      // 这里改写成 leaf 操作（fill/click/...）+ selector 再进入下方各分支。
      if (act0.name === "locator") {
        const op = String(act0.operation || "");
        return __pwHandle({ method: "playwright", action: { ...act0, name: op, selector: act0.selector } });
      }
      const act = act0;
      const an = act.name || "";
      // 【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：所有 `method:"evaluate"` 的表达式在**发送前**统一包一层 try/catch，
      // 页内异常变成正常返回值 `{__evoEvalErr:"..."}`，不再走异常回传通道。
      // 为什么：重启后实测同一个非法选择器——example.com 780ms、bing 864ms 就报真实错误，
      // 而 github.com 稳定卡 16049/16183ms 才报 `embed HTTP bridge timed out waiting for guest poll`。
      // 该站点钳断了异常回传通道，宿主只能等兜底超时。一次白等 16 秒，模型还会重试。
      // 包一层后：任何站点、任何页内异常，都在毫秒级拿到原因，且错误文案能指对方向。
      // 判据：这不是「让异常消失」，异常原因原样回传给调用方，只是换了条不依赖异常通道的路。
      const __wrapEval = (command) => {
        try {
          if (!command || command.method !== "evaluate") return command;
          const expr = command.expression;
          if (typeof expr !== "string" || !expr.trim()) return command;
          if (expr.indexOf("__evoEvalErr") !== -1) return command; // 已包过，别套第二层
          // 【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
          // 改了什么：`awaitPromise:true` 的命令用**async** IIFE 包，并把内层值 await 出来再装信封。
          // 为什么：同步 IIFE 在 `awaitPromise:true` 下只会被宿主 await 到「外层普通对象」，
          // 里面的 Promise 不会被 await，序列化后成 `{}` —— async 页面函数（playwright.evaluate
          // 那条路径，第 785 行恒为 awaitPromise:true）会从「拿到结果」退化成「拿到 {}」。
          // 判据：这是一处真回归，改动前后 envelope 的形状必须对 awaitPromise 分开取样。
          const body = command.awaitPromise
            ? "(async function(){ try { return { __evoEvalOk: 1, v: (await (\n" + expr + "\n)) }; }"
              + " catch (e) { return { __evoEvalErr: String((e && e.message) || e) }; } })()"
            : "(function(){ try { return { __evoEvalOk: 1, v: (\n" + expr + "\n) }; }"
              + " catch (e) { return { __evoEvalErr: String((e && e.message) || e) }; } })()";
          return Object.assign({}, command, { expression: body });
        } catch (_) {
          return command;
        }
      };
      const engine = (command) => __gwFetch("/api/browser/execute", { method: "POST", body: JSON.stringify({ command: __wrapEval(command) }) })
        .then((r) => {
          // 【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
          // 改了什么：在这里把 __wrapEval 的信封**统一拆掉**，还原成调用方原本期望的形状：
          // 页内异常 → {ok:false, error:{code:"execution_error", ...}}；正常值 → {ok:true, value}。
          // 为什么：evaluate 有 17 个调用点，逐个改解包必然漏；在唯一入口拆封，
          // 所有调用点（含直接 await engine(...) 的）拿到的形状与修复前完全一致，零改动风险。
          try {
            const v = r && r.value;
            if (v && typeof v === "object" && typeof v.__evoEvalErr === "string") {
              return { ok: false, error: { code: "execution_error", message: `页面内执行失败：${v.__evoEvalErr.slice(0, 300)}` } };
            }
            if (v && typeof v === "object" && v.__evoEvalOk === 1) {
              return Object.assign({}, r, { value: v.v === undefined ? null : v.v });
            }
          } catch (_) {}
          return r;
        });
      // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 __engineRead，统一把引擎 ok:false 变成可见错误。
      // 为什么：evaluate/textContent/innerText/getAttribute/isVisible/isEnabled/count 六条读路径
      // 原先一律 `value: r.value ?? null`；引擎返回 ok:false 时 value 是 undefined，
      // 于是「页面报错」在模型侧长成「结果是 null / 0」，它只能换个写法再试一遍（=反复）。
      const __engineRead = async (command, what) => {
        const r = await engine(command);
        if (r && r.ok === false) {
          const e = r.error || {};
          const msg = String(e.message || e.code || "browser engine returned ok=false").slice(0, 300);
          await __bridgeLog(`[browser-bridge] ${what} FAILED err=${msg}`);
          return { ok: false, error: { code: "execution_error", message: `${what} 执行失败：${msg}` } };
        }
        // 【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：解包 __wrapEval 的信封。页内异常现在以 {__evoEvalErr} 正常返回，
        // 在这里必须变成 ok:false 的可见错误；否则「页面报错」会长成「值是 null / 0」。
        // 为什么：这是上一行注释里同一个坑——错误被静默成正常值，模型只能换个写法重试。
        const v = r ? r.value : null;
        if (v && typeof v === "object" && typeof v.__evoEvalErr === "string") {
          const msg = v.__evoEvalErr.slice(0, 300);
          await __bridgeLog(`[browser-bridge] ${what} PAGE_ERROR err=${msg}`);
          return { ok: false, error: { code: "execution_error", message: `${what} 页面内执行失败：${msg}` } };
        }
        if (v && typeof v === "object" && v.__evoEvalOk === 1) {
          return { ok: true, value: v.v === undefined ? null : v.v };
        }
        return { ok: true, value: r ? (r.value ?? null) : null };
      };
      const rawSel = () => String(act.locator?.selector || act.selector || "");
      if (an === "domSnapshot") {
        // 引擎 snapshot 返回结构化 {url,title,elements[],dom[]}；运行时契约要字符串。
        // 正文大纲必须排在交互元素之前：模型常对返回值 .slice(0,1000)，否则只剩顶栏链接会空转重试。
        const r = await engine({ method: "snapshot", maxElements: 400 });
        // 快照失败不能装成空页：否则模型会以为“这页真没东西”然后反复重试。
        if (r && r.ok === false) {
          const e = r.error || {};
          return { ok: false, error: { code: "execution_error", message: `domSnapshot 执行失败：${String(e.message || e.code || "browser engine returned ok=false").slice(0, 300)}` } };
        }
        const snap = r.snapshot || {};
        const els = Array.isArray(snap.elements) ? snap.elements : [];
        const outline = Array.isArray(snap.dom) ? snap.dom.slice() : [];
        outline.sort((a, b) => {
          const av = a && a.inViewport ? 0 : 1;
          const bv = b && b.inViewport ? 0 : 1;
          if (av !== bv) return av - bv;
          return (Number(a && a.depth) || 0) - (Number(b && b.depth) || 0);
        });
        // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：① 正文大纲去重（连续同文只留一条）+ 视口内优先；② 交互元素视口内优先排序；
        // ③ 超出上限的元素不再只印「(N more interactive)」——改为紧凑行（无坐标、名字截短）全量列出，
        //    并给出一句「怎么取到全部」的用法提示。
        // 为什么：现网快照 6861 字符里正文 100 条吃掉大半，交互元素只印 36 条就写
        // 「... (46 more interactive)」——剩下 46 个 ref 模型**没有任何办法在同一轮拿到**，
        // 只能重新 domSnapshot 或凭猜去点，点不到再重试，这就是最典型的「反复」。
        // 只合并「连续重复」——嵌套元素把同一段文字重复上报是常态；
        // 但页面上两个不同位置的同名链接（如多个「阅读全文」）必须都留着，
        // 否则模型数不清条目。用全局去重会误删后者（本条判据来自本节自查）。
        const textLines = [];
        let __lastKey = null;
        for (const node of outline) {
          if (textLines.length >= 100) break;
          const t = String(node.text || "").replace(/\s+/g, " ").trim();
          if (!t) continue;
          const key = (node.tag || "") + "|" + t;
          if (key === __lastKey) continue;
          __lastKey = key;
          const pad = "  ".repeat(Math.min(Number(node.depth) || 0, 6));
          textLines.push(pad + (node.tag || "text") + " \"" + t.slice(0, 140) + "\"");
        }
        // 视口内的元素先列：模型 90% 的动作落在当前可见区，先看到它就不用滚动/重读。
        const elsSorted = els.slice().sort((a, b) => ((a && a.inViewport ? 0 : 1) - (b && b.inViewport ? 0 : 1)));
        const maxInteractive = textLines.length ? 36 : 80;
        const one = (el, compact) => {
          const ref = el.ref ? `[${el.ref}]` : "";
          const label = String(el.name || el.text || "").replace(/\s+/g, " ").trim().slice(0, compact ? 40 : 80);
          const geo = compact ? "" : (el.rect && el.rect.x != null
            ? ` x=${Math.round(el.rect.x)},y=${Math.round(el.rect.y)}`
            : (el.x != null ? ` x=${Math.round(el.x)},y=${Math.round(el.y)}` : ""));
          return `${ref} ${el.role || el.tag || "node"} "${label}"${geo}`.trim();
        };
        const head = elsSorted.slice(0, maxInteractive);
        const rest = elsSorted.slice(maxInteractive);
        const lines = head.map((el) => one(el, false));
        const compactLines = rest.slice(0, 80).map((el) => one(el, true));
        const restMore = rest.length > 80 ? `${
          String.fromCharCode(10)}... (还有 ${rest.length - 80} 个交互元素未列出，可先滚动或用具体 selector 收窄)` : "";
        const more = rest.length
          ? String.fromCharCode(10) + `... (另有 ${rest.length} 个交互元素，紧凑列出：ref 可直接用于 click/fill)` +
            String.fromCharCode(10) + compactLines.join(String.fromCharCode(10)) + restMore
          : "";
        const value = `page: ${snap.url || ""} | ${snap.title || ""}
${textLines.length ? "text:" + String.fromCharCode(10) + textLines.join(String.fromCharCode(10)) + String.fromCharCode(10) : ""}interactive:
${lines.join(String.fromCharCode(10))}${more}`;
        await __bridgeLog(`[browser-bridge] domSnapshot elements=${els.length} textNodes=${textLines.length} url=${snap.url || ""}`);
        return { ok: true, value };
      }
      if (an === "waitForLoadState") {
        // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：① 轮询期间用页面内 document.readyState 兜底（原来只认 getState.state.ready，
        // 探针一失败就空转满 15s——现网实测一次 waitForLoadState 花 16016ms）；
        // ② 目标态已达成时不再无条件补眠 500ms，改为「已达成→立即返回，未达成→短 settle」；
        // ③ settle 可被 timeout 约束（原来 timeoutMs:200 也要花 534ms）。
        // 为什么：goto+wait+snapshot 是每轮固定开销，空转一项就吃掉 0.5~16s。
        // 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：① 默认预算 15000ms → 3000ms（与插件自带口径「routine URL/load-state waits remain capped at 3000ms」一致）；
        // ② 等不到目标态时不再 `return ok:true` —— 改为如实报 timeout，并带上当前 readyState/资源数 + 下一步怎么走。
        // 为什么：现网实测 github.com 在 IAB 里 goto 1474ms 返回后，12 秒仍停在 readyState=interactive
        // （146 个锚点、页面早已可用），一次不带 timeout 的 waitForLoadState 实测 **20163ms 打满预算**，
        // 然后照样回 ok:true。模型白等 20s 且拿到的是谎报的成功 —— 这既是每轮固定开销，也是"以为还没就绪"的反复来源。
        // 只压预算不报错会留下"真没就绪也报成功"，只报错不压预算会继续白等，两条必须一起改。
        const state = String(act.state || "load").toLowerCase();
        const timeout = Math.min(Number(act.timeout) || Number(act.timeoutMs) || 3000, 30000);
        const deadline = Date.now() + timeout;
        const probeReady = async () => {
          try {
            const rs = await engine({ method: "evaluate", expression: "document.readyState" });
            const v = typeof rs.value === "string" ? rs.value : "";
            if (v) return v;
          } catch (e) { /* 落到 getState */ }
          try {
            const st = await engine({ method: "getState" });
            return String(st.state?.ready || st.state?.readyState || "");
          } catch (e) { return ""; }
        };
        // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：networkidle 不再等价于 load —— 除 readyState=complete 外，
        // 还要求「资源条目数连续 400ms 不再增长」才算安静；其余状态语义不变。
        // 为什么：原实现把 networkidle 直接判成 `ready === "complete"`，等同于 load，
        // 但调用方用 networkidle 恰恰是想要「等动态内容静下来」。它立刻就返回"成功了"，
        // 模型随即读到还在渲染的页面、拿不到目标元素，再重读再重试 —— 这是"反复"的隐蔽来源。
        const resourceCount = async () => {
          try {
            const r = await engine({ method: "evaluate", expression: "performance.getEntriesByType('resource').length" });
            const n = Number(r && r.value);
            return Number.isFinite(n) ? n : -1;
          } catch (e) { return -1; }
        };
        const satisfied = (ready) => {
          if (!ready) return false;
          if (state === "domcontentloaded" || state === "interactive") return ready === "interactive" || ready === "complete";
          return ready === "complete";
        };
        let lastReady = "";
        let lastCount = -1, stableSince = 0;
        while (Date.now() < deadline) {
          lastReady = await probeReady();
          if (satisfied(lastReady)) {
            if (state !== "networkidle") break;
            // networkidle：还得等资源不再增长
            const c = await resourceCount();
            if (c < 0) break;                       // 探针不可用就别假装等到了，按 complete 收
            if (c !== lastCount) { lastCount = c; stableSince = Date.now(); }
            else if (Date.now() - stableSince >= 400) break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (satisfied(lastReady) && (state !== "networkidle" || lastCount < 0 || Date.now() - stableSince >= 400)) {
          await __bridgeLog(`[browser-bridge] waitForLoadState state=${state} ready=${lastReady} resources=${lastCount} settled=immediate`);
          return { ok: true, value: true };
        }
        // 只有等不到目标态时才补一小段 settle，且不超过剩余预算。
        const settleMs = Math.max(0, Math.min(state === "networkidle" ? 600 : 300, deadline - Date.now()));
        if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
        // 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：超时分支从 `return ok:true` 改成带证据的 ok:false。
        // 为什么：原来等不到也报成功，模型无从判断"是还没就绪还是真没有"，只能再 wait 一次；
        // 而且 SPA（github.com 实测全程停在 interactive）永远到不了 load，
        // 报错里必须直接告诉它「现在该继续，不要再等」——否则又是一次空转。
        await __bridgeLog(`[browser-bridge] waitForLoadState state=${state} ready=${lastReady || "?"} settleMs=${settleMs} timedOut=1`);
        const hint = (lastReady === "interactive" || lastReady === "complete")
          ? "页面 DOM 已可用（readyState=" + lastReady + "），SPA 可能永远不会到 load；直接 domSnapshot 读取即可，不要再重复等"
          : "当前 readyState=" + (lastReady || "?") + "；可稍后重试或改用 waitForTimeout + domSnapshot 轮询";
        return {
          ok: false,
          error: {
            code: "timeout",
            message: `waitForLoadState(${state}) 超时 ${timeout}ms：ready=${lastReady || "?"} resources=${lastCount}。${hint}`,
          },
        };
      }
      if (an === "waitForURL") {
        // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：用页面内 location.href 真等（支持字符串前缀与正则），超时返回错误并带上当前 URL。
        // 为什么：原实现固定循环 10×300ms（最坏 3s）后**无条件** `return ok:true`——
        // 即使 URL 压根没变也报成功。模型据此以为导航完成，读到的却是旧页内容，
        // 于是"点了没反应"→ 再点 → 再读，形成反复。
        const want = String(act.url || "");
        const budget = Math.min(Number(act.timeout) || Number(act.timeoutMs) || 3000, 30000);
        const deadline = Date.now() + budget;
        const matchUrl = (href) => {
          if (!want) return true;
          const m = want.match(/^\/([\s\S]*)\/([a-z]*)$/);
          if (m) { try { return new RegExp(m[1], m[2]).test(href); } catch (e) { /* 落到前缀 */ } }
          return href === want || href.startsWith(want);
        };
        let href = "";
        while (Date.now() < deadline) {
          const r = await engine({ method: "evaluate", expression: "location.href" });
          href = String((r && r.value) || "");
          if (matchUrl(href)) return { ok: true, value: true };
          await new Promise((res) => setTimeout(res, 100));
        }
        return { ok: false, error: { code: "timeout", message: `waitForURL 超时 ${budget}ms：期望 ${want.slice(0, 120)}，当前 ${href.slice(0, 160)}` } };
      }
      if (an === "evaluate") {
        // Playwright 把函数源码标成 expressionKind=function。原样丢给 Runtime.evaluate
        // 得到的是函数对象，JSON 后是 {}。这里先调用，并要求宿主 awaitPromise。
        const kind = String(act.expressionKind || "string");
        let expression = String(act.expression ?? act.pageFunction ?? "");
        if (kind === "function") {
          const argJson = JSON.stringify(act.arg === undefined ? null : act.arg);
          expression = `(${expression})(${argJson})`;
        }
        await __bridgeLog(`[browser-bridge] evaluate kind=${kind} awaitPromise=1 head=${expression.replace(/\s+/g, " ").slice(0, 160)}`);
        const rd = await __engineRead({ method: "evaluate", expression, awaitPromise: true }, "playwright.evaluate");
        if (!rd.ok) return rd;
        let preview = "";
        try { preview = JSON.stringify(rd.value).slice(0, 180); } catch (e) { preview = String(rd.value); }
        await __bridgeLog(`[browser-bridge] evaluate done valueType=${typeof rd.value} preview=${preview}`);
        return { ok: true, value: rd.value };
      }
      if (an === "elementInfo") {
        return await __engineRead({ method: "elementInfo", ...(act.options || {}) }, "playwright.elementInfo");
      }
      if (an === "waitForTimeout") {
        await new Promise((r) => setTimeout(r, Math.min(Number(act.timeoutMs) || 0, 3000)));
        return { ok: true, value: true };
      }
      const sel = rawSel();
      const needsSelector = ["click", "dblclick", "fill", "type", "selectOption", "textContent", "innerText", "allTextContents", "getAttribute", "isVisible", "isEnabled", "count", "waitFor"].includes(an);
      if (needsSelector && !sel) {
        return { ok: false, error: { code: "unsupported", message: `EvoFlow 浏览器桥缺少 selector（${an}）。action=${JSON.stringify(act).slice(0, 200)}` } };
      }
      if (needsSelector && __locatorMode(sel) === "internal-other") {
        await __bridgeLog(`[browser-bridge] locator unsupported mode=internal-other op=${an} sel=${sel.slice(0, 160)}`);
        return { ok: false, error: { code: "unsupported", message: `EvoFlow 浏览器桥暂未实现该 Playwright 定位器（${sel.slice(0, 80)}）。role/text/label/placeholder/testid/xpath/css 可用。` } };
      }
      // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：动作类操作统一走 __pickExpr（支持 `>> nth=N`）+ __STRICT 严格模式；
      // 结果类操作（textContent/innerText/getAttribute/isVisible/isEnabled/count）同样受 nth 约束。
      // 为什么：原来清一色 `__evoMatch(sel)[0]`——多重命中静默取第 0 个（现网实测点错链接），
      // 而 first()/nth(i) 生成的 `>> nth=N` 后缀被当整串选择器，永远 0 命中。
      const strict = act.strict !== false;
      // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：把 __pickExpr/__countExpr 从「页面表达式内」提到「Node 侧先求值」。
      // 为什么：它们是桥侧的表达式生成器，写进页内模板后在页面里就是未定义标识符，
      // 每次调用都抛 ReferenceError；复启后现网实测 locator("a").count()=0
      // （页内 querySelectorAll('a') 真值 66），heading/list/link 全 0 —— 比修复前更糟。
      const pickExprJs = __pickExpr(sel);
      const countExprJs = __countExpr(sel);
      // 【self-evolution-bot · 2026-11-18 · 第53轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：ref 选择器直接转发引擎 ref 命令面（click/fill/type 支持 ref）。
      // 为什么：快照打印的 [eNN] 必须真能用，否则模型每轮都在"读得到、点不到"之间反复。
      const refId = __refOf(sel);
      if (refId && ["click", "dblclick", "fill", "type"].includes(an)) {
        await __bridgeLog(`[browser-bridge] locator op=${an} mode=ref ref=${refId}`);
        if (an === "fill" || an === "type") {
          const r = await engine({ method: "fill", ref: refId, value: String(act.text ?? act.value ?? "") });
          if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `ref ${refId} fill failed` } };
          return { ok: true, value: true };
        }
        const r = await engine({ method: an === "dblclick" ? "dblclick" : "click", ref: refId });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `ref ${refId} ${an} failed` } };
        return { ok: true, value: true };
      }
      if (refId) {
        // 读类操作：ref -> 引擎快照里的 selector，再走普通 CSS 读。
        const snapRes = await engine({ method: "snapshot", maxElements: 600 });
        const els = (snapRes && snapRes.snapshot && snapRes.snapshot.elements) || [];
        const hit = els.find((e) => e.ref === refId);
        if (!hit || !hit.selector) {
          return { ok: false, error: { code: "execution_error", message: `ref ${refId} 已失效（快照已被后续导航/刷新作废），请重新 domSnapshot 取新 ref` } };
        }
        const selJson = JSON.stringify(hit.selector);
        let readExpr = "";
        if (an === "count") {
          readExpr = `document.querySelectorAll(${selJson}).length`;
        } else if (an === "isVisible") {
          readExpr = `(function(){const el=document.querySelector(${selJson});`;
          readExpr += "if(!el)return false;const s=getComputedStyle(el);";
          readExpr += "return s.display!=='none'&&s.visibility!=='hidden';})()";
        } else if (an === "isEnabled") {
          readExpr = `(function(){const el=document.querySelector(${selJson});return el?!el.disabled:false;})()`;
        } else if (an === "getAttribute") {
          // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
          // 改了什么：只读 act.attribute。
          // 为什么：上游 把动作名存在 act.name（=="getAttribute"），
          // 原写法 `act.attribute || act.name` 的顺序倒了，且 act.name 恒真，
          // 于是 getAttribute("href") 实际取的是属性名 "getAttribute" → 永远 null。
          // locator("a").getAttribute("href") 永返 null，模型只能改用 evaluate 重查。
          const attrJson = JSON.stringify(String(act.attribute || ""));
          readExpr = `(function(){const el=document.querySelector(${selJson});`;
          readExpr += `return el?el.getAttribute(${attrJson}):null;})()`;
        } else {
          const prop = an === "innerText" ? "innerText" : "textContent";
          const wrap = an === "allTextContents";
          readExpr = `(function(){const el=document.querySelector(${selJson});if(!el)return null;`;
          readExpr += wrap ? `return [el.${prop}];})()` : `return el.${prop};})()`;
        }
        // 与主读路径统一：ref 读失败也要把错误原文回给模型，而不是 null。
        const rd = await __engineRead({ method: "evaluate", expression: readExpr }, `locator(${refId}).${an}`);
        if (!rd.ok) return rd;
        return { ok: true, value: rd.value };
      }
      if (an === "click" || an === "dblclick") {
        await __bridgeLog(`[browser-bridge] locator op=${an} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const total=${countExprJs};
            if(!els.length)return {missing:true,total};
            if(els.length>1&&${strict ? "true" : "false"})return {ambiguous:els.length,total};
            const el=els[0]; el.scrollIntoView({block:'center'});
            const rc=el.getBoundingClientRect();
            return {x:rc.left+rc.width/2,y:rc.top+rc.height/2,total}; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `${an} evaluate failed` } };
        const pt = r.value && typeof r.value === "object" ? r.value : null;
        await __bridgeLog(`[browser-bridge] locator ${an} result=${JSON.stringify(pt).slice(0, 200)}`);
        if (!pt || pt.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}（命中 0 个）` } };
        if (pt.ambiguous) return { ok: false, error: { code: "strict_mode_violation", message: `strict mode violation: ${pt.ambiguous} 个元素匹配 ${sel}；用 .nth(i)/.first() 指定，或用 name/更具体的定位收窄` } };
        const out = { ok: true, value: true };
        await engine({ method: an === "dblclick" ? "dblclick" : "click", x: pt.x, y: pt.y });
        return out;
      }
      if (an === "fill" || an === "type") {
        const text = String(act.text ?? act.value ?? "");
        await __bridgeLog(`[browser-bridge] locator op=${an} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const total=${countExprJs};
            if(!els.length)return {missing:true,total};
            if(els.length>1&&${strict ? "true" : "false"})return {ambiguous:els.length,total};
            const el=els[0]; el.focus();
            const d=Object.getOwnPropertyDescriptor((el.__proto__||Object.getPrototypeOf(el)),'value');
            if(d&&d.set)d.set.call(el,${JSON.stringify(text)}); else el.value=${JSON.stringify(text)};
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            return {ok:true}; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `${an} evaluate failed` } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        if (pv.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}（命中 0 个）` } };
        if (pv.ambiguous) return { ok: false, error: { code: "strict_mode_violation", message: `strict mode violation: ${pv.ambiguous} 个元素匹配 ${sel}；用 .nth(i)/.first() 指定` } };
        return { ok: true, value: true };
      }
      if (an === "press") {
        // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：press 先聚焦定位器命中的元素，再派发按键；无 selector 时才打到当前焦点。
        // 为什么：Playwright 语义是 locator.press()＝「聚焦该元素再按键」。
        // 原实现直接转发 key，落在**残留焦点**上：模型刚 fill 过 A 输入框、再去
        // locator("搜索框").press("Enter")，回车其实发给了 A —— 页面没反应，
        // 模型以为定位错，换写法重试（实测机型下的典型"反复"）。
        const key = String(act.key || act.value || "Enter");
        if (sel) {
          const rf = await engine({
            method: "evaluate",
            expression: `(function(){${__MATCH_FN};
              const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
              if(!els.length)return {missing:true};
              const el=els[0]; el.focus();
              return {focused: document.activeElement === el, tag: el.tagName.toLowerCase()}; })()`,
          });
          const pf = (rf && rf.value && typeof rf.value === "object") ? rf.value : {};
          if (pf.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}（命中 0 个）` } };
        }
        return await engine({ method: "press", key });
      }
      if (an === "selectOption") {
        await __bridgeLog(`[browser-bridge] locator op=selectOption mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：重写 selectOption —— 按 Playwright 语义真正选中 option 并**回读校验**。
        // 为什么（现网实测假成功）：原实现只做 `el.value = "b"` + dispatch change。
        // 实测 `<select multiple>` 传 ["b"] 后 `selectedOptions` 为空，而桥返回 ok:true ——
        // 模型以为选好了，接着提交表单，结果全是空值，然后再重试一遍（=反复）。
        // 根因有二：① 多选/按 label 选择时 `el.value=` 不生效；② 从不回读，未选中也算成功。
        const wanted = [];
        const pushVal = (v) => { if (v != null) wanted.push(v); };
        if (Array.isArray(act.values)) act.values.forEach(pushVal);
        if (Array.isArray(act.options)) {
          for (const o of act.options) {
            if (o && typeof o === "object") { pushVal(o.value); pushVal(o.label); }
            else pushVal(o);
          }
        }
        pushVal(act.value); pushVal(act.label);
        const wantJson = JSON.stringify(wanted.map((v) => String(v)));
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const total=${countExprJs};
            if(!els.length)return {missing:true,total};
            if(els.length>1&&${strict ? "true" : "false"})return {ambiguous:els.length,total};
            const el=els[0];
            if(!el || el.tagName!=='SELECT') return {notSelect:true, tag: el && el.tagName};
            const wanted=${wantJson};
            const norm=(s)=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
            const want=wanted.map(norm).filter(Boolean);
            const opts=Array.from(el.options||[]);
            const hit=[];
            for(const w of want){
              const o=opts.find(x=>norm(x.value)===w) || opts.find(x=>norm(x.label)===w) ||
                      opts.find(x=>norm(x.text)===w);
              if(o && !hit.includes(o)) hit.push(o);
            }
            if(!hit.length) return {noMatch:true, wanted:want, available:opts.slice(0,12).map(o=>({v:o.value,l:norm(o.label)}))};
            const multi=!!el.multiple;
            for(const o of opts) o.selected=false;
            hit.forEach(o=>{o.selected=true;});
            if(!multi && hit.length>1) hit.slice(1).forEach(o=>{o.selected=false;});
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            const got=Array.from(el.selectedOptions||[]).map(o=>o.value);
            return {ok:true, selected:got, wanted:hit.map(o=>o.value), value:el.value}; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `${an} evaluate failed` } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        if (pv.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}` } };
        if (pv.ambiguous) return { ok: false, error: { code: "strict_mode_violation", message: `strict mode violation: ${pv.ambiguous} 个元素匹配 ${sel}` } };
        if (pv.notSelect) return { ok: false, error: { code: "execution_error", message: `selectOption 目标不是 <select>（实际 ${pv.tag}）：${sel}` } };
        if (pv.noMatch) {
          // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】只做折行，不改文案；原单行 244 字符超出本仓 240 上限
          const __nm = `selectOption 没有匹配的 option：想要 ${JSON.stringify(pv.wanted)}，`
            + `可选项 ${JSON.stringify(pv.available)}（${sel}）。`
            + `别重复同一参数，改 value/label 或先读 options。`;
          return { ok: false, error: { code: "execution_error", message: __nm } };
        }
        // 回读校验：这是本条修复的核心——未真正选中就不许报成功。
        if (!Array.isArray(pv.selected) || pv.selected.length === 0) {
          return { ok: false, error: { code: "execution_error", message: `selectOption 回读为空：写入后 selectedOptions 仍为空（${sel}）。目标可能被 JS 重置，别重复调用。` } };
        }
        await __bridgeLog(`[browser-bridge] locator selectOption selected=${JSON.stringify(pv.selected)} sel=${sel.slice(0, 120)}`);
        return { ok: true, value: true };
      }
      // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 setChecked / check / uncheck（Playwright 的勾选语义）。
      // 为什么：客户端 Locator.setChecked() 直接发 operation="setChecked"，桥无此分支 →
      // 现网实测返回 `unsupported`。而表单场景里勾选框是最常见操作，模型只能退化成
      // "click 一下试试"，却无法指定「确保勾上 / 确保取消」，点错状态后又要反复点。
      if (an === "setChecked" || an === "check" || an === "uncheck") {
        const wantChecked = an === "check" ? true : an === "uncheck" ? false : act.checked !== false;
        await __bridgeLog(`[browser-bridge] locator op=${an} want=${wantChecked} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const total=${countExprJs};
            if(!els.length)return {missing:true,total};
            if(els.length>1&&${strict ? "true" : "false"})return {ambiguous:els.length,total};
            const el=els[0];
            const want=${wantChecked ? "true" : "false"};
            const isCheckable = el && (el.tagName==='INPUT') && ['checkbox','radio'].includes(String(el.type||'').toLowerCase());
            if(!isCheckable) return {notCheckable:true, tag: el && el.tagName, type: el && el.type};
            if(!!el.checked !== want){
              el.focus();
              el.click();
            }
            const after=!!el.checked;
            return {ok:true, checked:after, wanted:want}; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `${an} evaluate failed` } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        if (pv.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}` } };
        if (pv.ambiguous) return { ok: false, error: { code: "strict_mode_violation", message: `strict mode violation: ${pv.ambiguous} 个元素匹配 ${sel}` } };
        if (pv.notCheckable) {
          return { ok: false, error: { code: "execution_error", message: `${an} 目标不是 checkbox/radio（实际 ${pv.tag}${pv.type ? "/" + pv.type : ""}）：${sel}` } };
        }
        // 回读校验：点了但状态没变（被 JS 拦掉 / disabled）必须报错，不能装作成功。
        if (pv.checked !== pv.wanted) {
          return { ok: false, error: { code: "execution_error", message: `${an} 未生效：点击后 checked=${pv.checked}，期望 ${pv.wanted}（${sel}）。元素可能被 JS 拦截或 disabled，别重复点击。` } };
        }
        return { ok: true, value: true };
      }
      // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 hover（桥层之前没接，虽然引擎明明有 _wv2_hover）。
      // 为什么：现网实测 locator.hover() 返回 `unsupported`。悬停是菜单/下拉/提示气泡的
      // 唯一入口，缺了它模型只能改用 click 去"撞"菜单，点开又点关，反复。
      if (an === "hover") {
        await __bridgeLog(`[browser-bridge] locator op=hover mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const total=${countExprJs};
            if(!els.length)return {missing:true,total};
            if(els.length>1&&${strict ? "true" : "false"})return {ambiguous:els.length,total};
            const el=els[0]; el.scrollIntoView({block:'center'});
            const rc=el.getBoundingClientRect();
            const x=rc.left+rc.width/2, y=rc.top+rc.height/2;
            const opts={bubbles:true, cancelable:true, clientX:x, clientY:y, view:window};
            el.dispatchEvent(new MouseEvent('mouseover',opts));
            el.dispatchEvent(new MouseEvent('mouseenter',{...opts,bubbles:false}));
            el.dispatchEvent(new MouseEvent('mousemove',opts));
            return {ok:true, x:Math.round(x), y:Math.round(y)}; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: "hover evaluate failed" } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        if (pv.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}` } };
        if (pv.ambiguous) return { ok: false, error: { code: "strict_mode_violation", message: `strict mode violation: ${pv.ambiguous} 个元素匹配 ${sel}` } };
        return { ok: true, value: true };
      }
      if (an === "textContent" || an === "innerText" || an === "allTextContents") {
        const prop = an === "innerText" ? "innerText" : "textContent";
        const many = an === "allTextContents";
        await __bridgeLog(`[browser-bridge] locator op=${an} prop=${prop} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: many
            ? `(function(){${__MATCH_FN}; return __evoMatch(${JSON.stringify(__splitNth(sel).base)}).map(e=>e.${prop}); })()`
            : `(function(){${__MATCH_FN}; const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[]; return els.length?els[0].${prop}:null; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `locator.${an} evaluate failed` } };
        return { ok: true, value: r.value ?? null };
      }
      if (an === "getAttribute") {
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const el=els[0];
            return el ? el.getAttribute(${JSON.stringify(String(act.attribute || ""))}) : null; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: "getAttribute failed" } };
        return { ok: true, value: r.value ?? null };
      }
      if (an === "isVisible" || an === "isEnabled") {
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const el=els[0]; if(!el)return false;
            ${an === "isEnabled" ? "return !el.disabled;" : "const s=getComputedStyle(el); return s.display!=='none'&&s.visibility!=='hidden'&&el.getBoundingClientRect().width>0;"} })()`,
        });
        // 引擎失败时 value 是 undefined，`!!undefined` = false —— 会被模型读成「元素不可见/不可用」，
        // 于是它去滚动、重试、换定位器。这类假阴性必须显式报错。
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: `locator.${an} evaluate failed` } };
        return { ok: true, value: !!r.value };
      }
      if (an === "count") {
        // 【self-evolution-bot · 2026-11-19 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：非法选择器不再走「异常回传 → 卡到超时」，改由 engine 的 __wrapEval 统一捕获，
        // 这里只需辨型：真数字才算命中数，其余一律显式报错。
        // 为什么：重启后实测同一个非法选择器——example.com 780ms、bing 864ms 就报真实错误，
        // 而 github.com 稳定卡 16049/16183ms；连测三次共 48 秒全白等。
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; return ${countExprJs}; })()`,
        });
        // 【self-evolution-bot · 2026-11-18 · 第58轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：① 正常路径只留一条日志（原来每次 count 连打 3 条，每条一个 HTTP POST）；
        // ② 结果必须辨型：只有 typeof === "number" 才算命中数，undefined/null/其它一律显式报错。
        // 为什么：原 `Number(r.value) || 0` 把「压根没算出数值」压成 0，和「真的没有匹配元素」同形。
        // 插件 guidance 又规定 count()=0 → 不要再等、直接重新 domSnapshot，于是模型陷入
        // 「快照 → count=0 → 再快照」的反复。现网实测：页面 querySelectorAll('a')=77 而
        // count('a')=0，引擎侧 valueType=NoneType preview=null —— 就是这个洞。
        if (r && r.ok === false) {
          const msg = String((r.error && (r.error.message || r.error.code)) || "evaluate failed").slice(0, 300);
          await __bridgeLog(`[browser-bridge] locator count FAILED mode=${__locatorMode(sel)} err=${msg}`);
          return { ok: false, error: { code: "execution_error", message: `locator count 执行失败（${sel.slice(0, 120)}）：${msg}` } };
        }
        const value = r ? r.value : undefined;
        if (typeof value !== "number") {
          const got = value === null ? "null" : (value === undefined ? "no response" : typeof value);
          await __bridgeLog(`[browser-bridge] locator count NOT_A_NUMBER mode=${__locatorMode(sel)} got=${got} sel=${sel.slice(0, 160)} expr=${String(countExprJs).slice(0, 140)}`);
          return {
            ok: false,
            error: {
              code: "execution_error",
              message: `locator count 没有返回数值（${sel.slice(0, 120)}）：页面表达式返回了 ${got}。`
                + "这不是「0 个匹配」，别再重复 count —— 改用 domSnapshot 看页面结构，或用 evaluate 自己数。",
            },
          };
        }
        const n = value;
        await __bridgeLog(`[browser-bridge] locator count=${n} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        return { ok: true, value: n };
      }
      // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 drag（拖拽）。支持 {fromRef/toRef} 与 {from:{x,y}/to:{x,y}} 两种线格式。
      // 为什么：现网实测 `Tab.drag()` 与 `Locator.dragTo()` 都返回 `unsupported`。
      // 拖拽是排序、看板、滑块、拖拽上传的唯一入口；缺了它模型只能去点「上移」按钮，
      // 遇到纯拖拽界面就彻底卡住并反复重试。
      if (an === "drag") {
        const pick = (refKey, objKey, xKey, yKey) => {
          const ref = act[refKey];
          if (ref) return { ref: String(ref) };
          const o = act[objKey];
          if (o && typeof o === "object") {
            const x = Number(o.x ?? o[0] ?? act[xKey]);
            const y = Number(o.y ?? o[1] ?? act[yKey]);
            if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
          }
          const fx = Number(act[xKey]), fy = Number(act[yKey]);
          if (Number.isFinite(fx) && Number.isFinite(fy)) return { x: fx, y: fy };
          return null;
        };
        const from = pick("fromRef", "from", "fromX", "fromY");
        const to = pick("toRef", "to", "toX", "toY");
        if (!from || !to) {
          return { ok: false, error: { code: "execution_error", message: `drag 缺少起点/终点（需要 fromRef/toRef 或 from{x,y}/to{x,y}）：${JSON.stringify(act).slice(0, 200)}` } };
        }
        await __bridgeLog(`[browser-bridge] drag from=${JSON.stringify(from)} to=${JSON.stringify(to)}`);
        const r = await engine({ method: "evaluate", expression: `(function(){${__MATCH_FN};
          const center=(t)=>{
            if(t==null) return null;
            if(t.ref){
              const els=__evoMatch(String(t.ref));
              if(!els.length) return null;
              const el=els[0]; el.scrollIntoView({block:'center'});
              const rc=el.getBoundingClientRect();
              return {el, x:rc.left+rc.width/2, y:rc.top+rc.height/2};
            }
            return {el:null, x:Number(t.x), y:Number(t.y)};
          };
          const a=center(${JSON.stringify(from)}), b=center(${JSON.stringify(to)});
          if(!a||!b) return {missing:true};
          const src=a.el||document.elementFromPoint(a.x,a.y);
          const tgt=b.el||document.elementFromPoint(b.x,b.y);
          if(!src||!tgt) return {missing:true};
          const mk=(type,x,y,extra)=>new DragEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,...(extra||{})});
          const dt=new DataTransfer();
          src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,clientX:a.x,clientY:a.y,dataTransfer:dt}));
          for(let i=1;i<=4;i++){
            const x=a.x+(b.x-a.x)*i/4, y=a.y+(b.y-a.y)*i/4;
            src.dispatchEvent(new DragEvent('drag',{bubbles:true,cancelable:true,clientX:x,clientY:y,dataTransfer:dt}));
            tgt.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,clientX:x,clientY:y,dataTransfer:dt}));
            tgt.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,clientX:x,clientY:y,dataTransfer:dt}));
          }
          tgt.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:b.x,clientY:b.y,dataTransfer:dt}));
          src.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:true,clientX:b.x,clientY:b.y,dataTransfer:dt}));
          return {ok:true, from:{x:Math.round(a.x),y:Math.round(a.y)}, to:{x:Math.round(b.x),y:Math.round(b.y)}}; })()` });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: "drag evaluate failed" } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        if (pv.missing) return { ok: false, error: { code: "execution_error", message: `drag 起点或终点找不到元素：from=${JSON.stringify(from)} to=${JSON.stringify(to)}` } };
        return { ok: true, value: true };
      }
      // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 scroll（滚动）。支持 {x,y}/{scrollX,scrollY} 与方向语义。
      // 为什么：现网实测 Tab.scroll() 返回 `unsupported`。长页面里「看不到就点不到」，
      // 缺滚动时模型只能靠 evaluate 手写 window.scrollTo，多一轮往返且常常滚错容器。
      if (an === "scroll") {
        const num = (...vs) => { for (const v of vs) { const n = Number(v); if (Number.isFinite(n)) return n; } return null; };
        const dx = num(act.scrollX, act.x, act.dx) ?? 0;
        const dy = num(act.scrollY, act.y, act.dy) ?? 0;
        const amount = num(act.amount);
        const dir = String(act.direction || "").toLowerCase();
        await __bridgeLog(`[browser-bridge] scroll dx=${dx} dy=${dy} amount=${amount} dir=${dir}`);
        const r = await engine({ method: "evaluate", expression: `(function(){
          const dir=${JSON.stringify(dir)}, amount=${amount === null ? "null" : amount};
          let dx=${dx}, dy=${dy};
          if(amount!==null&&dir){ if(dir==='down')dy=amount; else if(dir==='up')dy=-amount;
            else if(dir==='right')dx=amount; else if(dir==='left')dx=-amount; }
          const before={x:Math.round(window.scrollX),y:Math.round(window.scrollY)};
          window.scrollBy({left:dx,top:dy,behavior:'instant'});
          const after={x:Math.round(window.scrollX),y:Math.round(window.scrollY)};
          return {ok:true, before, after, moved:(after.x!==before.x||after.y!==before.y)}; })()` });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: "scroll evaluate failed" } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        // 页面已到顶/底时滚不动是正常现象，但要如实告诉模型「没动」，否则它会以为滚过了。
        return { ok: true, value: true, state: pv.moved === false ? "not_moved_top_or_bottom" : "moved", scroll: pv.after };
      }
      // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：新增 elementScreenshot（元素级截图）。
      // 为什么：客户端 Locator.elementScreenshot() 会发 operation="elementScreenshot"，
      // 桥无此分支 → `unsupported`。整页截图看不出单个控件是否渲染正确，
      // 模型只能截全页再猜位置，白烧一次大图。
      if (an === "elementScreenshot") {
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            const total=${countExprJs};
            if(!els.length)return {missing:true,total};
            if(els.length>1&&${strict ? "true" : "false"})return {ambiguous:els.length,total};
            const el=els[0]; el.scrollIntoView({block:'center'});
            const rc=el.getBoundingClientRect();
            return {ok:true, clip:{x:Math.max(0,rc.left),y:Math.max(0,rc.top),width:Math.max(1,rc.width),height:Math.max(1,rc.height)}}; })()`,
        });
        if (r && r.ok === false) return { ok: false, error: r.error || { code: "execution_error", message: "elementScreenshot bounds failed" } };
        const pv = r.value && typeof r.value === "object" ? r.value : {};
        if (pv.missing) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}` } };
        if (pv.ambiguous) return { ok: false, error: { code: "strict_mode_violation", message: `strict mode violation: ${pv.ambiguous} 个元素匹配 ${sel}` } };
        const shot = await engine({ method: "screenshot", clip: pv.clip });
        if (shot && shot.ok === false) return { ok: false, error: shot.error || { code: "execution_error", message: "elementScreenshot failed" } };
        return { ok: true, value: (shot && (shot.data || shot.image || shot.value)) ?? null };
      }
      if (an === "waitFor") {
        // 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
        // 改了什么：按 state（attached/visible/hidden/detached）真轮询，超时报错。
        // 为什么：原实现直接 `return { ok:true, value:true }`——不等一毫秒就告诉模型“等到了”，
        // 模型以为页面已就绪去点，点不到再重试 = 反复。
        const want = String(act.state || "visible").toLowerCase();
        const budget = Math.min(Number(act.timeout) || Number(act.timeoutMs) || 3000, 30000);
        const deadline = Date.now() + budget;
        const probe = async () => {
          const r = await engine({ method: "evaluate", expression: `(function(){${__MATCH_FN};
            const __all=${pickExprJs}; const els=Array.isArray(__all)?__all:[];
            if(!els.length) return {n:0, vis:false};
            const el=els[0]; const s=getComputedStyle(el); const rc=el.getBoundingClientRect();
            return {n:els.length, vis: !(s.display==='none'||s.visibility==='hidden'||rc.width<=0||rc.height<=0)}; })()` });
          return (r && r.value && typeof r.value === "object") ? r.value : { n: 0, vis: false };
        };
        let last = { n: 0, vis: false };
        while (Date.now() < deadline) {
          last = await probe();
          const done =
            want === "attached" ? last.n > 0 :
            want === "detached" ? last.n === 0 :
            want === "hidden" ? !last.vis : last.vis;
          if (done) return { ok: true, value: true };
          await new Promise((res) => setTimeout(res, 50));
        }
        return { ok: false, error: { code: "timeout", message: `locator.waitFor(${want}) 超时 ${budget}ms：${sel.slice(0, 120)}（命中 ${last.n} 个，可见=${last.vis}）` } };
      }
      return { ok: false, error: { code: "unsupported", message: `EvoFlow v1 暂不支持 playwright.${an}；可用：domSnapshot/click/dblclick/fill/type/press/selectOption/textContent/innerText/getAttribute/isVisible/isEnabled/count/evaluate/waitForLoadState/waitForURL/waitForTimeout。action=${JSON.stringify(act).slice(0, 160)}` } };
    };

  globalThis[__evoflowBridgeSymbol] = {
    documentationRoot: __docsRoot,
    assertAvailable: __assert,
    async list() {
      const body = await __gwFetch("/api/browser/tabs");
      const tab = (body.tabs || [])[0] || {};
      __logCmd({ kind: "list", url: tab.url, ok: true });
      return [{
        id: "evoflow-webview",
        type: "iab",
        active: true,
        capabilities: [{ id: "visibility", description: "Show or hide the browser pane" }],
        metadata: { source: "evoflow-gateway", url: tab.url, title: tab.title, viewport: tab.viewport },
      }];
    },
    async execute(_browserId, _generation, command) {
      await __assert();
      // ZCode 运行时（browser-client.mjs 的 BrowsersFacade）用 { method, params: {...} }
      // 嵌套形状；EvoFlow 引擎契约是平铺字段。这里统一解包 params 再透传，
      // 否则 navigate/screenshot 等全部报 "requires url"。
      const cmd = command && typeof command.params === "object" && command.params !== null
        ? { ...command, ...command.params }
        : command;
      const name = cmd?.method || "";
      if (!globalThis.__evoflowBridgeAnnounced) {
        globalThis.__evoflowBridgeAnnounced = true;
        await __bridgeLog(`[browser-bridge] ready docsRoot=${__docsRoot || "(empty)"} caps=playwrightWaitForTimeout,evaluate-awaitPromise,role,text,xpath,dom-outline`);
      }
      // Agent sometimes nests url as { url: "https://..." } — flatten before engine.
      if (cmd && cmd.url && typeof cmd.url === "object" && cmd.url !== null) {
        const nested = cmd.url.url || cmd.url.href || cmd.url.uri;
        if (nested) cmd.url = String(nested);
      }
      const url = cmd?.url || "";
      try {
        let result;
        if (__local[name]) {
          result = __local[name](cmd);
        } else if (name === "playwright") {
          result = await __pwHandle(cmd);
        } else if (name === "playwrightWaitForTimeout") {
          const ms = Math.min(Math.max(Number(cmd.timeoutMs) || 0, 0), 10000);
          await __bridgeLog(`[browser-bridge] playwrightWaitForTimeout ms=${ms}`);
          await new Promise((r) => setTimeout(r, ms));
          result = { ok: true, value: true };
        } else if (__direct.has(name)) {
          if (name === "navigate") {
            const u = typeof cmd.url === "string" ? cmd.url.trim() : "";
            if (!u) {
              await __bridgeLog(`[browser-bridge] navigate rejected: empty url cmd=${JSON.stringify(cmd).slice(0, 200)}`);
              result = { ok: false, error: { code: "execution_error", message: "navigate requires url" } };
            } else {
              await __bridgeLog(`[browser-bridge] navigate url=${u.slice(0, 160)}`);
              result = await __gwFetch("/api/browser/execute", { method: "POST", body: JSON.stringify({ command: cmd }) });
            }
          } else {
            result = await __gwFetch("/api/browser/execute", { method: "POST", body: JSON.stringify({ command: cmd }) });
          }
        } else if (__map[name]) {
          const mapped = __map[name](cmd, _browserId);
          if (mapped && mapped.url && typeof mapped.url === "object" && mapped.url !== null) {
            const nested = mapped.url.url || mapped.url.href || mapped.url.uri;
            if (nested) mapped.url = String(nested);
          }
          if (name === "newTab") {
            await __bridgeLog(`[browser-bridge] newTab -> ${mapped.method}${mapped.url ? " url=" + String(mapped.url).slice(0, 120) : " (no url, getState)"}`);
          }
          result = await __gwFetch("/api/browser/execute", { method: "POST", body: JSON.stringify({ command: mapped }) });
          if (mapped.__tab) result.tab = mapped.__tab;
          if ("__dialog" in mapped) result.dialog = mapped.__dialog;
        } else {
          result = __unsupported(name, cmd);
        }
        __attachTab(result);
        __logCmd({ kind: name, url, ok: result?.ok !== false });
        return result;
      } catch (err) {
        __logCmd({ kind: name, url, ok: false, error: String(err).slice(0, 160) });
        // 错误回显收到的命令：模型看到后能自纠命令形状（如 navigate 缺 url）。
        const cmdEcho = JSON.stringify(cmd || {}).slice(0, 200);
        throw new Error(`${String(err && err.message || err).slice(0, 300)} | cmd=${cmdEcho}`);
      }
    },
  };
  // ── CUA 桥（computer-use 插件）──
  // 宿主自带的桥只在 ZCODE_CUA_PERMISSION_BROKER_SOCKET 存在时可用（此时它是
  // 权威 provider：14 个工具面 + UIA 无障碍树 + 应用图标 + 会话租约全部原生），
  // 必须保留；缺失时回退 EvoFlow v1 视觉桥（网关 → cua_exec.ps1，截图 + SendInput）。
  const __cuaSymbol = Symbol.for("zcode.node-repl.computer-use-bridge");
  if (!process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET) {
    globalThis[__cuaSymbol] = {
      documentationRoot: __docsRoot,
      assertAvailable: async () => {},
      call: async (method, methodInput) => {
        try {
          const resp = await __gwFetch("/api/cua/execute", {
            method: "POST",
            body: JSON.stringify({ method, input: methodInput || {} }),
          });
          __logCmd({ kind: `cua:${method}`, ok: resp?.ok !== false });
          return resp; // CallToolResult 形状（content / isError）
        } catch (err) {
          __logCmd({ kind: `cua:${method}`, ok: false, error: String(err).slice(0, 160) });
          throw err;
        }
      },
    };
  } else {
    // 原生 broker 是权威通道但不落盘。包一层调用日志：每次 CUA 动作的
    // method / input / result / duration → logs/plugin-control.log ([mcp:cua-native]); without it CUA
    // "动作被吞"时无法定位是哪一击出的问题。fire-and-forget 上报，绝不阻塞动作。
    const __nativeCua = globalThis[__cuaSymbol];
    if (__nativeCua && typeof __nativeCua.call === "function") {
      const __origCuaCall = __nativeCua.call.bind(__nativeCua);
      const __cuaReport = async (msg) => {
        try {
          // 必须 await：内核每次调用后即销毁，fire-and-forget 的上报会随进程一起被丢弃。
          await __gwFetch("/api/browser/log", {
            method: "POST",
            body: JSON.stringify({ source: "kernel", entries: [{ msg: msg.slice(0, 1800) }] }),
          });
        } catch {}
      };
      __nativeCua.call = async (method, methodInput) => {
        const t0 = Date.now();
        let inputHead = "";
        try { inputHead = JSON.stringify(methodInput || {}).slice(0, 400); } catch {}
        __cuaReport(`[mcp:cua-native] CALL start method=${method} input=${inputHead}`);
        try {
          const r = await __origCuaCall(method, methodInput || {});
          let head = "";
          try { head = JSON.stringify(r).slice(0, 400); } catch {}
          await __cuaReport(
            `[mcp:cua-native] CALL done method=${method} ok=${r && r.isError ? "false" : "true"} dur=${((Date.now() - t0) / 1000).toFixed(1)}s result=${head}`,
          );
          return r;
        } catch (err) {
          await __cuaReport(`[mcp:cua-native] CALL FAILED method=${method} dur=${((Date.now() - t0) / 1000).toFixed(1)}s error=${String(err).slice(0, 300)}`);
          throw err;
        }
      };
    }
  }
}
"""

# Models often skip the official skill bootstrap and write:
#   const browser = require('browser-use')
# or bare `browser.tabs...` → "browser is not defined".
# Auto-load browser-client.mjs once per kernel, expose `browser` / `agent`,
# and shim require('browser-use') to the same object.
_BROWSER_AUTO_BOOTSTRAP_JS = r"""
await (async () => {
  // Re-wrap if an older kernel left browser without .bootstrap (frozen runtime object).
  if (globalThis.__evoflowBrowserBootstrapped && typeof globalThis.browser?.bootstrap === "function") {
    // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
    // 改了什么：短路分支里补一次 globalThis.tab 兜底解析。
    // 为什么：本次新增的 tab 预解析写在下面主流程里，而这里会先 return —— 不补这一手，
    // 只要内核曾 bootstrap 过，globalThis.tab 就永远是 undefined，文档承诺落空。
    if (!globalThis.tab) {
      try {
        const b = globalThis.browser;
        const list = b && b.tabs ? await b.tabs.list() : [];
        const first = list && list[0];
        if (first) {
          const t = await b.tabs.get(first.id);
          if (t) {
            globalThis.tab = t;
            try { global.tab = t; } catch (_) {}
          }
        }
      } catch (_) {}
    }
    return;
  }
  const root = String(process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || "").trim();
  if (!root) return;
  try {
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const clientUrl = pathToFileURL(join(root, "scripts", "browser-client.mjs")).href;
    const { setupBrowserRuntime } = await import(clientUrl);
    await setupBrowserRuntime({ globals: globalThis });
    let b = globalThis.browser;
    if (!b) {
      try { b = await globalThis.agent.browsers.get("iab"); } catch (_) {
        try { b = await globalThis.agent.browsers.getDefault(); } catch (_) { b = null; }
      }
    }
    if (b) {
      // Runtime objects are often non-extensible — Proxy so .bootstrap always exists.
      const wrapped = new Proxy(b, {
        get(target, prop, receiver) {
          if (prop === "bootstrap") return async () => wrapped;
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
        has(target, prop) {
          return prop === "bootstrap" || Reflect.has(target, prop);
        },
      });
      globalThis.browser = wrapped;
      try { global.browser = wrapped; } catch (_) {}
      if (b.tabs) {
        globalThis.tabs = b.tabs;
        try { global.tabs = b.tabs; } catch (_) {}
      }
      // 【self-evolution-bot · 2026-11-18 · 第59轮 · 模型:deepseek-v4.1-flash-1017】
      // 改了什么：预先把唯一的 tab 解析成 globalThis.tab（并同时挂 global.tab）。
      // 为什么：EvoFlow 只有一个内置 WebView，但模型每个 js cell
      // 都要自己走 tabs.list() → tabs.get() 才能拿到 tab。实测这三步固定开销
      // getForUrl 12.5ms + tabs.list 13.7ms + tabs.get 25.0ms ≈ 51ms，且 308 次调用里
      // 107 次手写了整段 bootstrap 前言（每次 ~494 字符）。预先解析后复用为 0ms。
      try {
        const list = await b.tabs.list();
        const first = list && list[0];
        if (first) {
          const t = await b.tabs.get(first.id);
          if (t) {
            globalThis.tab = t;
            try { global.tab = t; } catch (_) {}
          }
        }
      } catch (_) {
        // 解析失败不致命：模型仍可自行 tabs.list()。
      }
    }
    try {
      const Module = (await import("node:module")).default;
      if (Module && typeof Module._load === "function" && !Module.__evoflowBrowserUseShim) {
        const origLoad = Module._load;
        Module._load = function (request, parent, isMain) {
          if (request === "browser-use" || request === "@zcode/browser-use-plugin") {
            return globalThis.browser || globalThis.agent?.browsers || {};
          }
          return origLoad.apply(this, arguments);
        };
        Module.__evoflowBrowserUseShim = true;
      }
    } catch (_) {}
    globalThis.__evoflowBrowserBootstrapped = true;
  } catch (err) {
    globalThis.__evoflowBrowserBootstrapError = String((err && err.message) || err).slice(0, 300);
  }
})();
"""


# Strip invented calls the model keeps emitting even after host auto-bootstrap.
_FAKE_BROWSER_BOOTSTRAP_RE = re.compile(
    r"(?:await\s+)?(?:globalThis\.)?browser\.bootstrap\s*\(\s*\)\s*;?",
    re.IGNORECASE,
)


def _sanitize_model_browser_js(code: str) -> str:
    """Drop no-op / invented browser.bootstrap() so the rest of the cell can run."""
    text = str(code or "")
    cleaned = _FAKE_BROWSER_BOOTSTRAP_RE.sub("", text)
    if cleaned != text:
        _ulog("stripped invented browser.bootstrap() from model js")
    return cleaned

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_next_id = 3  # ids 1/2 reserved for the probe-free startup
_responses: dict[int, dict[str, Any]] = {}
_response_events: dict[int, threading.Event] = {}
_reader_thread: threading.Thread | None = None
# Gateway base baked into the kernel bridge JS at spawn time. If the desktop
# rebinds (profile port / runtime file) we must respawn — the bridge does not
# re-read env after boot.
_kernel_gw_base: str | None = None


def _meta_envelope(session_id: str | None = None) -> dict[str, Any]:
    # session_id：宿主 CUA broker 的 requestContext 依赖它（com.zcode/request-context，
    # desktop 版宿主为 .strict() schema；缺 session_id 时 broker 直接拒绝请求）。
    # 真实会话（EvoFlow thread_id）传入后，broker 的控制器租约（CONTROLLER_BUSY）、
    # 每会话状态（无障碍树基线、kill switch）都按会话隔离——多个对话同时操作桌面时
    # 只有持有租约的那个会成功，其余收到明确的忙错误而不是互相打断。
    sid = str(session_id or "").strip() or "evoflow-main"
    return {
        _META_KEY: _PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {"tools": {}},
        "io.modelcontextprotocol/clientInfo": {"name": "evoflow", "version": "1.0.0"},
        "com.zcode/request-context": {
            "session_id": sid,
            "runtime_scope": "main",
            "workspace_key": sid,
        },
    }


def resolve_host_server_js(storage_root: Path | None = None) -> Path | None:
    """Locate ``dist/mcp/server.js`` from the node-repl-host install cache.

    node-repl-host 不出现在市场清单（宿主运行时不对用户露出）。
    首次需要时从安装包 ``official-plugins-bundle`` 自愈复制到插件缓存。
    """
    try:
        if storage_root is None:
            from .storage import resolve_storage_root

            storage_root = resolve_storage_root()
        cache_root = storage_root / "cache" / "evoflow-plugins-official" / _NODE_REPL_HOST_PLUGIN
        if not cache_root.is_dir():
            _ensure_host_runtime_copied(storage_root, cache_root)
        version_dirs = sorted(
            (d for d in cache_root.iterdir() if d.is_dir()),
            key=lambda d: [int(part) if part.isdigit() else 0 for part in d.name.split(".")],
        ) if cache_root.is_dir() else []
        for version_dir in reversed(version_dirs):
            candidate = version_dir / _NODE_REPL_SERVER_REL
            if candidate.is_file():
                return candidate
    except Exception:  # noqa: BLE001
        logger.debug("node-repl-host resolution failed", exc_info=True)
    return None


def _ensure_host_runtime_copied(storage_root: Path, cache_root: Path) -> None:
    """Copy node-repl-host from the packaged official plugin bundle."""
    import shutil

    from .builtin import discover_bundled_official_cache

    bundle_root = discover_bundled_official_cache()
    if bundle_root is None:
        return
    host_dir = bundle_root / _NODE_REPL_HOST_PLUGIN
    if not host_dir.is_dir():
        return
    version_dirs = sorted(
        (d for d in host_dir.iterdir() if d.is_dir()),
        key=lambda d: [int(part) if part.isdigit() else 0 for part in d.name.split(".")],
    )
    for version_dir in reversed(version_dirs):
        if (version_dir / _NODE_REPL_SERVER_REL).is_file():
            cache_root.mkdir(parents=True, exist_ok=True)
            target = cache_root / version_dir.name
            if not (target / _NODE_REPL_SERVER_REL).is_file():
                shutil.copytree(version_dir, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git"))
                logger.info("node-repl-host runtime copied from packaged bundle: %s", target)
            return


def is_node_repl_available(storage_root: Path | None = None) -> bool:
    """The ``mcp__node_repl__js`` tool is offered when a dependent official
    plugin (browser-use / computer-use) is installed + enabled and the host
    runtime is present."""
    try:
        if resolve_host_server_js(storage_root) is None:
            return False
        from .storage import InstalledPluginsState, load_installed_plugins_state

        storage = (
            Path(storage_root)
            if storage_root
            else __import__("evoflow.plugins.storage", fromlist=["resolve_storage_root"]).resolve_storage_root()
        )
        state = load_installed_plugins_state(storage)
        for record in state.plugins:
            if record.name in ("browser-use", "computer-use") and state.is_enabled(record.id):
                return True
        return False
    except Exception:  # noqa: BLE001
        return False


def _pump_stdout(proc: subprocess.Popen) -> None:
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            request_id = message.get("id")
            if isinstance(request_id, int):
                _responses[request_id] = message
                event = _response_events.get(request_id)
                if event is not None:
                    event.set()
    finally:
        # 内核退出：唤醒所有在途等待，让调用方拿到"内核已退出"而不是傻等超时。
        for event in list(_response_events.values()):
            event.set()


def _latest_plugin_root(storage_root: Path, plugin_name: str) -> Path | None:
    """Latest installed version dir for a plugin (for plugin-root env injection)."""
    cache_root = Path(storage_root) / "cache" / "evoflow-plugins-official" / plugin_name
    if not cache_root.is_dir():
        return None
    version_dirs = sorted(
        (d for d in cache_root.iterdir() if d.is_dir()),
        key=lambda d: [int(p) if p.isdigit() else 0 for p in d.name.split(".")],
    )
    return version_dirs[-1] if version_dirs else None


def _browser_docs_root(storage_root: Path) -> str:
    """Plugin ``docs/`` so ``agent.documentation.get("screenshots")`` resolves."""
    root = _latest_plugin_root(storage_root, _BROWSER_USE_PLUGIN)
    if root is None:
        return ""
    docs = root / "docs"
    if (docs / "documents.json").is_file():
        return str(docs)
    return ""


def _ensure_process() -> subprocess.Popen:
    global _proc, _reader_thread, _kernel_gw_base
    from evoflow.gateway_http import gateway_port_from_base, resolve_gateway_base_url

    gw_url = resolve_gateway_base_url(allow_legacy_default=True) or "http://127.0.0.1:8070"
    if _proc is not None and _proc.poll() is None:
        if _kernel_gw_base and _kernel_gw_base.rstrip("/") == gw_url.rstrip("/"):
            return _proc
        # Gateway port moved (packaged rebind / env catch-up) — kill stale bridge.
        _ulog(f"kernel gateway changed {_kernel_gw_base} -> {gw_url}; respawning")
        try:
            _proc.kill()
        except Exception:
            pass
        _proc = None
        _kernel_gw_base = None

    from .storage import resolve_storage_root

    server_js = resolve_host_server_js(resolve_storage_root())
    if server_js is None:
        raise RuntimeError("node-repl-host runtime is not available in the plugin cache")
    _responses.clear()
    _response_events.clear()
    from .storage import resolve_storage_root as _rsr

    storage_root = _rsr()
    kernel_env = dict(os.environ)
    # Packaged desktop: Gateway is on a hashed profile port (8100..8999), not
    # :8070. Force-assign (do not setdefault) so a stale inherited 8070 cannot
    # win over EVOFLOW_GATEWAY_URL / backend-runtime.json.
    gw_port_n = gateway_port_from_base(gw_url)
    gw_port = str(gw_port_n) if gw_port_n else "8070"
    kernel_env["EVOFLOW_GATEWAY_URL"] = gw_url
    kernel_env["EVOFLOW_GATEWAY_PORT"] = gw_port
    _ulog(f"kernel gateway base={gw_url}")
    # 浏览器/CUA 桥命令面共享令牌：桥 JS 每次请求携带 X-EvoFlow-Bridge-Token 头，
    # 网关 _bridge_token_guard 强制校验（bridge_auth，持久化 token 重启稳定）。
    try:
        from .bridge_auth import get_bridge_token

        kernel_env["EVOFLOW_BROWSER_BRIDGE_TOKEN"] = get_bridge_token()
    except Exception:
        logger.warning("bridge token unavailable; kernel bridge requests may be rejected", exc_info=True)
    # 官方插件技能的 bootstrap 依赖插件根目录 env（control-browser 读
    # ZCODE_PLUGIN_ROOT/scripts/browser-client.mjs；computer-use 读
    # ZCODE_CUA_PLUGIN_ROOT/scripts/computer-use-client.mjs）。
    for plugin_name, env_key in (
        (_BROWSER_USE_PLUGIN, "ZCODE_PLUGIN_ROOT"),
        (_BROWSER_USE_PLUGIN, "CLAUDE_PLUGIN_ROOT"),
        (_COMPUTER_USE_PLUGIN, "ZCODE_CUA_PLUGIN_ROOT"),
    ):
        if not kernel_env.get(env_key):
            plugin_root = _latest_plugin_root(storage_root, plugin_name)
            if plugin_root:
                kernel_env[env_key] = str(plugin_root)
    docs_root = _browser_docs_root(storage_root)
    if docs_root:
        kernel_env["EVOFLOW_BROWSER_DOCS_ROOT"] = docs_root
    _ulog(
        "kernel env "
        f"docsRoot={docs_root or '(empty)'} "
        f"pluginRoot={kernel_env.get('ZCODE_PLUGIN_ROOT') or '(empty)'}"
    )
    # CUA 原生链路：helper 运行时可用时注入 broker socket + fork 配方，
    # 激活宿主自带的 broker（14 工具面 + UIA + 图标 + 会话租约）。
    # 不可用时保持无 socket，内核桥 JS 会回退到网关 v1 视觉桥。
    try:
        from .cua_helper import kernel_env_overlay

        kernel_env.update(kernel_env_overlay(storage_root))
    except Exception:  # noqa: BLE001
        logger.warning("cua helper overlay unavailable; CUA stays on visual bridge", exc_info=True)
    from evoflow.utils.subprocess_platform import subprocess_hide_window_kwargs

    # node.exe 是控制台子系统；不带 CREATE_NO_WINDOW 时会弹出黑窗。
    # 官方内核把 process.title 写成 zcode-node-repl-mcp，preload 把它改成 evoflow-node-repl。
    # ZCODE_PLUGIN_ROOT 等变量名必须保留：官方 skill 按这个名字读插件根目录，不会出现在窗口标题上。
    preload = Path(__file__).with_name("evoflow_node_repl_preload.cjs")
    if not preload.is_file():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            frozen_preload = Path(meipass) / "evoflow" / "plugins" / "evoflow_node_repl_preload.cjs"
            if frozen_preload.is_file():
                preload = frozen_preload
    node_argv = ["node", str(server_js)]
    if preload.is_file():
        node_argv = ["node", "-r", str(preload), str(server_js)]
    _proc = subprocess.Popen(
        node_argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        cwd=str(server_js.parent),
        env=kernel_env,
        **subprocess_hide_window_kwargs(),
    )
    _reader_thread = threading.Thread(target=_pump_stdout, args=(_proc,), daemon=True)
    _reader_thread.start()
    _kernel_gw_base = gw_url
    logger.info("node-repl-host kernel started: %s (gateway=%s)", server_js, gw_url)
    return _proc


def _request(
    method: str,
    params: dict[str, Any],
    timeout_sec: float,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Send one JSON-RPC request; concurrent callers wait on per-id events.

    写入只在锁内做一行（快进快出），等待在锁外按 id 挂起——一个 CUA 调用跑 120s
    不会再阻塞其它会话的浏览器调用；宿主侧按 request-context 的 session_id 做
    每会话队列与 CUA 控制器租约。
    """
    global _next_id
    with _lock:
        proc = _ensure_process()
        request_id = _next_id
        _next_id += 1
        event = threading.Event()
        _response_events[request_id] = event
        try:
            payload = {**params, "_meta": _meta_envelope(session_id)}
            assert proc.stdin is not None
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": payload}) + "\n")
            proc.stdin.flush()
        except Exception:
            _response_events.pop(request_id, None)
            _responses.pop(request_id, None)
            raise
    completed = event.wait(timeout_sec)
    _response_events.pop(request_id, None)
    if not completed:
        if proc.poll() is not None:
            raise RuntimeError("node-repl-host kernel exited unexpectedly")
        raise TimeoutError(f"node-repl-host {method} timed out after {timeout_sec}s")
    response = _responses.pop(request_id, None)
    if response is None:
        raise RuntimeError("node-repl-host kernel exited unexpectedly")
    return response


def call_node_repl_js_structured(
    code: str,
    timeout_ms: int = 120_000,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Execute JavaScript in the node-repl-host kernel; return the full result.

    返回 ``{"text", "images", "meta", "is_error"}``：

    - ``text`` — 全部 text block 拼接（模型可见正文）。
    - ``images`` — ``[{"data": <base64>, "mime_type": "image/png"}]``；宿主的
      structured sink（getAXStateAndScreenshot / getScreenshot 的 emit）会把截图作为
      image block 放进 content，v1 驱动把它丢掉导致视觉闭环断裂，这里必须保留。
    - ``meta`` — 结果 ``_meta``（ZCode 的 ``zcode/nodeReplCuaApp`` 目标应用身份、
      帧完整性签名等宿主专用元数据），供展示层构建 target-app 卡片；模型面不消费。

    ``session_id`` 传真实会话（thread）id：broker 按会话隔离状态并仲裁桌面控制器
    租约；缺省回退 "evoflow-main"。
    """
    started = time.monotonic()
    code = _sanitize_model_browser_js(code)
    preview = " ".join(code.split())[:160]
    _ulog(f"js call start ({len(code)} chars): {preview}")
    try:
        response = _request(
            "tools/call",
            {
                "name": "js",
                "arguments": {
                    "code": _BRIDGE_SETUP_JS + "\n" + _BROWSER_AUTO_BOOTSTRAP_JS + "\n" + code,
                    "timeout_ms": min(int(timeout_ms), 120_000),
                },
            },
            timeout_sec=timeout_ms / 1000 + 15,
            session_id=session_id,
        )
    except Exception as exc:
        _ulog(f"js call FAILED after {time.monotonic() - started:.1f}s: {exc}")
        raise
    if "error" in response:
        _ulog(f"js call jsonrpc error: {json.dumps(response['error'], ensure_ascii=False)[:200]}")
        raise RuntimeError(f"node_repl js error: {json.dumps(response['error'], ensure_ascii=False)[:400]}")
    result = response.get("result") or {}
    blocks = [block for block in result.get("content") or [] if isinstance(block, dict)]

    def _is_frame_authority(block: dict[str, Any]) -> bool:
        # broker 附着在结果里的帧凭证（{"image_ref": {...}}，单键 JSON）是宿主专用
        # 元数据：ZCode 侧从不把它展示给模型，这里同样过滤。
        if block.get("type") != "text" or not isinstance(block.get("text"), str):
            return False
        try:
            parsed = json.loads(block["text"])
        except ValueError:
            return False
        return isinstance(parsed, dict) and list(parsed.keys()) == ["image_ref"]

    text = "\n".join(
        str(block.get("text") or "")
        for block in blocks
        if block.get("type") == "text" and not _is_frame_authority(block)
    )
    images = [
        {"data": str(block["data"]), "mime_type": str(block.get("mimeType") or "image/png")}
        for block in blocks
        if block.get("type") == "image" and isinstance(block.get("data"), str) and block["data"]
    ]
    meta = result.get("_meta") if isinstance(result.get("_meta"), dict) else None
    if result.get("isError"):
        message = "node_repl js failed: " + text[:800]
        _ulog(f"js call isError after {time.monotonic() - started:.1f}s: {message[:200]}")
        return {"text": text, "images": images, "meta": meta, "is_error": True, "error": message}
    _ulog(
        f"js call ok in {time.monotonic() - started:.1f}s, text {len(text)} chars, "
        f"images {len(images)}, meta {'yes' if meta else 'no'}"
    )
    return {"text": text, "images": images, "meta": meta, "is_error": False, "error": None}


def call_node_repl_js(
    code: str,
    timeout_ms: int = 120_000,
    session_id: str | None = None,
) -> str:
    """Execute JavaScript in the node-repl-host kernel; returns the text result.

    每次 call 都先注入：
    1. 浏览器桥 setup（幂等）—— control-browser 读
       ``Symbol.for("zcode.node-repl.browser-control-bridge")``；
    2. browser-client 自动 bootstrap（幂等）—— 暴露 ``agent`` / ``browser``，
       并 shim ``require('browser-use')``，避免模型跳过官方引导直接报错。
    """
    structured = call_node_repl_js_structured(code, timeout_ms, session_id=session_id)
    if structured["is_error"]:
        raise RuntimeError(structured["error"] or "node_repl js failed")
    return structured["text"]


def shutdown() -> None:
    global _proc, _kernel_gw_base
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _proc.kill()
        _proc = None
        _kernel_gw_base = None
