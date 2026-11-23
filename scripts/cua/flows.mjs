// 【2026-11-22】把「画红心」「用 WPS 实时写 docx」两条桌面流程固化成一次调用。
//
// 为什么要有这个文件：11-22 这两件事分别耗掉 2.5 分钟 / 4 分钟。慢的不是打字或画线，
// 而是①边做边探索 ②每个动作一次 broker 往返 ③弹层一开元素树重排、索引作废
// ④弹层是**独立窗口**，在主窗口上点弹层坐标会报 `frame … no longer maps to a live display`。
// 今天全部坐标/坑都实测过，已串成函数一次调用跑完。
// 【实测 2026-11-22 21:4x ✅ 跑通】清空画布 → 红色 → 画笔 → 72 段心形 → 填充红，
// 一次调用 **23.5s** 出图（对照：手工边探索边做要 2.5 分钟，约 6 倍提速）。
// 时间分布：每次坐标点击 ~1.3s（AppActivate + 截帧）+ 笔迹 4.4s + 等待/读回。
// 想再快就减点击次数，别再动笔迹（笔迹已经是单进程一次 SendInput）。
//
// 三个真根因（都踩过、都修了）：
//  ① **同一 app 上连续两次坐标点击，第二次一定用上一帧**，帧被上一次点击消耗，
//     报 `frame … no longer maps to a live display`。→ 见 tap()/tapXY()：每次都刷帧。
//  ② **画笔笔迹必须发真实鼠标事件**。原来用 SetCursorPos 挪光标，WinUI 画图只认
//     真实输入，结果只留下起点一个红点、没有线。→ kit.STROKE_PS 改 mouse_event。
//  ③ **弹层是模态的**：它开着时主窗口收不到任何按键（ctrl+n / Escape 全落空），
//     而且第一次点心内会先被"关弹层"吃掉。→ 见 closePopups() + 填充补第二击。
//  另：PS 脚本里**不能写中文注释/中文串**，PowerShell 按 ANSI 解码会把 C# 编译搞挂。
//
// 用法（node_repl 一个 cell，见 scripts/cua/snippet-heart.js / snippet-story.js）：
//   const root = process.env.ZCODE_CUA_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
//   const { join } = await import("node:path"); const { pathToFileURL } = await import("node:url");
//   const { setupComputerUseRuntime } = await import(pathToFileURL(join(root,"scripts","computer-use-client.mjs")).href);
//   await setupComputerUseRuntime({ globals: globalThis });
//   const flows = await import(pathToFileURL("D:/dev/github/EvoFlow/scripts/cua/flows.mjs").href);
//   console.log(await flows.drawRedHeart({ cu: agent.computerUse }));
//
// 五条硬约束（都是踩出来的）：
//   · 每个 node_repl cell 是全新 realm —— 本模块不抓全局，cu 由调用方传入。
//   · **主窗口工具栏一律用坐标点**（选择/图像/工具/画笔/形状/颜色/层）：这些图标没有
//     AXPress 可靠语义，按 index 点会撞 "index no longer refers to the element"，
//     实测 4 次重试全失败。坐标（按 REF_SHOT 等比换算）一次就中。
//   · 弹层是独立窗口（标题「主机弹出窗口」），它的**元素树稳定且带中文名**（填充/铅笔/
//     颜色选取器…），所以在弹层里可以按名字点；但点之前必须 getAXState 刷一次观测，
//     否则 elements() 拿到的 index 与派发时的观测不一致。
//   · 弹层一开一关，之前绑的 frame 就失效 —— 每次动坐标前重绑窗口 + 截一帧。
//   · 整条笔迹必须一次 SendInput（kit.drawStroke）：逐段 drag 是每段一次往返，几十段必超时。

import * as kit from "./cua-kit.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 参考截图尺寸：本机画图（窗口 1432×989）交付截图实测 1280×886，工具栏坐标按它量。 */
export const REF_SHOT = { width: 1280, height: 886 };

