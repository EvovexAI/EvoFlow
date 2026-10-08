/**
 * Computer Use Helper 权限状态的进程内共享缓存。
 *
 * 为什么需要它：权限状态有两个消费方——设置页「电脑控制」分区与输入框常驻入口按钮。
 * 二者过去各自持有一份 useCuaPermissionStatus 实例，各自轮询、各自维护 sticky 探针快照，
 * 结果是同一台机器的同一份 TCC 授权在两处可能显示成不同状态，且请求量翻倍。
 * 这里把「上次结果 + in-flight 去重 + sticky 探针」收敛成按 workspace 分槽的单一真相。
 *
 * 刷新是事件驱动而非定时轮询（进入页面 / 应用重获焦点 / 显式 refresh），
 * 由 useCuaPermissionStatus 触发。缓存跨组件卸载保留：重新进入设置页时先渲染上次的授权状态，
 * 不再从 null 闪一下「未知」再跳到已授权。
 */
import { isCuaPermissionStatusAvailable } from "@zcode/services";
import type {
  CuaPermissionStatus,
  CuaPermissionStatusQueryOptions,
  CuaPermissionStatusResult,
  ICuaPermissionService,
} from "@zcode/services";

import {
  persistCuaPermissionStatus,
  readCachedCuaPermissionStatus,
} from "./cuaPermissionStatusCache.js";

interface CuaPermissionStatusSnapshot {
  /** 上次成功查询的结果；null = 该 workspace 尚未拿到过任何状态。 */
  status: CuaPermissionStatusResult | null;
  /**
   * status 是否可用于决策。查询进行中或最近一次查询失败时为 false——
   * 展示可以继续沿用 lastKnown，但「打开系统设置」这类动作必须等新结果。
   */
  fresh: boolean;
  /**
   * 是否已有可展示的确定内容。冷启动缓存命中即成立，拿到过真实结果后只升不降。
   *
   * 与 fresh 的分工：fresh 表达「当前值是否刚确认」，每次查询开始都会落回 false；
   * 展示若跟着它走，授权按钮就会在「打开系统设置」与「验证中…」之间反复切换、
   * 按钮宽度随之跳变。settled 专供展示，避免这种抖动。
   */
  settled: boolean;
}

/**
 * 未命中槽位时返回的快照。useSyncExternalStore 要求 getSnapshot 的返回值引用稳定，
 * 每次新建对象会触发无限重渲染，因此惰性构造一次后复用。
 *
 * 首值取自跨进程缓存：进程内槽位重启即空，若首帧仍是 null，设置页两行权限会先渲染出
 * 授权按钮、随首次查询返回再整体消失（行高塌陷）。TCC 授权属于 Helper bundle 而非
 * workspace，所以这份缓存对任何 workspace 都是当前最佳猜测；「尚未确认」由 fresh=false 表达。
 */
let initialSnapshotCache: CuaPermissionStatusSnapshot | null = null;

function initialSnapshot(): CuaPermissionStatusSnapshot {
  if (!initialSnapshotCache) {
    const cached = readCachedCuaPermissionStatus();
    initialSnapshotCache = { status: cached, fresh: false, settled: cached !== null };
  }
  return initialSnapshotCache;
}

