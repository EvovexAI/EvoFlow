/* eslint-disable max-lines -- Telegram provider 集中处理 Bot API 文本、按钮、媒体解析和附件下载。 */
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  SelectionPrompt,
} from "@zcode/shared";
import { BOT_MENU_COMMAND_ORDER } from "../commandOrder.js";
import type { BotProviderAdapter } from "./types.js";
import {
  fetchBotProvider,
  fetchBotProviderJson,
} from "#src/bots/providers/providerRequest.js";

interface TelegramProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

interface TelegramBotCommand {
  command: string;
  description: string;
}

const TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

interface TelegramGetMeResponse {
  ok?: boolean;
  description?: string;
  result?: {
    username?: string;
    first_name?: string;
  };
}

interface TelegramFileResponse {
  ok?: boolean;
  description?: string;
  result?: {
    file_path?: string;
    file_size?: number;
  };
}

const telegramCommandDescriptions = {
  bind: "Bind this chat",
  help: "Show help",
  status: "Show current status",
  new: "Create a new task",
  workspace: "Select project",
  model: "Select model",
  mode: "Select mode",
  thoughtLevel: "Select thinking level",
  reply: "Select reply detail",
} as const;

const telegramCommandNames = {
  bind: "bind",
  help: "help",
  status: "status",
  new: "new",
  workspace: "project",
  model: "model",
  mode: "mode",
  thoughtLevel: "think",
  reply: "reply",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function splitTelegramText(text: string): string[] {
  const limit = 3900;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

function truncateCallbackToast(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function readTelegramPrivateMessage(botId: string, update: Record<string, unknown>): BotInboundMessage | null {
  const message = isRecord(update.message) ? update.message : null;
  if (!message) {
    return null;
  }
  const chat = isRecord(message.chat) ? message.chat : null;
  const from = isRecord(message.from) ? message.from : null;
  const text =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";
  const userId = typeof from?.id === "number" || typeof from?.id === "string" ? String(from.id) : "";
  const chatType = chat?.type === "private" ? "private" : "group";
  const attachments = readTelegramAttachments(message);
  if ((!text && attachments.length === 0) || !userId) {
    return null;
  }
  return {
    botId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    actor: {
      provider: "telegram",
      botId,
      providerUserId: userId,
      displayName:
        typeof from?.username === "string"
          ? from.username
          : typeof from?.first_name === "string"
            ? from.first_name
            : undefined,
      chatType,
      chatId:
        typeof chat?.id === "number" || typeof chat?.id === "string"
          ? String(chat.id)
          : undefined,
      providerMessageId:
        typeof message.message_id === "number" || typeof message.message_id === "string"
          ? String(message.message_id)
          : undefined,
    },
  };
}

function readTelegramFileAttachment(
  value: unknown,
  kind: BotInboundAttachment["kind"],
  fallbackName: string,
): BotInboundAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const providerFileId = typeof value.file_id === "string" ? value.file_id : "";
  if (!providerFileId) {
    return null;
  }
  const filename =
    typeof value.file_name === "string" && value.file_name.trim()
      ? value.file_name
      : fallbackName;
  return {
    id: providerFileId,
    kind,
    filename,
    mimeType:
      typeof value.mime_type === "string" && value.mime_type.trim()
        ? value.mime_type
        : defaultMimeTypeForAttachmentKind(kind),
    ...(typeof value.file_size === "number" ? { sizeBytes: value.file_size } : {}),
    providerFileId,
  };
}

function readTelegramPhotoAttachment(message: Record<string, unknown>): BotInboundAttachment | null {
  if (!Array.isArray(message.photo) || message.photo.length === 0) {
    return null;
  }
  const photo = message.photo.filter(isRecord).at(-1);
  if (!photo) {
    return null;
  }
  return readTelegramFileAttachment(photo, "image", "telegram-photo.jpg");
}

function defaultMimeTypeForAttachmentKind(kind: BotInboundAttachment["kind"]): string {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function readTelegramAttachments(message: Record<string, unknown>): BotInboundAttachment[] {
  return [
    readTelegramPhotoAttachment(message),
    readTelegramFileAttachment(message.document, "file", "telegram-document"),
    readTelegramFileAttachment(message.video, "video", "telegram-video.mp4"),
    readTelegramFileAttachment(message.audio, "audio", "telegram-audio"),
    readTelegramFileAttachment(message.voice, "audio", "telegram-voice.ogg"),
  ].filter((attachment): attachment is BotInboundAttachment => attachment !== null);
}

function readTelegramCallbackMessage(botId: string, update: Record<string, unknown>): BotInboundMessage | null {
  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  if (!callbackQuery) {
    return null;
  }
  const message = isRecord(callbackQuery.message) ? callbackQuery.message : null;
  const chat = isRecord(message?.chat) ? message.chat : null;
  const from = isRecord(callbackQuery.from) ? callbackQuery.from : null;
  const data = typeof callbackQuery.data === "string" ? callbackQuery.data : "";
  const userId = typeof from?.id === "number" || typeof from?.id === "string" ? String(from.id) : "";
  if (!data || !userId) {
    return null;
  }
  const commandText = decodeTelegramCallbackData(data);
  return {
    botId,
    text: commandText,
    actor: {
      provider: "telegram",
      botId,
      providerUserId: userId,
      displayName:
        typeof from?.username === "string"
          ? from.username
          : typeof from?.first_name === "string"
            ? from.first_name
            : undefined,
      chatType: chat?.type === "private" ? "private" : "group",
      chatId:
        typeof chat?.id === "number" || typeof chat?.id === "string"
          ? String(chat.id)
          : undefined,
      providerMessageId:
        typeof callbackQuery.id === "string"
          ? callbackQuery.id
          : typeof message?.message_id === "number" || typeof message?.message_id === "string"
            ? String(message.message_id)
            : undefined,
    },
  };
}

function readTelegramCallbackId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const update = isRecord(payload.update) ? payload.update : payload;
  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  return typeof callbackQuery?.id === "string" ? callbackQuery.id : null;
}

function readTelegramCallbackMessageRef(payload: unknown): { chatId: string; messageId: number } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const update = isRecord(payload.update) ? payload.update : payload;
  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  const message = isRecord(callbackQuery?.message) ? callbackQuery.message : null;
  const chat = isRecord(message?.chat) ? message.chat : null;
  const chatId = typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
  const messageId = typeof message?.message_id === "number" ? message.message_id : null;
  return chatId && messageId !== null ? { chatId, messageId } : null;
}

function buildSelectionCallbackData(selection: SelectionPrompt, optionId: string, index: number): string {
  if (selection.action === "permission.respond") {
    return `zc:permission:${index + 1}`;
  }
  if (selection.action === "elicitation.respond") {
    return selection.token
      ? `zc:e:${selection.token}:${index + 1}`
      : `zc:elicitation:${index + 1}`;
  }
  if (selection.action === "model.provider.set") {
    return `zc:cmd:/model provider ${index + 1}`;
  }
  if (selection.action === "model.set") {
    return `zc:cmd:/model model ${index + 1}`;
  }
  // Telegram callback_data 最多 64 字节，workspace/task id 可能是远程 identity 或长路径。
  // 这里只回传当前列表序号，后续命令解析复用已有的数字选项解析，避免长 id 被 Telegram 拒收。
  return `zc:${selection.action.replace(".set", "")}:${index + 1}`;
}

function buildSelectionReplyMarkup(selection: SelectionPrompt): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const cancelRows = selection.showCancel === false
    ? []
    : [
        // Bugfix: Telegram 原生按钮以前没有取消入口，用户只能手敲 0 才能退出 pending selection。
        [{ text: selection.cancelLabel ?? "Cancel", callback_data: "zc:cancel" }],
      ];
  return {
    inline_keyboard: [
      ...selection.options.map((option, index) => [
        {
          text: option.label,
          callback_data: buildSelectionCallbackData(selection, option.id, index),
        },
      ]),
      ...cancelRows,
    ],
  };
}

