import { z } from "zod";
import type { ChatModelId, ChatSource, ChatToolCall } from "../chat/demo-chat";

const artifactMetricSchema = z.object({
  label: z.string(),
  value: z.number(),
});

const artifactSourceSchema = z.object({
  path: z.string(),
  title: z.string(),
});

const artifactStepSchema = z.object({
  detail: z.string(),
  lineNumber: z.number().int().nonnegative(),
  name: z.string(),
  status: z.enum(["completed", "pending"]),
});

export const techRadarArtifactSchema = z.object({
  metrics: z.array(artifactMetricSchema),
  title: z.string(),
});

export const executionReviewArtifactSchema = z.object({
  steps: z.array(artifactStepSchema).min(1),
});

export const knowledgeSignalRadarArtifactSchema = z.object({
  efficiencyScore: z.number().min(0).max(100),
  latencyMs: z.number().positive(),
  scores: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
  sources: z.array(artifactSourceSchema).min(1),
});

const projectTimelineItemSchema = z.object({
  description: z.string(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  title: z.string(),
  year: z.string(),
});

export const projectTimelineArtifactSchema = z.object({
  items: z.array(projectTimelineItemSchema).min(1),
});

export type TechRadarArtifact = z.infer<typeof techRadarArtifactSchema>;
export type ExecutionReviewArtifact = z.infer<typeof executionReviewArtifactSchema>;
export type KnowledgeSignalRadarArtifact = z.infer<typeof knowledgeSignalRadarArtifactSchema>;
export type ProjectTimelineArtifact = z.infer<typeof projectTimelineArtifactSchema>;

type ArtifactPayloadMap = {
  executionReview: ExecutionReviewArtifact;
  knowledgeSignalRadar: KnowledgeSignalRadarArtifact;
  projectTimeline: ProjectTimelineArtifact;
  techRadar: TechRadarArtifact;
};

export type AiArtifactKind = keyof ArtifactPayloadMap;

export type AiArtifact = {
  [K in AiArtifactKind]: {
    kind: K;
    payload: ArtifactPayloadMap[K];
  };
}[AiArtifactKind];

export const aiArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("techRadar"),
    payload: techRadarArtifactSchema,
  }),
  z.object({
    kind: z.literal("executionReview"),
    payload: executionReviewArtifactSchema,
  }),
  z.object({
    kind: z.literal("knowledgeSignalRadar"),
    payload: knowledgeSignalRadarArtifactSchema,
  }),
  z.object({
    kind: z.literal("projectTimeline"),
    payload: projectTimelineArtifactSchema,
  }),
]);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function createArtifact<K extends AiArtifactKind>(
  kind: K,
  payload: ArtifactPayloadMap[K],
): Extract<AiArtifact, { kind: K }> {
  return aiArtifactSchema.parse({
    kind,
    payload,
  }) as Extract<AiArtifact, { kind: K }>;
}

export function buildChatArtifacts({
  model,
  sources,
  toolCalls,
}: {
  model: ChatModelId;
  sources: ChatSource[];
  toolCalls: ChatToolCall[];
}): AiArtifact[] {
  const artifacts: AiArtifact[] = [];

  if (toolCalls.length > 0) {
    artifacts.push(
      createArtifact("executionReview", {
        steps: toolCalls.map((toolCall, index) => ({
          detail: toolCall.detail,
          lineNumber: 12 + index,
          name: toolCall.name,
          status: toolCall.status,
        })),
      }),
    );
  }

  if (sources.length > 0) {
    artifacts.push(
      createArtifact("knowledgeSignalRadar", {
        efficiencyScore: clamp(
          79 + sources.length * 4 + toolCalls.length * 3,
          70,
          98,
        ),
        latencyMs:
          model === "gpt-5"
            ? Number((1.2 + toolCalls.length * 0.1).toFixed(1))
            : Number((0.9 + toolCalls.length * 0.1).toFixed(1)),
        scores: [
          clamp(62 + sources.length * 8, 50, 92),
          clamp(68 + toolCalls.length * 6, 52, 94),
          clamp(72 + sources.length * 5, 58, 96),
          clamp(model === "gpt-5" ? 88 : 81, 60, 96),
          clamp(74 + sources.length * 4, 60, 95),
          clamp(67 + toolCalls.length * 7, 54, 94),
        ],
        sources,
      }),
    );
  }

  return artifacts;
}