/** 工具栏各按钮在参考截图里的锚点（今天实测，窗口尺寸变了按比例换算即可）。 */
export const TAB = {
  select: [51, 175],
  image: [152, 175],
  tool: [247, 175],
  brush: [337, 175],
  shape: [444, 175],
  color: [535, 175],
  size: [52, 690], // 左侧竖滑轨靠下 ≈ 16 像素
};

/**
 * 读截图宽高（PNG 的 IHDR / JPEG 的 SOF）。
 * 【2026-11-22 实测】getScreenshot 回的不一定是 PNG：本机画图给的是 JPEG（FF D8 开头）。
 */
export function imgSize(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[0] === 0x89 && u8[1] === 0x50) {
    return { width: dv.getUint32(16), height: dv.getUint32(20), fmt: "png" };
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i < u8.length - 9) {
      if (u8[i] !== 0xff) { i++; continue; }
      const marker = u8[i + 1];
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          height: (u8[i + 5] << 8) | u8[i + 6],
          width: (u8[i + 7] << 8) | u8[i + 8],
          fmt: "jpeg",
        };
      }
      if (len <= 0) break;
      i += 2 + len;
    }
  }
  return null;
}

/** list_windows 的 bounds 是数组 [x,y,w,h]，观测里是对象 —— 统一成对象。 */
export function normRect(b) {
  if (Array.isArray(b)) return { x: b[0], y: b[1], width: b[2], height: b[3] };
  return { x: b.x ?? b.left ?? 0, y: b.y ?? b.top ?? 0, width: b.width, height: b.height };
}

/**
 * 找画图主窗口并返回 {pid, windowId, bounds}。
 * 【2026-11-22】list_windows 的窗口对象只有 window_id/bounds/title，**没有 pid**；
 * 拿 `win.pid` 会得到 undefined，getApp 立刻抛 "needs … {name|bundle_id|pid}"。pid 取自 listApps。
 */
export async function resolvePaint(cu) {
  const apps = await cu.listApps({ emit: false });
  const re = /mspaint|画图|paint/i;
  const hits = apps.filter((a) => re.test(`${a.name ?? ""} ${a.bundle_id ?? ""}`));
  if (!hits.length) throw new Error("没找到画图窗口，先启动 mspaint");
  const target = hits.find((a) => a.active) ?? hits[0];
  const wins = await cu.computer.list_windows({ app_ref: { pid: target.pid } });
  const mains = wins.filter((w) => w.main && /画图|paint/i.test(w.title ?? ""));
  const win = mains[0] ?? wins.find((w) => w.main) ?? wins[0];
  if (!win) throw new Error(`pid ${target.pid} 下没有画图窗口`);
  return { pid: target.pid, windowId: win.window_id, bounds: normRect(win.bounds), title: win.title };
}

/** 重绑主窗口并取一帧（弹层开关会让旧 frame 失效，所以每次动坐标前都调它）。 */
async function bindFrames(cu, pid, windowId) {
  const app = await cu.getApp({ pid, window_id: windowId });
  const bytes = await app.getScreenshot({ emit: false });
  return { app, shot: imgSize(bytes) };
}

/** 把目标进程顶到前台（Windows 真实指针要求前台就是它，否则整批动作被拒）。 */
async function activate(pid) {
  const { execFile } = await import("node:child_process");
  await new Promise((res) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", `$w=New-Object -ComObject WScript.Shell; [void]$w.AppActivate(${pid})`],
      { windowsHide: true, timeout: 15000 },
      () => res(),
    );
  });
  await sleep(180);
}

/**
 * 一次可靠的坐标点击：激活 → **现取一帧** → 按当前帧等比换算 → 点。
 *
 * 【2026-11-22 实测根因，务必照做】同一个 app 对象上**连续两次坐标点击**，
 * 第二次必定报 `click: frame frame-xxxx no longer maps to a live display. action_sent=false.`
 * —— 帧被上一次点击消耗掉了。之前以为是「弹层导致帧失效」，其实同窗口连点两下就会。
 * 所以：**每一个坐标动作都自带一次刷帧，绝不复用上一帧**。这条是本流程唯一必守的纪律。
 * 代价是每次点击多 ~0.4s（powershell 激活 + 截帧），但一次成功胜过三次重试。
 */
