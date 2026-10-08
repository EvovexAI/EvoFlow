import type { BroadcastClaimLease, BroadcastMessage, IBroadcastService } from "@zcode/services";
import type { CodingPlanResetType } from "@zcode/shared";
import type {
  CodingPlanQuotaResetUiEntries,
  CodingPlanQuotaResetUiEntry,
} from "@/lib/codingPlanQuotaResetUi.js";

export interface CodingPlanQuotaResetAutomaticObservation {
  completedAt: number;
  /** 同一 renderer 生命周期内，用户由未登录进入登录态时递增的鉴权会话序号。 */
  authSessionSeq: number;
}

export interface CodingPlanQuotaResetAutomaticObservations {
  fiveHour: CodingPlanQuotaResetAutomaticObservation | null;
  week: CodingPlanQuotaResetAutomaticObservation | null;
}

/** 跨窗口已播记录：source + 类型 -> 已在任一窗口播放过自动完成提示的 used_at。 */
export interface CodingPlanQuotaResetAutoPlayedSlot {
  fiveHour: number | null;
  week: number | null;
}

interface CodingPlanQuotaResetStoreState {
  authSessionSeq: number;
  codingPlanQuotaResetUiBySource: Record<string, CodingPlanQuotaResetUiEntries>;
  codingPlanQuotaResetAutomaticObservationsBySource: Record<
    string,
    CodingPlanQuotaResetAutomaticObservations
  >;
  codingPlanQuotaResetAutoPlayedBySource: Record<string, CodingPlanQuotaResetAutoPlayedSlot>;
}

/** 自动完成"多窗口只播一次"的跨窗口广播频道（state: 前缀符合跨窗口状态同步约定）。 */
const CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL = "state:codereset-autoplayed";

interface CodingPlanQuotaResetAutoPlayedBroadcastPayload {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}

function buildCodingPlanQuotaResetAutoPlayClaimKey(
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): string {
  return `coding-plan-reset-autoplay:${encodeURIComponent(sourceKey)}:${resetType}:${completedAt}`;
}

function parseCodingPlanQuotaResetAutoPlayedPayload(
  payload: unknown,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const sourceKey = typeof record.sourceKey === "string" ? record.sourceKey.trim() : "";
  const resetType =
    record.resetType === "WEEK" || record.resetType === "FIVE_HOUR" ? record.resetType : null;
  const completedAt =
    typeof record.completedAt === "number" && Number.isFinite(record.completedAt)
      ? record.completedAt
      : null;
  if (!sourceKey || !resetType || completedAt === null) {
    return null;
  }
  return { sourceKey, resetType, completedAt };
}

/**
 * 解析"自动完成已播"跨窗口广播；非本频道消息、本地回声与非法 payload 均返回 null。
 *
 * host 的 send 会先把消息本地回声给本窗口 Renderer（无 sourceWindowId）；
 * 只有 BroadcastHub 中转的跨窗口消息才带 sourceWindowId，本地回声必须忽略，
 * 否则自己刚广播的"已播放"会把自己的动画当场抑制掉。
 */
export function parseCodingPlanQuotaResetAutoPlayedBroadcastMessage(
  message: Pick<BroadcastMessage, "channel" | "payload" | "sourceWindowId">,
): CodingPlanQuotaResetAutoPlayedBroadcastPayload | null {
  if (message.channel !== CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL) {
    return null;
  }
  if (message.sourceWindowId === undefined) {
    return null;
  }
  return parseCodingPlanQuotaResetAutoPlayedPayload(message.payload);
}

/**
 * 广播本窗口首次播放的自动完成 used_at，其他窗口收到后抑制同 used_at 的提示。
 */
function broadcastCodingPlanQuotaResetAutoPlayed(
  broadcastService: Pick<IBroadcastService, "send">,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): void {
  void broadcastService.send({
    channel: CODING_PLAN_QUOTA_RESET_AUTO_PLAYED_CHANNEL,
    payload: { sourceKey, resetType, completedAt },
  });
}

interface CodingPlanQuotaResetStoreUpdate {
  patch: Pick<
    CodingPlanQuotaResetStoreState,
    | "codingPlanQuotaResetUiBySource"
    | "codingPlanQuotaResetAutomaticObservationsBySource"
    | "codingPlanQuotaResetAutoPlayedBySource"
  >;
}