function decodeTelegramCallbackData(data: string): string {
  if (data === "zc:cancel") {
    return "/cancel";
  }
  if (data.startsWith("zc:e:")) {
    const [, , token, value] = data.split(":");
    return token && value ? `/elicitation ${token} ${value}` : "/elicitation";
  }
  if (data.startsWith("zc:cmd:")) {
    return data.slice("zc:cmd:".length);
  }
  if (data.startsWith("zc:")) {
    return `/${data.slice(3).replace(":", " ")}`;
  }
  return data;
}

function buildTelegramCommands(bot: BotConfig): TelegramBotCommand[] {
  return BOT_MENU_COMMAND_ORDER
    .filter((command) => command === "help" || command === "bind" || bot.allowedCommands[command] !== false)
    .map((command) => ({
      command: telegramCommandNames[command],
      description: telegramCommandDescriptions[command],
    }));
}

export function createTelegramBotProvider(
  deps: TelegramProviderDeps,
): BotProviderAdapter {
  async function loadToken(bot: BotConfig): Promise<string | null> {
    return bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;
  }

  async function getMe(bot: BotConfig): Promise<TelegramGetMeResponse | null> {
    const token = await loadToken(bot);
    if (!token?.trim()) {
      return null;
    }
    const response = await fetchBotProviderJson<TelegramGetMeResponse>(
      `https://api.telegram.org/bot${token}/getMe`,
    );
    if (!response.ok) {
      return null;
    }
    return response.payload ?? {};
  }

  return {
    async test(bot) {
      if (!bot.credentialRef) {
        return { ok: false, message: "Telegram bot token is missing." };
      }
      const payload = await getMe(bot);
      if (!payload) {
        return { ok: false, message: "Telegram getMe failed." };
      }
      const name = payload.result?.first_name || payload.result?.username;
      return {
        ok: payload.ok === true,
        name,
        message: payload.ok === true ? "Telegram bot is reachable." : payload.description ?? "Telegram getMe failed.",
      };
    },

    async resolveName(bot) {
      const payload = await getMe(bot);
      return payload?.ok === true ? payload.result?.first_name || payload.result?.username || null : null;
    },

    async syncCommands(bot) {
      const token = await loadToken(bot);
      if (!token?.trim()) {
        return;
      }
      if (!bot.enabled) {
        await fetchBotProvider(`https://api.telegram.org/bot${token}/deleteMyCommands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }).catch(() => undefined);
        return;
      }

      const defaultCommands = buildTelegramCommands(bot);
      // Bugfix: Telegram 菜单不会自动从我们支持的 slash commands 推导。
      // 这里只同步默认英文菜单；中文命令由 parser 支持，避免 Telegram 客户端菜单显示中英混杂。
      await fetchBotProvider(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: defaultCommands }),
      });
    },

    async send(bot: BotConfig, message: BotOutboundMessage) {
      const token = await loadToken(bot);
      if (!token?.trim()) {
        return;
      }
      const selection = message.selection;
      const replyMarkup = selection ? buildSelectionReplyMarkup(selection) : undefined;
      const chunks = splitTelegramText(message.text);
      for (const [index, text] of chunks.entries()) {
        // Bugfix: 长 Plan 会被拆成多条消息，审批提示位于最后一条。
        // 按钮必须跟随最终决策上下文，不能挂在尚未发送完整正文的第一条上。
        const shouldAttachReplyMarkup = index === chunks.length - 1 && replyMarkup;
        const response = await fetchBotProvider(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: message.providerUserId,
            text,
            parse_mode: "Markdown",
            ...(shouldAttachReplyMarkup ? { reply_markup: replyMarkup } : {}),
          }),
        });
        if (!response.ok) {
          // Bugfix: Telegram Markdown 对未闭合的 `_*[]()` 很敏感，模型输出偶尔会被拒收。
          // 解析失败时退回纯文本重发，既优先支持 Markdown，也保证消息不会丢。
          await fetchBotProvider(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: message.providerUserId,
              text,
              ...(shouldAttachReplyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
          });
        }
      }
    },

    async sendTyping(bot: BotConfig, target) {
      const token = await loadToken(bot);
      if (!token?.trim()) {
        return;
      }
      await fetchBotProvider(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target.providerUserId,
          action: "typing",
        }),
      });
    },

    async acknowledgeCallback(bot: BotConfig, payload: unknown, text?: string, _message?: BotOutboundMessage, signal?: AbortSignal) {
      const token = await loadToken(bot);
      const callbackQueryId = readTelegramCallbackId(payload);
      if (!token?.trim() || !callbackQueryId) {
        return;
      }
      await fetchBotProvider(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text?.trim() ? { text: truncateCallbackToast(text) } : {}),
        }),
      });
      const messageRef = readTelegramCallbackMessageRef(payload);
      if (messageRef && text?.trim()) {
        await fetchBotProvider(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            chat_id: messageRef.chatId,
            message_id: messageRef.messageId,
            reply_markup: { inline_keyboard: [] },
          }),
        }).catch(() => undefined);
      }
    },

    async downloadAttachment(bot, attachment) {
      const token = await loadToken(bot);
      if (!token?.trim() || !attachment.providerFileId) {
        return null;
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      );
      try {
        const fileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_id: attachment.providerFileId }),
          signal: controller.signal,
        });
        if (!fileResponse.ok) {
          throw new Error(`Telegram getFile failed: HTTP ${fileResponse.status}`);
        }
        const filePayload = (await fileResponse.json()) as TelegramFileResponse;
        const filePath = filePayload.result?.file_path;
        if (filePayload.ok !== true || !filePath) {
          throw new Error(filePayload.description ?? "Telegram getFile did not return file_path.");
        }
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Telegram file download failed: HTTP ${response.status}`);
        }
        return {
          attachment: {
            ...attachment,
            ...(typeof filePayload.result?.file_size === "number"
              ? { sizeBytes: filePayload.result.file_size }
              : {}),
          },
          data: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error) {
        if ((error as { name?: unknown })?.name === "AbortError") {
          // Bugfix: Telegram 文件接口卡住时要快速失败，避免 bot 回调一直没有可见结果。
          throw new Error("Telegram file download timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = typeof payload.botId === "string" ? payload.botId : "";
      const update = isRecord(payload.update) ? payload.update : payload;
      if (!botId) {
        return [];
      }
      const message = readTelegramPrivateMessage(botId, update) ?? readTelegramCallbackMessage(botId, update);
      return message ? [message] : [];
    },
  };
}
