import { useCallback, useLayoutEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { OccupationValue } from "@/onboarding/occupationOptions.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

const workDirections: Record<OccupationValue, string> = {
  developer: "software_data_ai",
  independent: "entrepreneurship_freelance_opc",
  infrastructure: "qa_operations_security",
  product: "product_project_solutions",
  design: "ui_ux_visual_design",
  student: "education_research",
  finance: "finance_accounting_consulting",
  creator: "media_content_creation",
  operations: "business_operations_ecommerce_customer_service",
  marketing: "marketing_brand_pr",
  legal: "legal_administration_hr",
  other: "other",
};

type ExitAction = "start" | "skip" | "close";
type Exposure = {
  ended: boolean;
  modeVisited: boolean;
  preferencesVisited: boolean;
  mode: InterfaceMode | null;
  preferenceValues: string;
};

/** 业务选择仍由引导组件持有；这里只记录本次真实展示范围和上报去重。 */
export function useOnboardingTelemetry({
  platform,
  visible,
  step,
  occupation,
  mode,
  memory,
  suggestions,
  migration,
}: {
  platform: Pick<IPlatformService, "reportTelemetryEvent">;
  visible: boolean;
  step: 0 | 1 | 2;
  occupation: OccupationValue | null;
  mode: InterfaceMode | null;
  memory: boolean;
  suggestions: boolean;
  migration: boolean;
}) {
  const exposure = useRef<Exposure | null>(null);
  useLayoutEffect(() => {
    if (!visible) {
      exposure.current = null;
      return;
    }
    const preferenceValues = `${memory}:${suggestions}:${migration}`;
    if (!exposure.current) {
      exposure.current = {
        ended: false,
        modeVisited: false,
        preferencesVisited: false,
        mode,
        preferenceValues,
      };
      void reportAppTelemetryEvent(
        platform,
        {
          elementName: "onboarding_expose",
          eventRegion: "app.onboarding",
          eventType: "expose",
          eventText: "",
          eventExtraDetail: {},
        },
        "onboardingTelemetry",
      );
    }
    const current = exposure.current;
    // 返回改模式后旧偏好不再代表用户看到的选项；切回原模式也必须重新展示第三页。
    if (current.mode !== mode || (step !== 2 && current.preferenceValues !== preferenceValues)) {
      current.preferencesVisited = false;
    }
    current.preferenceValues = preferenceValues;
    current.mode = mode;
    if (step === 1) current.modeVisited = true;
    if (step === 2) current.preferencesVisited = true;
    // 不在 cleanup 重置：StrictMode 的 effect 重放不是一次新的产品曝光。
  }, [visible, step, mode, platform, memory, suggestions, migration]);

  return useCallback(
    (action: ExitAction, eventText: string) => {
      const current = exposure.current;
      const detail = {
        work_direction: occupation ? workDirections[occupation] : "null",
        ui_mode: current?.modeVisited && mode ? (mode === "office" ? "work" : "code") : "null",
        proactive_task_recommendations_enabled:
          current?.preferencesVisited && mode === "office" ? String(suggestions) : "null",
        workspace_memory_enabled: current?.preferencesVisited ? String(memory) : "null",
        claude_code_history_migration_selected: current?.preferencesVisited
          ? String(migration)
          : "null",
        exit_action: action,
        exit_step: String(step + 1),
      };
      // 点击时冻结文案与答案；仅保存成功后调用，不读被 skip 改写的 settings/record。
      return () => {
        if (!current || current.ended || exposure.current !== current) return;
        current.ended = true;
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "onboarding_end",
            eventRegion: "app.onboarding",
            eventType: "ck",
            eventText,
            eventExtraDetail: detail,
          },
          "onboardingTelemetry",
        );
      };
    },
    [platform, occupation, mode, memory, suggestions, migration, step],
  );
}
