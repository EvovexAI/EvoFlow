import { useEffect, useMemo, useRef, useState } from "react";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * 内容产物（`file` / `markdown`）的字节读取。
 *
 * 逐字照 `attachmentRead` 的分块习语：一块 ≤ 512 KiB，`nextOffset` 为 null 即读完。
 * 全量拼进内存的上界是 `ARTIFACT_CAPS.maxFileBytes`（= 20 MiB，与附件同级），
 * 这个量级下一次性 Blob 比让每个查看器各自去做 range 读简单得多——查看器全是既有的叶子组件，
 * 它们要的是 Blob / ArrayBuffer，不是一个游标。
 *
 * ```
 * offset 0 ──read──▶ {dataBase64, mediaType, totalBytes, nextOffset}
 *        ◀──────────  解码成 Uint8Array 塞进 chunks[]
 *   nextOffset ──read──▶ …  直到 null
 *        ▼
 *   拼成一个 Uint8Array ─▶ Blob ─▶ objectUrl（卸载 / 换版本时 revoke）
 * ```
 */

/** 一块的字节数。与附件用同一个常量，不另铸——网关那边的上界就是它。 */
const CHUNK_BYTES = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;

/**
 * 一份产物最多读多少块。20 MiB / 512 KiB = 40 块，留一倍余量当死循环刹车：
 * 一个不肯把 `nextOffset` 收敛到 null 的实现不该把渲染线程锁死。
 */
const MAX_CHUNKS = 96;

interface WorkflowRunArtifactBytesState {
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  /** Blob 的 object URL；`<img src>` / PdfViewer 用。卸载与换版本时自动 revoke。 */
  objectUrl: string | null;
  /** journal 记录上的 contentType（不是 store 重新嗅探出来的那个）——渲染器分派的精确匹配契约。 */
  mediaType: string | null;
  totalBytes: number | null;
  loading: boolean;
  error: string | null;
}

function emptyState(): WorkflowRunArtifactBytesState {
  return {
    bytes: null,
    blob: null,
    objectUrl: null,
    mediaType: null,
    totalBytes: null,
    loading: false,
    error: null,
  };
}

/** base64 → 字节。renderer 里 `atob` 恒在（Electron 与浏览器都是 Chromium）。 */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 字节 → base64。office 查看器只吃 `FileBinaryPreview.dataBase64`，所以这条回程路是必要的。
 *
 * 分段（8 KiB）而不是 `String.fromCharCode(...bytes)`：后者在 20 MiB 上会以
 * "Maximum call stack size exceeded" 炸掉——展开成 2000 万个实参。
 */
export function encodeBytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  const step = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

export function useWorkflowRunArtifactBytes(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  version: number;
  /** 关掉即不读，也不留下任何 object URL（预置看板与折叠态都靠它省掉整条链路）。 */
  enabled?: boolean;
}): WorkflowRunArtifactBytesState {
  const { workflowRunArtifactRead } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactBytesState>(emptyState);
  // 已发出的 object URL：卸载与换版本时必须 revoke，否则每翻一版就漏一份 20 MiB。
  const objectUrlRef = useRef<string | null>(null);

  const { artifactId, runId, sessionId, version } = options;
  const enabled =
    options.enabled !== false &&
    sessionId.length > 0 &&
    runId.length > 0 &&
    artifactId.length > 0 &&
    version > 0;

  useEffect(() => {
    const revokePrevious = () => {
      if (objectUrlRef.current !== null) {
        if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = null;
      }
    };
    revokePrevious();
    setState(emptyState());
    if (!enabled) return;

    let alive = true;
    setState((current) => ({ ...current, loading: true }));
    void (async () => {
      try {
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let offset = 0;
        let mediaType = "application/octet-stream";
        let totalBytes = 0;
        for (let index = 0; index < MAX_CHUNKS; index += 1) {
          const result = await workflowRunArtifactRead({
            sessionId,
            runId,
            artifactId,
            version,
            offset,
            limit: CHUNK_BYTES,
          });
          if (!alive) return;
          mediaType = result.mediaType;
          totalBytes = result.totalBytes;
          chunks.push(decodeBase64(result.dataBase64));
          if (result.nextOffset === null) break;
          offset = result.nextOffset;
        }
        if (!alive) return;
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, cursor);
          cursor += chunk.length;
        }
        const blob = new Blob([bytes], { type: mediaType });
        // jsdom 里没有 createObjectURL：拿不到 URL 不是错误，只是 `<img>` 那条路走不了，
        // Blob / bytes 两条路仍然通（PdfViewer 与 office 查看器读的就是它们）。
        const objectUrl =
          typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(blob)
            : null;
        objectUrlRef.current = objectUrl;
        setState({
          bytes,
          blob,
          objectUrl,
          mediaType,
          totalBytes,
          loading: false,
          error: null,
        });
      } catch (caught) {
        if (!alive) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] 读取产物字节失败", {
          artifactId,
          error: message,
          runId,
          sessionId,
          version,
        });
        setState({ ...emptyState(), error: message });
      }
    })();

    return () => {
      alive = false;
      revokePrevious();
    };
  }, [artifactId, enabled, runId, sessionId, version, workflowRunArtifactRead]);

  return useMemo(() => state, [state]);
}
