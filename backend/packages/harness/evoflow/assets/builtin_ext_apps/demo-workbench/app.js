/* 演示工作台 — 对接 EvoFlow 网关 API 的单页演示应用。
   数据全部来自本机网关（同源相对路径 /api/...，本机默认零鉴权）：
   - 员工体系：/api/proactive/roles*、/sessions/*（roster + busy + 工作板 + 会话回放）
   - 工作流：  /api/apps*（列表 / 运行 / run 详情 2s 轮询拿节点级进度与输出）
   - 总览：    /api/tasks（任务中心最近记录）
   源码在用户数据目录 ui-extensions/demo-workbench/，改完刷新本页即生效。 */

(function () {
  "use strict";

  /* ────────────────────────── 基础设施 ────────────────────────── */

  var state = {
    view: "overview",
    roles: [],
    busyMap: {},
    apps: [],
    tasks: [],
    empQuery: "",
    empDetail: null, // { code, role, tab, sessionKey, conversations, messages }
    runView: null, // { runId, appId, status, progress, steps, lastFetch }
    runHistory: null, // { appId, items }
  };

  var pollers = {};
  function setPoller(name, fn, ms) {
    clearPoller(name);
    pollers[name] = setInterval(fn, ms);
  }
  function clearPoller(name) {
    if (pollers[name]) {
      clearInterval(pollers[name]);
      pollers[name] = null;
    }
  }
  function clearViewPollers() {
    ["overview", "employees", "run", "messages", "detail"].forEach(clearPoller);
  }

  function apiFetch(method, path, body, timeoutMs) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl
      ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000)
      : null;
    var opts = { method: method, headers: { Accept: "application/json" }, signal: ctrl ? ctrl.signal : undefined };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts)
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            var detail = t;
            try { detail = (JSON.parse(t) || {}).detail || t; } catch (e) { /* keep text */ }
            var err = new Error("HTTP " + res.status + (detail ? " · " + String(detail).slice(0, 200) : ""));
            err.status = res.status;
            throw err;
          });
        }
        var ct = res.headers.get("content-type") || "";
        return ct.indexOf("json") >= 0 ? res.json() : res.text();
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }
  function apiGet(path, timeoutMs) { return apiFetch("GET", path, undefined, timeoutMs); }
  function apiPost(path, body) { return apiFetch("POST", path, body === undefined ? {} : body); }

  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function page() { return document.getElementById("page"); }

  /* 轮询重绘护栏：内容没变就不动 DOM —— 保住输入框焦点、不打断进行中的点击、
     不重置输出区滚动位置。key 是渲染上下文（视图/页签），跨视图切换必然重绘。
     返回 true 表示真的重绘了（调用方才需要重挂事件）。 */
  function paintIfChanged(el, key, html) {
    if (!el) return false;
    if (el.__paintKey === key && el.__lastPaint === html) return false;
    el.__paintKey = key;
    el.__lastPaint = html;
    el.innerHTML = html;
    return true;
  }

  function toast(msg, isErr) {
    var wrap = document.getElementById("toast-wrap");
    var el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var diff = Date.now() - d.getTime();
    if (diff >= 0 && diff < 60000) return "刚刚";
    if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff >= 0 && diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDuration(a, b) {
    if (!a || !b) return "";
    var ms = new Date(b).getTime() - new Date(a).getTime();
    if (isNaN(ms) || ms < 0) return "";
    if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + "s";
    return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
  }
  function pct(v) {
    var n = Number(v);
    if (isNaN(n)) n = 0;
    if (n <= 1 && n > 0 && String(v || "").indexOf(".") >= 0) n = n * 100; // 0.x 形态
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  var RUN_STATUS = {
    running: ["run", "运行中"],
    completed: ["ok", "已完成"],
    failed: ["fail", "失败"],
    cancelled: ["idle", "已取消"],
    canceled: ["idle", "已取消"],
    paused: ["warn", "已暂停"],
    planned: ["idle", "排队中"],
    pending: ["idle", "待执行"],
    executing: ["run", "执行中"],
    timed_out: ["fail", "超时"],
  };
  function runChip(status) {
    var key = String(status || "pending").toLowerCase();
    var hit = RUN_STATUS[key] || ["idle", key || "未知"];
    return '<span class="chip ' + hit[0] + '"><span class="chip-dot"></span>' + esc(hit[1]) + "</span>";
  }

  var AVATAR_HUES = [222, 258, 288, 340, 12, 32, 152, 190];
  function avatarStyle(seed) {
    var s = String(seed || "?");
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var hue = AVATAR_HUES[h % AVATAR_HUES.length];
    return "background:linear-gradient(135deg,hsl(" + hue + ",68%,58%),hsl(" + ((hue + 34) % 360) + ",62%,46%))";
  }
  function initials(name) {
    var s = String(name || "?").trim();
    return s.slice(0, 1).toUpperCase();
  }

  var ICON = {
    flow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="12" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.5 7.3 15.5 11"/><path d="M8.4 16.6 15.5 13"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.4"/><path d="M3.5 19.5c.7-3.2 2.9-4.8 5.5-4.8s4.8 1.6 5.5 4.8"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16 14.6c2.1.2 3.7 1.5 4.4 3.9"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.4-6 4 12L16 12h5"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5" opacity="0.45"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M6.2 5h11.6l2.2 8v6H4v-6l2.2-8Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 5-7 7 7 7"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  };

  /* ────────────────────────── 健康探测 ────────────────────────── */

  function checkHealth() {
    apiGet("/health/liveness", 5000)
      .then(function () { paintHealth(true); })
      .catch(function () { paintHealth(false); });
  }
  function paintHealth(ok) {
    var dot = document.getElementById("gw-dot");
    var label = document.getElementById("gw-label");
    var port = document.getElementById("gw-port");
    var chip = document.getElementById("live-chip");
    var text = document.getElementById("live-text");
    dot.className = "sys-dot " + (ok ? "ok" : "down");
    label.textContent = ok ? "网关已连接" : "网关不可达";
    port.hidden = !window.location.port;
    port.textContent = window.location.port ? "端口 " + window.location.port : "";
    chip.className = "live-chip " + (ok ? "ok" : "down");
    text.textContent = ok ? "实时数据流正常" : "连接中断，重试中";
  }

  /* ────────────────────────── 视图路由 ────────────────────────── */

  function setView(view) {
    state.view = view;
    clearViewPollers();
    document.querySelectorAll("#primary-nav .nav-item").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    document.getElementById("crumb-view").textContent =
      view === "overview" ? "总览" : view === "employees" ? "员工体系" : "工作流";
    if (view === "overview") { renderOverviewSkeleton(); refreshOverview(); setPoller("overview", refreshOverview, 6000); }
    if (view === "employees") { renderEmployeesSkeleton(); refreshEmployees(); setPoller("employees", refreshEmployeesLight, 5000); }
    if (view === "workflows") { state.runView = null; renderWorkflowsSkeleton(); refreshWorkflows(); }
  }

  document.getElementById("primary-nav").addEventListener("click", function (e) {
    var btn = e.target.closest(".nav-item");
    if (btn) setView(btn.getAttribute("data-view"));
  });
  document.getElementById("btn-refresh").addEventListener("click", function () {
    if (state.view === "overview") refreshOverview();
    else if (state.view === "employees") refreshEmployees();
    else if (state.view === "workflows" && state.runView) pollRun(true);
    else if (state.view === "workflows") refreshWorkflows();
  });

  /* ────────────────────────── 总览 ────────────────────────── */

  function renderOverviewSkeleton() {
    var html =
      '<div class="hero"><h1>EvoFlow 演示工作台</h1>' +
      "<p>系统内置演示应用：左侧「员工体系」实时展示演示员工的花名册、忙碌状态、工作板与会话记录；「工作流」可一键运行演示工作流并观看每个节点的实时进度与输出。</p>" +
      '<div class="hero-actions"><button class="hero-btn" data-goto="employees">查看员工体系</button>' +
      '<button class="hero-btn" data-goto="workflows">运行演示工作流</button></div></div>' +
      '<div class="metrics-grid">' + Array(4).join('<div class="metric-card"><div class="metric-icon">' + ICON.people + '</div><div class="metric-body"><div class="metric-value">—</div><div class="metric-label">加载中…</div></div></div>') + "</div>" +
      '<div class="skeleton" style="height:180px"></div>';
    if (!paintIfChanged(page(), "sk-overview", html)) return;
    page().querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () { setView(b.getAttribute("data-goto")); });
    });
  }

  function busyCodesParam() {
    return state.roles
      .map(function (r) { return r.agent_code; })
      .filter(Boolean)
      .map(encodeURIComponent)
      .join(",");
  }

  /* 部分端点（如 /api/tasks 带 page 参数时）返回 {success, data:{...}} 包裹形态。 */
  function unwrapData(payload, key) {
    if (!payload) return undefined;
    if (payload[key] !== undefined) return payload[key];
    if (payload.data && payload.data[key] !== undefined) return payload.data[key];
    return undefined;
  }

  function refreshOverview() {
    apiGet("/api/proactive/roles")
      .then(function (r) { state.roles = (r && r.roles) || []; })
      .catch(function () { state.roles = []; })
      .then(function () {
        return Promise.all([
          apiGet("/api/proactive/roles-busy?codes=" + busyCodesParam()).catch(function () { return { busy: {} }; }),
          apiGet("/api/apps").catch(function () { return []; }),
          apiGet("/api/tasks?page_size=8&hide_noise=true").catch(function () { return {}; }),
        ]);
      })
      .then(function (r) {
        state.busyMap = (r[0] && r[0].busy) || {};
        state.apps = Array.isArray(r[1]) ? r[1] : (r[1] && r[1].apps) || [];
        state.tasks = unwrapData(r[2], "tasks") || [];
        paintOverview();
      })
      .catch(function () { /* 各自已兜底 */ });
  }

  function busyCount() {
    var n = 0;
    Object.keys(state.busyMap || {}).forEach(function (k) { if (state.busyMap[k] && state.busyMap[k].busy) n++; });
    return n;
  }

  function paintOverview() {
    var roles = state.roles;
    var active = roles.filter(function (r) { return String(r.status || "active") === "active"; }).length;
    var busy = busyCount();
    var apps = state.apps;
    var totalRuns = apps.reduce(function (s, a) { return s + (Number(a.total_runs) || 0); }, 0);
    var running = state.tasks.filter(function (t) {
      var s = String(t.status || "").toLowerCase();
      return s === "running" || s === "executing" || s === "planned";
    }).length;

    var busyChips = roles
      .filter(function (r) { var b = state.busyMap[r.agent_code]; return b && b.busy; })
      .map(function (r) {
        var b = state.busyMap[r.agent_code] || {};
        var label = empName(r) + " · " + (b.current_session_key ? String(b.current_session_key).split(":").slice(-1)[0] : "任务中");
        return '<span class="chip run" title="' + esc(b.current_session_key || "") + '"><span class="chip-dot"></span>' + esc(label) + "</span>";
      }).join(" ");

    var taskRows = state.tasks
      .map(function (t) {
        return (
          '<div class="task-row"><div class="task-main"><div class="task-name">' + esc(t.name || t.id || "未命名任务") + "</div>" +
          '<div class="task-desc">' + esc(t.id || "") + " · " + esc(fmtTime(t.updated_at || t.created_at)) + "</div></div>" +
          '<div class="task-progress">' + runChip(t.status) +
          '<div class="pct">' + pct(t.progress) + "%</div></div></div>"
        );
      }).join("");

    var html =
      '<div class="hero"><h1>EvoFlow 演示工作台</h1>' +
      "<p>系统内置演示应用：左侧「员工体系」实时展示演示员工的花名册、忙碌状态、工作板与会话记录；「工作流」可一键运行演示工作流并观看每个节点的实时进度与输出。</p>" +
      '<div class="hero-actions"><button class="hero-btn" data-goto="employees">查看员工体系</button>' +
      '<button class="hero-btn" data-goto="workflows">运行演示工作流</button></div></div>' +

      '<div class="metrics-grid">' +
      metricCard(ICON.people, "green", String(roles.length), "演示员工", active + " 在岗") +
      metricCard(ICON.pulse, "amber", String(busy), "忙碌中", busy ? "实时轮询 5s" : "全部空闲") +
      metricCard(ICON.flow, "", String(apps.length), "已保存工作流", "累计运行 " + totalRuns + " 次") +
      metricCard(ICON.layers, "violet", String(running), "进行中任务", "来自任务中心") +
      "</div>" +

      '<div class="section-head"><h2>正在工作的员工</h2><span class="head-hint">每 6 秒自动刷新</span></div>' +
      '<div class="card card-pad" style="margin-bottom:22px">' +
      (busyChips || '<span class="head-hint">当前没有忙碌的员工 —— 去「员工体系」给演示员工安排点活，或运行一个工作流。</span>') +
      "</div>" +

      '<div class="section-head"><h2>任务中心 · 最近记录</h2><span class="head-hint">工作流运行 = 一条任务</span></div>' +
      (taskRows
        ? taskRows
        : '<div class="card"><div class="empty-state"><div class="empty-icon">' + ICON.inbox + "</div><h3>还没有任务记录</h3><p>运行一个演示工作流后，这里会出现任务中心的实时记录。</p></div></div>");

    if (!paintIfChanged(page(), "overview", html)) return;
    page().querySelectorAll("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () { setView(b.getAttribute("data-goto")); });
    });
  }

  function metricCard(icon, tone, value, label, sub) {
    return (
      '<div class="metric-card"><div class="metric-icon ' + (tone || "") + '">' + icon + "</div>" +
      '<div class="metric-body"><div class="metric-value">' + esc(value) + "</div>" +
      '<div class="metric-label">' + esc(label) + '</div><div class="metric-sub">' + esc(sub) + "</div></div></div>"
    );
  }

  /* ────────────────────────── 员工体系 ────────────────────────── */

  function empName(r) {
    return String(r.display_name || r.role_name || r.agent_name || r.agent_code || "未命名").trim();
  }

  function renderEmployeesSkeleton() {
    var html =
      '<div class="emp-toolbar"><div class="search-box">' + ICON.search +
      '<input id="emp-search" type="text" placeholder="搜索员工 / 部门…" /></div>' +
      '<span class="head-hint">忙碌状态每 5 秒自动刷新</span></div>' +
      '<div class="emp-grid">' + Array(6).join('<div class="skeleton" style="height:132px"></div>') + "</div>";
    paintIfChanged(page(), "sk-employees", html);
  }

  function refreshEmployees() {
    apiGet("/api/proactive/roles")
      .then(function (r) { state.roles = (r && r.roles) || []; })
      .catch(function () { state.roles = []; })
      .then(function () {
        return apiGet("/api/proactive/roles-busy?codes=" + busyCodesParam()).catch(function () { return { busy: {} }; });
      })
      .then(function (r) {
        state.busyMap = (r && r.busy) || {};
        paintEmployees();
        if (state.empDetail) refreshEmployeeDetail(false);
      })
      .catch(function () { /* 已兜底 */ });
  }
  function refreshEmployeesLight() {
    apiGet("/api/proactive/roles-busy?codes=" + busyCodesParam())
      .then(function (r) {
        state.busyMap = (r && r.busy) || {};
        paintEmployees();
      })
      .catch(function () { /* 忽略瞬时失败 */ });
  }

  function paintEmployees() {
    var html =
      '<div class="emp-toolbar"><div class="search-box">' + ICON.search +
      '<input id="emp-search" type="text" placeholder="搜索员工 / 部门…" value="' + esc(state.empQuery) + '" /></div>' +
      '<span class="head-hint">忙碌状态每 5 秒自动刷新 · 点击卡片查看工作板与会话</span></div>' +
      '<div id="emp-grid-wrap"></div>';
    var firstPaint = paintIfChanged(page(), "employees", html);

    // 搜索框只渲染一次；输入时只重绘卡片网格，保住焦点与光标。
    var input = document.getElementById("emp-search");
    if (firstPaint && input) {
      input.addEventListener("input", function () {
        state.empQuery = input.value;
        paintEmployeeGrid();
      });
    }
    paintEmployeeGrid();
  }

  function paintEmployeeGrid() {
    var q = state.empQuery.trim().toLowerCase();
    var roles = state.roles.filter(function (r) {
      if (!q) return true;
      return (empName(r) + " " + (r.department || "") + " " + (r.agent_code || "")).toLowerCase().indexOf(q) >= 0;
    });
    var html = roles.length
      ? '<div class="emp-grid">' + roles.map(empCardHtml).join("") + "</div>"
      : '<div class="card"><div class="empty-state"><div class="empty-icon">' + ICON.people +
        "</div><h3>" + (q ? "没有匹配的员工" : "还没有员工") + "</h3><p>" +
        (q ? "换个关键词试试。" : "在主面板「员工」页创建演示员工后，这里会实时显示他们的状态。") + "</p></div></div>";
    var wrap = document.getElementById("emp-grid-wrap");
    if (!paintIfChanged(wrap, "employees-grid", html)) return;
    wrap.querySelectorAll(".emp-card").forEach(function (card) {
      card.addEventListener("click", function () {
        openEmployeeDrawer(card.getAttribute("data-code"));
      });
    });
  }

  function empCardHtml(r) {
    var code = r.agent_code;
    var busy = (state.busyMap[code] || {}).busy;
    var status = String(r.status || "active");
    var statusChip =
      status === "active" ? '<span class="chip ok"><span class="chip-dot"></span>在岗</span>'
      : status === "paused" ? '<span class="chip warn"><span class="chip-dot"></span>请假</span>'
      : '<span class="chip idle"><span class="chip-dot"></span>' + esc(status) + "</span>";
    var current = state.busyMap[code] || {};
    var currentLine = busy
      ? "正在工作" + (current.current_session_key ? " · " + esc(String(current.current_session_key).split(":").slice(-1)[0]) : "") +
        (current.started_at ? " · " + esc(fmtTime(current.started_at)) : "")
      : "空闲中";
    return (
      '<div class="emp-card' + (state.empDetail && state.empDetail.code === code ? " selected" : "") + '" data-code="' + esc(code) + '">' +
      '<div class="emp-top"><div class="avatar" style="' + avatarStyle(code) + '">' + esc(initials(empName(r))) +
      '<span class="busy-dot' + (busy ? " on" : "") + '"></span></div>' +
      '<div class="emp-meta"><div class="emp-name">' + esc(empName(r)) + "</div>" +
      '<div class="emp-sub">' + esc(r.department || "未分配部门") + " · " + esc(code) + "</div></div></div>" +
      '<div class="emp-chips">' + statusChip +
      (busy ? '<span class="chip run"><span class="chip-dot"></span>忙碌</span>' : '<span class="chip idle"><span class="chip-dot"></span>空闲</span>') +
      "</div>" +
      '<div class="emp-current">' + currentLine + "</div></div>"
    );
  }

  /* 员工详情抽屉 */
  function openEmployeeDrawer(code) {
    var role = state.roles.filter(function (r) { return r.agent_code === code; })[0] || { agent_code: code };
    state.empDetail = { code: code, role: role, tab: "board", sessionKey: null };
    document.querySelectorAll(".emp-card").forEach(function (c) {
      c.classList.toggle("selected", c.getAttribute("data-code") === code);
    });
    renderDrawerShell();
    refreshEmployeeDetail(true);
    setPoller("detail", function () { refreshEmployeeDetail(false); }, 5000);
  }

  function closeEmployeeDrawer() {
    state.empDetail = null;
    clearPoller("detail");
    clearPoller("messages");
    var mask = document.getElementById("drawer-mask");
    var dr = document.getElementById("emp-drawer");
    if (mask) mask.remove();
    if (dr) dr.remove();
    document.querySelectorAll(".emp-card").forEach(function (c) { c.classList.remove("selected"); });
  }

  function renderDrawerShell() {
    var d = state.empDetail;
    var r = d.role;
    var mask = document.createElement("div");
    mask.id = "drawer-mask";
    mask.className = "drawer-mask";
    mask.addEventListener("click", closeEmployeeDrawer);

    var dr = document.createElement("div");
    dr.id = "emp-drawer";
    dr.className = "drawer";
    dr.innerHTML =
      '<div class="drawer-head"><div class="avatar" style="' + avatarStyle(d.code) + '">' + esc(initials(empName(r))) + "</div>" +
      '<div class="drawer-title"><b>' + esc(empName(r)) + "</b><span>" + esc(r.department || "未分配部门") + " · " + esc(d.code) +
      ' <span id="drawer-busy"></span></span></div>' +
      '<button class="drawer-close" title="关闭">' + ICON.x + "</button></div>" +
      '<div class="drawer-tabs">' +
      '<button class="drawer-tab" data-tab="board">工作板</button>' +
      '<button class="drawer-tab" data-tab="sessions">会话记录</button></div>' +
      '<div class="drawer-body" id="drawer-body"><div class="skeleton" style="height:120px"></div></div>';

    document.body.appendChild(mask);
    document.body.appendChild(dr);
    dr.querySelector(".drawer-close").addEventListener("click", closeEmployeeDrawer);
    dr.querySelector(".drawer-tabs").addEventListener("click", function (e) {
      var tab = e.target.closest(".drawer-tab");
      if (!tab) return;
      d.tab = tab.getAttribute("data-tab");
      if (d.tab !== "sessions") { d.sessionKey = null; clearPoller("messages"); }
      paintDrawerTabs();
      refreshEmployeeDetail(true);
    });
    paintDrawerTabs();
  }

  function paintDrawerTabs() {
    var d = state.empDetail;
    document.querySelectorAll(".drawer-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === d.tab);
    });
  }

  function refreshEmployeeDetail(force) {
    var d = state.empDetail;
    if (!d) return;
    var body = document.getElementById("drawer-body");
    if (!body) return;
    paintDrawerBusy();

    if (d.tab === "board") {
      apiGet("/api/proactive/roles/" + encodeURIComponent(d.code) + "/work-board?limit=30")
        .then(function (r) { paintWorkBoard(r); })
        .catch(function (e) { body.innerHTML = '<div class="empty-state"><p>' + esc(e.message) + "</p></div>"; });
      return;
    }
    // sessions tab
    if (!d.conversations || force) {
      apiGet("/api/proactive/sessions/" + encodeURIComponent(d.code) + "/conversations?limit=50")
        .then(function (r) {
          d.conversations = (r && r.conversations) || [];
          paintSessions();
          if (!d.sessionKey && d.conversations.length) {
            selectConversation(d.conversations[0].session_key);
          }
        })
        .catch(function (e) { body.innerHTML = '<div class="empty-state"><p>' + esc(e.message) + "</p></div>"; });
    } else {
      paintSessions();
    }
  }

  function paintDrawerBusy() {
    var el = document.getElementById("drawer-busy");
    if (!el) return;
    var b = state.busyMap[state.empDetail.code] || {};
    el.textContent = b.busy ? "· 正在工作中" : "";
  }

  function paintWorkBoard(r) {
    var body = document.getElementById("drawer-body");
    if (!body || !state.empDetail) return;
    var tasks = (r && r.tasks) || [];
    var approvals = (r && r.pending_approvals) || [];
    var counts = (r && r.counts) || {};
    var taskRows = tasks.map(function (t) {
      var id = t.task_id || t.id || "";
      return (
        '<div class="task-row"><div class="task-main"><div class="task-name">' + esc(t.name || t.id || "未命名工作项") + "</div>" +
        '<div class="task-desc">' + esc(fmtTime(t.updated_at || t.created_at)) + (t.round_id ? " · 轮次 " + esc(t.round_id) : "") + "</div></div>" +
        '<div class="task-progress">' + runChip(t.status) + '<div class="pct">' + pct(t.progress) + "%</div>" +
        '<div class="progress-track" style="margin-top:6px"><div class="progress-fill" style="width:' + pct(t.progress) + '%"></div></div></div></div>'
      );
    }).join("");
    var bodyHtml =
      '<div class="section-head"><h2 style="font-size:14px">岗位工作项</h2>' +
      '<span class="head-hint">任务 ' + esc(String(counts.tasks != null ? counts.tasks : tasks.length)) + " · 审批 " + esc(String(counts.pending_approvals != null ? counts.pending_approvals : approvals.length)) + "</span></div>" +
      (taskRows || '<div class="empty-state" style="padding:30px"><p>这个员工的工作板暂时是空的。</p></div>') +
      (approvals.length
        ? '<div class="section-head"><h2 style="font-size:14px">待审批</h2></div>' +
          approvals.map(function (a) {
            return '<div class="task-row"><div class="task-main"><div class="task-name">' + esc(a.title || a.summary || a.id) + "</div>" +
              '<div class="task-desc">' + esc(fmtTime(a.created_at)) + "</div></div>" +
              '<span class="chip warn"><span class="chip-dot"></span>待审批</span></div>';
          }).join("")
        : "");
    paintIfChanged(body, "board", bodyHtml);
  }

  function paintSessions() {
    var d = state.empDetail;
    var body = document.getElementById("drawer-body");
    if (!body || !d) return;
    var convs = d.conversations || [];
    var html =
      '<div class="section-head"><h2 style="font-size:14px">会话列表</h2><span class="head-hint">选中即回放，5s 增量刷新</span></div>' +
      (convs.length
        ? convs
            .map(function (c) {
              var kind = String(c.kind || "chat").toLowerCase();
              var selected = d.sessionKey === c.session_key ? " selected" : "";
              var title = c.title || c.display_name || c.session_key;
              return (
                '<div class="conv-row' + selected + '" data-sk="' + esc(c.session_key) + '">' +
                '<span class="conv-kind ' + esc(kind) + '">' + esc(kind) + "</span>" +
                '<div class="conv-main"><div class="conv-title">' + esc(title) + "</div>" +
                '<div class="conv-sub">' + esc(fmtTime(c.updated_at || c.last_message_at || c.created_at)) +
                (c.run_status ? " · " + esc(c.run_status) : "") + "</div></div></div>"
              );
            })
            .join("")
        : '<div class="empty-state" style="padding:30px"><p>暂无会话记录。</p></div>') +
      '<div id="conv-messages"></div>';
    if (!paintIfChanged(body, "sessions", html)) return;
    body.querySelectorAll(".conv-row").forEach(function (row) {
      row.addEventListener("click", function () {
        selectConversation(row.getAttribute("data-sk"));
      });
    });
    if (d.sessionKey) paintMessages();
  }

  function selectConversation(sessionKey) {
    var d = state.empDetail;
    if (!d) return;
    d.sessionKey = sessionKey;
    paintSessions();
    document.querySelectorAll(".conv-row").forEach(function (row) {
      row.classList.toggle("selected", row.getAttribute("data-sk") === sessionKey);
    });
    loadMessages();
    setPoller("messages", loadMessages, 4000);
  }

  function loadMessages() {
    var d = state.empDetail;
    if (!d || !d.sessionKey) return;
    apiGet(
      "/api/proactive/sessions/" + encodeURIComponent(d.code) + "/messages?session_key=" + encodeURIComponent(d.sessionKey)
    )
      .then(function (r) {
        d.messages = (r && (r.messages || r.data && r.data.messages)) || [];
        paintMessages();
      })
      .catch(function () { /* 回放失败不打断轮询 */ });
  }

  function paintMessages() {
    var d = state.empDetail;
    var wrap = document.getElementById("conv-messages");
    if (!wrap || !d) return;
    var msgs = d.messages || [];
    var html =
      '<div class="section-head" style="margin-top:18px"><h2 style="font-size:14px">消息回放</h2>' +
      '<span class="head-hint">' + msgs.length + " 条</span></div>" +
      (msgs.length
        ? msgs
            .map(function (m) {
              var role = String(m.role || m.sender || m.type || "assistant").toLowerCase();
              var isUser = role.indexOf("user") >= 0 || role.indexOf("human") >= 0;
              var content = m.content || m.text || m.message || "";
              if (typeof content !== "string") {
                try { content = JSON.stringify(content); } catch (e) { content = String(content); }
              }
              return (
                '<div class="msg' + (isUser ? " user" : "") + '"><div class="msg-bubble">' + esc(content) + "</div>" +
                '<div class="msg-time">' + esc(fmtTime(m.created_at || m.timestamp || m.time)) + "</div></div>"
              );
            })
            .join("")
        : '<div class="empty-state" style="padding:24px"><p>这个会话还没有消息。</p></div>');
    if (!paintIfChanged(wrap, "messages", html)) return;
    var drawerBody = document.getElementById("drawer-body");
    if (drawerBody) drawerBody.scrollTop = drawerBody.scrollHeight;
  }

  /* ────────────────────────── 工作流 ────────────────────────── */

  function renderWorkflowsSkeleton() {
    var html =
      '<div class="section-head"><h2>演示工作流</h2><span class="head-hint">点击「运行」实时观看节点进度</span></div>' +
      '<div class="app-grid">' + Array(3).join('<div class="skeleton" style="height:170px"></div>') + "</div>";
    paintIfChanged(page(), "sk-workflows", html);
  }

  function refreshWorkflows() {
    apiGet("/api/apps")
      .then(function (r) {
        state.apps = Array.isArray(r) ? r : (r && r.apps) || [];
        paintWorkflows();
      })
      .catch(function (e) {
        paintIfChanged(
          page(),
          "error-workflows",
          '<div class="card"><div class="empty-state"><h3>工作流列表加载失败</h3><p>' + esc(e.message) + "</p></div></div>"
        );
      });
  }

  function paintWorkflows() {
    var apps = state.apps;
    var html =
      '<div class="section-head"><h2>演示工作流</h2>' +
      '<span class="head-hint">运行 = 任务中心一条记录，节点进度每 2 秒轮询</span></div>' +
      (apps.length
        ? '<div class="app-grid">' + apps.map(appCardHtml).join("") + "</div>"
        : '<div class="card"><div class="empty-state"><div class="empty-icon">' + ICON.flow +
          "</div><h3>还没有保存的工作流</h3><p>一键创建一个内置的演示工作流（3 个真实节点，由员工智能体执行）。</p>" +
          '<button class="primary-btn" id="btn-sample">' + ICON.plus + "创建示例工作流</button></div></div>");
    if (!paintIfChanged(page(), "workflows", html)) return;

    page().querySelectorAll("[data-run]").forEach(function (b) {
      b.addEventListener("click", function () { runApp(b.getAttribute("data-run")); });
    });
    page().querySelectorAll("[data-history]").forEach(function (b) {
      b.addEventListener("click", function () { showRunHistory(b.getAttribute("data-history")); });
    });
    var sample = document.getElementById("btn-sample");
    if (sample) {
      sample.addEventListener("click", function () {
        sample.disabled = true;
        sample.textContent = "创建中…";
        createSampleWorkflow().then(function (app) {
          toast("示例工作流已创建：正在自动运行");
          return runApp(app.id);
        }).catch(function (e) {
          toast("创建失败：" + e.message, true);
          sample.disabled = false;
        });
      });
    }
  }

  function appCardHtml(a) {
    var raw = String(a.icon || "").trim();
    var isEmoji = raw && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(raw);
    var iconHtml = isEmoji ? '<span style="font-size:19px">' + esc(raw) + "</span>" : ICON.flow;
    return (
      '<div class="app-card"><div class="app-head"><div class="app-icon">' + iconHtml + "</div>" +
      '<div class="emp-meta"><div class="app-name">' + esc(a.name || a.id) + "</div>" +
      '<div class="emp-sub">' + esc(a.category || "workflow") + (a.status ? " · " + esc(a.status) : "") + "</div></div></div>" +
      '<div class="app-desc">' + esc(a.description || "（没有描述）") + "</div>" +
      '<div class="app-foot"><span class="runs-count">已运行 ' + esc(String(a.total_runs != null ? a.total_runs : (a.usage_count || 0))) + " 次</span>" +
      '<span style="display:flex;gap:8px"><button class="small-btn" data-history="' + esc(a.id) + '">历史</button>' +
      '<button class="small-btn solid" data-run="' + esc(a.id) + '">运行</button></span></div></div>'
    );
  }

  function createSampleWorkflow() {
    var body = {
      name: "演示 · 每日站会纪要",
      description: "内置演示工作流：由员工智能体依次完成「收集进展 → 提炼风险 → 输出纪要」三步，用于演示节点级实时进度。",
      icon: "",
      category: "demo",
      execution_mode: "workflow",
      auto_run: false,
      source: "builtin-demo",
      parameters: [],
      steps: [
        { ref: "1", name: "收集今日进展", description: "用 2-3 句话总结一条今天值得写进站会纪要的工作进展（虚构一个演示场景即可，例如某演示项目的进度）。", depends_on: [] },
        { ref: "2", name: "提炼风险与阻塞", description: "基于上一步的进展总结，提炼 1-2 条风险或阻塞项，每条配一句缓解建议。", depends_on: ["1"] },
        { ref: "3", name: "输出站会纪要", description: "把前两步的输出整理成一份简短站会纪要：进展、风险、下一步各一节，总长不超过 150 字。", depends_on: ["2"] },
      ],
    };
    return apiPost("/api/apps", body).then(function (app) {
      state.apps.unshift(app);
      return app;
    });
  }

  function runApp(appId) {
    var app = state.apps.filter(function (a) { return a.id === appId; })[0];
    toast("正在启动运行：" + ((app && app.name) || appId));
    apiPost("/api/apps/" + encodeURIComponent(appId) + "/run", { parameters: {}, run_kind: "production", trigger_kind: "manual" })
      .then(function (r) {
        var runId = r && (r.run_id || r.id);
        if (!runId) throw new Error("响应中没有 run_id");
        toast("运行已创建，进入实时视图");
        openRunView(appId, runId);
      })
      .catch(function (e) { toast("运行失败：" + e.message, true); });
  }

  function openRunView(appId, runId) {
    state.runView = { appId: appId, runId: runId, status: "pending", progress: 0, steps: [] };
    state.view = "workflows";
    document.querySelectorAll("#primary-nav .nav-item").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === "workflows");
    });
    document.getElementById("crumb-view").textContent = "工作流 / 运行";
    clearViewPollers();
    paintRunShell();
    pollRun(true);
    setPoller("run", function () { pollRun(false); }, 2000);
    if (!state.runHistory || state.runHistory.appId !== appId) {
      state.runHistory = { appId: appId, items: [] };
      loadRunHistory(appId);
    }
  }

  function paintRunShell() {
    var rv = state.runView;
    var app = state.apps.filter(function (a) { return a.id === rv.appId; })[0] || {};
    var html =
      '<div class="section-head"><h2>' + esc(app.name || rv.appId) + ' · 运行详情</h2>' +
      '<button class="ghost-btn" id="btn-back">' + ICON.back + " 返回工作流列表</button></div>" +
      '<div class="two-col"><div><div class="section-head"><h2 style="font-size:14px">运行历史</h2></div>' +
      '<div class="card" id="run-history"><div class="card-pad head-hint">加载中…</div></div></div>' +
      '<div><div class="card run-banner" id="run-banner"></div>' +
      '<div class="section-head"><h2 style="font-size:14px">节点进度</h2><span class="head-hint" id="run-poll-hint">每 2 秒轮询</span></div>' +
      '<div id="run-steps"></div></div></div>';
    if (!paintIfChanged(page(), "run-shell:" + rv.runId, html)) return;
    document.getElementById("btn-back").addEventListener("click", function () {
      state.runView = null;
      clearViewPollers();
      setView("workflows");
    });
    paintRunBanner();
    paintRunSteps();
  }

  function pollRun(force) {
    var rv = state.runView;
    if (!rv) return;
    if (!force && isTerminal(rv.status)) return;
    apiGet("/api/apps/runs/" + encodeURIComponent(rv.runId))
      .then(function (r) {
        rv.status = String((r && r.status) || "pending").toLowerCase();
        rv.progress = r ? r.progress : 0;
        rv.steps = (r && r.steps) || [];
        rv.resultSummary = (r && r.result_summary) || "";
        paintRunBanner();
        paintRunSteps();
        if (isTerminal(rv.status)) {
          clearPoller("run");
          var hint = document.getElementById("run-poll-hint");
          if (hint) hint.textContent = "运行已结束";
          toast("运行" + (RUN_STATUS[rv.status] ? RUN_STATUS[rv.status][1] : rv.status));
          loadRunHistory(rv.appId); // 历史行状态同步到终态
        }
      })
      .catch(function () { /* 下个 tick 再试 */ });
  }

  function isTerminal(status) {
    return ["completed", "failed", "cancelled", "canceled"].indexOf(String(status).toLowerCase()) >= 0;
  }

  function paintRunBanner() {
    var el = document.getElementById("run-banner");
    var rv = state.runView;
    if (!el || !rv) return;
    var p = pct(rv.progress);
    var statusLabel = (RUN_STATUS[rv.status] || [0, rv.status])[1];
    var html =
      '<div class="run-progress"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">' +
      '<span><b style="font-size:15px">' + esc(statusLabel) + "</b> " +
      '<span class="run-id">' + esc(rv.runId) + "</span></span>" +
      '<span class="pct">' + p + "%</span></div>" +
      '<div class="progress-track"><div class="progress-fill' + (rv.status === "running" && !p ? " indeterminate" : "") + '" style="width:' + (p || 4) + '%"></div></div></div>' +
      (rv.status === "running" || rv.status === "executing" || rv.status === "planned"
        ? '<button class="small-btn danger" id="btn-cancel">取消运行</button>'
        : "");
    if (!paintIfChanged(el, "banner", html)) return;
    var cancel = document.getElementById("btn-cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        cancel.disabled = true;
        apiPost("/api/apps/runs/" + encodeURIComponent(rv.runId) + "/cancel")
          .then(function () { toast("已请求取消"); pollRun(true); })
          .catch(function (e) { toast("取消失败：" + e.message, true); cancel.disabled = false; });
      });
    }
  }

  function paintRunSteps() {
    var el = document.getElementById("run-steps");
    var rv = state.runView;
    if (!el || !rv) return;
    var steps = (rv.steps || []).filter(function (s) { return !s.is_rollup_step; });
    var html;
    if (!steps.length) {
      html = '<div class="card"><div class="empty-state" style="padding:34px"><p>节点信息尚未生成，正在等待调度…</p></div></div>';
    } else {
      html =
      '<div class="step-list">' +
      steps
        .map(function (s) {
          var status = String(s.status || "pending").toLowerCase();
          var p = pct(s.progress);
          var name = s.display_name || s.name || "节点 " + (s.ref || "");
          var out = String(s.result_summary || "").trim();
          var evi = (s.evidence_paths || []).map(function (p2) {
            return '<span class="evidence-chip" title="' + esc(p2) + '">' + esc(String(p2).split(/[\\/]/).pop()) + "</span>";
          }).join("");
          var outputs = (s.outputs || []).map(function (o) {
            var label = typeof o === "string" ? o : (o && (o.path || o.name || o.title)) || "";
            if (!label) return "";
            return '<span class="evidence-chip" title="' + esc(label) + '">' + esc(String(label).split(/[\\/]/).pop()) + "</span>";
          }).join("");
          return (
            '<div class="step-card ' + esc(status) + '">' +
            '<div class="step-head">' + runChip(s.status) +
            '<span class="step-name">' + esc(name) + "</span>" +
            (s.assigned_agent ? '<span class="step-agent">' + esc(s.assigned_agent) + "</span>" : "") +
            '<span class="step-agent">' + esc(fmtDuration(s.started_at, s.completed_at)) + "</span></div>" +
            '<div class="step-progress"><div class="progress-track"><div class="progress-fill" style="width:' + p + '%"></div></div>' +
            '<span class="pct">' + p + "%</span></div>" +
            (out ? '<div class="step-output">' + esc(out) + "</div>" : "") +
            (s.error_text ? '<div class="step-error">' + esc(s.error_text) + "</div>" : "") +
            (evi || outputs ? '<div class="step-evidence">' + evi + outputs + "</div>" : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>";
    }
    paintIfChanged(el, "run-steps", html);
  }

  function loadRunHistory(appId) {
    apiGet("/api/apps/" + encodeURIComponent(appId) + "/runs?limit=12")
      .then(function (r) {
        var items = (r && (r.items || r.runs)) || [];
        state.runHistory = { appId: appId, items: items };
        paintRunHistory();
      })
      .catch(function () {
        state.runHistory = { appId: appId, items: [] };
        paintRunHistory();
      });
  }

  function paintRunHistory() {
    var el = document.getElementById("run-history");
    var rv = state.runView;
    var h = state.runHistory;
    if (!el || !rv || !h || h.appId !== rv.appId) return;
    var html = h.items.length
      ? h.items
          .map(function (r) {
            var id = r.run_id || r.id || "";
            var selected = id === rv.runId ? " selected" : "";
            return (
              '<div class="history-row' + selected + '" data-rid="' + esc(id) + '">' + runChip(r.status) +
              '<span class="h-main">' + esc(r.result_summary || "") + "</span>" +
              '<span class="h-time">' + esc(fmtTime(r.started_at || r.created_at)) + "</span></div>"
            );
          })
          .join("")
      : '<div class="card-pad head-hint">这个工作流还没有历史运行。</div>';
    if (!paintIfChanged(el, "run-history", html)) return;
    el.querySelectorAll(".history-row").forEach(function (row) {
      row.addEventListener("click", function () {
        openRunView(rv.appId, row.getAttribute("data-rid"));
      });
    });
  }

  function showRunHistory(appId) {
    var app = state.apps.filter(function (a) { return a.id === appId; })[0];
    apiGet("/api/apps/" + encodeURIComponent(appId) + "/runs?limit=20")
      .then(function (r) {
        var items = (r && (r.items || r.runs)) || [];
        var html =
          '<div class="section-head"><h2>' + esc((app && app.name) || appId) + " · 运行历史</h2>" +
          '<button class="ghost-btn" id="btn-back">' + ICON.back + " 返回</button></div>" +
          '<div class="card card-pad">' +
          (items.length
            ? items
                .map(function (run) {
                  var id = run.run_id || run.id || "";
                  return (
                    '<div class="history-row" data-rid="' + esc(id) + '">' + runChip(run.status) +
                    '<span class="h-main">' + esc(run.result_summary || id) + "</span>" +
                    '<span class="h-time">' + esc(fmtTime(run.started_at || run.created_at)) + "</span></div>"
                  );
                })
                .join("")
            : '<div class="empty-state" style="padding:24px"><p>还没有运行记录，去列表点「运行」。</p></div>') +
          "</div>";
        if (!paintIfChanged(page(), "history-page:" + appId, html)) return;
        document.getElementById("btn-back").addEventListener("click", function () { setView("workflows"); });
        page().querySelectorAll(".history-row[data-rid]").forEach(function (row) {
          row.addEventListener("click", function () { openRunView(appId, row.getAttribute("data-rid")); });
        });
      })
      .catch(function (e) { toast("历史加载失败：" + e.message, true); });
  }

  /* ────────────────────────── 启动 ────────────────────────── */

  checkHealth();
  setPoller("health", checkHealth, 10000);
  setView("overview");
})();
