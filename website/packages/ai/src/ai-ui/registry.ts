import { z } from "zod";
import {
  executionReviewArtifactSchema,
  knowledgeSignalRadarArtifactSchema,
  techRadarArtifactSchema,
} from "./artifacts";

export const navigationActionSchema = z.object({
  route: z.string().min(1),
});

export const themeActionSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
});

export const actionRegistry = {
  navigateTo: navigationActionSchema,
  toggleTheme: themeActionSchema,
} as const;

export const artifactRegistry = {
  techRadar: techRadarArtifactSchema,
  executionReview: executionReviewArtifactSchema,
  knowledgeSignalRadar: knowledgeSignalRadarArtifactSchema,
} as const;