interface Slot {
  snapshot: CuaPermissionStatusSnapshot;
  inFlight: boolean;
  /** 查询进行中又来了新的刷新请求：合并成一次补查，而不是并发发起。 */
  rerunRequested: boolean;
  /** 主动截图是显式用户意图，只做 OR 合并；消费后立即复位，同一轮最多执行一次。 */
  pendingFunctionalProbe: boolean;
  /** 瞬态不可用的退避重试计时器；稳态下恒为 undefined。 */
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 已用掉的重试次数，索引 TRANSIENT_RETRY_DELAYS_MS。 */
  retryAttempt: number;
  /**
   * 已就绪快照：一旦观察到 fully-ready（TCC 双项 granted + 两个功能探针都 ok），
   * 后续只读刷新里只要 TCC 双项仍 granted，就沿用已确认 ok 的探针结果。
   * 只读查询本来就不会跑截图探针（上游 shouldRunCuaScreenCaptureProbe 要求显式
   * includeFunctionalProbes），若如实下推 false 会把之前实测到的就绪结论抹掉。
   * 真实降级（TCC 被吊销 / Helper 不可用）走 else 分支清 sticky，如实发布。
   */
  stickyReady: CuaPermissionStatus | null;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

/**
 * 与设置页 helperContextKey 同构：权限归属于 (workspace 路径, workspace identity)。
 * 用 NUL 分隔，避免路径里的空格让不同 workspace 撞进同一槽位。
 */
export function cuaPermissionStatusKey(workspacePath: string, workspaceIdentity?: string): string {
  return [workspacePath, workspaceIdentity?.trim() ?? ""].join("\u0000");
}

export function subscribeCuaPermissionStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCuaPermissionStatusSnapshot(key: string | null): CuaPermissionStatusSnapshot {
  if (!key) return initialSnapshot();
  return slots.get(key)?.snapshot ?? initialSnapshot();
}

function ensureSlot(key: string): Slot {
  const existing = slots.get(key);
  if (existing) return existing;
  const created: Slot = {
    snapshot: initialSnapshot(),
    inFlight: false,
    rerunRequested: false,
    pendingFunctionalProbe: false,
    retryTimer: undefined,
    retryAttempt: 0,
    stickyReady: null,
  };
  slots.set(key, created);
  return created;
}

function clearTransientRetry(slot: Slot): void {
  if (slot.retryTimer) clearTimeout(slot.retryTimer);
  slot.retryTimer = undefined;
}

function publish(slot: Slot, snapshot: CuaPermissionStatusSnapshot): void {
  if (
    slot.snapshot.status === snapshot.status &&
    slot.snapshot.fresh === snapshot.fresh &&
    slot.snapshot.settled === snapshot.settled
  )
    return;
  slot.snapshot = snapshot;
  for (const listener of listeners) listener();
}

/**
 * 展示态就绪：TCC 双项 granted。设置页权限行与输入框入口按钮共用这一口径，
 * 保证同一份授权在两处显示一致。
 *
 * 为什么展示态不看功能探针：只读刷新按上游约定永不运行截图探针
 * （shouldRunCuaScreenCaptureProbe 要求显式 includeFunctionalProbes，主动抓屏必须是
 * 用户意图），screenCaptureProbeOk 因而恒为 false，拿它判展示等于把已授权用户恒判成
 * 待授权。真实不可用（TCC 记了授权但 WindowServer 未放行像素等）由工具调用的普通
 * MCP error 暴露给模型，Renderer 不靠常驻查询或错误文本猜权限。
 */
export function isCuaPermissionTccGranted(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  );
}

/**
 * runtime 端到端就绪：TCC 双项 granted **且**两个功能探针实测通过。
 * 只有刚做完一次显式主动探针（授权返回 / Helper 重启后验证）才可能成立，
 * 因此仅用于下方 sticky 快照的记录条件，不作为展示口径。
 */
function isFunctionallyReady(result: CuaPermissionStatusResult | null): boolean {
  return (
    !!result &&
    "accessibility" in result &&
    result.accessibility === "granted" &&
    result.accessibilityProbeOk === true &&
    result.screenRecording === "granted" &&
    result.screenCaptureProbeOk === true
  );
}

/** 应用 sticky 探针，返回真正对外发布的结果。 */
function withStickyProbes(
  slot: Slot,
  result: CuaPermissionStatusResult,
): CuaPermissionStatusResult {
  if (!("accessibility" in result)) {
    slot.stickyReady = null;
    return result;
  }
  if (isFunctionallyReady(result)) {
    slot.stickyReady = result;
    return result;
  }
  if (
    slot.stickyReady &&
    result.accessibility === "granted" &&
    result.screenRecording === "granted"
  ) {
    return {
      ...result,
      accessibilityProbeOk: slot.stickyReady.accessibilityProbeOk,
      screenCaptureProbeOk: slot.stickyReady.screenCaptureProbeOk,
    };
  }
  slot.stickyReady = null;
  return result;
}

/**
 * 瞬态不可用的退避重试间隔（毫秒）。
 *
 * 为什么需要它：main 侧 getStatus 在 Helper host 尚未 running 时如实返回 unavailable
 * （见 packages/services/src/node.ts）。Helper 冷启动 / 插件刚启用后的 recreate 都会
 * 落进这个窗口——本机实测从 installed 到 ready 约 3 秒。事件驱动刷新只在挂载 / 焦点 /
 * 显式 refresh 时采样，若把这种样本当终态，输入框入口会红点 +「错误」且不可点击，
 * 用户停在应用内没有任何自愈路径。旧的轮询实现靠下一轮采样兜住，这里用有界退避替代：
 * 累计约 7 秒足够覆盖冷启动窗口，用尽后如实报错，稳态下不产生任何计时器。
 */
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * 安排一次退避重试；额度用尽返回 false，由调用方如实发布结果。
 * 重试不带 options：主动截图探针是显式用户意图，不该被自动重试放大。
 */
function scheduleTransientRetry(slot: Slot, params: FetchCuaPermissionStatusParams): boolean {
  const delay = TRANSIENT_RETRY_DELAYS_MS[slot.retryAttempt];
  if (delay === undefined) {
    // 复位，让下一次真实事件（focus / refresh / 重新挂载）重新获得完整重试额度。
    slot.retryAttempt = 0;
    return false;
  }
  slot.retryAttempt += 1;
  clearTransientRetry(slot);
  slot.retryTimer = setTimeout(() => {
    slot.retryTimer = undefined;
    const { service, workspacePath, workspaceIdentity } = params;
    fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity, mode: "retry" });
  }, delay);
  return true;
}

