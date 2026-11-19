// 【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】
// 改了什么：新增本文件，把「在画图/记事本里干活」这一轮的 6 个坑固化成可复用函数。
// 为什么：用户明说要**频繁**做这类桌面操作（画画、打字）。每次从零写 bootstrap +
// 猜色板坐标 + 猜撤销次数，一个动作要 4~6 个 cell，而且我这次真的把用户画的横线
// 用 ctrl+z 多撤给撤掉了。这些都不是知识点问题，是**每次都要重新拼装**的问题。
// 用法（node_repl cell 里一行）：
//   const kit = await import("file:///D:/dev/github/EvoFlow/scripts/cua/cua-kit.mjs");
//   const { cu, app, win } = await kit.attach({ app: /画图|paint/i });
//
// 设计约束（踩过才知道）：
//  · 每个 node_repl cell 是全新 realm，所以本模块**不能在 import 时抓全局**，
//    一切走参数传入 —— 否则第二次调用拿到的是上一个 realm 的僵尸对象。
//  · 画图窗口一旦被最小化/移动，坐标动作会以两种不同 code 被拒；所以 attach()
//    总是用 window_id 钉住窗口，并且返回的 app 可直接用坐标。

const PLUGIN_SUBDIR = ["scripts", "computer-use-client.mjs"];

/**
 * 取当前 cell 里**已经初始化好**的 computerUse。
 *
 * 【self-evolution-bot · 2026-11-19 · 第65轮】为什么不能在本模块里 setup：
 * 实测（同一 cell 对照）——cell 顶层 `globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")]`
 * 是 object，而从一个被 `import()` 进来的**二次模块**里看同一个表达式是 undefined。
 * 也就是说二次模块有自己的 realm，`globalThis` 是干净的空对象，宿主注入的桥接不在上面。
 * 所以 `setupComputerUseRuntime` 在模块里必抛 "Computer Use runtime bridge is unavailable"，
 * 而同样的调用写在 cell 顶层就成功。第一版我写成自己 boot，直接踩中。
 *
 * 正确形态：cell 先 bootstrap（3 行），再把 `agent.computerUse` 传进来。
 */
export function useRuntime(cu) {
  if (!cu || typeof cu.getApp !== "function") {
    throw new Error(
      "useRuntime(cu) 需要一个已初始化的 computerUse。在 cell 里先做 bootstrap：" +
        "const root = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT; " +
        "const { setupComputerUseRuntime } = await import(pathToFileURL(join(root,'scripts','computer-use-client.mjs')).href); " +
        "await setupComputerUseRuntime({ globals: globalThis }); " +
        "然后 kit.attach({ cu: globalThis.agent.computerUse, app: /画图/i })",
    );
  }
  return cu;
}

/** 兼容旧调用名：外部若只想探测桥接是否可用。 */
export function bridgeProbe() {
  const S = Symbol.for("zcode.node-repl.computer-use-bridge");
  return { hasSymbol: typeof globalThis[S], cu: typeof globalThis.agent?.computerUse };
}

/**
 * 一步到位：按名字找应用 → 用 window_id 钉住窗口 → 返回可直接发坐标动作的 app。
 * @param {{cu: object, app: RegExp|string, window?: number}} opts
 *   cu     —— **必填**，cell 里初始化好的 agent.computerUse（见 useRuntime 注释）
 *   app    —— 匹配 listApps 里 name 的正则或子串（如 /画图|paint/i）
 *   window —— 指定第几个窗口，默认第一个（main）
 * @returns {{cu, app, win, all}}
 */
