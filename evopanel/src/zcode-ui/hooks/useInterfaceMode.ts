import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useZCodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}