interface FetchCuaPermissionStatusParams {
  service: ICuaPermissionService;
  workspacePath: string;
  workspaceIdentity?: string;
  options?: CuaPermissionStatusQueryOptions;
  /**
   * "refresh"（默认）= 外部状态可能刚变（焦点返回、Helper 重启、插件开关），进行中的查询
   * 可能读的是旧世界，必须补一次；
   * "ensure" = 只要求「有一份新鲜结果」（组件挂载），已有查询在飞时直接搭车，
   * 否则设置页与输入框入口先后挂载会各自排队，白白多打一次 host RPC；
   * "retry" = store 自己排的退避重试，**不重置重试计数**——否则每次重试都拿回满额度，
   * 有界退避会退化成固定间隔的无限轮询。
   */
  mode?: "refresh" | "ensure" | "retry";
}

/**
 * 拉一次权限状态并写入共享缓存。同一 workspace 的并发调用会被合并：进行中时至多记一个补查，
 * 避免原生授权 prompt / 系统设置来回切换连续产生 focus 时把 AX + 截图探针叠成一串。
 */
export function fetchCuaPermissionStatus(params: FetchCuaPermissionStatusParams): void {
  const { service, workspacePath, workspaceIdentity, options, mode = "refresh" } = params;
  const key = cuaPermissionStatusKey(workspacePath, workspaceIdentity);
  const slot = ensureSlot(key);
  slot.pendingFunctionalProbe ||= options?.includeFunctionalProbes === true;
  if (slot.inFlight) {
    if (mode === "refresh") slot.rerunRequested = true;
    return;
  }
  // 真实事件（挂载 / focus / 显式 refresh）接管采样：取消排队中的退避重试，并把额度归零。
  // retry 自身不走这里——否则每次重试都拿回满额度，有界退避会变成无限轮询。
  if (mode !== "retry") {
    clearTransientRetry(slot);
    slot.retryAttempt = 0;
  }
  slot.inFlight = true;
  const includeFunctionalProbes = slot.pendingFunctionalProbe;
  slot.pendingFunctionalProbe = false;
  // 查询期间旧结果不可用于决策：用户可能刚在系统设置里改过授权，或 Helper 正在换代。
  publish(slot, { status: slot.snapshot.status, fresh: false, settled: slot.snapshot.settled });

  let completed: CuaPermissionStatusResult | null = null;
  void Promise.resolve()
    .then(() => service.getStatus(workspacePath, workspaceIdentity, { includeFunctionalProbes }))
    .then((result) => {
      completed = result;
    })
    .catch(() => {
      // 保留 lastKnown 展示；由下方的退避重试收敛。
    })
    .finally(() => {
      slot.inFlight = false;
      if (slot.rerunRequested) {
        // 刷新发生在查询过程中：旧结果可能来自重启前的 Helper，不发布，只补一次新查询。
        slot.rerunRequested = false;
        fetchCuaPermissionStatus({ service, workspacePath, workspaceIdentity });
        return;
      }
      // 查询失败 / Helper 尚未 running 都是环境瞬态，不是授权终态。还有重试额度时保留上一状态
      // （fresh=false 表示未确认），让退避重试去收敛。
      //
      // 额度用尽后两个分支的归宿不同，这里如实说明：
      // - 结果是 unavailable（Helper 确实起不来）→ 落到下方如实发布，UI 显示错误态；
      // - 查询 reject（RPC 通道故障）→ 落到 `if (!completed)`，只保留 lastKnown + fresh=false，
      //   **不产生错误终态**。冷启动且无缓存时入口会停在 starting、设置页停在「验证中」，
      //   直到下一次真实事件（focus / 重新挂载 / 显式 refresh）重新采样。这是刻意的：通道故障
      //   说明「我们不知道权限状态」，而不是「权限有问题」，把它渲染成红色错误会误导用户去
      //   重新授权。代价是这种故障下没有可见的错误提示，仅在 RPC 持续失败时出现。
      const transient = !completed || !isCuaPermissionStatusAvailable(completed);
      if (transient && scheduleTransientRetry(slot, params)) {
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      if (!completed) {
        // reject 且重试额度已用尽：保留 lastKnown + fresh=false，等下一次真实事件（见上）。
        publish(slot, {
          status: slot.snapshot.status,
          fresh: false,
          settled: slot.snapshot.settled,
        });
        return;
      }
      slot.retryAttempt = 0;
      const published = withStickyProbes(slot, completed);
      publish(slot, { status: published, fresh: true, settled: true });
      // 供下次冷启动首屏使用。unavailable 由 persist 内部忽略：Helper 没起来是环境态，
      // 记住它只会让下次冷启动的首屏错得更久。
      persistCuaPermissionStatus(published);
    });
}