export async function attach({ cu, app: matcher, window = 0, title, pid, windowId } = {}) {
  const runtime = useRuntime(cu);
  const apps = await runtime.listApps({ emit: false });
  // 【self-evolution-bot · 2026-11-19 · 第66轮】用 pid + windowId 直绑，绕开一切名称问题。
  // 为什么需要：记事本**每改一次内容标题就变**（无标题 → *ABC → *标题行），
  // 任何按标题筛的写法第二次调用就失配；而窗口本身（window_id）全程不变。
  // 判据：能拿到 window_id 就绝不靠名字认人。
  if (pid && windowId) {
    const bound = await runtime.getApp({ pid, window_id: windowId });
    await bound.getScreenshot({ emit: false });
    return { cu: runtime, app: bound, win: { pid, window_id: windowId }, all: [] };
  }
  // 【self-evolution-bot · 2026-11-19 · 第65轮】正则不能在别的 realm 里直接用：
  // 从 cell 传进来的 RegExp 到本模块后 `instanceof RegExp` 为假、`String(re)` 会带着
  // 两边的 `/.../i` 字面量，导致拼出 `//画图|paint/i/i` 这种永不匹配的式子
  // （实测报错原文就是这个）。判据：只取 `re.source` 重建，flag 自己给 i。
  const pattern =
    typeof matcher === "string"
      ? matcher
      : matcher?.source ?? String(matcher ?? "");
  if (!pattern) throw new Error("attach({app}) 需要一个名字正则或子串");
  // 【self-evolution-bot · 2026-11-19 · 第66轮】名称匹配会被**瞬时弹窗**劫持：
  // 画图弹出一个 tooltip（窗口标题「主机弹出窗口」）后，listApps 里 pid 16044 的 name
  // 就变成了弹窗标题，`/画图|paint/` 直接 0 命中、整个 attach 抛错。
  // 修法：把 bundle_id / exe 路径一起当匹配文本（画图的 bundle_id 里含 mspaint.exe），
  // 窗口也**优先取 main:true**，而不是取数组第一个（第一个可能正是那个弹窗）。
  const re = new RegExp(pattern, "i");
  const hay = (a) => `${a.name ?? ""} ${a.bundle_id ?? ""}`;
  const hits = apps.filter((a) => re.test(hay(a)));
  if (!hits.length) {
    throw new Error(
      `没有匹配 ${re} 的应用。当前可见：` +
        apps.map((a) => a.name).filter(Boolean).slice(0, 25).join(" / "),
    );
  }
  // 多个同名应用（两个 Explorer / 两个记事本）时选 active 那个，再不行取第一个。
  const target = hits.find((a) => a.active) ?? hits[0];
  const wins = await runtime.computer.list_windows({ app_ref: { pid: target.pid } });
  if (!wins?.length) throw new Error(`应用 ${target.name}(pid ${target.pid}) 没有可用窗口`);
  const mains = wins.filter((w) => w.main);
  const pool = mains.length ? mains : wins;
  // 【self-evolution-bot · 2026-11-19 · 第66轮】记事本是**单进程多窗口**（一个 pid 612 挂了
  // 4 个标签页窗口：无标题 / *观测站的那一夜 / 演示稿 / 会议记录）。只按 app 名 attach
  // 会随便挑一个，可能正挑到用户正在写的稿子。所以支持 `title` 显式筛：
  //   attach({ app:/notepad/i, title:/无标题/ })  —— 只认标题匹配的那个窗口
  // 传了 title 却匹配不到就抛错，绝不静默退回「随便一个」。
  let pool2 = pool;
  if (title) {
    const tre = new RegExp(typeof title === "string" ? title : title.source ?? String(title), "i");
    pool2 = pool.filter((w) => tre.test(w.title ?? ""));
    if (!pool2.length) {
      throw new Error(
        `pid ${target.pid} 下没有标题匹配 ${tre} 的窗口。现有：` +
          pool.map((w) => `${w.title}[${w.window_id}]`).join(" / "),
      );
    }
  }
  // 窗口标题也可能是弹窗（同上一处缺陷）；能按名字再筛一次就更稳。
  const named = pool2.filter((w) => re.test(w.title ?? ""));
  const finalPool = named.length ? named : pool2;
  const win = finalPool[Math.min(window, finalPool.length - 1)];
  const bound = await runtime.getApp({ pid: target.pid, window_id: win.window_id });
  // 先取一次帧：Windows 上最小化的窗口要靠一次捕获才恢复，否则后续坐标动作
  // 报 "no actionable raster for this coordinate action"。
  await bound.getScreenshot({ emit: false });
  return { cu: runtime, app: bound, win, all: hits };
}

/** 当前元素表（每次动作前重新取 —— 索引会随观测变化，严禁缓存）。 */
export async function elements(app) {
  return app.elements();
}

