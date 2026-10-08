import type {
  CodingPlanQuotaResetAutoPlayReservation,
  CodingPlanQuotaResetAutoPlayReservationAttempt,
} from "@/store/codingPlanQuotaResetState.js";

type CodingPlanQuotaResetAutoPlayCoordinationResult =
  | { status: "committed" }
  | { status: "released" }
  | { status: "retry"; retryAfterMs: number }
  | { status: "blocked" };

/**
 * 把异步 reservation 和组件展示边界串起来。
 *
 * Main 返回 winner 时 Composer 可能已经卸载或切换 source；必须先用 isCurrent
 * 复核，再 commit played。失效 winner 只 release token，不能消费全局播放资格。
 */
export async function coordinateCodingPlanQuotaResetAutoPlay(params: {
  reserve: () => Promise<CodingPlanQuotaResetAutoPlayReservationAttempt>;
  isCurrent: () => boolean;
  commit: (reservation: CodingPlanQuotaResetAutoPlayReservation) => boolean;
  release: (reservation: CodingPlanQuotaResetAutoPlayReservation) => Promise<void>;
  onCommitted: (reservation: CodingPlanQuotaResetAutoPlayReservation) => void;
}): Promise<CodingPlanQuotaResetAutoPlayCoordinationResult> {
  const attempt = await params.reserve();
  if (attempt.status === "retry") {
    return attempt;
  }
  if (attempt.status === "blocked") {
    return attempt;
  }

  const { reservation } = attempt;
  if (!params.isCurrent()) {
    await params.release(reservation);
    return { status: "released" };
  }
  if (!params.commit(reservation)) {
    await params.release(reservation);
    return { status: "released" };
  }

  params.onCommitted(reservation);
  return { status: "committed" };
}
