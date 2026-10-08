import { getMediaPreviewFormat, ServiceChannels, type MediaPreviewKind } from "@zcode/shared";
import type { IFileService } from "../file/file.js";
import { createServiceDescriptor } from "../descriptors.js";

export type MediaPreviewPreparation =
  | {
      kind: "local-url";
      mediaType: string;
      path: string;
      size: number;
      url: string;
    }
  | {
      kind: "host-range-url";
      mediaType: string;
      path: string;
      previewId: string;
      size: number;
      url: string;
      urlExpiresAt: number;
    }
  | {
      kind: "inline";
      dataBase64: string;
      mediaType: string;
      path: string;
      size: number;
    };

export interface IMediaPreviewService {
  prepare(params: {
    path: string;
    expectedKind: MediaPreviewKind;
  }): Promise<MediaPreviewPreparation>;
  refreshPlaybackUrl?(params: { previewId: string }): Promise<{
    url: string;
    expiresAt: number;
  }>;
  release?(params: { previewId: string }): Promise<void>;
}

export const IMediaPreviewService = createServiceDescriptor<IMediaPreviewService>(
  ServiceChannels.MediaPreview,
);

export function createMediaPreviewService(options: {
  fileService: IFileService;
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  createLocalMediaPreviewUrl?: (path: string) => string;
  inlineMaxBytes?: number;
}): IMediaPreviewService {
  const inlineMaxBytes = options.inlineMaxBytes ?? 8 * 1024 * 1024;

  return {
    async prepare({ path, expectedKind }) {
      const format = getMediaPreviewFormat(path);
      if (!format || format.kind !== expectedKind) {
        throw new Error(`Unsupported media preview format: ${path}`);
      }

      const fileStat = await options.fileService.stat({ path });
      if (fileStat.type !== "file" || typeof fileStat.size !== "number") {
        throw new Error(`Path is not a media file: ${path}`);
      }

      if (options.authorizeLocalMediaPreviewPath && options.createLocalMediaPreviewUrl) {
        const canonicalPath = await options.authorizeLocalMediaPreviewPath(path);
        return {
          kind: "local-url",
          mediaType: format.mediaType,
          path: canonicalPath,
          size: fileStat.size,
          url: options.createLocalMediaPreviewUrl(canonicalPath),
        };
      }

      if (fileStat.size > inlineMaxBytes) {
        throw new Error(`Media file is too large for inline preview: ${path}`);
      }

      const preview = await options.fileService.readMediaPreview({
        path,
        maxBytes: inlineMaxBytes,
      });
      return {
        kind: "inline",
        dataBase64: preview.dataBase64,
        mediaType: preview.mediaType,
        path,
        size: preview.totalBytes,
      };
    },
  };
}
