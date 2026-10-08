import { useSyncExternalStore } from "react";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { isPrimaryFollowupModifierPressed } from "@/v4/composer/followupModeSettings.js";

const listeners = new Set<() => void>();
let pressed = false;
let detachWindowListeners: (() => void) | null = null;

function publish(next: boolean): void {
  if (pressed === next) return;
  pressed = next;
  for (const listener of listeners) listener();
}

function attachWindowListeners(): () => void {
  const syncModifier = (event: KeyboardEvent) => {
    publish(
      isPrimaryFollowupModifierPressed({
        isApplePlatform: isAppleKeyboardPlatform(),
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      }),
    );
  };
  const clearModifier = () => publish(false);
  window.addEventListener("keydown", syncModifier);
  window.addEventListener("keyup", syncModifier);
  window.addEventListener("blur", clearModifier);
  return () => {
    window.removeEventListener("keydown", syncModifier);
    window.removeEventListener("keyup", syncModifier);
    window.removeEventListener("blur", clearModifier);
    pressed = false;
  };
}

/**
 * 分屏和多窗口内容树可能同时挂载多个 Composer。修饰键是 window 事实，
 * 每个 Composer 各绑一套 keydown/keyup 会重复处理；这里用单一外部 store 广播瞬时状态。
 */
function subscribePrimaryFollowupModifier(listener: () => void): () => void {
  listeners.add(listener);
  if (!detachWindowListeners && typeof window !== "undefined") {
    detachWindowListeners = attachWindowListeners();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachWindowListeners) {
      detachWindowListeners();
      detachWindowListeners = null;
    }
  };
}

function getPrimaryFollowupModifierSnapshot(): boolean {
  return pressed;
}

export function usePrimaryFollowupModifier(): boolean {
  return useSyncExternalStore(
    subscribePrimaryFollowupModifier,
    getPrimaryFollowupModifierSnapshot,
    () => false,
  );
}
