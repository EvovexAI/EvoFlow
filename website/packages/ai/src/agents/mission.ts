import { z } from "zod";
import {
  chatModelSchema,
  chatSourceSchema,
  chatToolCallSchema,
} from "../chat/demo-chat";

const accentSchema = z.enum(["primary", "secondary", "tertiary"]);

const agentCapabilitySchema = z.object({
  accent: accentSchema,
  label: z.string(),
});

const agentMetricSchema = z.object({
  accent: accentSchema,
  label: z.string(),
  progress: z.number().min(0).max(100),
  valueLabel: z.string(),
});

const agentPhaseSchema = z.object({
  accent: accentSchema,
  label: z.string(),
  progress: z.number().min(0).max(100),
  stateLabel: z.string(),
});

export const agentMissionStepSchema = z.object({
  accent: accentSchema,
  body: z.string(),
  code: z.string().optional(),
  eyebrow: z.string(),
  time: z.string(),
  title: z.string(),
});

export const agentMissionRequestSchema = z.object({
  locale: z.enum(["zh", "en"]).default("zh"),
  model: chatModelSchema.default("gpt-5"),
  prompt: z.string().trim().min(1).max(4000),
});

export const agentMissionResponseSchema = z.object({
  agent: z.string(),
  answer: z.string(),
  mission: z.string(),
  mode: z.enum(["fallback", "live"]),
  model: chatModelSchema,
  provider: z.string(),
  sources: z.array(chatSourceSchema),
  state: z.object({
    capabilities: z.array(agentCapabilitySchema).min(1),
    capabilitiesLabel: z.string(),
    metrics: z.array(agentMetricSchema).min(1),
    phases: z.array(agentPhaseSchema).min(1),
    statusLabel: z.string(),
    statusValue: z.string(),
    title: z.string(),
  }),
  steps: z.array(agentMissionStepSchema).min(1),
  summary: z.string(),
  toolCalls: z.array(chatToolCallSchema),
});

export type AgentMissionRequest = z.infer<typeof agentMissionRequestSchema>;
export type AgentMissionResponse = z.infer<typeof agentMissionResponseSchema>;
