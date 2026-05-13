import { z } from "zod";
import { chatModelSchema, chatSourceSchema } from "../chat/demo-chat";

export const agentToolName = z.enum([
  "knowledge_search",
  "artifact_strategy",
  "implementation_checklist",
]);
export type AgentToolName = z.infer<typeof agentToolName>;

export const agentArtifactKind = z.enum(["html", "markdown", "json", "python"]);
export type AgentArtifactKind = z.infer<typeof agentArtifactKind>;

export const agentStreamRequestSchema = z.object({
  locale: z.enum(["zh", "en"]).default("zh"),
  model: chatModelSchema.default("gpt-5"),
  prompt: z.string().trim().min(1).max(4000),
});
export type AgentStreamRequest = z.infer<typeof agentStreamRequestSchema>;

const baseEvent = z.object({ ts: z.string().optional() });

export const agentEventSchema = z.discriminatedUnion("type", [
  baseEvent.extend({
    type: z.literal("step_started"),
    stepId: z.string(),
    title: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("thought_progress"),
    stepId: z.string(),
    title: z.string(),
    content: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("step_completed"),
    stepId: z.string(),
    title: z.string(),
    content: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool_called"),
    tool: agentToolName,
    input: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("tool_result"),
    tool: agentToolName,
    output: z.string().optional(),
  }),
  baseEvent.extend({
    type: z.literal("artifact_started"),
    artifactId: z.string(),
    kind: agentArtifactKind,
    title: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("artifact_chunk"),
    artifactId: z.string(),
    content: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("artifact_completed"),
    artifactId: z.string(),
    kind: agentArtifactKind,
    title: z.string(),
    content: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("final_answer_chunk"),
    content: z.string(),
  }),
  baseEvent.extend({
    type: z.literal("done"),
    model: chatModelSchema.optional(),
    provider: z.string().optional(),
    mode: z.enum(["fallback", "live"]).optional(),
    sources: z.array(chatSourceSchema).optional(),
    summary: z.string().optional(),
    toolCalls: z.array(z.object({
      name: z.string(),
      detail: z.string(),
      status: z.enum(["completed", "pending"]),
    })).optional(),
    latencyMs: z.number().optional(),
  }),
  baseEvent.extend({
    type: z.literal("error"),
    error: z.string(),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;

export type AgentStepId = "analysis" | "execution" | "artifact" | "final";
