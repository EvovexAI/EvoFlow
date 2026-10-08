import type { BotCommand } from "@zcode/shared";

function splitCommand(text: string): { name: string; rest: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/u);
  if (firstSpace === -1) {
    return { name: body.toLowerCase(), rest: "" };
  }
  return {
    name: body.slice(0, firstSpace).toLowerCase(),
    rest: body.slice(firstSpace + 1).trim(),
  };
}

export function parseBotCommand(text: string): BotCommand {
  const parsed = splitCommand(text);
  if (!parsed) {
    return text.trim() === "0" ? { type: "selection.cancel" } : { type: "message", text };
  }

  const { name, rest } = parsed;
  switch (name) {
    case "bind":
      return rest ? { type: "bind", code: rest } : { type: "unknown", name, raw: text };
    case "help":
    case "帮助":
      return { type: "help" };
    case "cancel":
    case "取消":
      return { type: "selection.cancel" };
    case "status":
    case "状态":
      return { type: "status" };
    case "new":
    case "clear":
    case "新建":
      return { type: "new" };
    case "reconnect":
    case "重连":
      return { type: "reconnect" };
    case "workspace":
    case "project":
    case "项目":
      return rest ? { type: "workspace.set", value: rest } : { type: "workspace.list" };
    case "model":
    case "模型":
      if (!rest) {
        return { type: "model.list" };
      }
      if (rest.startsWith("provider ")) {
        return { type: "model.provider.set", value: rest.slice("provider ".length).trim() };
      }
      if (rest.startsWith("model ")) {
        return { type: "model.set", value: rest.slice("model ".length).trim() };
      }
      return { type: "model.set", value: rest };
    case "mode":
    case "模式":
      return rest ? { type: "mode.set", value: rest } : { type: "mode.list" };
    case "thoughtlevel":
    case "thought_level":
    case "thought-level":
    case "think":
    case "思考":
      return rest ? { type: "thoughtLevel.set", value: rest } : { type: "thoughtLevel.list" };
    case "task":
      return rest ? { type: "task.set", value: rest } : { type: "task.list" };
    case "reply":
    case "回复":
      return rest ? { type: "reply.set", value: rest } : { type: "reply.list" };
    case "stop":
    case "停止":
      return { type: "stop" };
    case "permission":
      return rest ? { type: "permission.respond", value: rest } : { type: "unknown", name, raw: text };
    case "elicitation":
    case "answer":
    case "回答":
      if (!rest) {
        return { type: "unknown", name, raw: text };
      }
      if (["submit", "done", "完成", "提交"].includes(rest.toLowerCase())) {
        return { type: "elicitation.submit" };
      }
      return { type: "elicitation.respond", value: rest };
    case "approve": {
      const [requestId, optionId] = rest.split(/\s+/u);
      return requestId && optionId
        ? { type: "approve", requestId, optionId }
        : { type: "unknown", name, raw: text };
    }
    case "deny":
      return rest ? { type: "deny", requestId: rest } : { type: "unknown", name, raw: text };
    default:
      return { type: "unknown", name, raw: text };
  }
}
