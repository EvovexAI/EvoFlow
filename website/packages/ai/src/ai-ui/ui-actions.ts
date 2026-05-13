import { z } from "zod";

export const uiActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("navigate"),
    route: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    action: z.literal("toggleTheme"),
    theme: z.enum(["light", "dark", "system"]),
  }),
  z.object({
    action: z.literal("showProjects"),
    filter: z.string().optional(),
    projects: z.array(
      z.object({
        title: z.string(),
        summary: z.string(),
        tags: z.array(z.string()),
        href: z.string().optional(),
      }),
    ),
  }),
  z.object({
    action: z.literal("showSkills"),
    category: z.string().optional(),
    skills: z.array(
      z.object({
        name: z.string(),
        level: z.number().min(0).max(100),
        category: z.string(),
      }),
    ),
  }),
]);

export type UiAction = z.infer<typeof uiActionSchema>;
export type UiActionType = UiAction["action"];
