import type { HTMLAttributes } from "react";

const INTERACTIVE_SELECTOR = "button,a,input,select,textarea,[role=switch],[role=menuitem]";

export function settingsResourceRowInteraction(
  onActivate?: () => void,
): HTMLAttributes<HTMLDivElement> {
  if (!onActivate) return {};

  return {
    role: "button",
    tabIndex: 0,
    onClick: (event) => {
      if ((event.target as Element).closest(INTERACTIVE_SELECTOR)) return;
      onActivate();
    },
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}
