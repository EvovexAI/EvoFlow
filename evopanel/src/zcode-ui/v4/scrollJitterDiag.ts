// 滚动抖动诊断（v4 时间线上滚抖动定位用）。
//
// 默认开启（localStorage.evoflow_v4_scroll_diag = "0" 关闭）。工作方式：
// 1. 滚动层向上 wheel 停止 250ms 后开 1.5s 采样窗，记录每次 scrollTop / scrollHeight 变化；
// 2. 采样结束：只要窗内有位移就 console 打归因报告（稳定用 info，抖动用 warn）；
// 3. 每条样本带 source（写入方挂名）；未挂名归因为 "browser/native"（滚动锚点/浏览器折算）；
//    挂名机制：写入方在改 scrollTop 前调 recordScrollWrite(source, el)。
//
// 已挂名写入方（ConversationTimeline）：scrollToBottom / scrollMemoryRestore /
// scrollToQuery / scrollToQueryLiveTail / scrollToQueryLiveTailMount /
// virtualizerScrollToIndex / virtualizerItemSizeAdjust / prependAnchorAdjust。

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
const REPORT_MIN_INTERVAL_MS = 1500;

let diagEnabled: boolean | null = null;
let activeEl: HTMLDivElement | null = null;
let lastObservedTop = 0;
let lastObservedScrollHeight = 0;
let pendingWriteSource: string | null = null;
let wheelStopTimer: ReturnType<typeof setTimeout> | null = null;
let sampleFinishTimer: ReturnType<typeof setTimeout> | null = null;
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
  if (sampleFinishTimer !== null) {
    clearTimeout(sampleFinishTimer);
    sampleFinishTimer = null;
  }
  // 持续上滚时取消未完成的采样窗，等真正停住再开窗。
  sampling = false;
  samples = [];
  wheelStopTimer = setTimeout(() => {
    if (!activeEl) return;
    sampling = true;
    samplingStartedAt = Date.now();
    samplingUntil = samplingStartedAt + SAMPLE_WINDOW_MS;
    samples = [];
    lastObservedTop = activeEl.scrollTop;
    lastObservedScrollHeight = activeEl.scrollHeight;
    console.info(
      `[v4-scroll-diag] 上滚已停，开始 ${SAMPLE_WINDOW_MS}ms 采样窗 ` +
        `scrollTop=${lastObservedTop.toFixed(1)} scrollHeight=${lastObservedScrollHeight}`,
    );
    sampleFinishTimer = setTimeout(finishSampling, SAMPLE_WINDOW_MS + 150);
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
  sampleFinishTimer = null;
  sampling = false;
  const now = Date.now();
  const captured = samples;
  samples = [];
  if (captured.length === 0) {
    console.info("[v4-scroll-diag] 上滚停止后采样窗内无 scrollTop 变化（稳定）");
    return;
  }
  if (now - lastReportAt < REPORT_MIN_INTERVAL_MS) {
    return;
  }

  let reversals = 0;
  let totalAbs = 0;
  let netDelta = 0;
  let prevDelta: number | null = null;
  for (let i = 0; i < captured.length; i++) {
    const delta = captured[i]!.after - captured[i]!.before;
    totalAbs += Math.abs(delta);
    netDelta += delta;
    if (prevDelta !== null && delta !== 0 && prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta)) {
      reversals += 1;
    }
    if (delta !== 0) prevDelta = delta;
  }
  // 「抖动」必须有方向往复；单向滑行（惯性 / scroll-anchoring 拽回底部）单独归类，
  // 避免把 0 往复 + 数百 px 净位移误报成抖动。
  const oscillated = reversals >= OSCILLATION_PAIRS_THRESHOLD;
  const drifted = !oscillated && totalAbs > TOTAL_DRIFT_THRESHOLD_PX;
  lastReportAt = now;

  const bySource = new Map<string, number>();
  let scrollHeightChanges = 0;
  for (const s of captured) {
    bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    if (s.scrollHeightChanged) scrollHeightChanges += 1;
  }
  const lines = captured
    .filter((s, i) => i === 0 || s.after !== s.before || s.scrollHeightChanged)
    .map(
      (s) =>
        `  +${String(s.dt).padStart(4)}ms ${s.before.toFixed(1)}→${s.after.toFixed(1)} ` +
        `(Δ${(s.after - s.before).toFixed(1)}) src=${s.source}${s.scrollHeightChanged ? " [scrollHeight也变了]" : ""}`,
    );

  const driftHint =
    drifted && netDelta > 0
      ? "（净位移向下=朝底部；若全是 browser/native，优先查 overflow-anchor / sticky composer）"
      : drifted && netDelta < 0
        ? "（净位移向上=继续离底；可能是触控板惯性）"
        : "";

  const header = oscillated
    ? `[v4-scroll-diag] 上滚停止后抖动：往复 ${reversals} 次 / 累计 |Δ| ${totalAbs.toFixed(1)}px / 净Δ ${netDelta.toFixed(1)}px`
    : drifted
      ? `[v4-scroll-diag] 上滚停止后单向漂移：往复 0 / 累计 |Δ| ${totalAbs.toFixed(1)}px / 净Δ ${netDelta.toFixed(1)}px${driftHint}`
      : `[v4-scroll-diag] 上滚停止后微动：往复 ${reversals} / 累计 |Δ| ${totalAbs.toFixed(1)}px / 净Δ ${netDelta.toFixed(1)}px`;
  const body =
    `  scrollTop 变化按来源统计: ${JSON.stringify(Object.fromEntries(bySource))}\n` +
    `  scrollHeight 同步变化次数: ${scrollHeightChanges}（>0 = 行高在重测）\n` +
    lines.join("\n");

  if (oscillated || drifted) {
    console.warn(`${header}\n${body}`);
  } else {
    console.info(`${header}\n${body}`);
  }
}

/** 在时间线滚动层上安装诊断监听（组件挂载 / 会话切换时调用）。 */
export function attachScrollJitterDiag(el: HTMLDivElement): void {
  if (!isEnabled()) return;
  if (activeEl && activeEl !== el) {
    detachScrollJitterDiag(activeEl);
  }
  if (activeEl === el) return;
  activeEl = el;
  lastObservedTop = el.scrollTop;
  lastObservedScrollHeight = el.scrollHeight;
  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("scroll", onScroll, { passive: true });
  console.info("[v4-scroll-diag] 已挂载（上滚停住后会采样 scrollTop；localStorage.evoflow_v4_scroll_diag=0 关闭）");
}

export function detachScrollJitterDiag(el: HTMLDivElement): void {
  if (activeEl !== el) return;
  activeEl = null;
  sampling = false;
  if (wheelStopTimer !== null) {
    clearTimeout(wheelStopTimer);
    wheelStopTimer = null;
  }
  if (sampleFinishTimer !== null) {
    clearTimeout(sampleFinishTimer);
    sampleFinishTimer = null;
  }
  el.removeEventListener("wheel", onWheel);
  el.removeEventListener("scroll", onScroll);
}
