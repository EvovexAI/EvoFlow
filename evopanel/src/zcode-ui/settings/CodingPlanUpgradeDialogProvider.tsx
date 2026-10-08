import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CodingPlanUpgradeDialog,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/CodingPlanUpgradeDialog.js";

import {
  useCodingPlanEntryPlanList,
  type CodingPlanEntryInventory,
} from "@/hooks/useCodingPlanEntryPlanList.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { reportCodingPlanUpgradeClick } from "@/lib/codingPlanFunnelTelemetry.js";

interface CodingPlanUpgradeDialogContextValue {
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

const CodingPlanUpgradeDialogContext = createContext<CodingPlanUpgradeDialogContextValue | null>(
  null,
);

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const inventory = useCodingPlanEntryPlanList();
  const inventoryRef = useRef(inventory);
  inventoryRef.current = inventory;
  const [target, setTarget] = useState<CodingPlanUpgradeDialogTarget | undefined>(undefined);
  const [openVersion, setOpenVersion] = useState(0);
  const opening = useRef<((opened: boolean) => void) | null>(null);
  const handleOpenResult = useCallback((opened: boolean) => opening.current?.(opened), []);
  useEffect(() => () => opening.current?.(false), []);
  const openCodingPlanUpgrade = useCallback(
    (
      nextTarget: CodingPlanUpgradeDialogTarget,
      observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
    ) => {
      // 所有入口统一守卫；查询完成后不自动重放之前被拦截的点击。
      const { status, entryPlanList } = inventoryRef.current;
      if (observation?.signal.aborted) return false;
      if (status !== "ready") {
        if (observation && status === "error") inventoryRef.current.retry();
        return false;
      }
      opening.current?.(false);
      if (observation) {
        const finish = (opened: boolean) => {
          if (opening.current !== finish) return;
          opening.current = null;
          observation.signal.removeEventListener("abort", abort);
          if (!opened) setTarget(undefined);
          observation.onResult(opened);
        };
        const abort = () => finish(false);
        opening.current = finish;
        observation.signal.addEventListener("abort", abort, { once: true });
      }
      // 原入口只携带当前卡片的套餐；在点击时冻结全连接列表，App 与 WebView 共用同一快照。
      nextTarget = nextTarget.funnelContext
        ? {
            ...nextTarget,
            funnelContext: { ...nextTarget.funnelContext, entryPlanList },
          }
        : nextTarget;
      if (nextTarget.funnelContext) {
        void reportCodingPlanUpgradeClick(platform, nextTarget.funnelContext);
      }
      setTarget(nextTarget);
      // 每次显式打开隔离旧 webview 事件，旧 dom-ready 不能确认新的观察请求。
      setOpenVersion((version) => version + 1);
      return true;
    },
    [platform],
  );
  const value = useMemo(
    () => ({ openCodingPlanUpgrade, inventory }),
    [openCodingPlanUpgrade, inventory],
  );

  return (
    <CodingPlanUpgradeDialogContext.Provider value={value}>
      {children}
      <CodingPlanUpgradeDialog
        key={openVersion}
        target={target}
        onClose={() => {
          handleOpenResult(false);
          setTarget(undefined);
        }}
        onOpenResult={opening.current ?? undefined}
        onReopen={setTarget}
      />
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  if (!context) {
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  }
  return context;
}

/**
 * 可独立挂载的 conversation pane 使用可选上下文；完整 App Root 仍会注入真实购买面板。
 */
export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
