import { createContext } from "react";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  trajectoryToolCallInputs,
  trajectoryToolMetadata,
  trajectoryToolOutputs,
} from "@/ModelTrajectoryToolPayload.js";

export type TrajectorySearchField = "content" | "tool-name" | "tool-id";

export interface TrajectorySearchMatch {
  key: string;
  callKey: string;
  callIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  fieldMatchIndex: number;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
}

interface TrajectorySearchIndex {
  query: string;
  matches: TrajectorySearchMatch[];
}

export interface TrajectorySearchTimelineItem {
  key: string;
  record: ZCodeModelTrajectoryRecord;
  inputMessages: ZCodeModelTrajectoryMessage[];
}

interface SearchTarget {
  callKey: string;
  callIndex: number;
  expansionKey: string;
  field: TrajectorySearchField;
  text: string;
}

export const TrajectorySearchRevealContext = createContext<string | null>(null);

export function buildTrajectorySearchIndex(
  items: readonly TrajectorySearchTimelineItem[],
  query: string,
): TrajectorySearchIndex {
  const normalizedQuery = normalizeTrajectorySearchText(query).text.trim();
  if (!normalizedQuery) return { query: "", matches: [] };

  const matches: TrajectorySearchMatch[] = [];
  for (const target of buildSearchTargets(items)) {
    const sourceMatches = findTrajectoryTextMatches(target.text, normalizedQuery);
    sourceMatches.forEach(({ sourceStart, sourceEnd }, fieldMatchIndex) => {
      matches.push({
        ...target,
        key: `${target.expansionKey}:${target.field}:${fieldMatchIndex}:${sourceStart}`,
        fieldMatchIndex,
        sourceStart,
        sourceEnd,
        sourceText: target.text,
      });
    });
  }
  return { query: normalizedQuery, matches };
}

function buildSearchTargets(items: readonly TrajectorySearchTimelineItem[]): SearchTarget[] {
  return items.flatMap((item, callIndex) => {
    const targets = item.inputMessages.flatMap((message, messageIndex) =>
      messageTargets(item.key, callIndex, `${item.key}:input:${messageIndex}`, message),
    );
    const response = item.record.response;
    if (!response) return targets;
    if (response.reasoningText) {
      targets.push(
        contentTarget(item.key, callIndex, `${item.key}:output:reasoning`, response.reasoningText),
      );
    }
    if (response.text) {
      targets.push(contentTarget(item.key, callIndex, `${item.key}:output:message`, response.text));
    }
    response.toolCalls.forEach((toolCall, toolCallIndex) => {
      targets.push(
        ...messageTargets(
          item.key,
          callIndex,
          `${item.key}:output:${toolCall.kind}:${toolCallIndex}`,
          { role: "assistant", parts: [toolCall] },
        ),
      );
    });
    return targets;
  });
}

function messageTargets(
  callKey: string,
  callIndex: number,
  expansionKey: string,
  message: ZCodeModelTrajectoryMessage,
): SearchTarget[] {
  const metadata = trajectoryToolMetadata(message);
  const content = message.parts.some((part) => part.kind === "tool-result")
    ? trajectoryToolOutputs(message).join("\n\n")
    : message.parts.some((part) => part.kind === "tool-call")
      ? trajectoryToolCallInputs(message).join("\n\n")
      : message.parts
          .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
          .join("\n\n");
  return [
    ...(content ? [contentTarget(callKey, callIndex, expansionKey, content)] : []),
    ...(metadata.names
      ? [{ callKey, callIndex, expansionKey, field: "tool-name" as const, text: metadata.names }]
      : []),
    ...(metadata.ids
      ? [{ callKey, callIndex, expansionKey, field: "tool-id" as const, text: metadata.ids }]
      : []),
  ];
}

function contentTarget(
  callKey: string,
  callIndex: number,
  expansionKey: string,
  text: string,
): SearchTarget {
  return { callKey, callIndex, expansionKey, field: "content", text };
}

export function findTrajectoryTextMatches(
  source: string,
  normalizedQuery: string,
): Array<{ sourceStart: number; sourceEnd: number }> {
  const normalizedSource = normalizeTrajectorySearchText(source);
  const matches: Array<{ sourceStart: number; sourceEnd: number }> = [];
  let searchStart = 0;
  while (searchStart < normalizedSource.text.length) {
    const matchStart = normalizedSource.text.indexOf(normalizedQuery, searchStart);
    if (matchStart === -1) break;
    const matchEnd = matchStart + normalizedQuery.length;
    const sourceStart = normalizedSource.starts[matchStart] ?? 0;
    matches.push({
      sourceStart,
      sourceEnd: normalizedSource.ends[matchEnd - 1] ?? sourceStart,
    });
    searchStart = matchEnd;
  }
  return matches;
}

function normalizeTrajectorySearchText(source: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let inWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      if (!inWhitespace) {
        text += " ";
        starts.push(index);
        ends.push(index + 1);
        inWhitespace = true;
      } else {
        ends[ends.length - 1] = index + 1;
      }
      continue;
    }
    inWhitespace = false;
    const normalizedCharacter = character.toLocaleLowerCase();
    text += normalizedCharacter;
    for (let offset = 0; offset < normalizedCharacter.length; offset += 1) {
      starts.push(index);
      ends.push(index + 1);
    }
  }
  return { text, starts, ends };
}
