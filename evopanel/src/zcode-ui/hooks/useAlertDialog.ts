import { useAlertDialogStore } from "@/store/alertDialogStore.js";

export function useAlertDialog() {
  return useAlertDialogStore((state) => state.requestAlert);
}
