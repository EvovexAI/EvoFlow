export function resolveChatEnterShortcut({
  enterSubmits,
}: {
  enterSubmits: boolean;
}): "Enter" | undefined {
  return enterSubmits ? "Enter" : undefined;
}