/** 按无障碍标题找一个**真的可按**的元素；找不到返回 null。 */
export async function pressable(app, title, { exact = false } = {}) {
  const els = await elements(app);
  return (
    els.find(
      (e) =>
        e.title &&
        (exact ? e.title === title : e.title.includes(title)) &&
        (e.actions ?? []).includes("AXPress") &&
        e.enabled !== false,
    ) ?? null
  );
}

/**
 * 选颜色：画图的色板有中文无障碍名（红色/玫瑰红/…），走这条路比猜坐标可靠。
 * 返回选中的色名，失败抛错并列出可用颜色。
 */
export async function pickColor(app, name) {
  const el = await pressable(app, name, { exact: true });
  if (!el) {
    const els = await elements(app);
    const names = els
      .map((e) => e.title)
      .filter((t) => t && !/^颜色 \d/.test(t) && t !== "空");
    throw new Error(`色板里没有「${name}」。可选：${names.slice(0, 40).join("、")}`);
  }
  await app.performSecondaryAction(el.index, "AXPress");
  return name;
}

/** 心形参数方程取点。scale≈2.4 / n≈26 出 ~77×90px 的心。 */
export function heartPoints({ cx, cy, scale = 2.4, n = 26, lift = 6 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t);
    pts.push([Math.round(cx + scale * x), Math.round(cy - scale * (y + lift))]);
  }
  return pts;
}

/**
 * 画图画布的有效区（1280×680 截图坐标系，实测窗口 window_id=144185108）。
 * 【self-evolution-bot · 2026-11-19 · 第66轮】为什么必须有这个闸：
 * 上一轮 `drawPath` 回了 `segs=16` 看着「成功」，实际 x=950 已越过白底右界 915，
 * 16 笔全落在画布外，画布一片空白——**段数不是成功判据，落在画布内才是前提**。
 * 窗口被缩放/换了 zoom 就重新量一次，别照抄。
 */
export const PAINT_CANVAS = { left: 366, top: 234, right: 912, bottom: 536 };

/** 校验每个点都在画布内；越界就抛，并指出是第几个点、差多少。 */
export function assertInCanvas(pts, rect = PAINT_CANVAS) {
  const bad = [];
  pts.forEach(([x, y], i) => {
    if (x < rect.left) bad.push(`#${i} x=${x} < left ${rect.left}`);
    else if (x > rect.right) bad.push(`#${i} x=${x} > right ${rect.right}`);
    if (y < rect.top) bad.push(`#${i} y=${y} < top ${rect.top}`);
    else if (y > rect.bottom) bad.push(`#${i} y=${y} > bottom ${rect.bottom}`);
  });
  if (bad.length) {
    throw new Error(
      `坐标越出画布（会白跑却回成功）：${bad.slice(0, 6).join(" | ")}` +
        (bad.length > 6 ? ` …共 ${bad.length} 处` : ""),
    );
  }
  return pts;
}

/**
 * 逐段拖拽。返回**实际发出的段数**——这个数字必须记下来，
 * 因为撤销是按笔迹算的，多撤一步就吃掉用户上一笔（我踩过）。
 *
 * 【self-evolution-bot · 2026-11-19 · 第66轮】实测取代猜测：
 * 24 段拖拽 ↔ **24 次 ctrl+z 恰好撤干净**（分 1+4+19 三批撤，每批都截图核对；
 * 第 24 步整颗消失，用户已有的三角/方框/横线/五角星/红心全程未动）。
 * 上一轮我凭猜撤 18 次，多撤的那几步把用户的横线抹了——**别猜，用 segs**。
 * canvas 传 null 可关闭越界闸（画布尺寸不明时）。
 */
export async function drawPath(app, pts, { canvas = PAINT_CANVAS } = {}) {
  if (canvas) assertInCanvas(pts, canvas);
  let segs = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    await app.drag(pts[i], pts[i + 1]);
    segs++;
  }
  return segs;
}

/**
 * 一次调完「选中红笔 → 校验画布内 → 描心 → 返回撤销步数」。
 * 返回值里的 `undoSteps` 直接喂给 undo()，不要用点数（n+1）也不要猜。
 */
