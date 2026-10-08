import { create } from "zustand";
import { logger } from "@/logger.js";

export interface ConfirmDialogRequest {
  title: string;
  testId?: string;
  description?: string;
  /** 特定业务弹框的稳定视觉规范；默认确认框不受影响。 */
  presentation?: "automation-confirmation";
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  showCloseButton?: boolean;
  showKeyboardHints?: boolean;
  compact?: boolean;
  checkbox?: { label: string; onCheckedChange: (checked: boolean) => void };
}

type ConfirmDialogChoice = "confirm" | "cancel" | "dismiss";

interface PendingConfirmDialogRequest extends ConfirmDialogRequest {
  resolve: (choice: ConfirmDialogChoice) => void;
}

interface ConfirmDialogState {
  pendingRequest?: PendingConfirmDialogRequest;
  requestConfirmation: (payload: ConfirmDialogRequest) => Promise<boolean>;
  requestChoice: (payload: ConfirmDialogRequest) => Promise<ConfirmDialogChoice>;
  settleConfirmation: (confirmed: boolean) => void;
  settleChoice: (choice: ConfirmDialogChoice) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestConfirmation: async (payload) => (await get().requestChoice(payload)) === "confirm",
  requestChoice: (payload) => {
    if (get().pendingRequest) {
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }

    return new Promise<ConfirmDialogChoice>((resolve) => {
      set({
        pendingRequest: {
          ...payload,
          resolve,
        },
      });
    });
  },
  settleConfirmation: (confirmed) => get().settleChoice(confirmed ? "confirm" : "cancel"),
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(choice);
  },
}));