/**
 * 原子写入重置 UI 状态和自动完成的鉴权会话轨迹，避免 entry 与观察记录跨 render 不一致。
 *
 * status 观察和 Composer 播放资格必须分离。设置页 / Usage 页也会调用本函数，
 * 如果在这里直接写 played，就会在没有展示 Tooltip/撒花时提前消耗跨窗口播放资格。
 */
function updateCodingPlanQuotaResetStoreState(
  state: CodingPlanQuotaResetStoreState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  entry: CodingPlanQuotaResetUiEntry | null,
  authSessionSeq: number,
): CodingPlanQuotaResetStoreUpdate {
  // 旧鉴权会话中的异步 status 可能在退出登录、组件卸载后才返回。
  // Store 必须在原子写入点校验序号，不能只依赖已卸载 Hook 内不会再更新的 ref。
  if (state.authSessionSeq !== authSessionSeq) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextEntries = { ...state.codingPlanQuotaResetUiBySource };
  const current = nextEntries[sourceKey] ?? { fiveHour: null, week: null };
  const updated =
    resetType === "WEEK" ? { ...current, week: entry } : { ...current, fiveHour: entry };
  if (updated.fiveHour === null && updated.week === null) {
    delete nextEntries[sourceKey];
  } else {
    nextEntries[sourceKey] = updated;
  }

  const automaticCompletedAt =
    entry?.status === "completed" && entry.startedAt === null ? entry.completedAt : null;
  if (automaticCompletedAt === null) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const currentObservations = state.codingPlanQuotaResetAutomaticObservationsBySource[
    sourceKey
  ] ?? {
    fiveHour: null,
    week: null,
  };
  const previousObservation =
    resetType === "WEEK" ? currentObservations.week : currentObservations.fiveHour;
  // 观察记录表达“首次看到 used_at 的鉴权会话”。重新登录后同一历史的
  // 对账只能更新 entry，不能把 observation 改写到新会话，否则下一轮会重新播放旧动画。
  if (previousObservation?.completedAt === automaticCompletedAt) {
    return {
      patch: {
        codingPlanQuotaResetUiBySource: nextEntries,
        codingPlanQuotaResetAutomaticObservationsBySource:
          state.codingPlanQuotaResetAutomaticObservationsBySource,
        codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
      },
    };
  }

  const nextObservations = {
    ...state.codingPlanQuotaResetAutomaticObservationsBySource,
  };
  const observation = { completedAt: automaticCompletedAt, authSessionSeq };
  nextObservations[sourceKey] =
    resetType === "WEEK"
      ? { ...currentObservations, week: observation }
      : { ...currentObservations, fiveHour: observation };

  return {
    patch: {
      codingPlanQuotaResetUiBySource: nextEntries,
      codingPlanQuotaResetAutomaticObservationsBySource: nextObservations,
      codingPlanQuotaResetAutoPlayedBySource: state.codingPlanQuotaResetAutoPlayedBySource,
    },
  };
}

/**
 * 应用来自其他窗口的"已播放"广播：合并 played 记录，并把本窗口正在播放的
 * 同 used_at 自动完成 observedAt 置空（收起 Tooltip、阻止后续撒花补播）。
 */
export function applyCodingPlanQuotaResetAutoPlayedBroadcast(
  state: Pick<
    CodingPlanQuotaResetStoreState,
    "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
  >,
  payload: CodingPlanQuotaResetAutoPlayedBroadcastPayload,
): Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
> {
  const playedBySource = { ...state.codingPlanQuotaResetAutoPlayedBySource };
  const slot = playedBySource[payload.sourceKey] ?? { fiveHour: null, week: null };
  const currentPlayed = payload.resetType === "WEEK" ? slot.week : slot.fiveHour;
  // 跨窗口消息可能乱序到达。played 是“至少已播到哪个 used_at”的单调游标，
  // 旧广播晚到不能把新记录回退，否则后续 status 会把已播完成再次当成候选。
  if (currentPlayed === null || payload.completedAt > currentPlayed) {
    playedBySource[payload.sourceKey] =
      payload.resetType === "WEEK"
        ? { ...slot, week: payload.completedAt }
        : { ...slot, fiveHour: payload.completedAt };
  }

  const entriesBySource = { ...state.codingPlanQuotaResetUiBySource };
  const entries = entriesBySource[payload.sourceKey];
  const key = payload.resetType === "WEEK" ? "week" : "fiveHour";
  const entry = entries?.[key];
  if (
    entry &&
    entry.status === "completed" &&
    entry.startedAt === null &&
    entry.completedAt === payload.completedAt &&
    entry.observedAt !== null
  ) {
    entriesBySource[payload.sourceKey] = {
      ...entries,
      [key]: { ...entry, observedAt: null },
    } as CodingPlanQuotaResetUiEntries;
  }

  return {
    codingPlanQuotaResetUiBySource: entriesBySource,
    codingPlanQuotaResetAutoPlayedBySource: playedBySource,
  };
}

