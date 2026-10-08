import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import {
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  type EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";

const HUMAN_BROWSER_VIEWPORT_PREFERENCE_WRITE_DELAY_MS = 200;

type HumanBrowserViewProps = Omit<
  ComponentProps<typeof UnifiedBrowserView>,
  "initialHumanViewportPreference" | "onHumanViewportPreferenceChange"
> & { agentOpened?: boolean };

function clonePreference(
  preference: EmbeddedBrowserViewportPreference,
): EmbeddedBrowserViewportPreference {
  return {
    ...preference,
    viewport: { ...preference.viewport },
  };
}

/** Browser 显示边界：普通 human tab 持久化偏好，Agent popup 使用独立默认 viewport。 */
export function HumanBrowserView(props: HumanBrowserViewProps): React.JSX.Element {
  const { agentOpened, ...unifiedProps } = props;
  const { loading, settings, update } = useSettings();
  const initialPreferenceRef = useRef<EmbeddedBrowserViewportPreference | null>(null);
  const pendingPreferenceRef = useRef<EmbeddedBrowserViewportPreference | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const updateRef = useRef(update);
  updateRef.current = update;

  if (!loading && !initialPreferenceRef.current) {
    initialPreferenceRef.current = clonePreference(
      agentOpened
        ? {
            mode: "responsive",
            viewport: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
            zoom: "fit",
          }
        : (settings?.embeddedBrowserViewportPreference ??
            DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE),
    );
  }

  const commitPreference = useCallback((preference: EmbeddedBrowserViewportPreference) => {
    void updateRef
      .current({ embeddedBrowserViewportPreference: clonePreference(preference) })
      .catch((error) => {
        logger.warn("[browser] 保存人类浏览器显示偏好失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  const clearPendingWrite = useCallback(() => {
    if (writeTimerRef.current === null) return;
    window.clearTimeout(writeTimerRef.current);
    writeTimerRef.current = null;
  }, []);

  const handlePreferenceChange = useCallback(
    (
      preference: EmbeddedBrowserViewportPreference,
      source: HumanBrowserViewportPreferenceChangeSource,
    ) => {
      pendingPreferenceRef.current = clonePreference(preference);
      if (source === "viewport") {
        clearPendingWrite();
        // resize handle 每帧都会产生 CSS viewport；只合并 settings IO，不改变 guest 实时更新。
        writeTimerRef.current = window.setTimeout(() => {
          writeTimerRef.current = null;
          const pendingPreference = pendingPreferenceRef.current;
          pendingPreferenceRef.current = null;
          if (pendingPreference) commitPreference(pendingPreference);
        }, HUMAN_BROWSER_VIEWPORT_PREFERENCE_WRITE_DELAY_MS);
        return;
      }

      clearPendingWrite();
      const pendingPreference = pendingPreferenceRef.current;
      pendingPreferenceRef.current = null;
      if (pendingPreference) commitPreference(pendingPreference);
    },
    [clearPendingWrite, commitPreference],
  );

  useEffect(
    () => () => {
      clearPendingWrite();
      const pendingPreference = pendingPreferenceRef.current;
      pendingPreferenceRef.current = null;
      if (pendingPreference) commitPreference(pendingPreference);
    },
    [clearPendingWrite, commitPreference],
  );

  const initialPreference = initialPreferenceRef.current;
  if (!initialPreference) {
    return (
      <div
        aria-busy="true"
        data-browser-human-viewport-preference-state="loading"
        className="h-full min-h-0 w-full min-w-0 bg-background"
      />
    );
  }

  return (
    <UnifiedBrowserView
      {...unifiedProps}
      initialHumanViewportPreference={initialPreference}
      onHumanViewportPreferenceChange={agentOpened ? undefined : handlePreferenceChange}
    />
  );
}