export async function drawHeart(appOrOpts, opts) {
  // 【self-evolution-bot · 2026-11-19 · 第66轮】宽容解包：上一版签名是
  // drawHeart(app, {cx, cy})，我第一次跑就写成 drawHeart({app, cx, cy}) —— 整包被当
  // 第一个参数 app，cx 收到 undefined，报「需要整数 cx/cy」却不提「参数放错位置」，
  // 白绕一轮。判据：目标对象必须有 drag()，没有但带 .app 就自动解包。
  let app = appOrOpts;
  let o = opts ?? {};
  if (!app || typeof app.drag !== "function") {
    if (app && app.app && typeof app.app.drag === "function") {
      app = app.app;
      o = appOrOpts;
    } else {
      throw new Error(
        "drawHeart(app, {cx, cy}) 第一个参数必须是 attach() 返回的 app（含 drag()）。" +
          "拿到的是：" + (app == null ? String(app) : typeof app),
      );
    }
  }
  const { cx, cy, scale = 1.2, n = 24, color = "红色" } = o;
  if (Number.isInteger(cx) === false || Number.isInteger(cy) === false) {
    throw new Error(
      `drawHeart 需要整数 cx / cy（截图像素坐标），实际收到 cx=${cx} cy=${cy}。` +
        " 参考空白区：PAINT_CANVAS = " + JSON.stringify(PAINT_CANVAS),
    );
  }
  await pickColor(app, color);
  await selectTool(app, "brush");
  const pts = heartPoints({ cx, cy, scale, n });
  const segs = await drawPath(app, pts);
  return { segs, undoSteps: segs, points: pts.length };
}

/**
 * 把目标窗口拉到前台。坐标类动作（drag/click）在 Windows 上要求目标窗口是
 * frontmost，否则报 "raw foreground event ... was refused because the live
 * frontmost application is pid xxx"。**这一步无法靠无障碍绕过**——逐段拖拽
 * 只能走坐标，所以必须真的把窗口激活。
 *
 * 做法：点一次它自己的标题栏（对 app 绑定是 a11y 通道，不改内容）。
 * 返回 {ok, frontmost?}：拿不到前台信息时不谎报成功。
 */
export async function focus(app, cu, { pid } = {}) {
  try {
    await app.click([Math.round(400), 11]);
  } catch {
    // 标题栏点不动就继续，下面用真实前台状态判定
  }
  try {
    const apps = await cu.listApps({ emit: false });
    const me = apps.find((a) => a.pid === pid) ?? apps.find((a) => a.active);
    return { ok: Boolean(me?.active ?? apps.find((a) => a.active)?.pid === pid), frontmost: me?.name ?? null };
  } catch {
    return { ok: false, frontmost: null };
  }
}

/** 精确撤销 n 步（只撤自己的笔迹）。返回 n。 */
export async function undo(app, n) {
  for (let i = 0; i < n; i++) await app.pressKey("ctrl+z");
  return n;
}

/** 精确重做 n 步（撤过头了用它救）。返回 n。 */
export async function redo(app, n) {
  for (let i = 0; i < n; i++) await app.pressKey("ctrl+y");
  return n;
}

/**
 * 把指针移出画布再截图 —— 否则画图的光标会被当成笔画，
 * 让你以为画错了（心口那个橙黄小点就是这么来的）。
 */
export async function cleanShot(app, { away = [400, 11] } = {}) {
  try {
    await app.click(away);
  } catch {
    // 标题栏点不动不致命，继续截图
  }
  await app.getScreenshot();
}

/** 备注：画图的工具栏图标（画笔/填充桶/橡皮）没有 AXPress，只能按坐标点。见 craft 文档。 */
export const PAINT_TAB = {
  brush: [337, 80],
  fill: [236, 80],
  eraser: [278, 80],
};

/**
 * 明确选中某个工具再画。
 * 【self-evolution-bot · 2026-11-19 · 第66轮】为什么这不是可选项：
 * 上一轮我改完坐标直接拖拽，**填充桶还处于选中态**，第一笔就把整块白底灌成红色，
 * 只能 ctrl+z×2 撤回。画图不会因为坐标合法就安全——先选工具，再动笔。
 * 注意：这是坐标点击，要求目标窗口在前台（见 focus）。
 */