type CodingPlanQuotaResetAutoPlayState = Pick<
  CodingPlanQuotaResetStoreState,
  "codingPlanQuotaResetUiBySource" | "codingPlanQuotaResetAutoPlayedBySource"
>;

export interface CodingPlanQuotaResetAutoPlayReservation {
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
  lease: BroadcastClaimLease;
}

export type CodingPlanQuotaResetAutoPlayReservationAttempt =
  | { status: "reserved"; reservation: CodingPlanQuotaResetAutoPlayReservation }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

function isCodingPlanQuotaResetAutoPlayCandidate(
  state: CodingPlanQuotaResetAutoPlayState,
  sourceKey: string,
  resetType: CodingPlanResetType,
  completedAt: number,
): boolean {
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const candidate = state.codingPlanQuotaResetUiBySource[sourceKey]?.[key];
  const played = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  return Boolean(
    candidate?.status === "completed" &&
    candidate.startedAt === null &&
    candidate.observedAt !== null &&
    candidate.completedAt === completedAt &&
    (played === null || played < completedAt),
  );
}

/**
 * Composer 在播放自动完成提示前申请临时 reservation。
 *
 * reservation 与 played 提交必须分离。等待 Main 期间组件可能卸载或切换 source；
 * 此阶段只占用带 token 的临时 lease，不写 played、不广播，也不把 busy 误判为已播放。
 */
export async function reserveCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "acquireClaim" | "releaseClaim">;
  readState: () => CodingPlanQuotaResetAutoPlayState;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  sourceKey: string;
  resetType: CodingPlanResetType;
  completedAt: number;
}): Promise<CodingPlanQuotaResetAutoPlayReservationAttempt> {
  const { broadcastService, readState, writeState, sourceKey, resetType, completedAt } = params;
  const payload = { sourceKey, resetType, completedAt };
  const key = resetType === "WEEK" ? "week" : "fiveHour";
  const initialState = readState();
  const initialPlayed =
    initialState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
  if (initialPlayed !== null && initialPlayed >= completedAt) {
    writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    return { status: "blocked" };
  }
  if (!isCodingPlanQuotaResetAutoPlayCandidate(initialState, sourceKey, resetType, completedAt)) {
    return { status: "blocked" };
  }

  let claimResult;
  try {
    claimResult = await broadcastService.acquireClaim(
      buildCodingPlanQuotaResetAutoPlayClaimKey(sourceKey, resetType, completedAt),
    );
  } catch {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "busy") {
    return { status: "retry", retryAfterMs: Math.max(50, claimResult.retryAfterMs) };
  }
  if (claimResult.status === "unavailable") {
    return { status: "retry", retryAfterMs: 500 };
  }
  if (claimResult.status === "committed") {
    // committed 只说明 Main 已有永久 claim；loser 仍等待真实 played 广播/本地游标，
    // 不能在这里清 observedAt，否则会再次把“已占用”误当成“已播放”。
    return { status: "blocked" };
  }

  const latestState = readState();
  if (!isCodingPlanQuotaResetAutoPlayCandidate(latestState, sourceKey, resetType, completedAt)) {
    await broadcastService.releaseClaim(claimResult.lease);
    const latestPlayed =
      latestState.codingPlanQuotaResetAutoPlayedBySource[sourceKey]?.[key] ?? null;
    if (latestPlayed !== null && latestPlayed >= completedAt) {
      writeState((state) => applyCodingPlanQuotaResetAutoPlayedBroadcast(state, payload));
    }
    return { status: "blocked" };
  }

  return {
    status: "reserved",
    reservation: { sourceKey, resetType, completedAt, lease: claimResult.lease },
  };
}

