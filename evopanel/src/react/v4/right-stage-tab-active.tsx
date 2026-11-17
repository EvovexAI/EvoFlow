/**
 * 右栏 forceMount 签：失活仍挂载，但 V4 Bridge 不得抢 focus / display authority。
 * RightStagePanel 提供，V4SessionPaneBridge 消费（对齐 ZCode hidden pane focused=false）。
 */
import { createContext, useContext, type ReactNode } from "react";

const RightStageTabActiveContext = createContext<boolean | null>(null);

export function RightStageTabActiveProvider(props: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <RightStageTabActiveContext.Provider value={props.active}>
      {props.children}
    </RightStageTabActiveContext.Provider>
  );
}

/** null = 不在右栏签内；true/false = 签是否前台。 */
export function useRightStageTabActive(): boolean | null {
  return useContext(RightStageTabActiveContext);
}
