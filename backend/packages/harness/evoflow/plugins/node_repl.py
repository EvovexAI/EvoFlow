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
  const __gwPort = process.env.EVOFLOW_GATEWAY_PORT || "8070";
  const __gwBase = `http://127.0.0.1:${__gwPort}`;
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
  const __MATCH_FN = `
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
      const roleOf = (el) => {
        const r = (el.getAttribute("role") || "").toLowerCase();
        if (r) return r;
        const tag = el.tagName;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (tag === "TEXTAREA" || el.isContentEditable) return "textbox";
        if (tag === "INPUT") {
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "button" || type === "submit" || type === "reset") return "button";
          if (type === "hidden" || type === "file") return type;
          return "textbox";
        }
        if (tag === "BUTTON") return "button";
        if (tag === "A") return "link";
        if (tag === "SELECT") return "combobox";
        return tag.toLowerCase();
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
        const role = (bracket >= 0 ? raw.slice(0, bracket) : raw).toLowerCase();
        let want = "";
        let exact = false;
        if (bracket >= 0 && raw.endsWith("]")) {
          const body = raw.slice(bracket + 6, -1);
          exact = body.endsWith("s");
          const literal = exact || body.endsWith("i") ? body.slice(0, -1) : body;
          try { want = JSON.parse(literal); } catch (e) { want = literal; }
        }
        const all = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable='true']"));
        return all.filter((el) => {
          if (roleOf(el) !== role || !visible(el)) return false;
          if (!want) return true;
          const n = nameOf(el);
          return exact ? n === String(want) : n.toLowerCase().includes(String(want).toLowerCase());
        });
      }
      if (sel.startsWith("internal:text=")) {
        const raw = sel.slice("internal:text=".length);
        const flag = raw.slice(-1);
        let want = raw.slice(0, -1);
        try { want = JSON.parse(want); } catch (e) {}
        const exact = flag === "s";
        const needle = String(want);
        const nodes = Array.from(document.querySelectorAll("a,button,h1,h2,h3,h4,h5,p,span,li,td,label,div"));
        const hits = [];
        for (const el of nodes) {
          const t = String(el.innerText || "").trim();
          if (!t || !visible(el)) continue;
          const ok = exact ? t === needle : t.toLowerCase().includes(needle.toLowerCase());
          if (!ok) continue;
          hits.push(el);
          if (hits.length >= 8) break;
        }
        return hits;
      }
      try { return Array.from(document.querySelectorAll(sel)); }
      catch (e) { return []; }
    }
  `;
  const __locatorMode = (sel) => {
    const s = String(sel || "");
    if (s.startsWith("internal:role=")) return "role";
    if (s.startsWith("internal:text=")) return "text";
    if (s.startsWith("xpath=") || s.startsWith("//") || s.startsWith("(//")) return "xpath";
    if (s.startsWith("internal:")) return "internal-other";
    return "css";
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
      const engine = (command) => __gwFetch("/api/browser/execute", { method: "POST", body: JSON.stringify({ command }) });
      const rawSel = () => String(act.locator?.selector || act.selector || "");
      if (an === "domSnapshot") {
        // 引擎 snapshot 返回结构化 {url,title,elements[],dom[]}；运行时契约要字符串。
        // 交互元素给坐标；dom 大纲把标题/段落/单元格正文带回来（天气卡片不在 button 上）。
        const r = await engine({ method: "snapshot", maxElements: 400 });
        const snap = r.snapshot || {};
        const els = Array.isArray(snap.elements) ? snap.elements : [];
        const lines = els.map((el) => {
          const ref = el.ref ? `[${el.ref}]` : "";
          const geo = el.x != null ? ` x=${Math.round(el.x)},y=${Math.round(el.y)}` : "";
          const box = el.rect && el.rect.x != null ? ` x=${Math.round(el.rect.x)},y=${Math.round(el.rect.y)}` : geo;
          return `${ref} ${el.role || el.tag || "node"} "${String(el.name || el.text || "").slice(0, 80)}"${box}`.trim();
        });
        const outline = Array.isArray(snap.dom) ? snap.dom : [];
        const textLines = outline.slice(0, 80).map((node) => {
          const pad = "  ".repeat(Math.min(Number(node.depth) || 0, 6));
          return `${pad}${node.tag || "text"} "${String(node.text || "").slice(0, 160)}"`;
        });
        const value = `page: ${snap.url || ""} | ${snap.title || ""}
${lines.join(String.fromCharCode(10))}
${textLines.length ? "text:" + String.fromCharCode(10) + textLines.join(String.fromCharCode(10)) : ""}`;
        await __bridgeLog(`[browser-bridge] domSnapshot elements=${els.length} textNodes=${textLines.length} url=${snap.url || ""}`);
        return { ok: true, value };
      }
      if (an === "waitForLoadState") {
        // 引擎 navigate 已等待 document.readyState=complete；这里直接确认。
        return { ok: true, value: true };
      }
      if (an === "waitForURL") {
        const want = String(act.url || "");
        for (let i = 0; i < 10; i++) {
          const st = await engine({ method: "getState" });
          if (st.state?.url && st.state.url.startsWith(want)) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        return { ok: true, value: true };
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
        const r = await engine({ method: "evaluate", expression, awaitPromise: true });
        let preview = "";
        try { preview = JSON.stringify(r.value).slice(0, 180); } catch (e) { preview = String(r.value); }
        await __bridgeLog(`[browser-bridge] evaluate done valueType=${typeof r.value} preview=${preview}`);
        return { ok: true, value: r.value ?? null };
      }
      if (an === "elementInfo") {
        return await engine({ method: "elementInfo", ...(act.options || {}) });
      }
      if (an === "waitForTimeout") {
        await new Promise((r) => setTimeout(r, Math.min(Number(act.timeoutMs) || 0, 3000)));
        return { ok: true, value: true };
      }
      const sel = rawSel();
      const needsSelector = ["click", "dblclick", "fill", "type", "selectOption", "textContent", "innerText", "allTextContents", "getAttribute", "isVisible", "isEnabled", "count"].includes(an);
      if (needsSelector && !sel) {
        return { ok: false, error: { code: "unsupported", message: `EvoFlow 浏览器桥缺少 selector（${an}）。action=${JSON.stringify(act).slice(0, 200)}` } };
      }
      if (needsSelector && __locatorMode(sel) === "internal-other") {
        await __bridgeLog(`[browser-bridge] locator unsupported mode=internal-other op=${an} sel=${sel.slice(0, 160)}`);
        return { ok: false, error: { code: "unsupported", message: `EvoFlow 浏览器桥暂未实现该 Playwright 定位器（${sel.slice(0, 80)}）。role/text/xpath/css 可用。` } };
      }
      if (an === "click" || an === "dblclick") {
        await __bridgeLog(`[browser-bridge] locator op=${an} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; const el=__evoMatch(${JSON.stringify(sel)})[0]; if(!el)return null; el.scrollIntoView({block:'center'}); const rc=el.getBoundingClientRect(); return {x:rc.left+rc.width/2,y:rc.top+rc.height/2,n:__evoMatch(${JSON.stringify(sel)}).length}; })()`,
        });
        const pt = r.value && typeof r.value === "object" ? r.value : null;
        await __bridgeLog(`[browser-bridge] locator ${an} hits=${pt ? pt.n : 0}`);
        if (!pt) return { ok: false, error: { code: "execution_error", message: `element not found: ${sel}` } };
        const out = { ok: true, value: true };
        await engine({ method: an === "dblclick" ? "dblclick" : "click", x: pt.x, y: pt.y });
        return out;
      }
      if (an === "fill" || an === "type") {
        const text = String(act.text ?? act.value ?? "");
        await __bridgeLog(`[browser-bridge] locator op=${an} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; const el=__evoMatch(${JSON.stringify(sel)})[0]; if(!el)throw new Error('element not found'); el.focus(); const d=Object.getOwnPropertyDescriptor((el.__proto__||Object.getPrototypeOf(el)),'value'); if(d&&d.set)d.set.call(el,${JSON.stringify(text)}); else el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
        });
        return { ok: true, value: r.value ?? true };
      }
      if (an === "press") {
        return await engine({ method: "press", key: String(act.key || "Enter") });
      }
      if (an === "selectOption") {
        await __bridgeLog(`[browser-bridge] locator op=selectOption mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; const el=__evoMatch(${JSON.stringify(sel)})[0]; if(!el)throw new Error('element not found'); el.value=${JSON.stringify(String(act.value ?? ""))}; el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`,
        });
        return { ok: true, value: r.value ?? true };
      }
      if (an === "textContent" || an === "innerText" || an === "allTextContents") {
        const prop = an === "innerText" ? "innerText" : "textContent";
        const many = an === "allTextContents";
        await __bridgeLog(`[browser-bridge] locator op=${an} mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; const els=__evoMatch(${JSON.stringify(sel)}); ${many ? "return els.map(e=>e." + prop + ");" : "return els.length ? els[0]." + prop + " : null;"} })()`,
        });
        return { ok: true, value: r.value ?? null };
      }
      if (an === "getAttribute") {
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; const el=__evoMatch(${JSON.stringify(sel)})[0]; return el ? el.getAttribute(${JSON.stringify(String(act.name || act.attribute || ""))}) : null; })()`,
        });
        return { ok: true, value: r.value ?? null };
      }
      if (an === "isVisible" || an === "isEnabled") {
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; const el=__evoMatch(${JSON.stringify(sel)})[0]; if(!el)return false; ${an === "isEnabled" ? "return !el.disabled;" : "const s=getComputedStyle(el); return s.display!=='none'&&s.visibility!=='hidden'&&el.getBoundingClientRect().width>0;"} })()`,
        });
        return { ok: true, value: !!r.value };
      }
      if (an === "count") {
        await __bridgeLog(`[browser-bridge] locator op=count mode=${__locatorMode(sel)} sel=${sel.slice(0, 160)}`);
        const r = await engine({
          method: "evaluate",
          expression: `(function(){${__MATCH_FN}; return __evoMatch(${JSON.stringify(sel)}).length; })()`,
        });
        const n = Number(r.value) || 0;
        await __bridgeLog(`[browser-bridge] locator count=${n} mode=${__locatorMode(sel)}`);
        return { ok: true, value: n };
      }
      if (an === "waitFor") {
        return { ok: true, value: true };
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

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_next_id = 3  # ids 1/2 reserved for the probe-free startup
_responses: dict[int, dict[str, Any]] = {}
_response_events: dict[int, threading.Event] = {}
_reader_thread: threading.Thread | None = None


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
    global _proc, _reader_thread
    if _proc is not None and _proc.poll() is None:
        return _proc
    from .storage import resolve_storage_root

    server_js = resolve_host_server_js(resolve_storage_root())
    if server_js is None:
        raise RuntimeError("node-repl-host runtime is not available in the plugin cache")
    _responses.clear()
    _response_events.clear()
    from .storage import resolve_storage_root as _rsr

    storage_root = _rsr()
    kernel_env = dict(os.environ)
    kernel_env.setdefault("EVOFLOW_GATEWAY_PORT", os.getenv("EVOFLOW_GATEWAY_PORT", "8070"))
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
    logger.info("node-repl-host kernel started: %s", server_js)
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
    preview = " ".join(code.split())[:160]
    _ulog(f"js call start ({len(code)} chars): {preview}")
    try:
        response = _request(
            "tools/call",
            {"name": "js", "arguments": {"code": _BRIDGE_SETUP_JS + "\n" + code, "timeout_ms": min(int(timeout_ms), 120_000)}},
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

    每次 call 都先注入浏览器桥 setup（幂等 ``??=``）：control-browser 技能的
    bootstrap 读取 ``Symbol.for("zcode.node-repl.browser-control-bridge")``，
    桥用 fetch 把 ZCode 浏览器命令转发给 EvoFlow Gateway（本地请求免鉴权）。
    """
    structured = call_node_repl_js_structured(code, timeout_ms, session_id=session_id)
    if structured["is_error"]:
        raise RuntimeError(structured["error"] or "node_repl js failed")
    return structured["text"]


def shutdown() -> None:
    global _proc
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _proc.kill()
        _proc = None
