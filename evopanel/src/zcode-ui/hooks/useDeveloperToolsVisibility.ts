import { useEffect, useState } from "react";
import {
  DEVELOPER_TOOLS_STORAGE_KEYS,
  readDeveloperToolsEnabled,
} from "@/lib/developerToolsPreference.js";

const DEVELOPER_TOOLS_PREFERENCE_POLL_MS = 1_000;

export function useDeveloperToolsVisibility(): boolean {
  const [enabled, setEnabled] = useState(readDeveloperToolsEnabled);

  useEffect(() => {
    const refresh = () => {
      setEnabled(readDeveloperToolsEnabled());
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        DEVELOPER_TOOLS_STORAGE_KEYS.includes(
          event.key as (typeof DEVELOPER_TOOLS_STORAGE_KEYS)[number],
        )
      ) {
        refresh();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", refresh);
    const intervalId = window.setInterval(refresh, DEVELOPER_TOOLS_PREFERENCE_POLL_MS);
    refresh();

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", refresh);
      window.clearInterval(intervalId);
    };
  }, []);

  return enabled;
}