async function tap(st, key) {
  await activate(st.pid);
  st.shot = imgSize(await st.app.getScreenshot({ emit: false }));
  const [x, y] = TAB[key];
  await st.app.click([
    Math.round((x * st.shot.width) / REF_SHOT.width),
    Math.round((y * st.shot.height) / REF_SHOT.height),
  ]);
  return st.shot;
}

/** 按截图像素坐标点一下（同样自带刷帧）。 */
async function tapXY(st, x, y) {
  await activate(st.pid);
  st.shot = imgSize(await st.app.getScreenshot({ emit: false }));
  await st.app.click([Math.round(x), Math.round(y)]);
}

/** 按截图**比例**点一下（对话框按钮这类位置随窗口尺寸漂的，用比例最稳）。 */
async function tapFrac(st, fx, fy) {
  await activate(st.pid);
  st.shot = imgSize(await st.app.getScreenshot({ emit: false }));
  await st.app.click([Math.round(st.shot.width * fx), Math.round(st.shot.height * fy)]);
}

/**
 * 有没有「是否要保存？」模态框。
 * 【2026-11-22 实测】这个对话框**不是**独立窗口（`list_windows` 里看不到它），
 * 它画在主窗口里。所以判据只能取主窗口元素树里的「是否要保存」文案
 * —— 别按「有没有第二个窗口」判：`主机弹出窗口`（工具/颜色弹层）也满足那个条件，
 * 我因此把工具弹层当成对话框，白跑了两轮。
 */
async function hasSaveDialog(st) {
  try {
    await st.app.getAXState({ emit: false });
    const els = await st.app.elements();
    return els.some((e) => /是否要保存/.test(e.title ?? ""));
  } catch {
    return false;
  }
}

/** 点「不保存」：1280×887 截图实测 (636,551) → 比例 (0.497, 0.621)。 */
async function discardChanges(st) {
  await activate(st.pid);
  st.shot = imgSize(await st.app.getScreenshot({ emit: false }));
  await st.app.click([
    Math.round(st.shot.width * 0.497),
    Math.round(st.shot.height * 0.621),
  ]);
  await sleep(900);
  return rebindState(st);
}

/** 原地重绑（复用同一 app，只刷新当前帧）。 */
async function rebindState(st) {
  st.shot = imgSize(await st.app.getScreenshot({ emit: false }));
  return st;
}

/**
 * 找当前打开的弹层窗口（「主机弹出窗口」），返回绑定好的 app。
 * 关键：弹层拿不到就说明没弹出来（而不是「在别处」）。
 */
async function popupApp(cu, pid, mainId) {
  const wins = await cu.computer.list_windows({ app_ref: { pid } });
  const w = wins.find((x) => x.window_id !== mainId && /弹出/.test(x.title ?? ""));
  if (!w) return null;
  const app = await cu.getApp({ pid, window_id: w.window_id });
  await app.getScreenshot({ emit: false }); // 唤醒 + 定帧
  return { app, win: w };
}

/**
 * 在弹层里按无障碍名字点一项。
 * 必须先 getAXState 刷观测 —— 否则 elements() 与派发用的观测不是同一版，
 * 会报 "element index N no longer refers to the element you saw there"。
 */
export async function clickPopupItem(pop, title, { exact = true, tries = 3 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    await pop.getAXState({ emit: false });
    const els = await pop.elements();
    const el = els.find(
      (e) =>
        e.title &&
        (exact ? e.title === title : e.title.includes(title)) &&
        (e.actions ?? []).includes("AXPress"),
    );
    if (el) {
      try {
        await pop.performSecondaryAction(el.index, "AXPress");
        return title;
      } catch (e) { last = e; }
    }
    await sleep(200);
  }
  throw new Error(`弹层里点不到「${title}」${last ? "：" + String(last.message).slice(0, 100) : ""}`);
}