/**
 * 组件确认仍 mounted、source/candidate 匹配并即将展示时提交 reservation。
 * 本函数同步写本地 played，再发送 Main commit 与 played 广播；同一 JS task 内不会穿插卸载。
 */
export function commitCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "commitClaim" | "send">;
  writeState: (
    updater: (state: CodingPlanQuotaResetAutoPlayState) => CodingPlanQuotaResetAutoPlayState,
  ) => void;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): boolean {
  const { broadcastService, writeState, reservation } = params;
  const { sourceKey, resetType, completedAt } = reservation;
  let committed = false;
  writeState((state) => {
    if (!isCodingPlanQuotaResetAutoPlayCandidate(state, sourceKey, resetType, completedAt)) {
      return state;
    }
    committed = true;
    const slots = state.codingPlanQuotaResetAutoPlayedBySource[sourceKey] ?? {
      fiveHour: null,
      week: null,
    };
    return {
      codingPlanQuotaResetUiBySource: state.codingPlanQuotaResetUiBySource,
      codingPlanQuotaResetAutoPlayedBySource: {
        ...state.codingPlanQuotaResetAutoPlayedBySource,
        [sourceKey]:
          resetType === "WEEK"
            ? { ...slots, week: completedAt }
            : { ...slots, fiveHour: completedAt },
      },
    };
  });
  if (!committed) {
    return false;
  }

  void broadcastService.commitClaim(reservation.lease);
  broadcastCodingPlanQuotaResetAutoPlayed(broadcastService, sourceKey, resetType, completedAt);
  return true;
}

export async function releaseCodingPlanQuotaResetAutoPlay(params: {
  broadcastService: Pick<IBroadcastService, "releaseClaim">;
  reservation: CodingPlanQuotaResetAutoPlayReservation;
}): Promise<void> {
  await params.broadcastService.releaseClaim(params.reservation.lease);
}

interface CodingPlanQuotaResetStoreActions {
  setCodingPlanQuotaResetUiEntry: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    entry: CodingPlanQuotaResetUiEntry | null,
    authSessionSeq: number,
  ) => void;
  reserveCodingPlanQuotaResetAutoPlay: (
    sourceKey: string,
    resetType: CodingPlanResetType,
    completedAt: number,
  ) => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  commitCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => boolean;
  releaseCodingPlanQuotaResetAutoPlay: (
    reservation: CodingPlanQuotaResetAutoPlayReservation,
  ) => Promise<void>;
}

type CodingPlanQuotaResetStoreWriter = (
  updater: (state: CodingPlanQuotaResetStoreState) => Partial<CodingPlanQuotaResetStoreState>,
) => void;

/** 把重置状态 action 集中在本领域文件，避免全局 Store 再次膨胀。 */
export function createCodingPlanQuotaResetStoreActions(params: {
  broadcastService: Pick<
    IBroadcastService,
    "acquireClaim" | "commitClaim" | "releaseClaim" | "send"
  >;
  readState: () => CodingPlanQuotaResetStoreState;
  writeState: CodingPlanQuotaResetStoreWriter;
}): CodingPlanQuotaResetStoreActions {
  const { broadcastService, readState, writeState } = params;
  return {
    setCodingPlanQuotaResetUiEntry: (sourceKey, resetType, entry, authSessionSeq) =>
      writeState(
        (state) =>
          updateCodingPlanQuotaResetStoreState(state, sourceKey, resetType, entry, authSessionSeq)
            .patch,
      ),
    reserveCodingPlanQuotaResetAutoPlay: (sourceKey, resetType, completedAt) =>
      reserveCodingPlanQuotaResetAutoPlay({
        broadcastService,
        readState,
        writeState: (updater) => writeState((state) => updater(state)),
        sourceKey,
        resetType,
        completedAt,
      }),
    commitCodingPlanQuotaResetAutoPlay: (reservation) =>
      commitCodingPlanQuotaResetAutoPlay({
        broadcastService,
        writeState: (updater) => writeState((state) => updater(state)),
        reservation,
      }),
    releaseCodingPlanQuotaResetAutoPlay: (reservation) =>
      releaseCodingPlanQuotaResetAutoPlay({ broadcastService, reservation }),
  };
}
