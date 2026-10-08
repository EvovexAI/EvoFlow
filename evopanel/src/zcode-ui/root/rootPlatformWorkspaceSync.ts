import { type WindowTabState } from "@/store/tabStore.js";

export function shouldPublishCompleteWorkspaceSnapshot(
  hasCompletedFullTabRestore: boolean,
): boolean {
  return hasCompletedFullTabRestore;
}