/**
 * 收掉所有残留弹层（工具/颜色面板）。
 * 【2026-11-22】弹层是模态的：它开着时主窗口收不到按键，`ctrl+n` / `Escape` 全落空。
 * 所以每个阶段开始前都要确认弹层已关，否则后面整段跑空。
 */
async function closePopups(cu, st) {
  for (let i = 0; i < 3; i++) {
    const wins = await cu.computer.list_windows({ app_ref: { pid: st.pid } });
    const pop = wins.find((w) => w.window_id !== st.windowId);
    if (!pop) return true;
    const app = await cu.getApp({ pid: st.pid, window_id: pop.window_id });
    try {
      await app.pressKey("Escape");
    } catch { /* 有些弹层不吃按键，下面用点别处关 */ }
    await sleep(350);
  }
  const wins = await cu.computer.list_windows({ app_ref: { pid: st.pid } });
  return !wins.some((w) => w.window_id !== st.windowId);
}

/** 等某个窗口标题出现（WPS 打开 docx 是异步的）。 */
async function waitWindow(cu, re, { timeout = 15000, poll = 400 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const apps = await cu.listApps({ emit: false });
    const hit = apps.find((a) => re.test(`${a.name ?? ""} ${a.bundle_id ?? ""}`));
    if (hit) return hit;
    await sleep(poll);
  }
  throw new Error(`等窗口超时：${re}`);
}

/** 读当前工具名（「在画布上使用 … 工具」）。判据：工具没切对就别动笔。 */
async function currentTool(app) {
  await app.getAXState({ emit: false });
  const el = (await app.elements()).find((e) => /在画布上使用 .+ 工具/.test(e.title ?? ""));
  return el?.title ?? null;
}

/* ────────────────────────── 流程一：画一颗填充红的爱心 ────────────────────────── */

/**
 * 把心形轮廓**按真实包围盒**归一化落进 rect（含 2% 内缩）。
 *
 * 为什么不用 kit.heartPoints：那个函数用固定 scale 乘方程值，实际画出多大取决于方程
 * 本身的 bbox，和调用方给的框对不上——我因此被自己的越界闸拦了一次（顶部 14 个点
 * 判成越界）。这里做法反过来：先采样原始方程，量出它自己的 bbox，再线性映射到目标框，
 * 「点全在框内」就成了构造保证。
 */
export function fitHeartPoints({ rect, n = 72, pad = 0.02 } = {}) {
  const raw = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    raw.push([
      16 * Math.pow(Math.sin(t), 3),
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
    ]);
  }
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  const insetX = w * pad, insetY = h * pad;
  // 等比缩放（不留变形），居中放进框
  const sx = (w - insetX * 2) / (maxX - minX);
  const sy = (h - insetY * 2) / (maxY - minY);
  const s = Math.min(sx, sy);
  const drawnW = (maxX - minX) * s, drawnH = (maxY - minY) * s;
  const offX = rect.left + (w - drawnW) / 2;
  const offY = rect.top + (h - drawnH) / 2;
  return raw.map(([x, y]) => [
    Math.round(offX + (x - minX) * s),
    // 屏幕 y 向下，方程 y 向上 → 反转
    Math.round(offY + (maxY - y) * s),
  ]);
}

/**
 * 画图里画一颗实心红心：清空画布 → 红色画笔 → 一次 SendInput 描完轮廓 → 填充桶灌红。
 * @returns {{ms:number, segs:number, tool:string, canvas:object}}
 */
