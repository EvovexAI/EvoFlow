import { basename, join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import type { ApiClient, FeedbackDeviceInfo } from "@zcode/shared";
import {
  buildRuntimeZCodeApiUrl,
  ZCODE_BUILD_TIME,
  ZCODE_COMMIT,
  ZCODE_VERSION,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import { arch, platform, release, type as osType } from "node:os";

import type { ICredentialService } from "../credential/credential.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { FeedbackUploadProgress, IFeedbackService } from "./feedback.js";
import { FeedbackHttpClient, FeedbackUploadCanceledError } from "./feedbackHttpClient.js";
import { cleanupLogArchive, prepareCompactLogArchive } from "./compactLogArchive.js";
import { getFeedbackAttachmentDir } from "../paths.js";
import { FeedbackLocalTicketStore } from "#src/feedback/feedbackLocalTicketStore.js";

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export interface CreateFeedbackServiceOptions {
  credentialService: ICredentialService;
  oauthService: IOAuthService;
  apiClient: ApiClient;
  getDeviceMid?: () => string | undefined;
  apiBaseUrl?: string;
  createFullLogArchive?: (
    sourceDir: string,
    options?: {
      onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
    },
  ) => Promise<{ path: string; size: number }>;
  revealPath?: (path: string) => Promise<void>;
}

function resolveApiBaseUrl(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.ZCODE_FEEDBACK_API_BASE?.trim() ||
    buildRuntimeZCodeApiUrl(process.env, "/api/v1")
  );
}

function buildDeviceSnapshot(): FeedbackDeviceInfo {
  return {
    appVersion: ZCODE_VERSION,
    buildCommitId: ZCODE_COMMIT,
    buildTime: ZCODE_BUILD_TIME,
    nodeVersion: process.version,
    osType: osType(),
    osPlatform: platform(),
    osRelease: release(),
    // node:os.version() 在 macOS 上是完整 Darwin kernel 字符串，超过后端 os_version VARCHAR(64) 会写库失败。
    osVersion: release(),
    osArch: arch(),
  };
}

export function createFeedbackService(options: CreateFeedbackServiceOptions): IFeedbackService {
  const apiBaseUrl = resolveApiBaseUrl(options.apiBaseUrl);
  function getHostDeviceMid(): string | undefined {
    return options.getDeviceMid?.()?.trim() || undefined;
  }

  function requireHostDeviceMid(): string {
    const deviceMid = getHostDeviceMid();
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    return deviceMid;
  }

  async function getZcodeJwtToken(): Promise<string | undefined> {
    return (await options.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || undefined;
  }

  async function hasZcodeJwtToken(): Promise<boolean> {
    return Boolean(await getZcodeJwtToken());
  }

  const httpClient = new FeedbackHttpClient({
    baseUrl: apiBaseUrl,
    apiClient: options.apiClient,
    getAuthHeaders: async () => {
      const headers: Record<string, string> = {};
      const deviceMid = getHostDeviceMid();
      // feedback 的 device_mid 必须复用宿主 deviceMid（与 provider 请求头、远控同一身份）；
      // 不单独生成 fb_ 身份，否则同一台机器在不同系统里会被拆成两个设备。
      if (deviceMid) {
        headers["X-Device-Mid"] = deviceMid;
      }
      const jwtToken = await getZcodeJwtToken();
      if (jwtToken) {
        headers.Authorization = `Bearer ${jwtToken}`;
      }
      return headers;
    },
  });
  const localTicketStore = new FeedbackLocalTicketStore();
  const uploadProgressEmitters = new Map<string, Emitter<FeedbackUploadProgress>>();
  const activeUploadControllers = new Map<string, AbortController>();
  const activeCreateControllers = new Map<string, AbortController>();

  function getUploadProgressEmitter(id: string): Emitter<FeedbackUploadProgress> {
    const current = uploadProgressEmitters.get(id);
    if (current) return current;
    const emitter = new Emitter<FeedbackUploadProgress>({
      onDidRemoveLastListener: () => {
        uploadProgressEmitters.delete(id);
        emitter.dispose();
      },
    });
    uploadProgressEmitters.set(id, emitter);
    return emitter;
  }

  return {
    create: async (input, createOptions) => {
      const device = input.device ?? buildDeviceSnapshot();
      const operationId = createOptions?.operationId?.trim();
      const controller = new AbortController();
      if (operationId) {
        // UI 取消创建工单时不能只关闭弹窗；host 需要能按 operationId
        // 找到当前 HTTP 请求并 abort，避免“正在连接反馈服务”永久悬挂。
        activeCreateControllers.get(operationId)?.abort();
        activeCreateControllers.set(operationId, controller);
      }
      try {
        const ticket = await httpClient.create(
          {
            ...input,
            device,
          },
          {
            signal: controller.signal,
          },
        );
        if (!(await hasZcodeJwtToken())) {
          await localTicketStore.upsert(requireHostDeviceMid(), ticket);
        }
        return ticket;
      } finally {
        if (operationId && activeCreateControllers.get(operationId) === controller) {
          activeCreateControllers.delete(operationId);
        }
      }
    },
    cancelCreate: async (operationId) => {
      const key = operationId.trim();
      if (!key) return;
      activeCreateControllers.get(key)?.abort();
    },
    list: async (query) => {
      if (await hasZcodeJwtToken()) {
        return httpClient.list(query);
      }
      const items = await localTicketStore.list(requireHostDeviceMid(), query);
      return { items, total: items.length };
    },
    get: (id) => httpClient.get(id),
    comment: (id, body) => httpClient.comment(id, body),
    uploadAttachment: async (id, kind, file) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      return httpClient.uploadFile(id, kind, file.path, filename, contentType, {
        messageId: file.messageId,
      });
    },
    uploadAttachmentWithProgress: async (id, kind, file, progressId) => {
      const filename = file.filename ?? basename(file.path);
      const contentType = file.contentType ?? (kind === "image" ? "image/png" : "application/zip");
      const emitter = getUploadProgressEmitter(progressId);
      emitter.fire({
        id: progressId,
        phase: "preparing",
        uploadedBytes: 0,
        totalBytes: 0,
      });
      const controller = new AbortController();
      activeUploadControllers.set(progressId, controller);
      return httpClient
        .uploadFile(id, kind, file.path, filename, contentType, {
          messageId: file.messageId,
          signal: controller.signal,
          onUploadProgress: (event) => {
            emitter.fire({
              id: progressId,
              phase: event.uploadedBytes >= event.totalBytes ? "complete" : "uploading",
              uploadedBytes: event.uploadedBytes,
              totalBytes: event.totalBytes,
            });
          },
        })
        .catch((error) => {
          if (error instanceof FeedbackUploadCanceledError) {
            emitter.fire({
              id: progressId,
              phase: "canceled",
              uploadedBytes: 0,
              totalBytes: 0,
            });
          }
          throw error;
        })
        .finally(() => {
          activeUploadControllers.delete(progressId);
        });
    },
    cancelUpload: async (progressId) => {
      activeUploadControllers.get(progressId)?.abort();
    },
    onDynamicUploadProgress: (id) => getUploadProgressEmitter(id).event,
    uploadAttachmentData: async (id, kind, file) => {
      const attachmentRootDir = getFeedbackAttachmentDir();
      await mkdir(attachmentRootDir, { recursive: true });
      const tempDir = await mkdtemp(join(attachmentRootDir, "attachment-"));
      // 附件名来自 renderer，不能作为本地相对路径使用。
      const filename = basename(file.filename.replaceAll("\\", "/")) || "attachment";
      const tempPath = join(tempDir, "content");
      try {
        await writeFile(tempPath, Buffer.from(file.dataBase64, "base64"));
        return await httpClient.uploadFile(id, kind, tempPath, filename, file.contentType, {
          messageId: file.messageId,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    attachLogsFromExport: async (id, attachOptions) => {
      const archive = await prepareCompactLogArchive({
        full: attachOptions?.full,
        createFullArchive: options.createFullLogArchive,
      });
      try {
        return await httpClient.uploadFile(
          id,
          "log",
          archive.path,
          basename(archive.path),
          "application/zip",
        );
      } finally {
        await cleanupLogArchive(archive.path);
      }
    },
    getDeviceSnapshot: async () => buildDeviceSnapshot(),
    prepareCompactLogArchive: async (archiveOptions) => {
      const progressId = archiveOptions?.progressId;
      const progressEmitter = progressId ? getUploadProgressEmitter(progressId) : null;
      return prepareCompactLogArchive({
        full: archiveOptions?.full,
        createFullArchive: options.createFullLogArchive,
        onProgress: progressEmitter
          ? (event) => {
              progressEmitter.fire({
                id: progressId!,
                phase: "preparing",
                uploadedBytes: event.processedBytes,
                totalBytes: event.totalBytes,
              });
            }
          : undefined,
      });
    },
    cleanupPreparedLogArchive: (path) => cleanupLogArchive(path),
    revealLogArchive: async (path) => {
      if (options.revealPath) {
        await options.revealPath(path);
        return;
      }
    },
  };
}
