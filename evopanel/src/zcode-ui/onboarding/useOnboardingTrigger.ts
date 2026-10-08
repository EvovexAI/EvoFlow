import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * 引导触发判定：当前用户在本地记录里没有条目时
 * needsOnboarding=true。settings 回填（换号恢复偏好）只在 userId 运行时变化后发生；
 * 手动修改由各入口回写 record（updateRecordPreferences），record 始终等于该用户最新偏好。
 *
 * 返回 [needsOnboarding, markOnboarded]：null 表示异步判定中；markOnboarded 在引导
 * 保存成功后把判定置 false（记录已落盘，本次会话不再触发）。
 */
export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const { onboardingRecord, userId, hasStoredOccupation, loadDeviceMid, update } = options;
  // null 表示异步判定中（按本地使用记录判断是否触发）。
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // 记录上一次判定时的 userId，回填只在身份实际变化后发生（见下方回填条件）。
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const fallback = () => !hasStoredOccupation;
    // 服务不可用（旧测试 double / 未注册的 host）时退回旧 settings 判定，行为不回退。
    if (!onboardingRecord) {
      setNeedsOnboarding(fallback());
      return;
    }
    // shouldOnboard 走 RPC，host 未带上 onboarding-record channel 时调用会挂起，
    // 之前判定期间渲染 null 会把整个主界面拦成永久黑屏。加超时兜底退回 settings 判定，
    // 保证任何情况下主界面最多等 3 秒。
    const timeout = setTimeout(() => {
      if (!cancelled) {
        logger.warn("[occupation-onboarding] shouldOnboard 超时，退回 settings 判定");
        setNeedsOnboarding(fallback());
      }
    }, 3000);
    // 登录认领先行：未登录时答的引导（null 条目）移交给当前登录用户，同一人不重复引导。
    // 必须 await 完成后再判定，否则 shouldOnboard 读到认领前的文件会误判需要引导。
    onboardingRecord
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 认领匿名引导记录失败", { error: String(cause) });
      })
      .then(() => onboardingRecord.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) setNeedsOnboarding(result);
          // 换账号恢复该用户偏好：settings 不分用户，A 答完后 B 触发引导会把 settings 顶成
          // B 的答案；再切回 A 时按 record 最近作答回填。同步失败只留日志。
          // 仅"上次是非空的另一身份"时回填（A→B 直切、B→登出）。null→id 不回填：启动 OAuth
          // 恢复与运行中登录共用该序列且无法区分，宁可少回填——手动修改已由各入口回写
          // record（record=最新偏好），缺失回填只影响"apikey 态后登录旧账号"这类边缘场景。
          const previousUserId = lastSyncedUserIdRef.current;
          lastSyncedUserIdRef.current = userId;
          if (!cancelled && !result && previousUserId != null && previousUserId !== userId) {
            void onboardingRecord
              .syncSettingsFromRecord()
              .then((patch) => {
                if (cancelled || !patch) return;
                return update(patch);
              })
              .catch((cause: unknown) => {
                logger.warn("[occupation-onboarding] 按记录同步偏好失败", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
          logger.warn("[occupation-onboarding] shouldOnboard 检查失败", { error: String(cause) });
          if (!cancelled) setNeedsOnboarding(fallback());
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // 不依赖 hasStoredOccupation（对应 settings?.onboardingOccupation）：保存成功会改写该字段，
    // 若记录写入失败会在当场重开引导；记录缺失导致的再次触发按约定留给下次启动。
  }, [onboardingRecord, userId, loadDeviceMid]);
  return [needsOnboarding, () => setNeedsOnboarding(false)];
}