export async function drawRedHeart({
  cu,
  color = "红色",
  box = { l: 0.33, r: 0.67, t: 0.46, b: 0.88 }, // 心形落框（截图比例）
  strokes = 72,
  fresh = true,
} = {}) {
  const t0 = Date.now();
  if (!cu) throw new Error("drawRedHeart 需要 cu（cell 里初始化好的 agent.computerUse）");

  /**
   * 绑一次活窗口。
   * 【2026-11-22 关键修复】必须**每次重新 resolvePaint**（重取 pid 与 window_id），
   * 不能复用一开始拿到的 window_id：画图窗口在会话中会移动/重建（实测 bounds
   * [1312,350] → [-200,394] → [0,0]，旧 window_id 的 frame 随即失效），
   * 报 `frame … no longer maps to a live display`，重试同一 window_id 会连挂三次。
   */
  const st = { pid: 0, windowId: 0, bounds: null, app: null, shot: null };
  const rebind = async () => {
    const r = await resolvePaint(cu);
    st.pid = r.pid; st.windowId = r.windowId; st.bounds = r.bounds;
    st.app = await cu.getApp({ pid: st.pid, window_id: st.windowId });
    st.shot = imgSize(await st.app.getScreenshot({ emit: false }));
    return st;
  };
  await rebind();

  /** 坐标动作重试壳：任何 frame/raster/geometry 类失败 → 重新 resolve + 重发。 */
  const run = async (label, fn) => {
    let err;
    for (let i = 0; i < 3; i++) {
      try {
        return await fn();
      } catch (e) {
        err = e;
        const m = String(e?.message ?? "");
        const retryable = /frame|raster|geometry|no longer refers|no longer maps|ELEMENT_UNAVAILABLE/i.test(m);
        if (!retryable || i === 2) break;
        await sleep(250);
        await rebind();
      }
    }
    throw new Error(`${label} 失败：${String(err?.message ?? err).slice(0, 160)}`);
  };

  // 1) 干净画布：Ctrl+N，若有「是否要保存?」→ 点「不保存」（坐标，别用元素索引）
  if (fresh) {
    await closePopups(cu, st); // 上一个流程留下的弹层会挡住按键
    await run("新建画布", async () => { await activate(st.pid); await st.app.pressKey("ctrl+n"); });
    await sleep(900);
    await rebind();
    if (await hasSaveDialog(st)) {
      await discardChanges(st);
      await sleep(600);
      await rebind();
    }
  }

  // 2) 颜色：点顶栏「颜色」→ 色板是独立弹层 → 里面按名字点「红色」
  // 【2026-11-22 实测】色板窗口 628×216，「红色」是带 AXPress 的 ListItem（本次 index 35，
  // 但索引会漂，必须每次 getAXState 后现取）。选完必须把 Escape 发给**弹层自己**——
  // 弹层开着时主窗口收不到任何按键，我因此白跑过一轮（Ctrl+N / Escape 全落空）。
  await run("点颜色按钮", async () => tap(st, "color"));
  await sleep(600);
  const palette = await popupApp(cu, st.pid, st.windowId);
  if (!palette) throw new Error("颜色弹层没出现（上一次的弹层可能没关，先收掉再重试）");
  await clickPopupItem(palette.app, color);
  await sleep(350);
  await palette.app.pressKey("Escape");
  await sleep(400);
  await closePopups(cu, st);

  // 3) 画笔：顶栏「画笔」（坐标点，别按 index）
  await closePopups(cu, st);
  await run("选画笔", async () => tap(st, "brush"));
  await sleep(400);
  let tool = await currentTool(st.app);
  if (!tool || !/画笔|铅笔/.test(tool)) throw new Error(`没切到画笔（当前：${tool ?? "未知"}）`);

  // 粗细 ≈ 16 像素
  await run("调笔粗", async () => tap(st, "size"));
  await sleep(250);

  // 4) 描心：整条笔迹一次 SendInput（drawStroke 内部自己激活，不需要我们再刷帧）
  await rebind();
  const rect = {
    left: Math.round(st.shot.width * box.l),
    top: Math.round(st.shot.height * box.t),
    right: Math.round(st.shot.width * box.r),
    bottom: Math.round(st.shot.height * box.b),
  };
  const cx = Math.round((rect.left + rect.right) / 2);
  const cy = Math.round((rect.top + rect.bottom) / 2);
  // 【2026-11-22 修 bug】别用 rect 当"心形自己的外框"去校验 —— 心形方程的实际 bbox
  // 和标称框不等（顶部尖角会探出去），上一次就因此误报「坐标越出画布」而中断。
  // 正确做法：先规划一版，再把 bbox **归一化映射**到 rect 内（带 2% 内缩），
  // 这样"落点全在框内"是构造保证的，不是事后赌的。
  const pts = fitHeartPoints({ rect, n: strokes });
  const segs = await run("描心形", async () => {
    // mapping 必须用**当前**这一帧的 bounds+shot 现算，不能沿用 rebind 之前的（窗口会动）
    kit.assertInCanvas(pts, rect); // 归一化后仍在框内才算数（越界会白跑却回成功）
    const mapping = kit.mappingFor(st.bounds, st.shot);
    // 直接走 drawStroke：它回 {"ok":true,...}，被前台拒会回 ok:false —— 必须看这个，别只看段数
    const r = await kit.drawStroke({ pid: st.pid, points: pts, mapping });
    if (r.ok !== true) throw new Error(`笔迹被拒（前台被别家抢）：${r.reason ?? JSON.stringify(r)}`);
    return pts.length - 1;
  });

  // 5) 填充桶灌红：「工具」弹层 → 直接按坐标点「填充」（AXPress 在 Paint 上静默失效）
  await run("点工具按钮", async () => tap(st, "tool"));
  await sleep(600);
  const tools = await popupApp(cu, st.pid, st.windowId);
  if (!tools) throw new Error("工具弹层没出现");
  // 弹层 raster 实测 251×216：「填充」(123,37)、「铅笔」(48,40)、「橡皮擦」(48,130)、
  // 「文本」(199,38)、「画笔」(123,130)、「放大镜」(199,130)。
  // 不按名字点：Button 虽有 AXPress，点了状态不变（静默失效），只能读回工具名验证。
  const popShot = imgSize(await tools.app.getScreenshot({ emit: false }));
  await tools.app.click([
    Math.round((123 * popShot.width) / 251),
    Math.round((37 * popShot.height) / 216),
  ]);
  await sleep(500);
  await closePopups(cu, st);
  await rebind();
  let fillTool = await currentTool(st.app);
  if (!fillTool || !/填充/.test(fillTool)) throw new Error(`没切到填充桶（当前：${fillTool ?? "未知"}）`);

  // 落点在内部（中心稍偏下，避开顶部凹口与描边）—— 坐标动作自带刷帧
  // 【2026-11-22 实测】第一次点击经常被"正在关闭的弹层"吃掉（弹层是模态的，
  // 这一击只关面板不落填充），所以补第二次。填充是幂等操作，同色点两次无害。
  const fillY = Math.round(cy + (rect.bottom - rect.top) * 0.1);
  await run("填充落点", async () => tapXY(st, cx, fillY));
  await sleep(700);
  const after1 = await currentTool(st.app);
  if (!/填充/.test(after1 ?? "")) throw new Error(`填充后工具被切走：${after1}`);
  // 补第二击（若第一击已生效，这一击只是把同一区域再填一次同色）
  await run("填充落点补一次", async () => tapXY(st, cx, fillY));
  await sleep(500);

  return { ms: Date.now() - t0, segs, tool: (await currentTool(st.app)) ?? "", canvas: rect };
}

