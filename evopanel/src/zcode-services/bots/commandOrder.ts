import type { BotCommandPolicy } from "@zcode/shared";
const BOT_POLICY_COMMAND_ORDER = [
  "status",
  "new",
  "workspace",
  "model",
  "mode",
  "thoughtLevel",
  "reply",
] as const satisfies readonly (keyof BotCommandPolicy)[];

export const BOT_MENU_COMMAND_ORDER = [
  "help",
  ...BOT_POLICY_COMMAND_ORDER,
  "bind",
] as const;
