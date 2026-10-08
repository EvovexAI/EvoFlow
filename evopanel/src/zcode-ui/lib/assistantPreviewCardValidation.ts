import {
  ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT,
  ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT,
  getAssistantPreviewCardFilePath,
  isValidAssistantPreviewWebsiteUrl,
  requiresAssistantPreviewCardFileStat,
  type AssistantPreviewCard,
  type AssistantPreviewCardFileStatService,
} from "@/lib/assistantPreviewCards.js";

export function getAssistantPreviewCardsValidationSignature(
  cards: readonly AssistantPreviewCard[],
): string {
  return cards
    .map((card) => {
      if (card.type === "website") {
        return [
          card.id,
          card.type,
          card.title,
          card.subtitleId,
          card.url,
          card.filePath ?? "",
        ].join("\u0000");
      }

      return [card.id, card.type, card.kind, card.title, card.subtitleId, card.path].join("\u0000");
    })
    .join("\u0001");
}

export function resolveAssistantPreviewCardsWithoutFileStat(
  cards: readonly AssistantPreviewCard[],
): AssistantPreviewCard[] | null {
  if (cards.some(requiresAssistantPreviewCardFileStat)) {
    return null;
  }

  return cards
    .filter((card) => card.type === "website" && isValidAssistantPreviewWebsiteUrl(card.url))
    .slice(0, ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT);
}

export async function resolveValidatedAssistantPreviewCards(
  cards: readonly AssistantPreviewCard[],
  fileService: AssistantPreviewCardFileStatService,
): Promise<AssistantPreviewCard[]> {
  const statFreeCards = resolveAssistantPreviewCardsWithoutFileStat(cards);
  if (statFreeCards) {
    return statFreeCards;
  }

  const candidates = cards.slice(0, ASSISTANT_PREVIEW_CARD_CANDIDATE_LIMIT);
  const paths = candidates
    .map(getAssistantPreviewCardFilePath)
    .filter((path): path is string => path !== null);
  const results = await fileService.checkFilesExist({ paths });
  const existingPaths = new Set(
    results.filter((result) => result.exists).map((result) => result.path),
  );

  return candidates
    .filter((card) => {
      if (card.type === "website" && !isValidAssistantPreviewWebsiteUrl(card.url)) {
        return false;
      }
      const path = getAssistantPreviewCardFilePath(card);
      return path === null || existingPaths.has(path);
    })
    .slice(0, ASSISTANT_PREVIEW_CARD_VISIBLE_LIMIT);
}