/* ────────────────── 流程二：用 WPS 打开 docx 实时写正文并保存 ────────────────── */

const PY = "C:/Users/admin/AppData/Local/Programs/Python/Python312/python.exe";
const WPS = "C:\\Users\\admin\\AppData\\Local\\Kingsoft\\WPS Office\\12.1.0.29690\\office6\\wps.exe";

/** 造一个空白 docx（python-docx 只在 Python312 里；PATH 上的 python 是 backend venv，没有）。 */
export async function ensureBlankDocx(file) {
  const { execFile } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const code = "import sys\nfrom docx import Document\nDocument().save(sys.argv[1])\nprint('ok')";
  await new Promise((resolve, reject) => {
    execFile(PY, ["-c", code, file], { windowsHide: true }, (err) =>
      err ? reject(new Error(`建 docx 失败: ${err.message}`)) : resolve(),
    );
  });
  if (!existsSync(file)) throw new Error(`docx 没生成：${file}`);
  return file;
}

/** 回读 docx 正文（交付校验），返回 {paras:[{len,text}], total}。 */
export async function readDocx(file) {
  const { execFile } = await import("node:child_process");
  const code = [
    "import sys, json",
    "from docx import Document",
    "ps=[p.text for p in Document(sys.argv[1]).paragraphs]",
    "print(json.dumps({'paras':[{'len':len(t),'text':t} for t in ps],'total':sum(len(t) for t in ps)}, ensure_ascii=False))",
  ].join("\n");
  const out = await new Promise((resolve, reject) => {
    execFile(PY, ["-c", code, file], { windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) =>
      err ? reject(new Error(`读 docx 失败: ${err.message}`)) : resolve(stdout),
    );
  });
  return JSON.parse(out);
}

