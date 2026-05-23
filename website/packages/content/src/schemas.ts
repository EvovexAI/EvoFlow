import { z } from "zod";

export const personalProfileSchema = z.object({
  name: z.string(),
  title: z.string(),
  summary: z.string(),
});

export const projectSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
});

export const timelineMilestoneSchema = z.object({
  year: z.string(),
  title: z.string(),
  description: z.string(),
});
