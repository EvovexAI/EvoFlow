import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export function useConfirmDialog() {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}