/**
 * 用 WPS 打开 docx → 把 paragraphs 实时敲进去 → Ctrl+S → 回读核对。
 * 为什么「先造 docx 再打开」而不是首页点「新建」：WPS 首页是 CEF 外壳，
 * 「新建」命中区点不动，还会误触相邻入口（实测点出「WPS 听记」）。
 */
export async function writeStoryToWps({ cu, file, paragraphs, bodyFrac = [0.5, 0.36] } = {}) {
  const t0 = Date.now();
  if (!cu) throw new Error("writeStoryToWps 需要 cu");
  if (!file || !paragraphs?.length) throw new Error("需要 file 与 paragraphs[]");

  const { execFile } = await import("node:child_process");
  const { basename } = await import("node:path");
  await ensureBlankDocx(file);

  await new Promise((resolve, reject) => {
    execFile("cmd", ["/c", "start", "", WPS, file], { windowsHide: true }, (err) =>
      err ? reject(new Error(`打开 WPS 失败: ${err.message}`)) : resolve(),
    );
  });

  const name = basename(file);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await waitWindow(cu, new RegExp(esc, "i"));
  const { app, win } = await kit.attach({ cu, app: /wps\.exe|WPS Office/i, title: name });
  await sleep(1100); // 等「正在打开文档···」过去，早了打字会落空

  // 焦点进正文：激活 + 刷帧后按当前截图比例点页面中上部
  // （同一个坑：不刷帧直接点会报 frame no longer maps to a live display）
  // 注意 list_windows 的对象**没有 pid**，pub 的 pid 要从 listApps 取。
  const wpsApps = await cu.listApps({ emit: false });
  const wpsPid = wpsApps.find((a) => /wps|kingsoft/i.test(`${a.name ?? ""} ${a.bundle_id ?? ""}`))?.pid;
  if (wpsPid) {
    await activate(wpsPid);
  }
  await sleep(200);
  const shot = imgSize(await app.getScreenshot({ emit: false }));
  await app.click([Math.round(shot.width * bodyFrac[0]), Math.round(shot.height * bodyFrac[1])]);
  await sleep(300);

  // 逐段实时输入：中文 typeText 直接可用，段落用 Return 分隔（不整篇 paste，用户要看过程）
  for (let i = 0; i < paragraphs.length; i++) {
    await app.typeText(paragraphs[i]);
    if (i < paragraphs.length - 1) await app.pressKey("Return");
    await sleep(110);
  }

  await app.pressKey("ctrl+s"); // 打开的是已存在文件 → 直接覆盖，不弹另存为
  await sleep(900);

  const verify = await readDocx(file);
  const expectedChars = paragraphs.join("").length;
  return {
    ms: Date.now() - t0,
    paragraphs: paragraphs.length,
    expectedChars,
    verifyOk: verify.total === expectedChars,
    verify,
    title: win.title,
  };
}
