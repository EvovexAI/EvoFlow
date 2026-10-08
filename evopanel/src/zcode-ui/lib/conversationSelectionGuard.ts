import { CONVERSATION_SELECTION_MAX_TEXT_LENGTH } from "@/lib/conversationSelectionReference.js";

type ConversationSelectionGuardResult = "eligible" | "ineligible" | "single-limit";

const CONVERSATION_SELECTION_EXCLUDED_SELECTOR = [
  "button",
  "input",
  "textarea",
  "[role='button']",
  "[role='dialog']",
  "[data-v4-composer-dock]",
  "[data-conversation-selection-tooltip]",
].join(",");

export function hasExcludedConversationSelectionEndpoint(
  startElement: Element | null | undefined,
  endElement: Element | null | undefined,
): boolean {
  return Boolean(
    startElement?.closest(CONVERSATION_SELECTION_EXCLUDED_SELECTOR) ||
    endElement?.closest(CONVERSATION_SELECTION_EXCLUDED_SELECTOR),
  );
}

export function guardConversationSelectionCandidate(input: {
  enabled: boolean;
  sameRow: boolean;
  insideTimeline: boolean;
  excluded: boolean;
  sameSelectableRegion: boolean;
  supportedContent: boolean;
  text: string;
  hasLayout: boolean;
}): ConversationSelectionGuardResult {
  if (
    !input.enabled ||
    !input.sameRow ||
    !input.insideTimeline ||
    input.excluded ||
    !input.sameSelectableRegion ||
    !input.supportedContent ||
    !input.text ||
    !input.hasLayout
  ) {
    return "ineligible";
  }
  return input.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH ? "single-limit" : "eligible";
}
