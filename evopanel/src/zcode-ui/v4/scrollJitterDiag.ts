// 滚动抖动诊断（v4 时间线上滚抖动定位用）。
//
// 默认开启（localStorage.evoflow_v4_scroll_diag = "0" 关闭）。工作方式：
// 1. 滚动层 wheel 停止 250ms 后开 1.5s 采样窗，记录每次 scrollTop / scrollHeight 变化；
// 2. 采样结束判定抖动：往复对（连续反向变化 ≥2 次）或累计 |Δ| > 8px；
// 3. 命中则 console.warn 输出归因报告——每条样本带 source（写入方挂名），
//    采样窗内未被挂名的变化归因为 "browser/native"（滚动锚点/浏览器折算），
//    挂名机制：写入方在改 scrollTop 前调 recordScrollWrite(source, el)。
//
// 已挂名写入方（ConversationTimeline）：scrollToBottom / scrollMemoryRestore /
// scrollToQuery / scrollToQueryLiveTail / virtualizerScrollToIndex /
// virtualizerItemSizeAdjust（tanstack 对视口上方行的测量补偿）。

export interface ScrollDiagSample {
  /** 相对采样窗起点的时间（ms）。 */
  dt: number;
  source: string;
  before: number;
  after: number;
  /** 采样期间 scrollHeight 是否同时变化（行高重测的伴生信号）。 */
  scrollHeightChanged: boolean;
}

const WHEEL_STOP_DELAY_MS = 250;
const SAMPLE_WINDOW_MS = 1500;
const OSCILLATION_PAIRS_THRESHOLD = 2;
const TOTAL_DRIFT_THRESHOLD_PX = 8;
const REPORT_MIN_INTERVAL_MS = 3000;

let diagEnabled: boolean | null = null;
let activeEl: HTMLDivElement | null = null;
let lastObservedTop = 0;
let lastObservedScrollHeight = 0;
let pendingWriteSource: string | null = null;
let wheelStopTimer: ReturnType<typeof setTimeout> | null = null;
let sampling = false;
let samplingStartedAt = 0;
let samplingUntil = 0;
let samples: ScrollDiagSample[] = [];
let lastReportAt = 0;

function isEnabled(): boolean {
  if (diagEnabled === null) {
    try {
      diagEnabled = globalThis.localStorage?.getItem("evoflow_v4_scroll_diag") !== "0";
    } catch {
      diagEnabled = true;
    }
  }
  return diagEnabled;
}

/** 写入方挂名：改 scrollTop 之前调用，采样窗内该次变化归因到此 source。 */
export function recordScrollWrite(source: string, el: HTMLDivElement | null): void {
  if (!isEnabled() || !el || el !== activeEl) return;
  pendingWriteSource = source;
}

function pushSample(source: string): void {
  if (!activeEl) return;
  const after = activeEl.scrollTop;
  const scrollHeightChanged = activeEl.scrollHeight !== lastObservedScrollHeight;
  samples.push({
    dt: Date.now() - samplingStartedAt,
    source,
    before: lastObservedTop,
    after,
    scrollHeightChanged,
  });
  lastObservedTop = after;
  lastObservedScrollHeight = activeEl.scrollHeight;
}

function onWheel(event: WheelEvent): void {
  if (!isEnabled() || !activeEl) return;
  const deltaY = event.deltaY;
  if (deltaY >= 0) return; // 只诊断上滚（阅读更早内容）后的稳定性
  if (wheelStopTimer !== null) clearTimeout(wheelStopTimer);
  wheelStopTimer = setTimeout(() => {
    if (!activeEl) return;
    sampling = true;
    samplingStartedAt = Date.now();
    samplingUntil = samplingStartedAt + SAMPLE_WINDOW_MS;
    samples = [];
    lastObservedTop = activeEl.scrollTop;
    lastObservedScrollHeight = activeEl.scrollHeight;
    setTimeout(finishSampling, SAMPLE_WINDOW_MS + 150);
  }, WHEEL_STOP_DELAY_MS);
}

function onScroll(): void {
  if (!isEnabled() || !activeEl) return;
  if (sampling && Date.now() <= samplingUntil) {
    pushSample(pendingWriteSource ?? "browser/native");
  }
  pendingWriteSource = null;
}

function finishSampling(): void {
  sampling = false;
  const now = Date.now();
  if (samples.length < 2 || now - lastReportAt < REPORT_MIN_INTERVAL_MS) {
    samples = [];
    return;
  }
  // 抖动判定：相邻变化方向相反的往复对 ≥2，或累计位移超阈值。
  let reversals = 0;
  let totalAbs = 0;
  let prevDelta: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i]!.after - samples[i]!.before;
    totalAbs += Math.abs(delta);
    if (prevDelta !== null && delta !== 0 && prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta)) {
      reversals += 1;
    }
    if (delta !== 0) prevDelta = delta;
  }
  const jittered = reversals >= OSCILLATION_PAIRS_THRESHOLD || totalAbs > TOTAL_DRIFT_THRESHOLD_PX;
  if (!jittered) {
    samples = [];
    return;
  }
  lastReportAt = now;
  const bySource = new Map<string, number>();
  let scrollHeightChanges = 0;
  for (const s of samples) {
    bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    if (s.scrollHeightChanged) scrollHeightChanges += 1;
  }
  const lines = samples
    .filter((s, i) => i === 0 || s.after !== s.before || s.scrollHeightChanged)
    .map(
      (s) =>
        `  +${String(s.dt).padStart(4)}ms ${s.before.toFixed(1)}→${s.after.toFixed(1)} ` +
        `(Δ${(s.after - s.before).toFixed(1)}) src=${s.source}${s.scrollHeightChanged ? " [scrollHeight也变了]" : ""}`,
    );
  console.warn(
    `[v4-scroll-diag] 检测到上滚停止后抖动：往复 ${reversals} 次 / 累计位移 ${totalAbs.toFixed(1)}px\n` +
      `  scrollTop 变化按来源统计: ${JSON.stringify(Object.fromEntries(bySource))}\n` +
      `  scrollHeight 同步变化次数: ${scrollHeightChanges}（>0 = 行高在重测）\n` +
      lines.join("\n"),
  );
  samples = [];
}

/** 在时间线滚动层上安装诊断监听（组件挂载时调用一次）。 */
export function attachScrollJitterDiag(el: HTMLDivElement): void {
  if (!isEnabled() || activeEl === el) return;
  activeEl = el;
  lastObservedTop = el.scrollTop;
  lastObservedScrollHeight = el.scrollHeight;
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("scroll", onScroll, { passive: true });
}

export function detachScrollJitterDiag(el: HTMLDivElement): void {
  if (activeEl !== el) return;
  activeEl = null;
  sampling = false;
  if (wheelStopTimer !== null) clearTimeout(wheelStopTimer);
  el.removeEventListener("wheel", onWheel);
  el.removeEventListener("scroll", onScroll);
}
