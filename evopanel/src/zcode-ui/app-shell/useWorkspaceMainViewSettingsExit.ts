import { useCallback, useLayoutEffect, useRef } from "react";
import type { WorkspaceMainView } from "@/app-shell/types.js";

export function useWorkspaceMainViewSettingsExit({
  isWorkspaceVisible,
  workspaceMainView,
  onExitSettings,
}: {
  isWorkspaceVisible: boolean;
  workspaceMainView: WorkspaceMainView;
  onExitSettings: () => void;
}) {
  const wasWorkspaceVisibleRef = useRef(isWorkspaceVisible);
  const settingsEntryMainViewRef = useRef(workspaceMainView);
  const preserveNextSettingsExitRef = useRef(false);

  const preserveNextSettingsExit = useCallback(() => {
    if (!wasWorkspaceVisibleRef.current) {
      preserveNextSettingsExitRef.current = true;
    }
  }, []);

  useLayoutEffect(() => {
    const wasWorkspaceVisible = wasWorkspaceVisibleRef.current;
    wasWorkspaceVisibleRef.current = isWorkspaceVisible;

    if (wasWorkspaceVisible && !isWorkspaceVisible) {
      settingsEntryMainViewRef.current = workspaceMainView;
      preserveNextSettingsExitRef.current = false;
      return;
    }

    if (!wasWorkspaceVisible && isWorkspaceVisible) {
      if (preserveNextSettingsExitRef.current) {
        // 插件市场已经打开时，从设置页再次点击“新建”，主视图值仍是
        // plugin-store，单靠前后值无法识别这是一次显式导航。消费这个一次性标记，
        // 防止设置退出流程把市场错误关闭；标记只允许在设置层打开时写入。
        preserveNextSettingsExitRef.current = false;
        return;
      }

      if (workspaceMainView === settingsEntryMainViewRef.current) {
        // Settings 只是覆盖 workspace，底层 App 不卸载，进入前的
        // automations 主视图会一直保留。设置层退出时统一回到对话，
        // 让 Back、插件提示词、创建 Skill 和设置页快捷键共享同一导航语义。
        onExitSettings();
      }
    }
  }, [isWorkspaceVisible, onExitSettings, workspaceMainView]);

  return { preserveNextSettingsExit };
}
