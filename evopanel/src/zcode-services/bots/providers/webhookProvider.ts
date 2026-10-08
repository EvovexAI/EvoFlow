import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  BotStructuredElicitationResponse,
  SelectionPrompt,
} from "@zcode/shared";
import type { BotProviderAdapter } from "./types.js";

interface WebhookProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatSelectionCommand(
  selection: SelectionPrompt,
  optionId: string,
): string {
  if (selection.action === "permission.respond") {
    return optionId;
  }
  if (selection.action === "elicitation.respond") {
    return selection.token ? `/elicitation ${selection.token} ${optionId}` : `/elicitation ${optionId}`;
  }
  if (selection.action === "model.provider.set") {
    return `/model provider ${optionId}`;
  }
  if (selection.action === "model.set") {
    return `/model model ${optionId}`;
  }
  return `/${selection.action.replace(".set", "")} ${optionId}`;
}

function buildSelectionText(message: BotOutboundMessage): string {
  if (!message.selection) {
    return message.text;
  }
  const selection = message.selection;
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` - ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}\n${formatSelectionCommand(selection, option.id)}`;
  });
  return `${message.text}\n${lines.join("\n")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWebhookAttachment(
  value: unknown,
  index: number,
): BotInboundAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  if (
    kind !== "image" &&
    kind !== "audio" &&
    kind !== "video" &&
    kind !== "file"
  ) {
    return null;
  }
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id
      : `webhook-${index + 1}`;
  const filename =
    typeof value.filename === "string" && value.filename.trim()
      ? value.filename
      : `${id}.${kind}`;
  const mimeType =
    typeof value.mimeType === "string" && value.mimeType.trim()
      ? value.mimeType
      : "application/octet-stream";
  return {
    id,
    kind,
    filename,
    mimeType,
    ...(typeof value.sizeBytes === "number"
      ? { sizeBytes: value.sizeBytes }
      : {}),
    ...(typeof value.providerFileId === "string"
      ? { providerFileId: value.providerFileId }
      : {}),
    ...(typeof value.downloadUrl === "string"
      ? { downloadUrl: value.downloadUrl }
      : {}),
    ...(typeof value.dataBase64 === "string"
      ? { dataBase64: value.dataBase64 }
      : {}),
    ...(typeof value.localPath === "string"
      ? { localPath: value.localPath }
      : {}),
  };
}

function parseWebhookAttachments(
  payload: Record<string, unknown>,
): BotInboundAttachment[] {
  return Array.isArray(payload.attachments)
    ? payload.attachments
        .map((attachment, index) => parseWebhookAttachment(attachment, index))
        .filter(
          (attachment): attachment is BotInboundAttachment =>
            attachment !== null,
        )
    : [];
}

function parseWebhookElicitationResponse(
  payload: Record<string, unknown>,
): BotStructuredElicitationResponse | undefined {
  if (payload.type !== "zcode.bot.elicitation_response") {
    return undefined;
  }
  const requestId =
    typeof payload.requestId === "string" && payload.requestId.trim()
      ? payload.requestId
      : "";
  const action = payload.action;
  if (
    !requestId ||
    (action !== "accept" && action !== "decline" && action !== "cancel")
  ) {
    return undefined;
  }
  return {
    requestId,
    action,
    ...(isRecord(payload.content) ? { content: payload.content } : {}),
  };
}

async function postWebhookWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (const retryDelayMs of [0, 500, 1_500]) {
    if (retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    try {
      const response = await fetch(url, init);
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function createWebhookBotProvider(
  deps: WebhookProviderDeps,
): BotProviderAdapter {
  return {
    async test(bot: BotConfig) {
      if (!bot.enabled) {
        return { ok: false, message: "Webhook bot is disabled." };
      }
      if (!bot.webhookSecretRef) {
        return {
          ok: false,
          message:
            "Webhook secret is missing. Configure a secret before exposing the callback endpoint.",
        };
      }
      if (bot.webhookUrl) {
        const secret = await deps.loadCredential(bot.webhookSecretRef);
        const response = await postWebhookWithRetry(bot.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [bot.webhookAuthHeaderName || "x-zcode-bot-secret"]: secret ?? "",
          },
          body: JSON.stringify({
            type: "zcode.bot.test",
            botId: bot.id,
            provider: "webhook",
            sentAt: Date.now(),
          }),
        });
        return {
          ok: response.ok,
          message: response.ok
            ? "Webhook outbound endpoint is reachable."
            : `Webhook outbound endpoint returned HTTP ${response.status}.`,
        };
      }
      return {
        ok: true,
        message: "Webhook bot is enabled for inbound callbacks.",
      };
    },

    async send(bot, message) {
      if (!bot.webhookUrl) {
        return;
      }
      const secret = bot.webhookSecretRef
        ? await deps.loadCredential(bot.webhookSecretRef)
        : null;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (secret) {
        headers[bot.webhookAuthHeaderName || "x-zcode-bot-secret"] = secret;
      }
      const response = await postWebhookWithRetry(bot.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "zcode.bot.message",
          botId: bot.id,
          provider: "webhook",
          userId: message.providerUserId,
          text: buildSelectionText(message),
          selection: message.selection,
          elicitation: message.elicitation,
          ...(message.elicitation
            ? { type: "zcode.bot.elicitation_request" }
            : {}),
          sentAt: Date.now(),
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Webhook outbound endpoint returned HTTP ${response.status}`,
        );
      }
    },

    parseCallback(payload: unknown): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = typeof payload.botId === "string" ? payload.botId : "";
      const text = typeof payload.text === "string" ? payload.text : "";
      const userId = typeof payload.userId === "string" ? payload.userId : "";
      const attachments = parseWebhookAttachments(payload);
      const elicitationResponse = parseWebhookElicitationResponse(payload);
      if (!botId || (!text && attachments.length === 0 && !elicitationResponse) || !userId) {
        return [];
      }
      return [
        {
          botId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(elicitationResponse ? { elicitationResponse } : {}),
          actor: {
            provider: "webhook",
            botId,
            providerUserId: userId,
            displayName:
              typeof payload.displayName === "string"
                ? payload.displayName
                : undefined,
            chatType: payload.chatType === "group" ? "group" : "private",
            chatId:
              typeof payload.chatId === "string" ? payload.chatId : undefined,
            // Bugfix: webhook 回调也需要携带消息 id 进入通用幂等层。
            // 否则上游重试同一条消息时，Bot 会重复创建/发送任务。
            providerMessageId:
              typeof payload.messageId === "string"
                ? payload.messageId
                : typeof payload.id === "string"
                  ? payload.id
                  : undefined,
          },
        },
      ];
    },
  };
}
