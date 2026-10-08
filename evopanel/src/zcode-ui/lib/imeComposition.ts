export function isImeComposingKeyEvent(event: {
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return Boolean(event.compositionActive || event.isComposing || event.nativeEvent?.isComposing);
}