export async function selectTool(app, name) {
  const at = PAINT_TAB[name];
  if (!at) {
    throw new Error(`未知工具「${name}」，可选：${Object.keys(PAINT_TAB).join(" / ")}`);
  }
  await app.click(at);
  return name;
}
/* ───────────────────────── 文本框（记事本等）───────────────────────── */

/**
 * 记事本状态栏「N 个字符」的期望值。
 * 【self-evolution-bot · 2026-11-19 · 第66轮】实测取值，**换行按 1 个字符算**：
 * 写入 `标题行\n第二行\n第三行`（3+3+3 汉字 + 2 换行 = 11 个码点），
 * 状态栏报 `11 个字符`，一一对应。
 * 我第一版按「\n 算 2（\r\n）」写成 13，于是把一条**正确的读数**误判成假读数，
 * 白查一轮状态栏来源。判据以本机实测为准，别按换行宽度推理。
 * 注意：纯英文/数字也是同样的码点计数（写 `ABC` → 状态栏 3）。
 */
export function expectedChars(text) {
  return [...String(text)].length;
}

/**
 * 读记事本状态栏的字符数；读不到返回 null。
 * 【self-evolution-bot · 2026-11-19 · 第66轮】必须**按行锚定**，不能全文搜第一个「个字符」：
 * 正文本身完全可能含有「个字符」三个字（写小说/技术稿就会），全文搜会把正文误当状态栏。
 * 状态栏在 AX 树里是独立一行：`[12] text 11 个字符 = 11 个字符 actions=[…]`。
 */
export async function readStatusChars(app) {
  const state = String((await app.getAXState({ emit: false })) ?? "");
  for (const line of state.split("\n")) {
    const m = /^\s*\[\d+\]\s+text\s+([\d,]+)\s*个字符\s*=\s*([\d,]*)\s*个字符\s*$/.exec(
      line.replace(/\s*actions=.*$/, ""),
    );
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  return null;
}

/**
 * 找到可写正文的编辑区。
 * 【self-evolution-bot · 2026-11-19 · 第66轮】新开的记事本标签页**没有键盘焦点**：
 * 直接 pressKey("ctrl+a") + paste 会全部落空，状态栏仍是 `0 个字符`，
 * 而调用一点都不报错（我实测踩到）。所以写之前必须拿到这个 textarea。
 */
export async function editorTarget(app) {
  const els = await app.elements();
  const area = els.find(
    (e) => e.kind === "textarea" && (e.actions ?? []).includes("AXSetValue"),
  );
  return area ?? null;
}

/**
 * 全文替换。**优先 setValue**（一条命令、不进剪贴板、不受焦点丢失影响）。
 * 回退路径三步缺一不可：`ctrl+a` 只选中、不替换 —— 实测选中后直接 paste，
 * 内容被插在开头、状态栏仍是旧值（463→没变），中间必须有 `Delete`。
 *
 * 返回 {expected, via}：`via` 是实际走通的路径，出问题时第一时间看它。
 */
export async function setText(app, text) {
  const s = String(text);
  const area = await editorTarget(app);
  if (area) {
    await app.setValue(area.index, s);
    return { expected: expectedChars(s), via: "setValue" };
  }
  // 没有可 setValue 的编辑区：至少先把焦点点进去，否则按键全部落到空处。
  await app.click([400, 200]);
  await app.pressKey("ctrl+a");
  await app.pressKey("Delete");
  await app.paste(s);
  return { expected: expectedChars(s), via: "keys" };
}

/**
 * 写入并按状态栏对账。返回 {expected, actual, ok, delta, via}。
 * `ok === false` 就是真的没写全，不要拿「没抛异常」当成功。
 */
export async function writeText(app, text, { settle = 400 } = {}) {
  const { expected, via } = await setText(app, text);
  if (settle) await new Promise((r) => setTimeout(r, settle));
  const actual = await readStatusChars(app);
  return {
    expected,
    actual,
    ok: actual === null ? null : actual === expected,
    delta: actual === null ? null : actual - expected,
    via,
  };
}
